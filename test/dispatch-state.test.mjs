// Unresolved sends: per-task unresolved sends keep their exact identity across task switches, selector changes,
// other tasks' sends and tray resyncs; only trusted response shapes finalize. Uses the production dispatch-state.js.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { RemoteServer } from '../server.mjs';
import { FakeCodex } from './fake-codex.mjs';
import { png } from './fixture-files.mjs';
import { DispatchBook, classifyResponse, reconcileTray, draftAfterSend, runDispatch, REPLAY_WINDOW_MS } from '../public/dispatch-state.js';

const scrypt = promisify(scryptCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = { suite: 'dispatch-state.test.mjs', startedAt: new Date().toISOString(), node: process.version, checks: [] };
const note = (name, detail = {}) => evidence.checks.push({ name, ...detail });
after(async () => {
  const dir = path.join(repo, 'work-artifacts', 'test-evidence'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `dispatch-state-${evidence.startedAt.replace(/[:.]/g, '-')}-${process.pid}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx' });
});

async function start(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'crw-dispatch-')));
  const root = path.join(base, 'projects'); await mkdir(path.join(root, 'one'), { recursive: true });
  const project = await realpath(path.join(root, 'one'));
  const salt = randomBytes(16); const hash = await scrypt('pw', salt, 32);
  const app = new FakeCodex({ project });
  const server = new RemoteServer({ bindHost: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1', allowedRoots: [root], uploadDir: path.join(base, 'data', 'uploads'), password: { salt: salt.toString('base64url'), hash: hash.toString('base64url') } }, { appServer: app });
  await server.start(); t.after(() => server.stop());
  const x = { app, server, port: server.address().port, project };
  const login = await raw(x, 'POST', '/api/login', { body: JSON.stringify({ password: 'pw' }) });
  x.auth = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.payload.csrf };
  x.thread = async () => (await raw(x, 'POST', '/api/tasks/start', { ...x.auth, body: JSON.stringify({ cwd: project }) })).payload.result.thread.id;
  return x;
}
// Same contract as app.js apiRaw(): { status, payload, json }, throws only without an HTTP answer.
function raw(x, method, url, { cookie, csrf, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body);
    const req = http.request({ hostname: '127.0.0.1', port: x.port, path: url, method, headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1', ...(payload ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let parsed = null; let json = false; try { parsed = JSON.parse(text); json = true; } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, payload: parsed, json }); });
    });
    req.on('error', reject); req.end(payload ?? undefined);
  });
}
const turnStart = (x, body) => raw(x, 'POST', '/api/turns/start', { ...x.auth, body });
const staged = async (x, threadId) => (await raw(x, 'GET', `/api/uploads?threadId=${threadId}`, x.auth)).payload.attachments;
async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('waitFor timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const quick = { delayMs: 10 };

test('only trusted structured answers finalize; gateway 5xx/52x, non-JSON and odd shapes are unknown', () => {
  const cases = {
    ok: [{ status: 200, json: true, payload: { result: { turn: { id: 't' } } } }, 'sent'],
    okWithoutResult: [{ status: 200, json: true, payload: { ok: true } }, 'unknown'],
    okHtml: [{ status: 200, json: false, payload: null }, 'unknown'],
    pending: [{ status: 202, json: true, payload: { status: 'dispatching' } }, 'pending'],
    oddAccepted: [{ status: 202, json: true, payload: {} }, 'unknown'],
    rejected: [{ status: 422, json: true, payload: { rejected: true, error: 'Codex가 요청을 거부했습니다: x' } }, 'rejected'],
    rejectedShapeless: [{ status: 422, json: true, payload: { error: 'x' } }, 'failed'],
    uncertain: [{ status: 409, json: true, payload: { uncertain: true, error: 'x' } }, 'uncertain'],
    badGateway: [{ status: 502, json: false, payload: null }, 'unknown'],
    gatewayTimeout: [{ status: 504, json: false, payload: null }, 'unknown'],
    cloudflare520: [{ status: 520, json: true, payload: { error: 'origin error' } }, 'unknown'],
    internal500: [{ status: 500, json: true, payload: { error: 'Internal server error' } }, 'unknown'],
    htmlError: [{ status: 403, json: false, payload: null }, 'unknown'],
    session: [{ status: 401, json: true, payload: { error: 'Login required' } }, 'auth'],
    network: [null, 'unknown']
  };
  for (const [name, [response, kind]] of Object.entries(cases)) assert.equal(classifyResponse(response, { firstCall: true }).kind, kind, name);
  assert.equal(classifyResponse({ status: 404, json: true, payload: { error: 'x' } }, { firstCall: true }).kind, 'failed', 'first call: structured refusal before dispatch');
  assert.equal(classifyResponse({ status: 404, json: true, payload: { error: 'x' } }, { firstCall: false }).kind, 'unknown', 'result check: server no longer knows the request');
  note('classification', Object.fromEntries(Object.entries(cases).map(([name, [, kind]]) => [name, kind])));
});

test('an attempt freezes its body; the same task cannot start another; drafts edited meanwhile survive success', async () => {
  const book = new DispatchBook();
  const entry = book.begin({ threadId: 'A', requestId: 'req-a-000000001', prompt: '원래 글', sentText: '원래 글\n', attachments: [{ id: 'F'.repeat(22), name: 'f.txt', size: 3 }], model: 'fixture-deep', effort: 'medium' });
  assert.throws(() => book.begin({ threadId: 'A', requestId: 'req-a-000000002', prompt: '새 글', sentText: '새 글' }), /unresolved send/);
  assert.throws(() => { entry.record.body = '{}'; }, TypeError); assert.throws(() => { entry.record.attachments.push({}); }, TypeError);
  book.begin({ threadId: 'B', requestId: 'req-b-000000001', prompt: 'B', sentText: 'B' });
  assert.deepEqual(JSON.parse(book.get('A').record.body), { threadId: 'A', prompt: '원래 글', attachments: ['F'.repeat(22)], model: 'fixture-deep', effort: 'medium', requestId: 'req-a-000000001' });
  assert.deepEqual([...book.protectedIds('A')], ['F'.repeat(22)]); assert.deepEqual([...book.protectedIds('B')], []);
  assert.equal(draftAfterSend('원래 글\n', '원래 글\n'), ''); assert.equal(draftAfterSend('원래 글\n추가로 고친 부분', '원래 글\n'), '원래 글\n추가로 고친 부분');
  const bodies = [];
  const result = await book.run('A', async body => { bodies.push(body); return { status: 502, json: false, payload: null }; }, { firstCall: true, ...quick });
  assert.equal(result.outcome, 'unknown'); assert.equal(book.get('A').phase, 'unresolved'); assert.equal(bodies[0], book.get('A').record.body);
  let clock = Date.now(); const timed = new DispatchBook({ now: () => clock });
  timed.begin({ threadId: 'T', requestId: 'req-t-000000001', prompt: 'x', sentText: 'x' });
  await timed.run('T', async () => { throw new Error('offline'); }, { firstCall: true, ...quick });
  clock += REPLAY_WINDOW_MS; let called = false;
  assert.equal((await timed.run('T', async () => { called = true; }, quick)).outcome, 'expired'); assert.equal(called, false, 'no replay after the server may have forgotten the requestId');
  assert.equal(timed.discard('T').requestId, 'req-t-000000001'); assert.equal(timed.get('T'), null);
});

test('tray reconciliation keeps attachments of dispatching/unresolved sends even when the staged list omits them', () => {
  const f = { key: 1, id: 'F'.repeat(22), status: 'ready', readyAt: 0 }; const g = { key: 2, id: 'G'.repeat(22), status: 'ready', readyAt: 0 };
  const uploading = { key: 3, status: 'uploading' };
  let r = reconcileTray([f, g, uploading], [], new Set([f.id]), 100);
  assert.deepEqual(r.kept, [f, uploading]); assert.deepEqual(r.dropped, [g]);
  r = reconcileTray([f], [{ id: 'H'.repeat(22), attempted: false }, { id: f.id, attempted: true }], new Set(), 100);
  assert.deepEqual(r.kept, [f]); assert.equal(f.attempted, true); assert.deepEqual(r.added.map(item => item.id), ['H'.repeat(22)]);
});

test('unresolved A (model+attachment) survives send B, selector reset, tray resync and a timed-out check; manual check confirms exactly one turn', async t => {
  const x = await start(t); const a = await x.thread(); const b = await x.thread();
  const image = png();
  const upload = await raw(x, 'POST', '/api/uploads', { ...x.auth, body: image, headers: { 'x-upload-thread': a, 'x-upload-name': encodeURIComponent('A-도식.png'), 'content-type': 'image/png' } });
  const fileId = upload.payload.attachment.id;
  const book = new DispatchBook();
  let trayA = [{ key: 1, threadId: a, id: fileId, name: 'A-도식.png', status: 'ready', readyAt: 0 }];

  // 1) A is sent with a non-default model/effort; the answer is lost while the server is still dispatching.
  let release; x.app.turnStartGate = new Promise(resolve => { release = resolve; });
  const entryA = book.begin({ threadId: a, requestId: 'dispatch-a-00001', prompt: 'A 요약', sentText: 'A 요약', attachments: [{ id: fileId, name: 'A-도식.png', size: image.length }], model: 'fixture-deep', effort: 'medium' });
  const originalBody = entryA.record.body; let inFlight;
  const first = await book.run(a, body => { inFlight = turnStart(x, body); throw new Error('response lost'); }, { firstCall: true, ...quick });
  assert.equal(first.outcome, 'unknown'); assert.equal(first.reason, 'network'); assert.equal(book.get(a).phase, 'unresolved');
  await waitFor(() => x.server.idempotency.get('dispatch-a-00001')?.status === 202);
  x.app.turnStartGate = null; // A's call stays held on the old gate; others proceed

  // 2) Reopening A while its first call is in flight: staged list omits the claimed file; the tray keeps it.
  assert.deepEqual(await staged(x, a), []);
  const synced = reconcileTray(trayA, await staged(x, a), book.protectedIds(a), Date.now());
  assert.deepEqual(synced.dropped, []); trayA = synced.kept; assert.deepEqual(trayA.map(item => item.id), [fileId]);

  // 3) Task B sends normally (default selectors); A's identity is untouched.
  book.begin({ threadId: b, requestId: 'dispatch-b-00001', prompt: 'B 질문', sentText: 'B 질문' });
  assert.equal((await book.run(b, body => turnStart(x, body), { firstCall: true, ...quick })).outcome, 'sent');
  assert.equal(book.get(a).record.body, originalBody);

  // 4) Back on A with default selectors and an edited draft: a fresh send is refused, the stored body is unchanged.
  assert.throws(() => book.begin({ threadId: a, requestId: 'dispatch-a-00002', prompt: 'A 요약 (수정)', sentText: 'A 요약 (수정)' }), /unresolved/);
  assert.equal(draftAfterSend('A 요약 (수정)', book.get(a).record.sentText), 'A 요약 (수정)', 'edited draft is kept');

  // 5) A result check while still in flight times out (bounded, 202 only) and stays unresolved.
  const bodies = [];
  const check1 = await book.run(a, body => { bodies.push(body); return turnStart(x, body); }, { attempts: 2, ...quick });
  assert.equal(check1.outcome, 'unknown'); assert.equal(check1.reason, 'timeout'); assert.equal(book.get(a).phase, 'unresolved');

  // 6) The held dispatch finishes; the manual check replays the identical body and confirms success.
  release(); assert.equal((await inFlight).status, 200);
  const check2 = await book.run(a, body => { bodies.push(body); return turnStart(x, body); }, quick);
  assert.equal(check2.outcome, 'sent'); assert.equal(book.get(a), null);
  assert.ok(bodies.every(body => body === originalBody), 'every check used the frozen body');

  const calls = x.app.calls.filter(call => call.method === 'turn/start');
  const forA = calls.filter(call => call.params.threadId === a);
  assert.equal(forA.length, 1, 'exactly one app-server turn for A'); assert.equal(calls.filter(call => call.params.threadId === b).length, 1);
  assert.equal(forA[0].params.model, 'fixture-deep'); assert.equal(forA[0].params.effort, 'medium');
  assert.match(forA[0].params.input[1].text, /A-도식\.png/); assert.equal(forA[0].params.input[2].type, 'localImage');
  const report = await waitFor(() => x.app.reports.find(value => value.threadId === a));
  assert.equal(report.images.length, 1); assert.equal(report.files[0].name, 'A-도식.png');
  // After success the sent file disappears from the staged list; reconciliation now drops it.
  assert.deepEqual(reconcileTray(trayA, await staged(x, a), book.protectedIds(a), Date.now()).dropped.map(item => item.id), [fileId]);
  note('unresolved-a-then-b', { checks: bodies.length, identicalBodies: true, appServerTurnsForA: forA.length, model: forA[0].params.model, effort: forA[0].params.effort, attachmentForwarded: true });
});

test('a 502/504/non-JSON answer to the first send stays unresolved and the real outcome is recovered later', async t => {
  const x = await start(t); const a = await x.thread(); const book = new DispatchBook();
  book.begin({ threadId: a, requestId: 'gateway-a-000001', prompt: 'gateway', sentText: 'gateway' });
  let delivered; // the request reached the server, but a proxy answered with an HTML gateway error
  const first = await book.run(a, async body => { delivered = await turnStart(x, body); return { status: 502, json: false, payload: null }; }, { firstCall: true, ...quick });
  assert.equal(delivered.status, 200); assert.equal(first.outcome, 'unknown'); assert.equal(first.reason, 'server');
  const second = await book.run(a, async () => ({ status: 504, json: false, payload: null }), quick);
  assert.equal(second.outcome, 'unknown'); assert.equal(book.get(a).phase, 'unresolved');
  const third = await book.run(a, body => turnStart(x, body), quick);
  assert.equal(third.outcome, 'sent');
  assert.equal(x.app.calls.filter(call => call.method === 'turn/start').length, 1, 'the check found the earlier turn instead of starting another');
  note('gateway-errors', { first: first.reason, second: second.outcome, recovered: third.outcome });
});

test('rejected and uncertain final answers close the attempt; runDispatch never builds a new request', async t => {
  const x = await start(t); const a = await x.thread(); const book = new DispatchBook();
  x.app.failTurns = 'rpc';
  book.begin({ threadId: a, requestId: 'final-reject-0001', prompt: 'r', sentText: 'r' });
  assert.equal((await book.run(a, body => turnStart(x, body), { firstCall: true, ...quick })).outcome, 'rejected'); assert.equal(book.get(a), null);
  x.app.failTurns = true;
  book.begin({ threadId: a, requestId: 'final-uncert-0001', prompt: 'u', sentText: 'u' });
  assert.equal((await book.run(a, body => turnStart(x, body), { firstCall: true, ...quick })).outcome, 'uncertain'); assert.equal(book.get(a), null);
  const sent = []; await runDispatch(async () => { sent.push(1); return { status: 202, json: true, payload: { status: 'dispatching' } }; }, { attempts: 3, ...quick });
  assert.equal(sent.length, 4);
});

test('app.js uses the shared dispatch book and has no global retry slot left', async () => {
  const source = await readFile(path.join(repo, 'public', 'app.js'), 'utf8');
  assert.match(source, /from '\.\/dispatch-state\.js'/);
  assert.doesNotMatch(source, /state\.(pendingSend|dispatchingThread|confirming)\b|resolveDispatch/);
  assert.match(source, /reconcileTray\(trayFor\(threadId\), data\.attachments \|\| \[\], state\.dispatch\.protectedIds\(threadId\)/);
  assert.match(source, /state\.dispatch\.run\(threadId, body => apiRaw\('\/api\/turns\/start', \{ method: 'POST', body \}\)/);
  const html = await readFile(path.join(repo, 'public', 'index.html'), 'utf8');
  assert.match(html, /id="task-title" tabindex="-1"/); assert.match(html, /id="pending-check"/);
});
