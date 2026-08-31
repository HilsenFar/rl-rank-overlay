// statsapi.mjs — make sure Rocket League's Stats API feed is switched on.
//
// The feed the overlay reads is off by default, and game updates occasionally
// reset it. This is a best-effort helper that finds the game's config file and,
// if the feed is disabled, turns it on. It changes ONE local file and touches
// nothing else. If it can't find the game it just logs once and gives up — the
// overlay still runs, it simply won't see a lobby until the feed is enabled.
//
// The file lives at <Rocket League>/TAGame/Config/DefaultStatsAPI.ini and the
// relevant section is:
//   [TAGame.MatchStatsExporter_TA]
//   PacketSendRate=120        <- 0 or missing means the feed is OFF
//   Port=49123
//
// Windows only (that is where Rocket League runs); a no-op elsewhere.

import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_DIR = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
const FALLBACK_DIRS = [
  'C:\\Program Files\\Epic Games\\rocketleague',
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\rocketleague'
];
const INI_REL = path.join('TAGame', 'Config', 'DefaultStatsAPI.ini');
const BACKUP_SUFFIX = '.rl-overlay.bak';

// Look for the config file, trying (1) an explicit override, (2) the Epic
// launcher's install manifests, then (3) a couple of classic default paths.
function findIni(override) {
  if (override) return fs.existsSync(override) ? override : null;
  try {
    for (const f of fs.readdirSync(MANIFEST_DIR)) {
      if (!f.endsWith('.item')) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(MANIFEST_DIR, f), 'utf8'));
        if (!/rocket\s*league/i.test(String(m.DisplayName || ''))) continue;
        const p = path.join(String(m.InstallLocation || '').replace(/\//g, '\\'), INI_REL);
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  } catch {}
  for (const d of FALLBACK_DIRS) {
    const p = path.join(d, INI_REL);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const readRate = t => { const m = t.match(/^\s*PacketSendRate\s*=\s*(-?\d+)/m); return m ? Number(m[1]) : null; };
const readPort = t => { const m = t.match(/^\s*Port\s*=\s*(\d+)/m); return m ? Number(m[1]) : null; };

function enableInText(text, rate) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (/^\s*PacketSendRate\s*=/m.test(text))
    return text.replace(/^(\s*)PacketSendRate\s*=.*$/m, '$1PacketSendRate=' + rate);
  if (/^\s*\[TAGame\.MatchStatsExporter_TA\]/m.test(text))
    return text.replace(/^(\s*\[TAGame\.MatchStatsExporter_TA\][^\r\n]*)/m, '$1' + eol + 'PacketSendRate=' + rate);
  return text + eol + '[TAGame.MatchStatsExporter_TA]' + eol + 'PacketSendRate=' + rate + eol;
}

/**
 * @param {object} [opts]
 * @param {(m:string)=>void} [opts.log]
 * @param {number} [opts.rate=120]   Desired PacketSendRate (capped at 120).
 * @param {string} [opts.ini]        Explicit path to DefaultStatsAPI.ini.
 * @returns {{found:boolean, ok:boolean, changed:boolean, iniPath:?string, port:?number}}
 */
export function ensureStatsApi(opts = {}) {
  const log = opts.log || (() => {});
  const rate = Math.min(120, Math.max(1, Number(opts.rate) || 120));
  if (process.platform !== 'win32') return { found: false, ok: false, changed: false, iniPath: null, port: null };

  const ini = findIni(opts.ini || process.env.STATSAPI_INI);
  if (!ini) {
    log('[statsapi] DefaultStatsAPI.ini not found — set STATSAPI_INI if the game lives somewhere unusual');
    return { found: false, ok: false, changed: false, iniPath: null, port: null };
  }

  let text;
  try { text = fs.readFileSync(ini, 'utf8'); }
  catch (e) { log('[statsapi] cannot read ' + ini + ': ' + (e.message || e)); return { found: true, ok: false, changed: false, iniPath: ini, port: null }; }

  const cur = readRate(text);
  const port = readPort(text);
  const dead = !cur || cur <= 0;

  let changed = false;
  if (dead || cur < rate) {
    try {
      const bak = ini + BACKUP_SUFFIX;
      if (!fs.existsSync(bak)) { try { fs.writeFileSync(bak, text); } catch {} }
      fs.writeFileSync(ini, enableInText(text, rate));
      changed = true;
      log('[statsapi] PacketSendRate ' + (cur === null ? 'was missing' : 'was ' + cur) + ' -> ' + rate +
        (dead ? ' (restart Rocket League to switch the feed on)' : ' (takes effect next game start)'));
    } catch (e) {
      log('[statsapi] the feed is off in ' + ini + ' but the fix failed (' + (e.message || e) + ') — set PacketSendRate=' + rate + ' by hand');
      return { found: true, ok: false, changed: false, iniPath: ini, port };
    }
  }
  return { found: true, ok: true, changed, iniPath: ini, port };
}
