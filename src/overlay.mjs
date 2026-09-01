// overlay.mjs — the RL rank overlay's local brain.
//
// It does three small things and nothing else:
//   1. reads the current lobby from Rocket League's Stats API (lib/feed.mjs),
//   2. asks the watcher for those players' ranks (lib/watcher.mjs),
//   3. serves a tiny page + a live event stream so the glass window can draw it.
//
// The only outbound network call in the whole program is the watcher request in
// lib/watcher.mjs. Everything else is localhost. There is no analytics, no
// feedback channel and no account of any kind here.
//
// Config (all optional, via environment variables):
//   WATCHER_URL   watcher base URL          (default https://collect.gitato.net)
//   PORT          local page/SSE port       (default 8342)
//   STATS_HOST    Stats API host            (default 127.0.0.1)
//   STATS_PORT    Stats API port            (default 49123)
//   STATSAPI_INI  explicit path to DefaultStatsAPI.ini (usually auto-detected)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFeed } from './lib/feed.mjs';
import { createWatcher, DEFAULT_URL } from './lib/watcher.mjs';
import { ensureStatsApi } from './lib/statsapi.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
// Optional: real rank emblem art. Drop PNG files named like 'Grand_Champion_I.png'
// into an emblems/ folder next to the app and the card uses them instead of the
// built-in shields. The folder ships empty on purpose: the game's own emblem art
// is Psyonix'/third-party property, so bring your own copies.
const EMBLEMS = path.join(HERE, '..', 'emblems');
const hasEmblems = (() => { try { return fs.readdirSync(EMBLEMS).some(f => f.endsWith('.png')); } catch { return false; } })();

const PORT = Number(process.env.PORT) || 8342;
const STATS_HOST = process.env.STATS_HOST || '127.0.0.1';
const STATS_PORT = Number(process.env.STATS_PORT) || 49123;
const WATCHER_URL = process.env.WATCHER_URL !== undefined ? process.env.WATCHER_URL : DEFAULT_URL;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// How long a fetched rank is good for. Ranks barely move within one session, so
// 10 minutes keeps the watcher quiet while still refreshing across a night.
const RANK_TTL_MS = 10 * 60e3;
// A player the watcher had no data for: retry sooner in case they finish their
// placement matches, but not so often that we hammer the service.
const RANK_MISS_TTL_MS = 2 * 60e3;

const watcher = createWatcher({ url: WATCHER_URL, log });

// pid -> { ranks: object|null, at: number }
const rankCache = new Map();
let roster = { players: [], playlistId: null, playlistKey: 'p2' };
let feedState = 'waiting';

function cached(pid) {
  const e = rankCache.get(pid);
  if (!e) return undefined;
  const ttl = e.ranks ? RANK_TTL_MS : RANK_MISS_TTL_MS;
  if (Date.now() - e.at > ttl) return undefined;
  return e;
}

// Ask the watcher about any lobby player whose rank we don't have (or is stale).
let looking = false;
async function refreshRanks() {
  if (looking || !watcher.available()) return;
  const want = [];
  for (const p of roster.players) if (p.pid && cached(p.pid) === undefined) want.push(p.pid);
  if (!want.length) return;
  looking = true;
  try {
    const res = await watcher.getRanks(want);
    const now = Date.now();
    for (const pid of want) rankCache.set(pid, { ranks: res[pid] || null, at: now });
    push();
  } catch {
    // watcher.js already logged and set its own backoff; try again next roster tick
  } finally {
    looking = false;
  }
}

// Build the payload the page draws from: each player with the rank for the
// playlist this lobby is (1s/2s/3s), plus their other playlists for the tooltip.
function snapshot() {
  const players = roster.players.map(p => {
    const c = p.pid ? cached(p.pid) : undefined;
    const ranks = c ? c.ranks : undefined; // undefined = still loading, null = no data
    return {
      name: p.name, team: p.team, pid: p.pid,
      rank: ranks === undefined ? undefined : (ranks && ranks[roster.playlistKey]) || null,
      ranks: ranks === undefined ? undefined : ranks
    };
  });
  return { players, playlistKey: roster.playlistKey, playlistId: roster.playlistId, feed: feedState, emblems: hasEmblems, ts: Date.now() };
}

// ---- server-sent events: push the snapshot to the page whenever it changes ----
const clients = new Set();
let lastSent = '';

function push() {
  const snap = snapshot();
  // Don't compare on ts — only push when the players or ranks actually change.
  const { ts, ...rest } = snap;
  const key = JSON.stringify(rest);
  if (key === lastSent) return;
  lastSent = key;
  const line = 'data: ' + JSON.stringify(snap) + '\n\n';
  for (const res of clients) { try { res.write(line); } catch {} }
}

// ---- feed wiring ----
createFeed({
  host: STATS_HOST, port: STATS_PORT, log,
  onState: s => { feedState = s; push(); },
  onRoster: r => { roster = r; push(); refreshRanks(); }
});

// Re-check for stale ranks periodically even if the roster is unchanged.
setInterval(refreshRanks, 20e3).unref?.();

// ---- tiny static + SSE server, localhost only ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    res.write('data: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ feed: feedState, watcher: watcher.status(), players: roster.players.length }));
    return;
  }
  if (url.pathname.startsWith('/emblems/')) {
    const name = url.pathname.slice('/emblems/'.length);
    if (!/^[A-Za-z_]{1,40}.png$/.test(name)) { res.writeHead(404); res.end(); return; }
    fs.readFile(path.join(EMBLEMS, name), (err, buf) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    });
    return;
  }
  // static files from ./public — only the overlay page and its assets
  let file = url.pathname === '/' ? 'overlay.html' : url.pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// Heartbeat so proxies/keep-alive don't drop idle SSE connections.
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch {} } }, 15e3).unref?.();

server.listen(PORT, '127.0.0.1', () => {
  log('RL rank overlay listening on http://127.0.0.1:' + PORT);
  log('watcher: ' + (watcher.url || '(disabled)'));
  const s = ensureStatsApi({ log });
  if (s.found && s.ok && !s.changed) log('[statsapi] feed already enabled (' + (s.iniPath || '') + ')');
});
