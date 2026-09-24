import http from 'node:http';
import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import { existsSync, watchFile } from 'node:fs';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServer } from './bridge/app-server.mjs';

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const SESSION_ABSOLUTE = 8 * 60 * 60 * 1000;
const SESSION_IDLE = 30 * 60 * 1000;
const EVENT_LIMIT = 300;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHODS = new Set(['thread/list', 'thread/read', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']);

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}
function text(res, status, value, headers = {}) { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }); res.end(value); }
function base64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
function cookieValue(req, name) { return (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1); }
function safeEqual(a, b) { const x = Buffer.isBuffer(a) ? a : Buffer.from(String(a)); const y = Buffer.isBuffer(b) ? b : Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); }
function originFromHost(req, https = true) { return `${https ? 'https' : 'http'}://${req.headers.host || ''}`; }
function normalizeOrigin(value) { const u = new URL(value); return u.origin; }
function hasPrefix(candidate, parent) { const relative = path.relative(parent, candidate); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function idKey(value) { return createHash('sha256').update(String(value)).digest('hex'); }

async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

export async function loadConfig(configPath) {
  return JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/, ''));
}

export class RemoteServer {
  constructor(config, { appServer, now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.publicOrigin = normalizeOrigin(config.publicOrigin);
    const hostname = new URL(this.publicOrigin).hostname;
    const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.bindHost || '127.0.0.1')) throw new Error('Remote server must bind to loopback');
    if (new URL(this.publicOrigin).protocol !== 'https:' && !loopback) throw new Error('Production publicOrigin must use HTTPS');
    this.secureCookie = new URL(this.publicOrigin).protocol === 'https:';
    this.sessions = new Map();
    this.loginAttempts = new Map();
    this.loginInFlight = 0;
    this.events = [];
    this.cursor = 0;
    this.pendingApprovals = new Map();
    this.idempotency = new Map();
    this.modelCatalog = null;
    this.modelCatalogUntil = 0;
    this.allowedProjects = new Map();
    this.controlledThreads = new Set();
    this.threadProjects = new Map();
    this.activeTurns = new Map();
    this.itemContexts = new Map();
    this.app = appServer || new AppServer(config);
    this.app.on('status', event => { if (!event.connected) { this.controlledThreads.clear(); this.activeTurns.clear(); this.threadProjects.clear(); this.pendingApprovals.clear(); } this.event('connection', event); });
    this.app.on('notification', event => this.receiveNotification(event));
    this.app.on('unsupportedRequest', event => this.event('unsupported', event));
    this.app.on('serverRequest', event => this.receiveApproval(event));
    this.app.on('serverRequestResolved', event => { this.pendingApprovals.delete(event.id); this.event('approvalResolved', event); });
    this.server = http.createServer((req, res) => this.handle(req, res).catch(error => this.fail(res, error)));
  }

  event(type, data) {
    const entry = { cursor: ++this.cursor, at: this.now(), type, data };
    this.events.push(entry);
    if (this.events.length > EVENT_LIMIT) this.events.shift();
  }

  async start() {
    try { await this.app.connect(); }
    catch (error) { this.app.close(); throw error; }
    return new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.bindHost || '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
  }
  async stop() { this.app.close(); return new Promise(resolve => this.server.close(resolve)); }
  address() { return this.server.address(); }

  fail(res, error) {
    const status = error.status || 500;
    json(res, status, { error: status === 500 ? 'Internal server error' : error.message });
  }

  expectedHost() { return new URL(this.publicOrigin).host; }
  checkHost(req) { return safeEqual(req.headers.host || '', this.expectedHost()); }
  checkOrigin(req) { return safeEqual(req.headers.origin || '', this.publicOrigin); }
  securityHeaders() {
    return {
      'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
      'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY'
    };
  }

  session(req) {
    this.expireSessions();
    const id = cookieValue(req, 'crw_session'); const value = id && this.sessions.get(id); const now = this.now();
    if (!value) return null;
    if (now >= value.absolute || now - value.last > SESSION_IDLE) { this.sessions.delete(id); return null; }
    value.last = now; return { id, ...value };
  }

  async handle(req, res) {
    const requestUrl = new URL(req.url, this.publicOrigin);
    if (requestUrl.pathname === '/health' && req.method === 'GET') return json(res, 200, { ok: true }, this.securityHeaders());
    if (requestUrl.pathname === '/api/login' && req.method === 'POST') return this.login(req, res);
    if (!this.checkHost(req)) return json(res, 421, { error: 'Unexpected Host' }, this.securityHeaders());
    if (requestUrl.pathname.startsWith('/api/')) {
      const session = this.session(req);
      if (!session) return json(res, 401, { error: 'Login required' }, this.securityHeaders());
      if (MUTATING.has(req.method) && (!this.checkOrigin(req) || !safeEqual(req.headers['x-csrf-token'] || '', session.csrf))) return json(res, 403, { error: 'CSRF validation failed' }, this.securityHeaders());
      return this.api(req, res, requestUrl, session);
    }
    if (req.method !== 'GET') return text(res, 405, 'Method not allowed', this.securityHeaders());
    return this.static(res, requestUrl.pathname);
  }

  async login(req, res) {
    if (!this.checkHost(req) || !this.checkOrigin(req)) return json(res, 421, { error: 'Unexpected origin' }, this.securityHeaders());
    const ip = req.socket.remoteAddress || 'unknown'; const key = idKey(ip); const now = this.now();
    const state = this.loginAttempts.get(key) || { failures: 0, until: 0 };
    if (state.until > now) return json(res, 429, { error: 'Try again later' }, this.securityHeaders());
    if (this.loginInFlight >= 16) return json(res, 429, { error: 'Try again later' }, this.securityHeaders());
    this.loginInFlight++;
    let payload; try { payload = await body(req); } finally { this.loginInFlight--; }
    const password = String(payload.password || '');
    const salt = Buffer.from(this.config.password.salt, 'base64url'); const expected = Buffer.from(this.config.password.hash, 'base64url');
    this.loginInFlight++;
    let actual; try { actual = await scrypt(password, salt, expected.length); } finally { this.loginInFlight--; }
    if (!safeEqual(actual, expected)) {
      const failures = Math.min(state.failures + 1, 8);
      this.loginAttempts.set(key, { failures, until: now + Math.min(60_000, 500 * 2 ** failures) });
      return json(res, 401, { error: 'Invalid access password' }, this.securityHeaders());
    }
    this.loginAttempts.delete(key);
    const id = base64url(randomBytes(32)); const csrf = base64url(randomBytes(32));
    this.sessions.set(id, { csrf, created: now, last: now, absolute: now + SESSION_ABSOLUTE });
    const attributes = [`crw_session=${id}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800'];
    if (this.secureCookie) attributes.push('Secure');
    json(res, 200, { csrf }, { ...this.securityHeaders(), 'set-cookie': attributes.join('; ') });
  }

  async api(req, res, url, session) {
    if (url.pathname === '/api/logout' && req.method === 'POST') { this.sessions.delete(session.id); return json(res, 200, { ok: true }, { ...this.securityHeaders(), 'set-cookie': 'crw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, this.state(Number(url.searchParams.get('cursor') || 0), session), this.securityHeaders());
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: await this.listProjects() }, this.securityHeaders());
    if (url.pathname === '/api/models' && req.method === 'GET') return json(res, 200, { models: await this.listModels() }, this.securityHeaders());
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, { tasks: await this.listTasks() }, this.securityHeaders());
    if (url.pathname === '/api/tasks/read' && req.method === 'POST') return this.readThread(res, await body(req));
    if (url.pathname === '/api/tasks/start' && req.method === 'POST') return this.startThread(res, await body(req));
    if (url.pathname === '/api/tasks/resume' && req.method === 'POST') return this.resumeThread(res, await body(req));
    if (url.pathname === '/api/turns/start' && req.method === 'POST') return this.startTurn(res, await body(req));
    if (url.pathname === '/api/turns/interrupt' && req.method === 'POST') return this.interruptTurn(res, await body(req));
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (approvalMatch && req.method === 'POST') return this.resolveApproval(res, decodeURIComponent(approvalMatch[1]), await body(req));
    const inputMatch = url.pathname.match(/^\/api\/input\/([^/]+)$/);
    if (inputMatch && req.method === 'POST') return this.resolveInput(res, decodeURIComponent(inputMatch[1]), await body(req));
    return json(res, 404, { error: 'Route not found' }, this.securityHeaders());
  }

  async call(res, method, params) {
    if (!METHODS.has(method)) throw Object.assign(new Error('Method is not allowed'), { status: 400 });
    const result = await this.app.request(method, params);
    this.event('commandCompleted', { method, ok: true });
    return json(res, 200, { result }, this.securityHeaders());
  }

  async startThread(res, params) {
    const cwd = await this.assertAllowedProject(String(params.cwd || ''));
    const result = await this.app.request('thread/start', { cwd });
    const threadId = result?.thread?.id || result?.id || result?.threadId;
    if (threadId) { this.controlledThreads.add(String(threadId)); this.threadProjects.set(String(threadId), cwd); }
    this.event('commandCompleted', { method: 'thread/start', ok: true });
    return json(res, 200, { result }, this.securityHeaders());
  }

  async readThread(res, params) {
    const threadId = String(params.threadId || '');
    const task = (await this.listTasks()).find(value => String(value.id || value.threadId) === threadId);
    if (!task && !this.threadProjects.has(threadId)) throw Object.assign(new Error('Thread is not in an allowed project'), { status: 403 });
    return this.call(res, 'thread/read', { threadId, includeTurns: true });
  }

  async resumeThread(res, params) {
    const threadId = String(params.threadId || '');
    if (!threadId) throw Object.assign(new Error('threadId is required'), { status: 400 });
    const tasks = await this.listTasks();
    const task = tasks.find(value => String(value.id || value.threadId) === threadId);
    if (!task) throw Object.assign(new Error('Thread is not in an allowed project'), { status: 403 });
    const rawState = task.status?.type || task.status || task.turn?.status?.type || task.turn?.status || '';
    const state = String(rawState).toLowerCase();
    if (['active', 'running', 'in_progress', 'busy'].includes(state)) throw Object.assign(new Error('Active thread cannot be taken over'), { status: 409 });
    const result = await this.app.request('thread/resume', { threadId });
    this.controlledThreads.add(threadId);
    this.threadProjects.set(threadId, await this.assertAllowedProject(task.cwd || task.workspace?.cwd));
    this.event('commandCompleted', { method: 'thread/resume', threadId, ok: true });
    return json(res, 200, { result }, this.securityHeaders());
  }

  async startTurn(res, params) {
    const requestId = String(params.requestId || ''); const threadId = String(params.threadId || ''); const prompt = String(params.prompt || '');
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId) || !threadId || !prompt || Buffer.byteLength(prompt) > 16 * 1024) throw Object.assign(new Error('Invalid turn request'), { status: 400 });
    if (!this.controlledThreads.has(threadId)) throw Object.assign(new Error('Resume this inactive allowed thread before sending a turn'), { status: 409 });
    const model = params.model == null || params.model === '' ? null : String(params.model);
    const effort = params.effort == null || params.effort === '' ? null : String(params.effort);
    if (effort && !model) throw Object.assign(new Error('A model is required when selecting reasoning effort'), { status: 400 });
    let choice = null;
    if (model) {
      choice = (await this.listModels()).find(value => value.model === model);
      if (!choice) throw Object.assign(new Error('Selected model is unavailable'), { status: 400 });
      if (effort && !choice.supportedReasoningEfforts.some(value => value.reasoningEffort === effort)) throw Object.assign(new Error('Selected reasoning effort is unsupported'), { status: 400 });
    }
    const digest = idKey(`${threadId}\0${prompt}\0${model || ''}\0${effort || ''}`); const prior = this.idempotency.get(requestId);
    if (prior) {
      if (prior.digest !== digest) throw Object.assign(new Error('requestId conflicts with a different turn'), { status: 409 });
      return json(res, prior.status, prior.body, this.securityHeaders());
    }
    this.idempotency.set(requestId, { digest, status: 202, body: { status: 'dispatching' }, expires: this.now() + 10 * 60_000 });
    try {
      const turnParams = { threadId, input: [{ type: 'text', text: prompt }] };
      if (model) turnParams.model = model;
      const defaultEffort = choice?.supportedReasoningEfforts.some(value => value.reasoningEffort === choice.defaultReasoningEffort) ? choice.defaultReasoningEffort : null;
      if (effort || defaultEffort) turnParams.effort = effort || defaultEffort;
      const result = await this.app.request('turn/start', turnParams);
      const response = { result }; this.idempotency.set(requestId, { digest, status: 200, body: response, expires: this.now() + 10 * 60_000 });
      this.event('commandCompleted', { method: 'turn/start', threadId, ok: true });
      return json(res, 200, response, this.securityHeaders());
    } catch {
      const response = { error: 'Turn dispatch failed; status is uncertain and will not be retried automatically' };
      this.idempotency.set(requestId, { digest, status: 409, body: response, expires: this.now() + 10 * 60_000 });
      return json(res, 409, response, this.securityHeaders());
    }
  }

  async listModels() {
    if (this.modelCatalog && this.modelCatalogUntil > this.now()) return this.modelCatalog;
    const models = []; const cursors = new Set(); let cursor;
    for (let page = 0; page < 10; page++) {
      const params = { limit: 100, includeHidden: false }; if (cursor) params.cursor = cursor;
      const result = await this.app.request('model/list', params);
      for (const item of result.data || []) {
        if (!item.hidden && (item.id || item.model)) models.push({ id: String(item.id || item.model), model: String(item.model || item.id), displayName: item.displayName || item.model || item.id, isDefault: Boolean(item.isDefault), defaultReasoningEffort: item.defaultReasoningEffort || null, supportedReasoningEfforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map(value => ({ reasoningEffort: value.reasoningEffort, description: value.description || '' })).filter(value => value.reasoningEffort) : [] });
      }
      cursor = result.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('Model catalog pagination loop rejected');
      cursors.add(cursor);
      if (page === 9) throw new Error('Model catalog pagination limit reached');
    }
    this.modelCatalog = models; this.modelCatalogUntil = this.now() + 30_000;
    return models;
  }

  async interruptTurn(res, params) {
    const threadId = String(params.threadId || ''); const turnId = this.activeTurns.get(threadId);
    if (!this.controlledThreads.has(threadId) || !turnId) throw Object.assign(new Error('No controlled active turn to interrupt'), { status: 409 });
    return this.call(res, 'turn/interrupt', { threadId, turnId });
  }

  state(cursor, session) {
    for (const [key, value] of this.idempotency) if (value.expires <= this.now()) this.idempotency.delete(key);
    return { cursor: this.cursor, csrf: session.csrf, connected: this.app.connected, controlledThreads: [...this.controlledThreads], activeTurns: Object.fromEntries(this.activeTurns), events: this.events.filter(event => event.cursor > cursor), approvals: [...this.pendingApprovals.values()] };
  }

  expireSessions() { const now = this.now(); for (const [id, session] of this.sessions) if (now >= session.absolute || now - session.last > SESSION_IDLE) this.sessions.delete(id); }

  async listProjects() {
    const projects = [];
    for (const root of this.config.allowedRoots || []) {
      if (!existsSync(root)) continue;
      const realRoot = await realpath(root);
      for (const entry of await readdir(realRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(realRoot, entry.name);
        try { const resolved = await this.assertAllowedProject(candidate); projects.push({ name: entry.name, path: resolved }); } catch { /* excluded */ }
      }
    }
    return projects;
  }

  async assertAllowedProject(candidate) {
    if (!path.isAbsolute(candidate)) throw Object.assign(new Error('Project path must be absolute'), { status: 400 });
    let resolved; try { resolved = await realpath(candidate); } catch { throw Object.assign(new Error('Project does not exist'), { status: 400 }); }
    const info = await stat(resolved); if (!info.isDirectory()) throw Object.assign(new Error('Project must be a directory'), { status: 400 });
    for (const configuredRoot of this.config.allowedRoots || []) {
      if (!existsSync(configuredRoot)) continue;
      const root = await realpath(configuredRoot);
      if (path.dirname(resolved) === root && hasPrefix(resolved, root)) { this.allowedProjects.set(resolved, true); return resolved; }
    }
    throw Object.assign(new Error('Project is outside allowed roots'), { status: 403 });
  }

  async assertAllowedApprovalCwd(candidate, threadId) {
    let resolved; try { resolved = await realpath(candidate); } catch { throw Object.assign(new Error('Approval cwd does not exist'), { status: 403 }); }
    const project = this.threadProjects.get(threadId);
    if (!project || !hasPrefix(resolved, project)) throw Object.assign(new Error('Approval cwd is outside the controlled project'), { status: 403 });
    return resolved;
  }

  async listTasks() {
    const result = await this.app.request('thread/list', {});
    const tasks = Array.isArray(result) ? result : (result.threads || result.data || []);
    const allowed = [];
    for (const task of tasks) {
      const cwd = task.cwd || task.workspace?.cwd;
      try { if (cwd) await this.assertAllowedProject(cwd); else continue; allowed.push(task); } catch { /* hide unscoped task */ }
    }
    return allowed;
  }

  receiveNotification(event) {
    const params = event.params || {}; const threadId = String(params.threadId || params.thread?.id || params.item?.threadId || '');
    const item = params.item || {}; const itemId = String(params.itemId || item.id || '');
    if (event.method === 'item/started' && itemId && threadId && this.controlledThreads.has(threadId)) {
      this.itemContexts.set(itemId, { threadId, cwd: params.cwd || item.cwd || params.workspace?.cwd, item });
    }
    if ((event.method === 'turn/started' || event.method === 'turn/completed') && threadId && this.controlledThreads.has(threadId)) {
      const turnId = params.turn?.id || params.turnId;
      if (event.method === 'turn/started' && turnId) this.activeTurns.set(threadId, String(turnId));
      if (event.method === 'turn/completed') this.activeTurns.delete(threadId);
    }
    if (!threadId || !this.controlledThreads.has(threadId)) return;
    this.event('notification', { method: event.method, params });
  }

  receiveApproval(request) {
    const params = request.params || {};
    const itemId = String(params.itemId || params.item?.id || ''); const context = itemId && this.itemContexts.get(itemId);
    const threadId = params.threadId || params.thread?.id || context?.threadId;
    const cwd = params.cwd || params.workspace?.cwd || context?.cwd || this.threadProjects.get(String(threadId));
    const display = this.approvalDisplay(request.method, params, context?.item);
    if (!threadId || !this.controlledThreads.has(String(threadId)) || !cwd || !display) {
      this.app.failRequest(request.id, -32602, 'Approval lacks an allowed thread and concrete change details');
      this.event('blockedApproval', { id: request.id, reason: 'missing concrete details' });
      return;
    }
    this.assertAllowedApprovalCwd(cwd, String(threadId)).then(() => {
      if (!this.app.incoming.has(String(request.id))) return;
      const approval = { id: request.id, method: request.method, threadId, cwd, display, params: request.method.includes('requestUserInput') ? params : undefined };
      this.pendingApprovals.set(request.id, approval); this.event('approvalRequested', approval);
    }).catch(() => {
      this.app.failRequest(request.id, -32602, 'Approval is outside allowed project roots');
      this.event('blockedApproval', { id: request.id, reason: 'outside allowed project' });
    });
  }

  approvalDisplay(method, params, item) {
    if (method === 'item/commandExecution/requestApproval') {
      const command = params.command || params.commandLine || params.item?.command || item?.command;
      return command ? { kind: 'command', command: String(command) } : null;
    }
    if (method === 'item/fileChange/requestApproval') {
      const changes = params.changes || params.files || params.item?.changes || item?.changes || item?.files;
      const diff = params.diff || params.item?.diff || item?.diff;
      if (Array.isArray(changes) && changes.length) return { kind: 'files', changes: changes.map(change => typeof change === 'string' ? change : `${change.path || '변경 파일'}${change.diff ? `\n${change.diff}` : ''}`), diff };
      return diff ? { kind: 'files', changes: [{ path: params.path || params.item?.path || item?.path || '변경 파일', diff }], diff } : null;
    }
    if (method === 'item/tool/requestUserInput' || method === 'tool/requestUserInput') {
      const questions = params.questions;
      return Array.isArray(questions) && questions.length ? { kind: 'input', questions } : null;
    }
    return null;
  }

  resolveApproval(res, id, payload) {
    const pending = this.pendingApprovals.get(id);
    if (!pending || pending.method.includes('requestUserInput')) throw Object.assign(new Error('Approval is not pending'), { status: 404 });
    const decision = payload.decision === 'accept' ? 'accept' : payload.decision === 'decline' ? 'decline' : null;
    if (!decision) throw Object.assign(new Error('Explicit accept or decline is required'), { status: 400 });
    this.app.resolveRequest(id, { decision });
    return json(res, 200, { ok: true }, this.securityHeaders());
  }

  resolveInput(res, id, payload) {
    const pending = this.pendingApprovals.get(id);
    if (!pending || !pending.method.includes('requestUserInput')) throw Object.assign(new Error('Input request is not pending'), { status: 404 });
    if (!payload.answers || typeof payload.answers !== 'object' || Array.isArray(payload.answers)) throw Object.assign(new Error('Answers are required'), { status: 400 });
    this.app.resolveRequest(id, { answers: payload.answers });
    return json(res, 200, { ok: true }, this.securityHeaders());
  }

  async static(res, pathname) {
    const files = new Map([['/', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css']]);
    const file = files.get(pathname); if (!file) return text(res, 404, 'Not found', this.securityHeaders());
    const content = await readFile(path.join(ROOT, 'public', file));
    const type = file.endsWith('.js') ? 'application/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...this.securityHeaders() }); res.end(content);
  }
}

async function main() {
  const configPath = process.env.CODEX_REMOTE_CONFIG || path.join(process.env.CODEX_REMOTE_DATA_DIR || 'C:\\Codex\\Apps\\CodexRemoteWeb\\data', 'runtime-config.json');
  const config = await loadConfig(configPath); const server = new RemoteServer(config);
  await server.start();
  process.on('SIGINT', () => server.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => server.stop().then(() => process.exit(0)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`Startup failed: ${error.message}\n`); process.exitCode = 1; });
