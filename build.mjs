// build.mjs — assemble a ready-to-run Windows release of the overlay.
//
// Output: dist/rl-rank-overlay/ (a folder you can double-click start.cmd in)
//     and dist/rl-rank-overlay-win-x64.zip (the release asset).
//
// The zip contains everything needed to run with nothing installed:
//   - RLOverlay.exe + the WebView2 DLLs (the transparent window)
//   - a copy of node.exe (the reader runtime) and its LICENSE text
//   - src/ (the readable source that actually does the work)
//   - start.cmd
// Prereqs to BUILD (not to run): .NET SDK (any recent), and this Node.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trySign } from './tools/sign.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');
const OUT = path.join(DIST, 'rl-rank-overlay');
const BIN = path.join(HERE, 'host', 'bin', 'Release');
// One version for everything: package.json is the source, the exe gets it too.
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

const log = (...a) => console.log('[build]', ...a);

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function cp(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
function cpDir(from, to, skip = () => false) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(e.name)) continue;
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) cpDir(s, d, skip);
    else cp(s, d);
  }
}

// 1. Build the transparent host.
log('building the WebView2 host (dotnet build -c Release) ...');
execFileSync('dotnet', ['build', path.join(HERE, 'host', 'RLOverlay.csproj'), '-c', 'Release', '-v', 'quiet', '-nologo',
  '-p:Version=' + VERSION], { stdio: 'inherit' });
if (!fs.existsSync(path.join(BIN, 'RLOverlay.exe'))) throw new Error('RLOverlay.exe not found after build');

// 2. Fresh output folder.
rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// 3. Host exe + its runtime DLLs (skip debug symbols).
cpDir(BIN, OUT, name => name.endsWith('.pdb'));

// 4. The reader source.
cpDir(path.join(HERE, 'src'), path.join(OUT, 'src'));

// 5. A copy of the Node runtime so the release runs with nothing installed,
//    plus its license text: MIT asks for it to travel with every copy. Fetched
//    for the exact bundled version (the build already needs the network for
//    dotnet restore).
cp(process.execPath, path.join(OUT, 'node', 'node.exe'));
const licUrl = 'https://raw.githubusercontent.com/nodejs/node/' + process.version + '/LICENSE';
log('fetching the Node.js license text for ' + process.version + ' ...');
const licRes = await fetch(licUrl);
const lic = licRes.ok ? await licRes.text() : '';
if (!/MIT/i.test(lic)) throw new Error('node LICENSE fetch failed: ' + licUrl);
fs.writeFileSync(path.join(OUT, 'node', 'LICENSE'), lic);

// 6. Launcher, icon and docs.
for (const f of ['start.cmd', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md']) {
  const s = path.join(HERE, f);
  if (fs.existsSync(s)) cp(s, path.join(OUT, f));
}
const icon = path.join(HERE, 'host', 'icon.ico');
if (fs.existsSync(icon)) cp(icon, path.join(OUT, 'icon.ico'));

// 7. Sign the shipped exe (no-op without the maintainer's signing.local.json).
await trySign([path.join(OUT, 'RLOverlay.exe')]);

// 8. Zip it (PowerShell Compress-Archive — always present on Windows).
const zip = path.join(DIST, 'rl-rank-overlay-win-x64.zip');
rmrf(zip);
log('zipping ...');
execFileSync('powershell', ['-NoProfile', '-Command',
  `Compress-Archive -Path '${OUT}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });

const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
log('done: ' + zip + ' (' + mb + ' MB)');
