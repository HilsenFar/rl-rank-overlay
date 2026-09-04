// watcher.mjs — ask the shared rank service ("the watcher") for player ranks.
//
// This is the ONLY thing the overlay sends anywhere. It takes a list of account
// ids that the game handed us for the current lobby and POSTs them to a public
// endpoint that answers with each player's competitive rank. That's it — there
// is no account, no key and no token on this side. The watcher holds a single
// read-only game session on the server so that thousands of overlays never have
// to; this client just asks it a question and shows the answer.
//
// Request:  POST <url>/v1/rank   { "pids": ["Epic|<id>|0", ...] }   (max 32)
// Response: { "ranks": { "<pid>": { p1, p2, p3, tournaments } | null }, ... }
// where each playlist entry is { label, division, mmr, tier, streak, matches }.
// A pid that maps to `null` simply means "no rank data for this player".

const DEFAULT_URL = 'https://collect.gitato.net';
const TIMEOUT_MS = 6000;
const BACKOFF_MS = 60e3;
const MAX_PIDS = 32;

/**
 * @param {object} opts
 * @param {string|false} [opts.url]  Watcher base URL. Falsey / "off" disables it.
 * @param {string} [opts.userAgent]
 * @param {(m:string)=>void} [opts.log]
 */
export function createWatcher(opts = {}) {
  const log = opts.log || (() => {});
  // The watcher only answers real tracker clients, so the User-Agent has to say
  // so. This is not a secret — it is just how the overlay identifies itself.
  const ua = opts.userAgent || 'GitatoRLTracker-Overlay/1.0';

  let url = opts.url !== undefined ? opts.url : DEFAULT_URL;
  if (url === false || /^(off|false|0|none|)$/i.test(String(url ?? ''))) url = null;
  if (url) url = String(url).replace(/\/+$/, '');

  const st = { downUntil: 0, lastOkAt: 0, lastError: null, lookups: 0 };

  function available() { return !!url && Date.now() >= st.downUntil; }

  // pids -> { pid: data | null }. Throws on a network / server error so the
  // caller can back off; an empty answer for one pid is `null`, not a throw.
  async function getRanks(pids) {
    if (!url) throw new Error('watcher disabled');
    if (Date.now() < st.downUntil) throw new Error('watcher in backoff');
    const ids = [...new Set((pids || []).map(String))].slice(0, MAX_PIDS);
    const out = {};
    for (const p of ids) out[p] = null;
    if (!ids.length) return out;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let httpFail = false;
    try {
      const r = await fetch(url + '/v1/rank', {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': ua, 'Accept-Encoding': 'identity' },
        body: JSON.stringify({ pids: ids })
      });
      if (!r.ok) {
        // 503 = the service is briefly unavailable, 429 = we asked too often,
        // 5xx = it is having a bad time. All mean "try again later", not "spam".
        st.lastError = 'HTTP ' + r.status;
        st.downUntil = Date.now() + (r.status === 429 ? 2 * BACKOFF_MS : BACKOFF_MS);
        httpFail = true;
        throw new Error(st.lastError);
      }
      const j = await r.json();
      if (!j || typeof j.ranks !== 'object') throw new Error('unexpected response shape');
      for (const p of ids) if (p in j.ranks) out[p] = j.ranks[p] || null;
      st.lastOkAt = Date.now();
      st.lastError = null;
      st.lookups++;
      return out;
    } catch (e) {
      // Anything that is not an HTTP status (timeout, refused, DNS, bad JSON)
      // gets its own backoff here; an HTTP error set one above already.
      if (!httpFail) {
        st.lastError = e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e);
        st.downUntil = Date.now() + BACKOFF_MS;
      }
      log('[watcher] ' + st.lastError);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  function status() {
    return {
      url, available: available(), lookups: st.lookups,
      lastOkAt: st.lastOkAt || null, lastError: st.lastError,
      downUntil: st.downUntil > Date.now() ? st.downUntil : null
    };
  }

  return { getRanks, available, status, url };
}

export { DEFAULT_URL };
