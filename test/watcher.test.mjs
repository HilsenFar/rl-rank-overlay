import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createWatcher } from '../src/lib/watcher.mjs';

function listen(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: 'http://127.0.0.1:' + srv.address().port }));
  });
}
const close = srv => new Promise(r => srv.close(() => r()));

test('a network failure after an earlier HTTP error still backs off', async () => {
  const { srv, url } = await listen((req, res) => { res.writeHead(503); res.end(); });
  const w = createWatcher({ url, log: () => {} });
  await assert.rejects(w.getRanks(['Epic|a|0']), /HTTP 503/);
  assert.equal(w.available(), false);

  await close(srv);                       // the port now refuses connections
  const realNow = Date.now;
  Date.now = () => realNow() + 61e3;      // step past the 60 s backoff
  try {
    assert.equal(w.available(), true);
    await assert.rejects(w.getRanks(['Epic|a|0']));
    const s = w.status();
    assert.equal(w.available(), false, 'connection refused must start a new backoff');
    assert.ok(s.downUntil > Date.now(), 'downUntil is set');
    assert.notEqual(s.lastError, 'HTTP 503', 'lastError names the real failure');
  } finally {
    Date.now = realNow;
  }
});

test('connection refused as the first failure backs off', async () => {
  const { srv, url } = await listen((req, res) => { res.writeHead(200); res.end('{}'); });
  await close(srv);
  const w = createWatcher({ url, log: () => {} });
  await assert.rejects(w.getRanks(['Epic|a|0']));
  assert.equal(w.available(), false);
  assert.ok(w.status().downUntil > Date.now());
});

test('a good answer maps pids and clears the error', async () => {
  const { srv, url } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ranks: { 'Epic|a|0': { p2: { label: 'Gold I', division: 1, mmr: 700, tier: 7 } } } }));
  });
  const w = createWatcher({ url, log: () => {} });
  const r = await w.getRanks(['Epic|a|0', 'Epic|b|0']);
  assert.equal(r['Epic|a|0'].p2.label, 'Gold I');
  assert.equal(r['Epic|b|0'], null);
  assert.equal(w.status().lookups, 1);
  assert.equal(w.status().lastError, null);
  await close(srv);
});
