// Desktop-started tasks in the web panel: resumeRoots scope, recency-ordered paged listing, open/resume by ID,
// single-writer lock handling (409), bridge oversize handling (H5) and sanitized logging of unexpected errors (M3).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, realpath, symlink, writeFile, readFile } from 'node:fs/promises';
import { parseUserContent } from '../public/ui-core.js';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { RemoteServer, sanitizeForLog } from '../server.mjs';
import { AppServer } from '../bridge/app-server.mjs';
import { FakeCodex } from './fake-codex.mjs';

const scrypt = promisify(scryptCallback);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = { suite: 'task-scope.test.mjs', startedAt: new Date().toISOString(), node: process.version, platform: process.platform, checks: [] };
const note = (name, detail = {}) => evidence.checks.push({ name, ...detail });
after(async () => {
  const dir = path.join(repo, 'work-artifacts', 'test-evidence'); await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `task-scope-${evidence.startedAt.replace(/[:.]/g, '-')}-${process.pid}.json`), JSON.stringify(evidence, null, 2), { flag: 'wx' });
});

const TASK_KEYS = ['cwd', 'folderMissing', 'id', 'location', 'lock', 'name', 'preview', 'protected', 'status', 'updatedAt'].sort();

// Layout (all under a fresh temp dir):
//   projects\one            allowedRoots direct child (project)
//   projects\one\sub        deeper than a project: not a project, not in scope without resumeRoots
//   c\Codex                 resume root A (root itself may hold a task)
//   c\Codex\2026-09-22\new-chat, c\Codex\2026-09-23\other, c\Codex\2026-09-22\new-chat\deep\er
//   Documents\Codex         resume root B (same basename as A → labels must differ)
//   Documents\Codex\2026-09-17\gone   (never created: missing folder)
//   outside\x               outside every root
//   c\Codex\link -> outside (junction): c\Codex\link\x must stay out of scope
async function layout() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'crw-scope-')));
  const dirs = {
    base, projects: path.join(base, 'projects'), one: path.join(base, 'projects', 'one'), sub: path.join(base, 'projects', 'one', 'sub'),
    rootA: path.join(base, 'c', 'Codex'), dated: path.join(base, 'c', 'Codex', '2026-09-22', 'new-chat'), other: path.join(base, 'c', 'Codex', '2026-09-23', 'other'),
    deep: path.join(base, 'c', 'Codex', '2026-09-22', 'new-chat', 'deep', 'er'), rootB: path.join(base, 'Documents', 'Codex'),
    gone: path.join(base, 'Documents', 'Codex', '2026-09-17', 'gone'), outside: path.join(base, 'outside', 'x'), link: path.join(base, 'c', 'Codex', 'link'),
    codexHome: path.join(base, 'codex-home')
  };
  for (const key of ['one', 'sub', 'dated', 'other', 'deep', 'rootB', 'outside', 'codexHome']) await mkdir(dirs[key], { recursive: true });
  await symlink(path.dirname(dirs.outside), dirs.link, 'junction');
  return dirs;
}

async function start(t, dirs, { resumeRoots, threads = [], runtimeDir, uploadDir } = {}) {
  const salt = randomBytes(16); const hash = await scrypt('pw', salt, 32);
  const app = new FakeCodex({ project: dirs.one });
  for (const thread of threads) app.threads.set(thread.id, { name: '', active: false, turns: [], ...thread });
  const config = { bindHost: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1', allowedRoots: [dirs.projects], codexHome: dirs.codexHome, password: { salt: salt.toString('base64url'), hash: hash.toString('base64url') } };
  if (resumeRoots !== undefined) config.resumeRoots = resumeRoots;
  if (uploadDir) config.uploadDir = uploadDir;
  const server = new RemoteServer(config, { appServer: app, runtimeDir });
  await server.start(); t.after(() => server.stop());
  const x = { app, server, port: server.address().port, dirs };
  const login = await send(x, 'POST', '/api/login', { body: { password: 'pw' } });
  x.auth = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.body.csrf };
  return x;
}
function send(x, method, url, { cookie, csrf, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: x.port, path: url, method, headers: { Host: '127.0.0.1', Origin: 'http://127.0.0.1', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* none */ } resolve({ status: res.statusCode, headers: res.headers, body: json }); });
    });
    req.on('error', reject); req.end(payload ?? undefined);
  });
}
const tasks = x => send(x, 'GET', '/api/tasks', x.auth);
const read = (x, threadId) => send(x, 'POST', '/api/tasks/read', { ...x.auth, body: { threadId } });
const resume = (x, threadId) => send(x, 'POST', '/api/tasks/resume', { ...x.auth, body: { threadId } });
const resumeCalls = x => x.app.calls.filter(call => call.method === 'thread/resume').length;
async function waitFor(check, timeout = 2000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw new Error('waitFor timed out'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
// Captures process.stderr writes made while fn runs.
async function captureStderr(fn) {
  const original = process.stderr.write; const lines = [];
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  try { await fn(); } finally { process.stderr.write = original; }
  return lines.join('');
}

// Timestamps: creation order deliberately differs from activity order.
function scenario(dirs) {
  return [
    { id: 'proj-old-activity', cwd: dirs.one, createdAt: 900, updatedAt: 1000, recencyAt: 1000 },
    { id: 'proj-new-activity', cwd: dirs.one, createdAt: 100, updatedAt: 5000, recencyAt: 5000, preview: 'x'.repeat(1000) },
    { id: 'proj-sub', cwd: dirs.sub, createdAt: 800, updatedAt: 4000, recencyAt: 4000 },
    { id: 'dated', cwd: `\\\\?\\${dirs.dated}`, createdAt: 700, updatedAt: 4500, recencyAt: 4500, name: '데스크톱 날짜 폴더 작업' },
    { id: 'deep', cwd: dirs.deep, createdAt: 600, updatedAt: 3000, recencyAt: 3000 },
    { id: 'root-itself', cwd: dirs.rootA, createdAt: 500, updatedAt: 2500, recencyAt: 2500 },
    { id: 'gone', cwd: dirs.gone, createdAt: 400, updatedAt: 2000, recencyAt: 2000 },
    { id: 'outside', cwd: dirs.outside, createdAt: 300, updatedAt: 6000, recencyAt: 6000 },
    { id: 'junction-escape', cwd: path.join(dirs.link, 'x'), createdAt: 200, updatedAt: 5500, recencyAt: 5500 },
    { id: 'relative', cwd: 'relative\\path', createdAt: 150, updatedAt: 5600, recencyAt: 5600 }
  ];
}

test('without resumeRoots the scope is unchanged: only direct project children, now newest activity first with trimmed fields', async t => {
  const dirs = await layout(); const x = await start(t, dirs, { threads: scenario(dirs) });
  const r = await tasks(x); assert.equal(r.status, 200);
  assert.deepEqual(r.body.tasks.map(task => task.id), ['proj-new-activity', 'proj-old-activity']);
  assert.equal(r.body.truncated, false); assert.equal(r.body.limit, 100);
  for (const task of r.body.tasks) assert.deepEqual(Object.keys(task).sort(), TASK_KEYS);
  const top = r.body.tasks[0];
  assert.equal(top.location, 'one'); assert.equal(top.cwd, dirs.one); assert.equal(top.folderMissing, false); assert.equal(top.preview.length, 240); assert.equal(top.updatedAt, 5000);
  assert.doesNotMatch(JSON.stringify(r.body), /fake-codex-home|gitInfo|"source"|"turns"/);
  const call = x.app.calls.find(value => value.method === 'thread/list');
  assert.deepEqual(call.params, { limit: 50, sortKey: 'recency_at', sortDirection: 'desc', useStateDbOnly: true });
  // Deeper, date-folder and outside tasks stay closed exactly as before.
  for (const id of ['proj-sub', 'dated', 'outside', 'gone']) { assert.equal((await read(x, id)).status, 403, id); assert.equal((await resume(x, id)).status, 403, id); }
  assert.equal(resumeCalls(x), 0);
  note('compat-without-resumeRoots', { listed: r.body.tasks.map(task => task.id), listParams: call.params });
});

test('resumeRoots: any depth and the root itself are listed with distinguishable locations; outside, junction escapes and relative cwds are not', async t => {
  const dirs = await layout(); const x = await start(t, dirs, { resumeRoots: [dirs.rootA, dirs.rootB], threads: scenario(dirs) });
  const r = await tasks(x); assert.equal(r.status, 200);
  assert.deepEqual(r.body.tasks.map(task => task.id), ['proj-new-activity', 'dated', 'deep', 'root-itself', 'gone', 'proj-old-activity']);
  const byId = Object.fromEntries(r.body.tasks.map(task => [task.id, task]));
  const sep = path.sep;
  assert.equal(byId['proj-new-activity'].location, 'one');
  assert.equal(byId.dated.location, `c${sep}Codex${sep}2026-09-22${sep}new-chat`); assert.equal(byId.dated.cwd, dirs.dated); assert.equal(byId.dated.name, '데스크톱 날짜 폴더 작업');
  assert.equal(byId.deep.location, `c${sep}Codex${sep}2026-09-22${sep}new-chat${sep}deep${sep}er`);
  assert.equal(byId['root-itself'].location, `c${sep}Codex`);
  assert.equal(byId.gone.location, `Documents${sep}Codex${sep}2026-09-17${sep}gone`); assert.equal(byId.gone.folderMissing, true);
  // proj-sub sits under projects\, which is not a resume root: still hidden.
  assert.equal(byId['proj-sub'], undefined);
  note('resumeRoots-listing', { listed: r.body.tasks.map(task => [task.id, task.location, task.folderMissing]) });
});

test('opening and resuming are judged by the thread cwd itself: works beyond the listed page, 403 outside, 404 unknown, missing folder is view-only', async t => {
  const dirs = await layout();
  // 130 newer in-scope tasks push "old-dated" far past the 100-item list cap.
  const threads = [{ id: 'old-dated', cwd: dirs.other, createdAt: 1, updatedAt: 1, recencyAt: 1 }, ...scenario(dirs)];
  for (let i = 0; i < 130; i++) threads.push({ id: `bulk-${i}`, cwd: dirs.dated, createdAt: 10_000 + i, updatedAt: 10_000 + i, recencyAt: 10_000 + i });
  const x = await start(t, dirs, { resumeRoots: [dirs.rootA, dirs.rootB], threads });
  const list = await tasks(x);
  assert.equal(list.body.tasks.some(task => task.id === 'old-dated'), false);
  let r = await read(x, 'old-dated'); assert.equal(r.status, 200);
  assert.equal(r.body.access.location, `c${path.sep}Codex${path.sep}2026-09-23${path.sep}other`); assert.equal(r.body.access.folderMissing, false); assert.equal(r.body.result.thread.id, 'old-dated');
  r = await resume(x, 'old-dated'); assert.equal(r.status, 200);
  assert.equal(x.server.threadProjects.get('old-dated'), dirs.other); assert.ok(x.server.controlledThreads.has('old-dated'));
  for (const id of ['outside', 'junction-escape', 'relative']) {
    r = await read(x, id); assert.equal(r.status, 403, id); assert.equal(r.body.result, undefined, `${id} history must not leak`);
    r = await resume(x, id); assert.equal(r.status, 403, id);
  }
  const readsBefore = x.app.calls.filter(call => call.method === 'thread/read').length;
  for (const bad of ['..\\..\\secret', 'a/b', 'x'.repeat(129)]) { assert.equal((await read(x, bad)).status, 404, bad); assert.equal((await resume(x, bad)).status, 404, bad); }
  assert.equal(x.app.calls.filter(call => call.method === 'thread/read').length, readsBefore, 'malformed IDs never reach Codex');
  r = await read(x, 'no-such-thread'); assert.equal(r.status, 404);
  r = await resume(x, 'no-such-thread'); assert.equal(r.status, 404);
  r = await read(x, 'gone'); assert.equal(r.status, 200); assert.equal(r.body.access.folderMissing, true);
  const before = resumeCalls(x);
  r = await resume(x, 'gone'); assert.equal(r.status, 409); assert.equal(r.body.code, 'thread_folder_missing'); assert.match(r.body.error, /폴더/);
  assert.equal(resumeCalls(x), before, 'no thread/resume for a missing folder');
  r = await resume(x, ''); assert.equal(r.status, 400);
  note('open-resume-by-id', { beyondListCap: 'old-dated', outside403: ['outside', 'junction-escape', 'relative'], unknown404: true, missingFolder: '409 thread_folder_missing' });
});

test('a thread locked by another Codex process answers 409 with the guidance (not 500), stays uncontrolled, and resumes once released', async t => {
  const dirs = await layout(); const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads: scenario(dirs) });
  x.app.lockedThreads.add('dated');
  let r; const log = await captureStderr(async () => { r = await resume(x, 'dated'); });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'thread_locked');
  assert.equal(r.body.error, '이 작업은 다른 Codex 프로세스(데스크톱 앱 등)가 사용 중입니다. 데스크톱 앱을 트레이까지 완전히 종료한 뒤 다시 시도하세요.');
  assert.equal(log, '', 'an expected lock refusal is not logged as an unexpected error');
  assert.equal(x.server.controlledThreads.has('dated'), false); assert.equal(x.server.threadProjects.has('dated'), false);
  const turn = await send(x, 'POST', '/api/turns/start', { ...x.auth, body: { threadId: 'dated', prompt: 'hi', requestId: 'locked-turn-0001' } });
  assert.equal(turn.status, 409); assert.equal(x.app.calls.filter(call => call.method === 'turn/start').length, 0);
  const state = await send(x, 'GET', '/api/state?cursor=0', x.auth);
  assert.ok(state.body.events.some(event => event.type === 'resumeBlocked' && event.data.threadId === 'dated'));
  x.app.lockedThreads.delete('dated');
  r = await resume(x, 'dated'); assert.equal(r.status, 200); assert.ok(x.server.controlledThreads.has('dated'));
  // Any other JSON-RPC refusal of thread/resume is a definitive 422, not a generic 500.
  x.app.request = (orig => async (method, params) => { if (method === 'thread/resume') throw Object.assign(new Error('rollout is unreadable'), { rpcError: true, code: -32603 }); return orig(method, params); })(x.app.request.bind(x.app));
  r = await resume(x, 'deep'); assert.equal(r.status, 422); assert.equal(r.body.code, 'resume_rejected'); assert.match(r.body.error, /rollout is unreadable/);
  note('active-writer-409', { status: 409, code: 'thread_locked', releasedThenResumed: true, otherRpcRefusal: 422 });
});

test('approvals of a resumed resume-root task are limited to its own cwd; new tasks still start only in direct project folders', async t => {
  const dirs = await layout(); const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads: scenario(dirs) });
  assert.equal((await resume(x, 'dated')).status, 200);
  const ask = (id, cwd) => { x.app.incoming.set(id, { id }); x.app.emit('serverRequest', { id, method: 'item/commandExecution/requestApproval', params: { threadId: 'dated', command: 'dir', cwd } }); };
  ask('inside', dirs.deep);
  await waitFor(() => x.server.pendingApprovals.has('inside'));
  ask('sibling', dirs.other);
  const blocked = await waitFor(async () => (await send(x, 'GET', '/api/state?cursor=0', x.auth)).body.events.find(event => event.type === 'blockedApproval' && event.data.id === 'sibling'));
  assert.equal(blocked.data.reason, 'outside allowed project'); assert.equal(x.server.pendingApprovals.has('sibling'), false);
  // Starting new work is unchanged: resume roots are not project roots.
  for (const cwd of [dirs.dated, dirs.rootA, dirs.sub]) assert.equal((await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd } })).status, 403, cwd);
  assert.equal((await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd: dirs.one } })).status, 200);
  const projects = await send(x, 'GET', '/api/projects', x.auth);
  assert.deepEqual(projects.body.projects.map(project => project.name), ['one']);
  note('approval-and-start-scope', { insideApproval: 'pending', siblingApproval: 'blocked', startOutsideProjects: 403 });
});

test('the panel runtime folder and upload store are protected: overlapping cwds are listed and readable but resume is 409; siblings resume', async t => {
  const dirs = await layout();
  const web = path.join(dirs.rootA, 'Apps', 'CodexRemoteWeb'); const runtimeDir = path.join(web, 'data'); const uploadDir = path.join(web, 'uploads-store');
  const sibling = path.join(dirs.rootA, 'Apps', 'Other');
  for (const dir of [path.join(runtimeDir, 'sub'), sibling]) await mkdir(dir, { recursive: true });
  const threads = [
    { id: 'root-itself', cwd: dirs.rootA, updatedAt: 90, turns: [{ id: 'turn-a', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '루트 작업' }] }] }] },
    { id: 'apps-ancestor', cwd: path.join(dirs.rootA, 'Apps'), updatedAt: 80 },
    { id: 'same-data', cwd: runtimeDir, updatedAt: 70 },
    { id: 'in-data', cwd: path.join(runtimeDir, 'sub'), updatedAt: 60 },
    { id: 'in-uploads', cwd: path.join(uploadDir, 'files'), updatedAt: 50 },
    { id: 'sibling', cwd: sibling, updatedAt: 40 },
    { id: 'dated', cwd: dirs.dated, updatedAt: 30 }
  ];
  const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads, runtimeDir, uploadDir });
  const list = await tasks(x);
  const flags = Object.fromEntries(list.body.tasks.map(task => [task.id, task.protected]));
  assert.deepEqual(flags, { 'root-itself': true, 'apps-ancestor': true, 'same-data': true, 'in-data': true, 'in-uploads': true, sibling: false, dated: false });
  const read = await send(x, 'POST', '/api/tasks/read', { ...x.auth, body: { threadId: 'root-itself' } });
  assert.equal(read.status, 200); assert.equal(read.body.access.protected, true);
  const history = await send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'root-itself' } });
  assert.equal(history.status, 200); assert.equal(history.body.turns.length, 1, 'protected tasks stay viewable');
  for (const id of ['root-itself', 'apps-ancestor', 'same-data', 'in-data', 'in-uploads']) {
    const r = await resume(x, id);
    assert.equal(r.status, 409, id); assert.equal(r.body.code, 'thread_scope_protected', id);
    assert.equal(r.body.error, '이 작업 폴더는 웹 패널의 운영 데이터 폴더를 포함하거나 그 안에 있어 웹에서 이어갈 수 없습니다. 데스크톱 앱에서 이어가세요.');
  }
  assert.equal(resumeCalls(x), 0, 'protected tasks never reach thread/resume');
  assert.equal(x.server.controlledThreads.size, 0);
  assert.equal((await resume(x, 'sibling')).status, 200); assert.equal((await resume(x, 'dated')).status, 200);
  assert.equal(resumeCalls(x), 2);
  note('protected-runtime-folders', { protectedIds: Object.keys(flags).filter(id => flags[id]), allowedSiblings: ['sibling', 'dated'], readAllowed: true, resume409: 'thread_scope_protected' });
});

test('protection applies without resumeRoots and to approvals: a project containing the (not yet created) runtime folder is view-only, and approvals inside it are refused', async t => {
  const dirs = await layout();
  const runtimeDir = path.join(dirs.one, 'runtime-data');
  const x = await start(t, dirs, { threads: [{ id: 'proj', cwd: dirs.one, updatedAt: 10 }], runtimeDir });
  const list = await tasks(x);
  assert.equal(list.body.tasks[0].protected, true, 'judged by nearest existing ancestor while the folder is missing');
  let r = await resume(x, 'proj'); assert.equal(r.status, 409); assert.equal(r.body.code, 'thread_scope_protected');
  // New tasks keep their unchanged scope; approvals inside the protected folder are refused, the rest of the project is not.
  await mkdir(path.join(runtimeDir, 'x'), { recursive: true });
  r = await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd: dirs.one } }); assert.equal(r.status, 200);
  const threadId = r.body.result.thread.id;
  const ask = (id, cwd) => { x.app.incoming.set(id, { id }); x.app.emit('serverRequest', { id, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'dir', cwd } }); };
  ask('in-protected', path.join(runtimeDir, 'x'));
  const blocked = await waitFor(async () => (await send(x, 'GET', '/api/state?cursor=0', x.auth)).body.events.find(event => event.type === 'blockedApproval' && event.data.id === 'in-protected'));
  assert.equal(blocked.data.reason, 'protected folder'); assert.equal(x.server.pendingApprovals.has('in-protected'), false);
  ask('in-project', dirs.sub);
  await waitFor(() => x.server.pendingApprovals.has('in-project'));
  assert.throws(() => new RemoteServer({ bindHost: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1', allowedRoots: [] }, { appServer: new FakeCodex(), runtimeDir: 'relative' }), /runtimeDir/);
  note('protected-approvals', { withoutResumeRoots: 'resume 409', approvalInsideProtected: 'blocked (protected folder)', approvalElsewhereInProject: 'pending' });
});

test('listing follows pages, removes duplicates, and stops at the item cap, the page cap and cursor loops', async t => {
  const dirs = await layout();
  const threads = [];
  for (let i = 0; i < 130; i++) threads.push({ id: `t-${String(i).padStart(3, '0')}`, cwd: dirs.dated, createdAt: i, updatedAt: 1000 + i, recencyAt: 1000 + i });
  const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads });
  let r = await tasks(x);
  assert.equal(r.body.tasks.length, 100); assert.equal(r.body.truncated, true); assert.equal(r.body.truncatedReason, 'items');
  assert.equal(r.body.tasks[0].id, 't-129'); assert.equal(r.body.tasks[99].id, 't-030');
  const listCalls = () => x.app.calls.filter(call => call.method === 'thread/list');
  assert.deepEqual(listCalls().map(call => call.params.cursor ?? null), [null, 'page-50', 'page-100']);
  note('item-cap', { returned: 100, pagesRequested: 3 });

  // Page cap: nothing in scope, many pages → at most 6 requests, reported as truncated.
  x.app.calls.length = 0;
  x.app.listHook = params => { const n = Number(String(params.cursor || 'c-0').split('-')[1]); return { data: [{ id: `o-${n}`, cwd: dirs.outside, updatedAt: 1 }], nextCursor: `c-${n + 1}` }; };
  r = await tasks(x); assert.equal(r.body.tasks.length, 0); assert.equal(r.body.truncated, true); assert.equal(listCalls().length, 6);
  assert.equal(r.body.truncatedReason, 'pages'); assert.equal(r.body.scanLimit, 300);

  // Cursor loop and duplicate threads across pages (observed from the scan-and-repair listing).
  x.app.calls.length = 0;
  x.app.listHook = () => ({ data: [{ id: 'dup', cwd: dirs.dated, updatedAt: 5, recencyAt: 5 }, { id: 'dup', cwd: dirs.dated, updatedAt: 5, recencyAt: 5 }], nextCursor: 'same' });
  r = await tasks(x); assert.deepEqual(r.body.tasks.map(task => task.id), ['dup']); assert.equal(listCalls().length, 2);
  assert.equal(r.body.truncated, false); assert.equal(r.body.truncatedReason, null);

  // Empty state DB → one scan-and-repair listing.
  x.app.calls.length = 0;
  x.app.listHook = params => params.useStateDbOnly ? { data: [], nextCursor: null } : { data: [{ id: 'from-scan', cwd: dirs.dated, updatedAt: 9 }], nextCursor: null };
  r = await tasks(x); assert.deepEqual(r.body.tasks.map(task => task.id), ['from-scan']);
  assert.deepEqual(listCalls().map(call => Boolean(call.params.useStateDbOnly)), [true, false]);
  note('page-cap-loop-dedupe-fallback', { pageCapRequests: 6, loopRequests: 2, emptyStateDbFallsBackToScan: true });
});

test('unexpected failures are logged to stderr in one sanitized line and answered 500; oversized Codex answers become 502', async t => {
  const dirs = await layout(); const x = await start(t, dirs, { resumeRoots: [dirs.rootA] });
  x.app.listHook = () => { throw new Error('boom token=abc123 password: hunter2\nsecond line sk-ABCDEFGH12345678 ' + 'Q'.repeat(64)); };
  let r; let log = await captureStderr(async () => { r = await tasks(x); });
  assert.equal(r.status, 500); assert.equal(r.body.error, 'Internal server error');
  assert.match(log, /^\[server\] 500 GET \/api\/tasks: boom token=\[redacted\] password: \[redacted\] second line \[redacted\] \[redacted\]/);
  assert.doesNotMatch(log, /hunter2|abc123|ABCDEFGH|QQQQ/); assert.equal(log.trim().split('\n').length, 1);
  x.app.listHook = () => { throw Object.assign(new Error('thread/list response exceeded 16 characters'), { tooLarge: true }); };
  log = await captureStderr(async () => { r = await tasks(x); });
  assert.equal(r.status, 502); assert.equal(r.body.error, 'Codex response is too large'); assert.match(log, /\[server\] 502 GET \/api\/tasks/);
  assert.equal(sanitizeForLog('cookie=crw_session=abc; ok'), 'cookie=[redacted]; ok');
  note('unexpected-error-logging', { sample: log.trim() });
});

// Twelve turns t00..t11; t11 (newest) carries a big command output, a file change, an image part and a reasoning item.
const NOTICE = ['[Codex 원격 웹 첨부 파일 1개]', '사용자가 원격 웹에서 업로드한 파일입니다.', '1. memo.txt — 텍스트, 4 B', '   경로: C:\\uploads\\files\\abc.txt'].join('\n');
function historyTurns() {
  const turns = [];
  for (let i = 0; i < 12; i++) {
    const id = `t${String(i).padStart(2, '0')}`;
    const items = [{ id: `${id}-u`, type: 'userMessage', content: [{ type: 'text', text: `질문 ${i}` }] }, { id: `${id}-a`, type: 'agentMessage', text: `답변 ${i}` }];
    if (i === 11) {
      items[0].content.push({ type: 'text', text: NOTICE }, { type: 'image', url: `data:image/png;base64,${'A'.repeat(5000)}` }, { type: 'localImage', path: 'C:\\uploads\\files\\shot.png' });
      items.splice(1, 0,
        { id: `${id}-r`, type: 'reasoning', summary: ['비공개 추론'], content: ['x'.repeat(10_000)] },
        { id: `${id}-c`, type: 'commandExecution', command: 'Get-ChildItem', status: 'completed', exitCode: 0, aggregatedOutput: 'o'.repeat(30_000), cwd: 'C:\\x', processId: 'p1' },
        { id: `${id}-f`, type: 'fileChange', status: 'completed', changes: [{ path: 'src\\a.js', kind: { type: 'update' }, diff: '+a\n-b' }] });
    }
    turns.push({ id, status: 'completed', items });
  }
  return turns;
}

test('history is paged separately from the metadata read: newest 5 turns first, older pages by cursor, cards and notices intact, big outputs clipped', async t => {
  const dirs = await layout();
  const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads: [{ id: 'long', cwd: dirs.dated, updatedAt: 5, turns: historyTurns() }] });
  x.app.mergeHistory = false;
  const read = await send(x, 'POST', '/api/tasks/read', { ...x.auth, body: { threadId: 'long' } });
  assert.equal(read.status, 200);
  // The open response carries only what the UI can use (no rollout path, gitInfo, environments, turns).
  assert.deepEqual(read.body.result, { thread: { id: 'long', name: null, status: 'idle' } });
  assert.ok(x.app.calls.filter(call => call.method === 'thread/read').every(call => call.params.includeTurns === false), 'open never asks for full history');
  const page = cursor => send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'long', ...(cursor ? { cursor } : {}) } });
  const first = await page();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.turns.map(turn => turn.id), ['t07', 't08', 't09', 't10', 't11'], 'newest five, oldest→newest');
  const listCall = x.app.calls.find(call => call.method === 'thread/turns/list');
  assert.deepEqual(listCall.params, { threadId: 'long', limit: 5, itemsView: 'full', sortDirection: 'desc' });
  const newest = first.body.turns.at(-1);
  assert.deepEqual(newest.items.map(item => item.type), ['userMessage', 'commandExecution', 'fileChange', 'agentMessage'], 'only rendered kinds; reasoning dropped');
  const command = newest.items[1];
  assert.equal(command.aggregatedOutput.length < 20_100, true); assert.match(command.aggregatedOutput, /출력 30,000자 중 앞 20,000자만 표시/);
  assert.equal(command.processId, undefined); assert.equal(command.command, 'Get-ChildItem');
  assert.deepEqual(newest.items[2].changes, [{ path: 'src\\a.js', diff: '+a\n-b' }]);
  const user = newest.items[0];
  assert.doesNotMatch(JSON.stringify(user), /base64/, 'inline image data never reaches the browser');
  const view = parseUserContent(user.content);
  assert.deepEqual(view.texts, ['질문 11']); assert.deepEqual(view.files.map(file => file.name), ['memo.txt']);
  const second = await page(first.body.nextCursor);
  assert.deepEqual(second.body.turns.map(turn => turn.id), ['t02', 't03', 't04', 't05', 't06']);
  const third = await page(second.body.nextCursor);
  assert.deepEqual(third.body.turns.map(turn => turn.id), ['t00', 't01']); assert.equal(third.body.nextCursor, null);
  // Merged history (prompt + notice flattened into one part) still splits into text and chips.
  x.app.mergeHistory = true;
  const merged = parseUserContent((await page()).body.turns.at(-1).items[0].content);
  assert.deepEqual(merged.files.map(file => file.name), ['memo.txt']); assert.doesNotMatch(JSON.stringify(merged), /경로/);
  // Out-of-scope history is refused like open.
  x.app.threads.set('outside', { id: 'outside', cwd: dirs.outside, updatedAt: 1, turns: historyTurns(), active: false });
  assert.equal((await send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'outside' } })).status, 403);
  assert.equal((await send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'long', cursor: 'c'.repeat(5000) } })).status, 400);
  note('paged-history', { pages: [first.body.turns.length, second.body.turns.length, third.body.turns.length], clippedOutput: true, droppedKinds: ['reasoning'] });
});

test('an oversized history page falls back to one turn, then to a summary of that turn, and older history keeps loading', async t => {
  const dirs = await layout();
  const turns = historyTurns().slice(0, 7);
  const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads: [{ id: 'huge', cwd: dirs.dated, updatedAt: 5, turns }] });
  x.app.oversizedTurns.add('t05');
  const page = cursor => send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'huge', ...(cursor ? { cursor } : {}) } });
  const a = await page();
  assert.equal(a.status, 200); assert.deepEqual(a.body.turns.map(turn => [turn.id, Boolean(turn.partial)]), [['t06', false]]);
  const b = await page(a.body.nextCursor);
  assert.deepEqual(b.body.turns.map(turn => [turn.id, Boolean(turn.partial)]), [['t05', true]]);
  assert.deepEqual(b.body.turns[0].items.map(item => item.type), ['userMessage', 'agentMessage']);
  const c = await page(b.body.nextCursor);
  assert.deepEqual(c.body.turns.map(turn => turn.id), ['t00', 't01', 't02', 't03', 't04']); assert.equal(c.body.nextCursor, null);
  const attempts = x.app.calls.filter(call => call.method === 'thread/turns/list').map(call => `${call.params.limit}/${call.params.itemsView}`);
  assert.deepEqual(attempts, ['5/full', '1/full', '5/full', '1/full', '1/summary', '5/full']);
  note('oversized-history-fallback', { attempts });
});

test('a task before its first message opens with empty history; missing threads are 404, other Codex read errors 502 with a log line', async t => {
  const dirs = await layout();
  const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads: [{ id: 'fresh', cwd: dirs.dated, updatedAt: 5, turns: [] }] });
  let r = await send(x, 'POST', '/api/tasks/read', { ...x.auth, body: { threadId: 'fresh' } }); assert.equal(r.status, 200);
  r = await send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'fresh' } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, { turns: [], nextCursor: null, empty: true });
  const started = await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd: dirs.one } });
  r = await send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: started.body.result.thread.id } });
  assert.equal(r.status, 200); assert.equal(r.body.empty, true);
  assert.equal((await send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'no-such' } })).status, 404);
  const original = x.app.request.bind(x.app);
  x.app.request = async (method, params) => { if (method === 'thread/read' && params.threadId === 'fresh') throw Object.assign(new Error('rollout parse failed at line 7'), { rpcError: true, code: -32603 }); return original(method, params); };
  let log = await captureStderr(async () => { r = await send(x, 'POST', '/api/tasks/read', { ...x.auth, body: { threadId: 'fresh' } }); });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'read_failed'); assert.equal(r.body.error, 'Codex could not read this task');
  assert.match(log, /^\[server\] thread\/read rejected: rollout parse failed at line 7 \(rpc -32603\)/);
  x.app.request = async (method, params) => { if (method === 'thread/read') throw Object.assign(new Error('invalid thread id: bad char'), { rpcError: true, code: -32600 }); return original(method, params); };
  log = await captureStderr(async () => { r = await send(x, 'POST', '/api/tasks/read', { ...x.auth, body: { threadId: 'fresh' } }); });
  assert.equal(r.status, 404); assert.equal(log, '');
  x.app.request = original;
  // Resume asks Codex not to hydrate the whole history.
  assert.equal((await resume(x, 'fresh')).status, 200);
  assert.deepEqual(x.app.calls.filter(call => call.method === 'thread/resume').at(-1).params, { threadId: 'fresh', excludeTurns: true });
  note('empty-history-and-read-errors', { emptyHistory: true, missing404: true, other502Logged: true, resumeExcludeTurns: true });
});

test('file-change approvals are refused when any target path or grant root touches a protected folder; relative paths use the approval cwd', async t => {
  const dirs = await layout();
  const runtimeDir = path.join(dirs.one, 'runtime-data'); const uploadDir = path.join(dirs.base, 'uploads-store');
  await mkdir(runtimeDir, { recursive: true }); await mkdir(path.join(dirs.one, 'src'), { recursive: true });
  const x = await start(t, dirs, { runtimeDir, uploadDir });
  const threadId = (await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd: dirs.one } })).body.result.thread.id;
  const ask = (id, method, params) => { x.app.incoming.set(id, { id }); x.app.emit('serverRequest', { id, method, params: { threadId, cwd: dirs.one, ...params } }); };
  const outcome = id => waitFor(async () => {
    if (x.server.pendingApprovals.has(id)) return 'pending';
    const event = (await send(x, 'GET', '/api/state?cursor=0', x.auth)).body.events.find(value => value.type === 'blockedApproval' && value.data.id === id);
    return event ? event.data.reason : null;
  });
  const file = 'item/fileChange/requestApproval';
  ask('rel-protected', file, { changes: [{ path: 'src\\ok.js', diff: '+1' }, { path: 'runtime-data\\runtime-config.json', diff: '+x' }] });
  ask('abs-upload', file, { changes: [{ path: path.join(uploadDir, 'files', 'x.txt'), diff: '+x' }] });
  ask('move-into', file, { changes: [{ path: 'src\\a.js', kind: { type: 'update', move_path: 'runtime-data\\a.js' }, diff: '+x' }] });
  ask('grant-root', file, { changes: [{ path: 'src\\b.js', diff: '+x' }], grantRoot: dirs.one });
  // Changes known only from the item/started context (the real protocol's shape).
  x.app.emit('notification', { method: 'item/started', params: { threadId, item: { id: 'fc-ctx', type: 'fileChange', changes: [{ path: path.join(runtimeDir, 'secret.json'), diff: '+s' }] } } });
  ask('context', file, { itemId: 'fc-ctx' });
  ask('fine', file, { changes: [{ path: 'src\\c.js', diff: '+c' }] });
  ask('command', 'item/commandExecution/requestApproval', { command: 'dir' });
  const results = {};
  for (const id of ['rel-protected', 'abs-upload', 'move-into', 'grant-root', 'context', 'fine', 'command']) results[id] = await outcome(id);
  assert.deepEqual(results, { 'rel-protected': 'protected folder', 'abs-upload': 'protected folder', 'move-into': 'protected folder', 'grant-root': 'protected folder', context: 'protected folder', fine: 'pending', command: 'pending' });
  note('file-change-paths-protected', results);
});

test('log sanitizing covers bearer tokens, base64 with / and +, and terminal control characters, but keeps plain paths', () => {
  assert.equal(sanitizeForLog('Authorization: Bearer abc.DEF-123_xyz'), 'Authorization: Bearer [redacted]');
  assert.equal(sanitizeForLog('header authorization=Basic dXNlcjpwYXNz'), 'header authorization=Basic [redacted]');
  assert.equal(sanitizeForLog('blob a1B2c3/D4e5F6+g7H8i9J0kLmNoPqRsTuVwXyZ0123456789abcd== end'), 'blob [redacted] end');
  assert.equal(sanitizeForLog('blob Zm9vYmFyYmF6cXV4/QUJDREVGR0hJSktMTU5PUFFSU1RVVldY end'), 'blob [redacted] end');
  assert.equal(sanitizeForLog('\u001b[31mred\u001b[0m \u0007bell\u009b'), '[31mred[0m bell');
  const frame = 'at failure (file:///C:/Codex/Projects/CodexRemoteWeb/lib/uploads.mjs:37:58)';
  assert.equal(sanitizeForLog(frame), frame);
});

test('log sanitizing round 2: quoted values with spaces, URL user info, spaced key names, bidi controls; plain names kept', () => {
  assert.equal(sanitizeForLog('password: "hunter two words" next'), 'password: "[redacted]" next');
  assert.equal(sanitizeForLog(`{"client_secret":"a b c","ok":1}`), `{"client_secret":"[redacted]","ok":1}`);
  assert.equal(sanitizeForLog("secret='x y'"), "secret='[redacted]'");
  assert.equal(sanitizeForLog('fetch https://alice:s3cr3t@example.com/path failed'), 'fetch https://[redacted]@example.com/path failed');
  assert.equal(sanitizeForLog('api key = abc123XYZ'), 'api key = [redacted]');
  assert.equal(sanitizeForLog('access token: qwerty'), 'access token: [redacted]');
  assert.equal(sanitizeForLog('a\u202Eb\u2066c\u2069d\u200Fe'), 'abcde');
  const rollout = 'rollout-2026-09-22T10-11-12-01a0c958-f3cb-77d3-84d1-f37391a1055e.jsonl';
  assert.equal(sanitizeForLog(`open ${rollout} failed`), `open ${rollout} failed`);
  assert.equal(sanitizeForLog('C:\\Codex\\Apps\\Development-SDKs-2026-09-20\\node-lts'), 'C:\\Codex\\Apps\\Development-SDKs-2026-09-20\\node-lts');
  assert.equal(sanitizeForLog('hex 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end'), 'hex [redacted] end');
});

test('protected-folder checks follow Win32 name rules: trailing dots/spaces, \\\\?\\ and UNC/device forms, streams (fail closed)', async t => {
  const dirs = await layout();
  const runtimeDir = path.join(dirs.one, 'runtime-data');
  await mkdir(path.join(runtimeDir, 'sub'), { recursive: true }); await mkdir(path.join(dirs.one, 'src'), { recursive: true });
  const x = await start(t, dirs, { runtimeDir });
  const threadId = (await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd: dirs.one } })).body.result.thread.id;
  const unc = `\\\\localhost\\${runtimeDir[0]}$${runtimeDir.slice(2)}`;
  const cases = {
    'dot-dir-relative': { changes: [{ path: 'runtime-data.\\runtime-config.json', diff: '+x' }] },
    'dot-dir-absolute': { changes: [{ path: `${runtimeDir}.\\runtime-config.json`, diff: '+x' }] },
    'space-dir': { changes: [{ path: 'runtime-data \\x.json', diff: '+x' }] },
    'dots-and-spaces': { changes: [{ path: 'runtime-data. . \\x.json', diff: '+x' }] },
    'grant-root-dot': { changes: [{ path: 'src\\a.js', diff: '+x' }], grantRoot: `${runtimeDir}.` },
    'verbatim-drive': { changes: [{ path: `\\\\?\\${runtimeDir}\\x.json`, diff: '+x' }] },
    'device-drive': { changes: [{ path: `\\\\.\\${runtimeDir}\\x.json`, diff: '+x' }] },
    'unc-admin-share': { changes: [{ path: `${unc}\\x.json`, diff: '+x' }] },
    'verbatim-unc': { changes: [{ path: `\\\\?\\UNC\\localhost\\${runtimeDir[0]}$${runtimeDir.slice(2)}\\x.json`, diff: '+x' }] },
    'dots-only-component': { changes: [{ path: 'src\\...\\x.json', diff: '+x' }] },
    'stream-alias': { changes: [{ path: 'runtime-data::$INDEX_ALLOCATION\\x.json', diff: '+x' }] },
    // Drive-relative paths resolve against the process cwd in Win32, and NT object paths bypass normal parsing: refused.
    'drive-relative-path': { changes: [{ path: `${runtimeDir[0]}:runtime-data\\runtime-config.json`, diff: '+x' }] },
    'drive-relative-move': { changes: [{ path: 'src\\a.js', kind: { type: 'update', move_path: `${runtimeDir[0]}:runtime-data\\a.js` }, diff: '+x' }] },
    'drive-relative-grant': { changes: [{ path: 'src\\a.js', diff: '+x' }], grantRoot: `${runtimeDir[0]}:runtime-data` },
    'nt-prefix-drive': { changes: [{ path: `\\??\\${runtimeDir}\\x.json`, diff: '+x' }] },
    'nt-prefix-unc': { changes: [{ path: `\\??\\UNC\\localhost\\${runtimeDir[0]}$${runtimeDir.slice(2)}\\x.json`, diff: '+x' }] },
    'normal-dotted-name': { changes: [{ path: 'src.\\ok.js', diff: '+x' }] },
    'normal': { changes: [{ path: 'src\\ok.js', diff: '+x' }] },
    'normal-relative-sub': { changes: [{ path: 'sub\\file.txt', diff: '+x' }] },
    'normal-relative-sibling': { changes: [{ path: '..\\sibling\\x.txt', diff: '+x' }] },
    'normal-absolute': { changes: [{ path: path.join(dirs.one, 'src', 'abs.js'), diff: '+x' }] }
  };
  for (const [id, params] of Object.entries(cases)) { x.app.incoming.set(id, { id }); x.app.emit('serverRequest', { id, method: 'item/fileChange/requestApproval', params: { threadId, cwd: dirs.one, ...params } }); }
  const results = {};
  for (const id of Object.keys(cases)) results[id] = await waitFor(async () => x.server.pendingApprovals.has(id) ? 'pending' : (await send(x, 'GET', '/api/state?cursor=0', x.auth)).body.events.find(event => event.type === 'blockedApproval' && event.data.id === id)?.data.reason);
  const expected = Object.fromEntries(Object.keys(cases).map(id => [id, id.startsWith('normal') ? 'pending' : 'protected folder']));
  assert.deepEqual(results, expected);
  // Task cwd judged the same way: ...\runtime-data. and a UNC alias are protected (view-only), a dotted sibling is not.
  const y = await start(t, dirs, { runtimeDir, resumeRoots: [dirs.projects], threads: [
    { id: 'cwd-dot', cwd: `${runtimeDir}.`, updatedAt: 3 }, { id: 'cwd-space-sub', cwd: `${runtimeDir} \\sub`, updatedAt: 2 }, { id: 'cwd-src-dot', cwd: `${path.join(dirs.one, 'src')}.`, updatedAt: 1 }] });
  const list = await tasks(y);
  const flags = Object.fromEntries(list.body.tasks.map(task => [task.id, task.protected]));
  assert.equal(flags['cwd-dot'], true); assert.equal(flags['cwd-space-sub'], true); assert.equal(flags['cwd-src-dot'], false);
  const r = await resume(y, 'cwd-dot'); assert.equal(r.status, 409); assert.equal(r.body.code, 'thread_scope_protected');
  note('win32-normalized-protection', { approvals: results, cwdFlags: flags });
});

test('item/fileChange/patchUpdated refreshes the change list: a pending card is updated, and refused once a new path is protected', async t => {
  const dirs = await layout();
  const runtimeDir = path.join(dirs.one, 'runtime-data'); await mkdir(runtimeDir, { recursive: true });
  const x = await start(t, dirs, { runtimeDir });
  const threadId = (await send(x, 'POST', '/api/tasks/start', { ...x.auth, body: { cwd: dirs.one } })).body.result.thread.id;
  const state = async () => (await send(x, 'GET', '/api/state?cursor=0', x.auth)).body;
  x.app.emit('notification', { method: 'item/started', params: { threadId, cwd: dirs.one, item: { id: 'fc1', type: 'fileChange', changes: [{ path: 'src\\a.js', diff: '+a' }] } } });
  x.app.incoming.set('ap1', { id: 'ap1' });
  x.app.emit('serverRequest', { id: 'ap1', method: 'item/fileChange/requestApproval', params: { threadId, itemId: 'fc1' } });
  await waitFor(() => x.server.pendingApprovals.has('ap1'));
  x.app.emit('notification', { method: 'item/fileChange/patchUpdated', params: { threadId, turnId: 'tu1', itemId: 'fc1', changes: [{ path: 'src\\a.js', diff: '+a' }, { path: 'src\\b.js', diff: '+b' }] } });
  const updated = await waitFor(async () => (await state()).approvals.find(a => a.id === 'ap1' && JSON.stringify(a.display).includes('b.js')));
  assert.equal(updated.display.changes.length, 2);
  assert.ok((await state()).events.some(event => event.type === 'approvalUpdated' && event.data.id === 'ap1'));
  x.app.emit('notification', { method: 'item/fileChange/patchUpdated', params: { threadId, turnId: 'tu1', itemId: 'fc1', changes: [{ path: 'src\\a.js', diff: '+a' }, { path: 'runtime-data\\runtime-config.json', diff: '+evil' }] } });
  const blocked = await waitFor(async () => (await state()).events.find(event => event.type === 'blockedApproval' && event.data.id === 'ap1'));
  assert.equal(blocked.data.reason, 'protected folder'); assert.equal(x.server.pendingApprovals.has('ap1'), false); assert.equal(x.app.incoming.has('ap1'), false);
  // A patch that arrives before the approval (no item/started) is used for the card and the check.
  x.app.emit('notification', { method: 'item/fileChange/patchUpdated', params: { threadId, turnId: 'tu2', itemId: 'fc2', changes: [{ path: 'runtime-data\\x.json', diff: '+x' }] } });
  x.app.incoming.set('ap2', { id: 'ap2' });
  x.app.emit('serverRequest', { id: 'ap2', method: 'item/fileChange/requestApproval', params: { threadId, itemId: 'fc2', cwd: dirs.one } });
  const blocked2 = await waitFor(async () => (await state()).events.find(event => event.type === 'blockedApproval' && event.data.id === 'ap2'));
  assert.equal(blocked2.data.reason, 'protected folder');
  note('patch-updated', { updatedDisplay: 2, refusedAfterProtectedPath: true, patchBeforeApproval: 'protected folder' });
});

test('history: a turn too large even as a summary becomes an "unavailable" placeholder and older history continues; only total failure is 502', async t => {
  const dirs = await layout();
  const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads: [{ id: 'h', cwd: dirs.dated, updatedAt: 5, turns: historyTurns().slice(0, 7) }] });
  x.app.oversizedSummaryTurns.add('t05');
  const page = cursor => send(x, 'POST', '/api/tasks/turns', { ...x.auth, body: { threadId: 'h', ...(cursor !== undefined ? { cursor } : {}) } });
  const a = await page(); assert.deepEqual(a.body.turns.map(turn => turn.id), ['t06']);
  const b = await page(a.body.nextCursor);
  assert.deepEqual(b.body.turns, [{ id: 't05', status: 'completed', items: [], unavailable: true }]);
  const c = await page(b.body.nextCursor); assert.deepEqual(c.body.turns.map(turn => turn.id), ['t00', 't01', 't02', 't03', 't04']);
  assert.deepEqual(x.app.calls.filter(call => call.method === 'thread/turns/list').map(call => `${call.params.limit}/${call.params.itemsView}`), ['5/full', '1/full', '5/full', '1/full', '1/summary', '1/notLoaded', '5/full']);
  // Cursor hygiene: non-string cursors are 400; a cursor that comes back unchanged ends the history.
  for (const cursor of [5, {}, ['x'], true]) assert.equal((await page(cursor)).status, 400, JSON.stringify(cursor));
  const original = x.app.request.bind(x.app);
  x.app.request = async (method, params) => method === 'thread/turns/list' && params.cursor === 'stuck' ? { data: [{ id: 'z', status: 'completed', items: [] }], nextCursor: 'stuck' } : original(method, params);
  assert.equal((await page('stuck')).body.nextCursor, null);
  // Even notLoaded too large → 502 (logged), no crash.
  x.app.request = async (method, params) => { if (method === 'thread/turns/list') throw Object.assign(new Error('thread/turns/list response exceeded 16777216 characters'), { tooLarge: true }); return original(method, params); };
  let r; const log = await captureStderr(async () => { r = await page(); });
  assert.equal(r.status, 502); assert.equal(r.body.error, 'Codex response is too large'); assert.match(log, /\[server\] 502 POST \/api\/tasks\/turns/);
  // -32601 "list_turns is not supported yet" is a read failure (502 read_failed + log), not an empty history.
  x.app.request = async (method, params) => { if (method === 'thread/turns/list') throw Object.assign(new Error('list_turns is not supported yet'), { rpcError: true, code: -32601 }); return original(method, params); };
  const log2 = await captureStderr(async () => { r = await page(); });
  assert.equal(r.status, 502); assert.equal(r.body.code, 'read_failed'); assert.match(log2, /thread\/turns\/list rejected: list_turns is not supported yet \(rpc -32601\)/);
  note('history-notLoaded-and-cursor', { placeholder: 't05', cursor400: 4, sameCursorEnds: true, totalFailure: 502, rpc32601: 'read_failed' });
});

test('the UI fixture uses its own Codex home, never the real ~/.codex lock files', async () => {
  const source = await readFile(path.join(repo, 'test', 'ui-fixture.mjs'), 'utf8');
  assert.match(source, /codexHome: path\.join\(base, 'codex-home'\)/);
});

test('resumeRoots must be an array of absolute paths', async () => {
  const base = { bindHost: '127.0.0.1', port: 0, publicOrigin: 'http://127.0.0.1', allowedRoots: [], password: { salt: 'a', hash: 'b' } };
  for (const resumeRoots of ['C:\\Codex', ['relative'], [42]]) assert.throws(() => new RemoteServer({ ...base, resumeRoots }, { appServer: new FakeCodex() }), /resumeRoots/);
  for (const resumeRoots of [[], null, undefined]) assert.doesNotThrow(() => new RemoteServer({ ...base, resumeRoots }, { appServer: new FakeCodex() }));
});

test('writer lock hint: a lock file held by another process shows as busy in the list and on open (Windows, read-only probe)', { skip: process.platform !== 'win32' && 'Windows-only lock semantics' }, async t => {
  const dirs = await layout(); const x = await start(t, dirs, { resumeRoots: [dirs.rootA], threads: scenario(dirs) });
  const lockDir = path.join(dirs.codexHome, 'thread-writer-locks'); await mkdir(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'dated.lock'); await writeFile(lockFile, '');
  // Another process holds an OS byte-range lock on the whole file, as Codex does for an open thread.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${lockFile.replace(/'/g, "''")}','Open','ReadWrite','ReadWrite'); $f.Lock(0, [long]::MaxValue); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [void][Console]::In.ReadLine(); $f.Close()`], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => holder.kill());
  await new Promise((resolve, reject) => { holder.stdout.on('data', data => { if (String(data).includes('locked')) resolve(); }); holder.on('exit', () => reject(new Error('lock holder exited early'))); });
  let r = await tasks(x);
  const lockOf = id => r.body.tasks.find(task => task.id === id)?.lock;
  assert.equal(lockOf('dated'), 'busy'); assert.equal(lockOf('deep'), null);
  assert.equal((await read(x, 'dated')).body.access.lock, 'busy');
  holder.stdin.end('\n'); await new Promise(resolve => holder.on('exit', resolve));
  r = await tasks(x); assert.equal(lockOf('dated'), null);
  assert.equal((await read(x, 'dated')).body.access.lock, null);
  note('writer-lock-hint', { heldByOtherProcess: 'busy', afterRelease: null });
});

function bridge(maxLine) {
  let child;
  const app = new AppServer({ transport: 'stdio' }, { maxLine, spawnImpl: () => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false; child.kill = () => { child.killed = true; };
    child.stdin.on('data', data => { for (const line of String(data).split('\n').filter(Boolean)) { const m = JSON.parse(line); if (m.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: m.id, result: { ok: true } })}\n`); else if (m.id) child.requests.push(m); } });
    child.requests = [];
    return child;
  } });
  return { app, child: () => child };
}

test('bridge: an oversized JSONL answer fails only its own request and the connection keeps working', async () => {
  const { app, child } = bridge(1000); await app.connect();
  const errors = []; app.on('protocolError', error => errors.push(error.message));
  const big = app.request('thread/list', {}); const small = app.request('thread/read', {});
  await new Promise(resolve => setImmediate(resolve));
  const [bigReq, smallReq] = child().requests;
  // Oversized complete line delivered in one piece, followed by a normal answer in the same chunk.
  child().stdout.write(`${JSON.stringify({ id: bigReq.id, result: { data: ['x'.repeat(2000)] } })}\n${JSON.stringify({ id: smallReq.id, result: { ok: 1 } })}\n`);
  await assert.rejects(big, error => error.tooLarge === true && /thread\/list/.test(error.message));
  assert.deepEqual(await small, { ok: 1 });
  assert.equal(app.connected, true);
  // Oversized line split over chunks: rejected as soon as it passes the limit, the tail is skipped, then normal again.
  const split = app.request('thread/read', {}); await new Promise(resolve => setImmediate(resolve));
  const splitReq = child().requests.at(-1);
  const line = `${JSON.stringify({ id: splitReq.id, result: { text: 'y'.repeat(3000) } })}\n`;
  child().stdout.write(line.slice(0, 1200));
  await assert.rejects(split, error => error.tooLarge === true);
  child().stdout.write(line.slice(1200, 2500)); child().stdout.write(line.slice(2500));
  const after = app.request('model/list', {}); await new Promise(resolve => setImmediate(resolve));
  child().stdout.write(`${JSON.stringify({ id: child().requests.at(-1).id, result: { fine: true } })}\n`);
  assert.deepEqual(await after, { fine: true });
  // Many normal lines in one chunk whose total exceeds the limit are not "one oversized line".
  const many = []; for (let i = 0; i < 5; i++) many.push(app.request('thread/read', { i }));
  await new Promise(resolve => setImmediate(resolve));
  child().stdout.write(child().requests.slice(-5).map(req => `${JSON.stringify({ id: req.id, result: { pad: 'z'.repeat(400) } })}\n`).join(''));
  assert.equal((await Promise.all(many)).length, 5);
  assert.equal(app.connected, true); assert.equal(errors.length, 2);
  app.close();
  note('bridge-oversize', { maxLine: 1000, failedOnlyOwnRequest: true, connectionKept: true, protocolErrors: errors });
});
