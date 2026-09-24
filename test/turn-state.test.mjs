// Turn lifecycle races (round 2): early interrupt, completion-before-response ordering, 202 confirmation, flattened history.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { RemoteServer } from '../server.mjs';
import { FakeCodex } from './fake-codex.mjs';
import { png } from './fixture-files.mjs';
import { parseUserContent, titleText, resolveDispatch } from '../public/ui-core.js';

const scrypt = promisify(scryptCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = { suite: 'turn-state.test.mjs', startedAt: new Date().toISOString(), node: process.version, checks: [] };
const note = (name, detail = {}) => evidence.checks.push({ name, ...detail });
after(async () => {
  const dir = path.join(repo, 'work-artifacts', 'test-evidence'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `turn-state-${evidence.startedAt.replace(/[:.]/g, '-')}-${process.pid}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx' });
});

async function start(t, fakeOptions = {}) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'crw-turn-')));
  const root = path.join(base, 'projects'); await mkdir(path.join(root, 'one'), { recursive: true });
  const project = await realpath(path.join(root, 'one'));
  const salt = randomBytes(16); const hash = await scrypt('pw', salt, 32);
  const app = new FakeCodex({ project, ...fakeOptions });
  const server = new RemoteServer({ bindHost: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1', allowedRoots: [root], uploadDir: path.join(base, 'data', 'uploads'), password: { salt: salt.toString('base64url'), hash: hash.toString('base64url') } }, { appServer: app });
  await server.start(); t.after(() => server.stop());
  const x = { app, server, port: server.address().port, project };
  const login = await send(x, 'POST', '/api/login', { body: { password: 'pw' } });
  x.auth = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.body.csrf };
  x.threadId = (await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd: project } })).body.result.thread.id;
  return x;
}
function send(x, method, url, { cookie, csrf, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body); const payload = body == null ? null : raw ? body : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: x.port, path: url, method, headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1', ...(payload ? { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'content-length': payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ } resolve({ status: res.statusCode, headers: res.headers, body: json }); });
    });
    req.on('error', reject); req.end(payload ?? undefined);
  });
}
const state = x => send(x, 'GET', '/api/state?cursor=0', x.auth);
async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('waitFor timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const turnCalls = x => x.app.calls.filter(call => call.method === 'turn/start').length;

test('interrupt works immediately after turn/start answers, before any turn/started notification', async t => {
  const x = await start(t, { stepMs: 300 });
  const r = await send(x, 'POST', '/api/turns/start', { ...x.auth, body: { threadId: x.threadId, prompt: '/fixture slow', requestId: 'early-interrupt-01' } });
  assert.equal(r.status, 200); const turnId = r.body.result.turn.id;
  const before = await state(x);
  assert.equal(before.body.activeTurns[x.threadId], turnId, 'registered from the App Server result');
  assert.equal(before.body.events.some(event => event.data?.method === 'turn/started'), false, 'turn/started has not arrived yet');
  assert.equal((await send(x, 'POST', '/api/turns/interrupt', { ...x.auth, body: { threadId: x.threadId, turnId: 'some-other-turn' } })).status, 409, 'a stale/foreign turn ID is refused');
  assert.equal(x.app.interrupted, undefined);
  const stop = await send(x, 'POST', '/api/turns/interrupt', { ...x.auth, body: { threadId: x.threadId, turnId } });
  assert.equal(stop.status, 200);
  assert.deepEqual(x.app.calls.filter(call => call.method === 'turn/interrupt').map(call => call.params), [{ threadId: x.threadId, turnId }]);
  const ended = await waitFor(async () => (await state(x)).body.events.find(event => event.data?.method === 'turn/completed' && event.data.params.turn?.status === 'interrupted'));
  assert.equal(ended.data.params.turnId, turnId);
  assert.equal((await state(x)).body.activeTurns[x.threadId], undefined);
  note('early-interrupt', { responseToInterruptMs: 'immediate', foreignTurnId: 409, interrupt: 200, completedStatus: 'interrupted' });
});

test('a turn that completes before its start response is not resurrected, and late/old notifications cannot flip state', async t => {
  const x = await start(t);
  const original = x.app.request.bind(x.app);
  x.app.request = async (method, params) => {
    if (method !== 'turn/start') return original(method, params);
    x.app.calls.push({ method, params });
    x.app.notify('turn/started', { threadId: params.threadId, turnId: 'fast-turn', turn: { id: 'fast-turn' } });
    x.app.notify('turn/completed', { threadId: params.threadId, turnId: 'fast-turn', turn: { id: 'fast-turn', status: 'completed' } });
    return { turn: { id: 'fast-turn' } };
  };
  assert.equal((await send(x, 'POST', '/api/turns/start', { ...x.auth, body: { threadId: x.threadId, prompt: 'quick', requestId: 'fast-complete-01' } })).status, 200);
  assert.equal((await state(x)).body.activeTurns[x.threadId], undefined, 'completion seen before the response wins');
  x.app.notify('turn/started', { threadId: x.threadId, turnId: 'fast-turn', turn: { id: 'fast-turn' } });
  assert.equal((await state(x)).body.activeTurns[x.threadId], undefined, 'a reordered late turn/started does not revive it');
  assert.equal((await send(x, 'POST', '/api/turns/interrupt', { ...x.auth, body: { threadId: x.threadId } })).status, 409);
  assert.equal(x.app.calls.some(call => call.method === 'turn/interrupt'), false);

  x.app.notify('turn/started', { threadId: x.threadId, turnId: 'new-turn', turn: { id: 'new-turn' } });
  x.app.notify('turn/completed', { threadId: x.threadId, turnId: 'older-turn', turn: { id: 'older-turn', status: 'completed' } });
  assert.equal((await state(x)).body.activeTurns[x.threadId], 'new-turn', 'completion of an older turn leaves the newer one active');
  note('completion-ordering', { completedBeforeResponse: 'not active', lateStarted: 'ignored', olderCompletion: 'ignored' });
});

test('202 dispatching is not success: replaying the identical request resolves to the real final outcome', async t => {
  for (const [name, finish, expected] of [['success', () => {}, 'sent'], ['rejected', x => { x.app.failTurns = 'rpc'; }, 'rejected'], ['uncertain', x => { x.app.failTurns = true; }, 'uncertain']]) {
    const x = await start(t);
    const data = Buffer.from(`${name} attachment`);
    const upload = await send(x, 'POST', '/api/uploads', { ...x.auth, body: data, headers: { 'x-upload-thread': x.threadId, 'x-upload-name': encodeURIComponent(`${name}.txt`), 'content-type': 'text/plain' } });
    assert.equal(upload.status, 201);
    const body = { threadId: x.threadId, prompt: `${name} prompt`, attachments: [upload.body.attachment.id], requestId: `pending-202-${name}` };
    let release; x.app.turnStartGate = new Promise(resolve => { release = resolve; });
    const first = send(x, 'POST', '/api/turns/start', { ...x.auth, body }); // this answer is "lost" by the client
    await waitFor(() => turnCalls(x) === 1 && x.server.idempotency.get(body.requestId)?.status === 202);
    const statuses = [];
    const result = await resolveDispatch(async () => { const r = await send(x, 'POST', '/api/turns/start', { ...x.auth, body }); statuses.push(r.status); return { status: r.status, payload: r.body }; }, {
      attempts: 20, delayMs: 20, onPending: attempt => { if (attempt === 1) { finish(x); x.app.turnStartGate = null; release(); } }
    });
    await first;
    assert.equal(statuses[0], 202, 'the replay first sees the in-flight dispatch');
    assert.equal(result.outcome, expected, name);
    assert.equal(turnCalls(x), 1, 'replays never dispatch a second turn');
    const listed = (await send(x, 'GET', `/api/uploads?threadId=${x.threadId}`, x.auth)).body.attachments;
    if (expected === 'sent') assert.deepEqual(listed, []);
    else assert.deepEqual(listed.map(item => item.attempted), [expected === 'uncertain'], 'attachment stays available; attempted only when uncertain');
    note(`pending-202-${name}`, { statuses, outcome: result.outcome, turnStartCalls: turnCalls(x) });
  }
});

test('history flattened with join("") (no separator) renders prompt text, chips and a clean task title', async t => {
  const x = await start(t, { mergeHistory: true });
  const upload = await send(x, 'POST', '/api/uploads', { ...x.auth, body: png(), headers: { 'x-upload-thread': x.threadId, 'x-upload-name': encodeURIComponent('도식.png'), 'content-type': 'image/png' } });
  const prompt = '이 그림 설명해줘 [참고] <i>원문</i>';
  assert.equal((await send(x, 'POST', '/api/turns/start', { ...x.auth, body: { threadId: x.threadId, prompt, attachments: [upload.body.attachment.id], requestId: 'join-history-001' } })).status, 200);
  await waitFor(() => x.app.reports[0]);
  // History now comes from the paged /api/tasks/turns (thread/turns/list), not a full thread/read.
  const read = await send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: x.threadId } });
  const user = read.body.turns[0].items.find(item => item.type === 'userMessage');
  assert.ok(user.content[0].text.startsWith(`${prompt}[Codex 원격 웹 첨부 파일 1개]`), 'glued with no separator');
  const view = parseUserContent(user.content);
  assert.deepEqual(view.texts, [prompt]); assert.deepEqual(view.files.map(file => file.name), ['도식.png']);
  assert.doesNotMatch(JSON.stringify(view), /경로|uploads/);
  const task = (await send(x, 'GET', '/api/tasks', x.auth)).body.tasks.find(value => value.id === x.threadId);
  assert.match(task.preview, /\[Codex 원격 웹 첨부 파일 1개\]/);
  assert.equal(titleText(task.name || task.preview), prompt);
  note('join-history', { texts: view.texts, files: view.files.map(file => file.name), title: titleText(task.preview) });
});
