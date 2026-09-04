// sign.mjs — Authenticode-sign build output with Azure Trusted Signing.
//
// The build calls trySign([...exes]) after compiling. Whether anything is
// actually signed is decided by one file: signing.local.json in the repo root
// (gitignored — it's the maintainer's Azure wiring, not part of the source):
//
//   {
//     "endpoint": "https://weu.codesigning.azure.net",
//     "account":  "<trusted-signing-account-name>",
//     "profile":  "<certificate-profile-name>",
//     "tenantId": "...", "clientId": "...", "clientSecret": "..."   // optional
//   }
//
// Without the file the build stays unsigned and says so — anyone can build
// from source; only the maintainer holds a signing identity.
//
// Auth: if tenantId/clientId/clientSecret are present they're used (service
// principal). Otherwise Azure's DefaultAzureCredential kicks in, which picks
// up an `az login` session if one exists.
//
// Mechanics: signtool.exe (Windows SDK) + Microsoft's Trusted Signing dlib.
// The dlib is fetched once from NuGet into ~/.trusted-signing-client and
// reused. Timestamps come from Microsoft's own TSA, so signatures outlive
// certificate rotation (Trusted Signing certs are short-lived by design).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(os.homedir(), '.trusted-signing-client');
const NUGET_ID = 'microsoft.trusted.signing.client';
const TSA = 'http://timestamp.acs.microsoft.com';

const log = (...a) => console.log('[sign]', ...a);

function loadConfig() {
  const p = path.join(ROOT, 'signing.local.json');
  if (!fs.existsSync(p)) return null;
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const k of ['endpoint', 'account', 'profile'])
    if (!c[k]) throw new Error('signing.local.json is missing "' + k + '"');
  return c;
}

// Newest x64 signtool from the installed Windows SDKs.
function findSigntool() {
  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  let best = null;
  try {
    for (const v of fs.readdirSync(kits)) {
      const p = path.join(kits, v, 'x64', 'signtool.exe');
      if (/^10\./.test(v) && fs.existsSync(p) && (!best || v > best.v)) best = { v, p };
    }
  } catch {}
  if (!best) throw new Error('signtool.exe not found — install the Windows SDK');
  return best.p;
}

async function ensureDlib() {
  const dlib = path.join(CACHE, 'bin', 'x64', 'Azure.CodeSigning.Dlib.dll');
  if (fs.existsSync(dlib)) return dlib;
  log('fetching the Trusted Signing client from NuGet (one-time) ...');
  const idx = await (await fetch(`https://api.nuget.org/v3-flatcontainer/${NUGET_ID}/index.json`)).json();
  const ver = idx.versions.filter(v => !v.includes('-')).pop();
  const buf = Buffer.from(await (await fetch(
    `https://api.nuget.org/v3-flatcontainer/${NUGET_ID}/${ver}/${NUGET_ID}.${ver}.nupkg`)).arrayBuffer());
  fs.mkdirSync(CACHE, { recursive: true });
  const zip = path.join(CACHE, 'client.zip');
  fs.writeFileSync(zip, buf);
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Expand-Archive -Path '${zip}' -DestinationPath '${CACHE}' -Force`]);
  fs.rmSync(zip);
  fs.writeFileSync(path.join(CACHE, 'VERSION'), ver);
  if (!fs.existsSync(dlib)) throw new Error('dlib missing after extract: ' + dlib);
  return dlib;
}

// When signing goes live: drop the SmartScreen paragraphs in README.md
// ('Run it' step 2) and docs/index.html (.smartscreen).
/**
 * Sign the given files if signing is configured; otherwise say so and skip.
 * @param {string[]} files absolute paths to .exe/.dll files
 * @returns {Promise<boolean>} true if files were signed and verified
 */
export async function trySign(files) {
  const cfg = loadConfig();
  if (!cfg) { log('unsigned build — signing.local.json not found (copy signing.local.example.json to set it up)'); return false; }

  const signtool = findSigntool();
  const dlib = await ensureDlib();

  const meta = path.join(os.tmpdir(), 'ts-metadata-' + process.pid + '.json');
  fs.writeFileSync(meta, JSON.stringify({
    Endpoint: cfg.endpoint,
    CodeSigningAccountName: cfg.account,
    CertificateProfileName: cfg.profile
  }));

  const env = { ...process.env };
  if (cfg.tenantId && cfg.clientId && cfg.clientSecret) {
    env.AZURE_TENANT_ID = cfg.tenantId;
    env.AZURE_CLIENT_ID = cfg.clientId;
    env.AZURE_CLIENT_SECRET = cfg.clientSecret;
  }

  try {
    log('signing ' + files.map(f => path.basename(f)).join(', ') + ' via ' + cfg.endpoint);
    execFileSync(signtool, ['sign', '/v', '/fd', 'SHA256', '/tr', TSA, '/td', 'SHA256',
      '/dlib', dlib, '/dmdf', meta, ...files], { stdio: 'inherit', env });
    for (const f of files)
      execFileSync(signtool, ['verify', '/pa', f], { stdio: 'inherit' });
    log('signed and verified ✔');
    return true;
  } finally {
    try { fs.rmSync(meta); } catch {}
  }
}
