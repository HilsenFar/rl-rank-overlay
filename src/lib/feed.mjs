// feed.mjs — read the Rocket League Stats API and hand back the live lobby roster.
//
// Rocket League ships a built-in "Stats API" that streams the state of your
// current match over a plain TCP socket on 127.0.0.1 (default port 49123).
// Despite what the game's docs call it, it is NOT a WebSocket: it is a raw
// stream of back-to-back JSON objects with no framing between them. So the job
// here is (1) connect, (2) split the stream on top-level `{ ... }` boundaries,
// and (3) pull the roster out of the `UpdateState` messages.
//
// Each message looks like { "Event": "UpdateState", "Data": "<json string>" }
// — note that Data is itself a JSON string that has to be parsed a second time.
// The one message we care about is UpdateState, whose Data carries:
//   { Players: [ { Name, PrimaryId, TeamNum, ... } ], Game: { Teams, PlaylistId } }
// PrimaryId is the account id we ask the watcher about (e.g. "Epic|<id>|0").
//
// This file talks to nobody but the game. It never reaches the network.

import net from 'node:net';

const RECONNECT_MS = 3000;

// Split a stream of concatenated JSON objects into individual object strings.
// String-aware so a `{` or `}` inside a quoted value never confuses the depth
// counter. `emit` is called once per complete top-level object.
function makeSplitter(emit) {
  let buf = '', depth = 0, inStr = false, esc = false, objStart = -1, i = 0;
  return function feed(chunk) {
    buf += chunk;
    for (; i < buf.length; i++) {
      const c = buf[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') { if (depth === 0) objStart = i; depth++; }
      else if (c === '}' && depth > 0 && --depth === 0 && objStart >= 0) {
        emit(buf.slice(objStart, i + 1));
        objStart = -1;
      }
    }
    if (depth === 0) { buf = ''; i = 0; objStart = -1; }
    else if (objStart > 0) { buf = buf.slice(objStart); i = buf.length; objStart = 0; }
    if (buf.length > 5e6) { buf = ''; depth = 0; inStr = false; esc = false; i = 0; objStart = -1; } // runaway guard
  };
}

// Ranked playlist ids the watcher knows about, keyed the way it returns them.
const PLAYLIST_KEY = { 10: 'p1', 11: 'p2', 13: 'p3', 34: 'tournaments' };

// Turn one UpdateState payload into a clean roster.
function rosterFrom(data) {
  const players = Array.isArray(data.Players) ? data.Players : [];
  const roster = [];
  const counts = [0, 0];
  for (const p of players) {
    if (!p || typeof p !== 'object') continue;
    const pid = p.PrimaryId || null;
    const name = p.Name || '?';
    const team = p.TeamNum === 1 ? 1 : 0;
    if (team === 0 || team === 1) counts[team]++;
    roster.push({ name, pid, team });
  }
  const game = data.Game || {};
  const playlistId = Number(game.PlaylistId) || null;
  // Which playlist's rank to show: prefer the game's own playlist id when it is
  // one we recognise, otherwise infer from how many players are on a side.
  let playlistKey = playlistId && PLAYLIST_KEY[playlistId] ? PLAYLIST_KEY[playlistId] : null;
  if (!playlistKey) {
    const size = Math.max(counts[0], counts[1]);
    playlistKey = size <= 1 ? 'p1' : size === 2 ? 'p2' : 'p3';
  }
  return { players: roster, playlistId, playlistKey };
}

/**
 * Start reading the game feed.
 * @param {object} opts
 * @param {string} [opts.host='127.0.0.1']
 * @param {number} [opts.port=49123]
 * @param {(r:{players:Array,playlistId:?number,playlistKey:string})=>void} opts.onRoster
 * @param {(state:'connected'|'waiting')=>void} [opts.onState]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{stop:()=>void}}
 */
export function createFeed(opts) {
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port) || 49123;
  const onRoster = opts.onRoster || (() => {});
  const onState = opts.onState || (() => {});
  const log = opts.log || (() => {});

  let sock = null, retry = null, stopped = false;

  function handle(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || msg.Event !== 'UpdateState') return;
    let d = msg.Data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
    if (!d || typeof d !== 'object') return;
    try { onRoster(rosterFrom(d)); } catch (e) { log('[feed] roster error: ' + (e && e.message || e)); }
  }

  function connect() {
    if (stopped) return;
    const split = makeSplitter(handle);
    sock = net.connect(port, host);
    sock.setEncoding('utf8');
    sock.on('connect', () => { log('[feed] connected to ' + host + ':' + port); onState('connected'); });
    sock.on('data', chunk => split(chunk));
    sock.on('error', () => {}); // handled by 'close'
    sock.on('close', () => {
      sock = null;
      if (stopped) return;
      onState('waiting');
      clearTimeout(retry);
      retry = setTimeout(connect, RECONNECT_MS);
    });
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      try { sock && sock.destroy(); } catch {}
    }
  };
}

export const _internal = { makeSplitter, rosterFrom, PLAYLIST_KEY };
