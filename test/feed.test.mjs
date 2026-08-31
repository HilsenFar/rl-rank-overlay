// Unit tests for the stream splitter and roster extraction. No game needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { _internal } from '../src/lib/feed.mjs';

const { makeSplitter, rosterFrom } = _internal;

test('splitter separates back-to-back JSON objects', () => {
  const out = [];
  const feed = makeSplitter(s => out.push(s));
  feed('{"a":1}{"b":2}');
  assert.deepEqual(out, ['{"a":1}', '{"b":2}']);
});

test('splitter reassembles objects across chunk boundaries', () => {
  const out = [];
  const feed = makeSplitter(s => out.push(s));
  feed('{"Event":"Update');
  feed('State","Data":"{}"}');
  assert.equal(out.length, 1);
  assert.deepEqual(JSON.parse(out[0]), { Event: 'UpdateState', Data: '{}' });
});

test('splitter ignores braces inside strings', () => {
  const out = [];
  const feed = makeSplitter(s => out.push(s));
  feed('{"name":"a}{b"}{"x":1}');
  assert.deepEqual(out, ['{"name":"a}{b"}', '{"x":1}']);
});

test('rosterFrom pulls names, ids, teams and infers the playlist', () => {
  const r = rosterFrom({
    Players: [
      { Name: 'Alice', PrimaryId: 'Epic|1|0', TeamNum: 0 },
      { Name: 'Bob', PrimaryId: 'Epic|2|0', TeamNum: 1 }
    ],
    Game: {}
  });
  assert.equal(r.players.length, 2);
  assert.equal(r.players[0].name, 'Alice');
  assert.equal(r.players[0].pid, 'Epic|1|0');
  assert.equal(r.playlistKey, 'p1'); // 1 player per side -> 1v1
});

test('rosterFrom prefers a known PlaylistId over team-size inference', () => {
  const r = rosterFrom({
    Players: [
      { Name: 'A', PrimaryId: 'x', TeamNum: 0 },
      { Name: 'B', PrimaryId: 'y', TeamNum: 1 }
    ],
    Game: { PlaylistId: 13 } // Standard 3v3
  });
  assert.equal(r.playlistKey, 'p3');
});

test('rosterFrom infers 3v3 from a full six-player lobby', () => {
  const mk = (t, n) => ({ Name: 'p' + n, PrimaryId: 'id' + n, TeamNum: t });
  const r = rosterFrom({ Players: [mk(0,1), mk(0,2), mk(0,3), mk(1,4), mk(1,5), mk(1,6)], Game: {} });
  assert.equal(r.playlistKey, 'p3');
});
