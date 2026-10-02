// Bridge (bridge/app-server.mjs) regressions with an in-memory fake child process: no real codex.exe is started.
// 1) stderr redaction keeps the key name (password=[redacted]) instead of a literal "$1".
// 2) a request whose write fails leaves no pending entry and no live timer; success, timeout and disconnect unchanged.
// 3) an asynchronous write error on the App Server's stdin (EPIPE after it died) disconnects instead of crashing.
// 4) stderr redaction still holds when a secret or a UTF-8 character is split across chunks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { AppServer } from '../bridge/app-server.mjs';

// Answers every request except `silent` with { result: { echo: method } }.
function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write(line) {
      const message = JSON.parse(line);
      if (message.id == null || message.method === 'silent') return true;
      setImmediate(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { echo: message.method } })}\n`)));
      return true;
    }
  });
  const spawnImpl = () => child;
  return { child, spawnImpl };
}

// stdin is a real Writable: after breakPipe() every write fails the way a pipe to an exited process does (the
// error arrives asynchronously, while `writable` is still true when the bridge checks it).
function brokenPipeSpawn() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; };
  let broken = false;
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      if (broken) return callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' }));
      const message = JSON.parse(String(chunk));
      if (message.method === 'initialize') setImmediate(() => child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`));
      callback();
    }
  });
  return { child, spawnImpl: () => child, breakPipe: () => { broken = true; } };
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

test('a write error on the App Server input disconnects the bridge instead of crashing the process', async t => {
  const { child, spawnImpl, breakPipe } = brokenPipeSpawn();
  const app = new AppServer({}, { spawnImpl });
  await app.connect();
  t.after(() => app.close());
  const statuses = []; app.on('status', status => statuses.push(status));
  breakPipe();
  // Accepted by the stream (writable is still true), so only the asynchronous 'error' can report the failure.
  await assert.rejects(app.request('thread/list', {}, 5_000), /App Server input closed \(EPIPE\)/);
  assert.deepEqual({ connected: app.connected, pending: app.pending.size, killed: child.killed, statuses: statuses.map(status => status.connected) },
    { connected: false, pending: 0, killed: true, statuses: [false] });
  assert.match(statuses[0].error, /^App Server input closed \(EPIPE\)/);
  await assert.rejects(app.request('thread/read', {}), /App Server is unavailable/);
  // The exit that follows the broken pipe is the same disconnect: no second status.
  child.emit('exit', 3, null);
  assert.equal(statuses.length, 1, 'exactly one disconnect status');
});

test('stderr redaction holds when a secret or a UTF-8 character is split across chunks', async () => {
  const { app, child } = await connected();
  const statuses = []; app.on('status', status => statuses.push(status));
  const korean = Buffer.from('한글 오류\n');
  for (const piece of [
    Buffer.from('login failed pass'), Buffer.from('word=hun'), Buffer.from('ter2 for user\nrefresh tok'), Buffer.from('en = abc.'),
    Buffer.from('def.ghi done\n'), korean.subarray(0, 1), korean.subarray(1),
    Buffer.from('last secret: s3cr'), Buffer.from('et-value') // no newline before the disconnect
  ]) child.stderr.emit('data', piece);
  app.close();
  const report = statuses.find(status => !status.connected)?.error || '';
  assert.match(report, /^App Server stopped: /);
  assert.match(report, /password=\[redacted\] for user/);
  assert.match(report, /token=\[redacted\] done/);
  assert.match(report, /한글 오류/);
  assert.match(report, /secret=\[redacted\]$/, 'the unterminated last line is redacted and reported at the disconnect');
  assert.doesNotMatch(report, /hun|ter2|abc|def\.ghi|s3cr|et-value|�/, 'no part of a value and no broken character');
});

test('an over-long stderr line keeps only its redacted head, even when the cut falls inside a key or value', async () => {
  // Each line is longer than the 4096-character pending-line limit before its newline arrives in a later chunk.
  for (const pieces of [
    ['x'.repeat(4090) + 'token=ab', 'cdef\n'], // cut inside the value
    ['y'.repeat(4094) + 'tok', 'en=VALUE\n'], // cut inside the key
    ['z'.repeat(3000), 'z'.repeat(3000) + 'secret=PART', 'TWO\n'] // over the limit only after several chunks
  ]) {
    const { app, child } = await connected();
    const statuses = []; app.on('status', status => statuses.push(status));
    for (const piece of [...pieces, 'next line\n']) child.stderr.emit('data', Buffer.from(piece));
    app.close();
    const report = statuses.find(status => !status.connected)?.error || '';
    assert.match(report, /next line$/, 'lines after the over-long one are kept');
    assert.doesNotMatch(report, /cdef|ab\b|VALUE|PART|TWO/, `no part of a value after the cut (${pieces[0].slice(-12)})`);
  }
});
