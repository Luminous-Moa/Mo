// Bridge (bridge/app-server.mjs) regressions with an in-memory fake child process: no real codex.exe is started.
// 1) stderr redaction keeps the key name (password=[redacted]) instead of a literal "$1".
// 2) a request whose write fails leaves no pending entry and no live timer; success, timeout and disconnect unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServer } from '../bridge/app-server.mjs';

// Answers every request except `silent` with { result: { echo: method } }.
function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = {
    writable: true,
    write(line) {
      const message = JSON.parse(line);
      if (message.id == null || message.method === 'silent') return true;
      setImmediate(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { echo: message.method } })}\n`)));
      return true;
    }
  };
  const spawnImpl = () => child;
  return { child, spawnImpl };
}

async function connected() {
  const { child, spawnImpl } = fakeSpawn();
  const app = new AppServer({}, { spawnImpl });
  await app.connect();
  return { app, child };
}

// Records timers the bridge creates (it uses the global setTimeout/clearTimeout) and which were cleared or fired.
// `created` lets a test prove the request timer was actually observed (if the bridge stopped using the globals,
// liveTimers 0 alone would pass vacuously).
function trackTimers(t) {
  const realSet = globalThis.setTimeout; const realClear = globalThis.clearTimeout;
  const live = new Set(); const tracker = { live, created: 0 };
  globalThis.setTimeout = (fn, ms, ...args) => { const handle = realSet(() => { live.delete(handle); fn(...args); }, ms); live.add(handle); tracker.created++; return handle; };
  globalThis.clearTimeout = handle => { live.delete(handle); return realClear(handle); };
  t.after(() => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; for (const handle of live) realClear(handle); });
  tracker.stop = () => { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear; };
  return tracker;
}

test('stderr redaction keeps the key name for password, secret and token values', async t => {
  const { app, child } = await connected();
  t.after(() => app.close());
  child.stderr.emit('data', Buffer.from('login failed password=hunter2 for user\n'));
  child.stderr.emit('data', Buffer.from('config Secret: s3cr3t-value\n'));
  child.stderr.emit('data', Buffer.from('refresh token = abc.def.ghi done\n'));
  assert.doesNotMatch(app.stderr, /\$1/, 'no literal "$1" in the redacted text');
  assert.match(app.stderr, /password=\[redacted\] for user/);
  assert.match(app.stderr, /Secret=\[redacted\]/);
  assert.match(app.stderr, /token=\[redacted\] done/);
  assert.doesNotMatch(app.stderr, /hunter2|s3cr3t-value|abc\.def\.ghi/, 'values stay hidden');
});

test('a request whose write fails rejects with the write error and leaves no pending entry or live timer', async t => {
  const { app, child } = await connected();
  t.after(() => app.close());
  const timers = trackTimers(t);
  child.stdin.writable = false;
  await assert.rejects(app.request('thread/list', {}, 60_000), /App Server input is unavailable/);
  timers.stop();
  assert.deepEqual({ createdTimers: timers.created, pending: app.pending.size, liveTimers: timers.live.size }, { createdTimers: 1, pending: 0, liveTimers: 0 },
    'the one request timer was observed and cleared, and the pending entry removed');
});

test('success, timeout and disconnect paths still settle and clean up as before', async t => {
  const { app } = await connected();
  t.after(() => app.close()); // also clears the 60 s request below if an assertion fails first
  assert.deepEqual(await app.request('thread/read', {}), { echo: 'thread/read' });
  assert.equal(app.pending.size, 0);
  await assert.rejects(app.request('silent', {}, 20), /silent timed out/);
  assert.equal(app.pending.size, 0);
  const waiting = app.request('silent', {}, 60_000);
  waiting.catch(() => {}); // asserted below; avoids an unhandled rejection if an earlier assertion fails
  assert.equal(app.pending.size, 1);
  app.close();
  await assert.rejects(waiting, /App Server stopped/);
  assert.equal(app.pending.size, 0);
  await assert.rejects(app.request('thread/read', {}), /App Server is unavailable/);
});
