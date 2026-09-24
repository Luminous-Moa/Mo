import http from 'node:http';
import { readFile, realpath, readdir, stat, open } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServer } from './bridge/app-server.mjs';
import { UploadStore, UPLOAD_ID, UPLOAD_TYPES, publicAttachment } from './lib/uploads.mjs';

const scrypt = promisify(scryptCallback);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 64 * 1024;
const SESSION_ABSOLUTE = 8 * 60 * 60 * 1000;
const SESSION_IDLE = 30 * 60 * 1000;
const EVENT_LIMIT = 300;
const REQUEST_TIMEOUT = 10 * 60_000;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const METHODS = new Set(['thread/list', 'thread/read', 'thread/start', 'thread/resume', 'turn/start', 'turn/interrupt']);
// Task list: newest activity first, collected page by page with hard bounds (see README "작업 목록").
const TASK_PAGE_SIZE = 50;
const TASK_MAX_PAGES = 6;
const TASK_MAX_ITEMS = 100;
const TASK_TEXT_LIMIT = 240;
const THREAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
// History is paged with thread/turns/list (newest first). Measured on the real account: single turns of 6.3 MiB and
// 27.6 MiB in full view, while whole-history thread/read reached 26 MiB. 5 turns keeps ordinary pages far below the
// bridge line limit; an oversized page is retried with 1 turn, then that turn in summary view (user text + reply).
const TURN_PAGE_SIZE = 5;
const TURN_TEXT_LIMIT = 200_000;
const TURN_OUTPUT_LIMIT = 20_000;
const TURN_DIFF_LIMIT = 50_000;
// Codex -32600 texts that mean "no such thread" (vs. other read failures).
const THREAD_MISSING = /thread not loaded|invalid thread id|thread not found|no such thread|unknown thread/i;
// Before the first user message a thread has no rollout: -32600 "... not materialized yet; thread/turns/list is
// unavailable before first user message" (verified with the real binary). Only that answer means "empty history";
// anything else (e.g. -32601 "list_turns is not supported yet") is a read failure.
const NO_HISTORY_YET = /not materialized|before first user message/i;
// Codex answers thread/resume with JSON-RPC -32600 "thread <id> already has an active writer" while another process
// (typically the desktop app) holds that thread's writer lock. Only that process exiting releases it.
const ACTIVE_WRITER = /already has an active writer/i;
const LOCKED_MESSAGE = '이 작업은 다른 Codex 프로세스(데스크톱 앱 등)가 사용 중입니다. 데스크톱 앱을 트레이까지 완전히 종료한 뒤 다시 시도하세요.';
const FOLDER_MISSING_MESSAGE = '작업 폴더가 지금 없어 이어갈 수 없습니다. 기록 보기만 가능합니다.';
const PROTECTED_MESSAGE = '이 작업 폴더는 웹 패널의 운영 데이터 폴더를 포함하거나 그 안에 있어 웹에서 이어갈 수 없습니다. 데스크톱 앱에서 이어가세요.';

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
function httpError(status, message, errorCode) { return Object.assign(new Error(message), { status, ...(errorCode ? { errorCode } : {}) }); }
// Codex may report cwd in Win32 namespace form (\\?\C:\...); path.relative cannot compare that with C:\...
function plainPath(value) {
  const text = String(value || '');
  if (/^\\\\\?\\UNC\\/i.test(text)) return `\\\\${text.slice(8)}`;
  return text.replace(/^\\\\\?\\/, '');
}
// Real path of the nearest existing ancestor plus the missing tail, so a removed folder is still judged by where it
// really was (a junction inside a root cannot make an outside path look inside).
async function loosePath(target) {
  const tail = []; let current = target;
  for (;;) {
    try { return path.join(await realpath(current), ...tail); } catch { /* keep walking up */ }
    const parent = path.dirname(current);
    if (parent === current) return target;
    tail.unshift(path.basename(current)); current = parent;
  }
}
// Win32 form of a path for protected-folder comparisons. Win32 path normalization (unlike Node's realpath) drops one
// trailing '.' from a component (a write to ...\data.\x lands in ...\data\x); it does not drop spaces there and does
// not strip '..'. This code is deliberately more conservative: it removes every trailing dot and space, so it can
// over-block (e.g. a real folder named "data " is treated as "data") but never under-block for these names.
//   'drive'   drive-letter path with every component cleaned that way; \\?\C:\ and \\.\C:\ prefixes are treated as the
//             plain drive path (for \\?\ that over-matches, which is the safe side).
//   Drive-relative paths (C:data) and NT object paths (\??\...) are refused earlier, in protectedCandidate.
//   'foreign' UNC (\\server\share, \\?\UNC\...) and other device paths, which can alias local drives
//             (\\localhost\C$\...), plus anything we refuse to interpret: components of only dots/spaces, or ':' after
//             the drive (alternate data streams such as dir::$INDEX_ALLOCATION). Callers fail closed on 'foreign'.
function win32Form(value) {
  let text = String(value || '');
  if (path.sep !== '\\') return { kind: 'drive', path: path.resolve(text) };
  text = text.replace(/\//g, '\\');
  const device = text.match(/^\\\\[?.]\\([A-Za-z]:)(\\.*)?$/);
  if (device) text = `${device[1]}${device[2] || '\\'}`;
  if (!/^[A-Za-z]:(\\|$)/.test(text)) return { kind: 'foreign', path: text };
  const parts = text.split('\\'); const cleaned = [parts[0]];
  for (const part of parts.slice(1)) {
    if (part === '' || part === '.' || part === '..') { cleaned.push(part); continue; }
    const trimmed = part.replace(/[. ]+$/, '');
    if (!trimmed || trimmed.includes(':')) return { kind: 'foreign', path: text };
    cleaned.push(trimmed);
  }
  return { kind: 'drive', path: path.resolve(`${cleaned.join('\\')}${cleaned.length === 1 ? '\\' : ''}`) };
}

// Shortest trailing part of each root that no other root shares, e.g. C:\Codex vs Documents\Codex.
function rootLabels(roots) {
  const parts = roots.map(root => root.split(/[\\/]+/).filter(Boolean));
  return parts.map((segments, index) => {
    for (let n = 1; n <= segments.length; n++) {
      const label = segments.slice(-n).join(path.sep);
      if (!parts.some((other, j) => j !== index && other.slice(-n).join(path.sep).toLowerCase() === label.toLowerCase())) return label;
    }
    return roots[index];
  });
}
// History for the browser: only the item kinds the UI renders, with very large outputs cut (a 27 MiB turn is mostly
// tool output). Image parts keep their local path only (never inline data).
function clipText(value, limit, label) {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > limit ? `${text.slice(0, limit)}\n… (${label} ${text.length.toLocaleString('en-US')}자 중 앞 ${limit.toLocaleString('en-US')}자만 표시)` : text;
}
function publicItem(item) {
  if (!item || typeof item !== 'object') return null;
  const base = { id: item.id != null ? String(item.id) : null, type: item.type };
  if (item.type === 'userMessage') {
    const content = (Array.isArray(item.content) ? item.content : []).map(part => {
      if (part?.type === 'text') return { type: 'text', text: clipText(part.text, TURN_TEXT_LIMIT, '메시지') };
      if (part?.type === 'localImage' || part?.type === 'image') return { type: part.type, path: typeof part.path === 'string' ? part.path : null };
      return null;
    }).filter(Boolean);
    return { ...base, content };
  }
  if (item.type === 'agentMessage') return { ...base, text: clipText(item.text ?? (Array.isArray(item.content) ? item.content.map(part => part?.text || '').join('') : ''), TURN_TEXT_LIMIT, '응답') };
  if (item.type === 'commandExecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : item.command;
    return { ...base, command: clipText(command, TURN_OUTPUT_LIMIT, '명령'), status: item.status ?? null, exitCode: item.exitCode ?? null, aggregatedOutput: clipText(item.aggregatedOutput ?? item.output ?? '', TURN_OUTPUT_LIMIT, '출력') };
  }
  if (item.type === 'fileChange') {
    const changes = (Array.isArray(item.changes) ? item.changes : []).map(change => typeof change === 'string' ? { path: clipText(change, 1000, '경로') } : { path: change?.path != null ? String(change.path) : null, diff: change?.diff != null ? clipText(change.diff, TURN_DIFF_LIMIT, '변경 내용') : undefined });
    return { ...base, status: item.status ?? null, changes };
  }
  return null;
}
// view: 'full' | 'summary' (partial: user text + replies only) | 'notLoaded' (unavailable: too large to show at all).
function publicTurn(turn, view = 'full') {
  const out = { id: turn?.id != null ? String(turn.id) : null, status: turn?.status ?? null, items: view === 'notLoaded' ? [] : (Array.isArray(turn?.items) ? turn.items : []).map(publicItem).filter(Boolean) };
  if (turn?.error) out.error = { message: clipText(turn.error.message ?? turn.error, 2000, '오류') };
  if (view === 'summary') out.partial = true;
  if (view === 'notLoaded') out.unavailable = true;
  return out;
}

// Unexpected-error log line: one line, bounded, with credential-looking values removed.
// Long runs that look like encoded secrets. Plain paths (file:///C:/Codex/Projects/...) are kept: a run is redacted
// only if it has no '/' at all, or carries base64 markers ('+', '=' padding), or has a mixed-case+digit segment ≥ 20.
// When in doubt this redacts (a hidden secret matters more than a readable log).
function opaqueRun(run) {
  if (/[+]|=$/.test(run)) return true;
  if (!run.includes('/')) {
    // Codex rollout file names (rollout-YYYY-MM-DDTHH-MM-SS-<uuid>) and digit-free kebab/snake identifiers made of
    // short words are not secrets; anything else of this length is.
    if (/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+-?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run)) return false;
    if (!/\d/.test(run) && /[-_]/.test(run) && run.split(/[-_]+/).every(part => part.length <= 24)) return false;
    return true;
  }
  return run.split('/').some(segment => segment.length >= 20 && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && /\d/.test(segment));
}
const SECRET_KEY = String.raw`(password|passwd|pass\s?phrase|secret|client[ _-]?secret|token|access[ _-]?token|refresh[ _-]?token|cookie|authorization|api[ _-]?key|access[ _-]?key|private[ _-]?key|session[ _-]?key|csrf|salt|hash)`;
export function sanitizeForLog(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ')
    // ESC and other C0/C1 controls could rewrite the operator's terminal; bidi controls could disguise the line.
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    // user:password@ in URLs
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/@]+@/gi, '$1[redacted]@')
    .replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    // key = "quoted value with spaces"
    .replace(new RegExp(`${SECRET_KEY}(["']?\\s*[=:]\\s*)(["'])(?:(?!\\3).)*\\3`, 'gi'), '$1$2$3[redacted]$3')
    .replace(new RegExp(`${SECRET_KEY}(["']?\\s*[=:]\\s*["']?)(?!(?:bearer|basic|token) \\[redacted\\])(?!["']?\\[redacted\\])[^\\s"',;}]+`, 'gi'), '$1$2[redacted]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, run => opaqueRun(run) ? '[redacted]' : run)
    .slice(0, 300);
}

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
  // runtimeDir: folder of the runtime config (password hash, session key; main() passes it). It and config.uploadDir
  // are protected: tasks whose cwd overlaps them cannot be resumed and approvals inside them are refused.
  constructor(config, { appServer, now = () => Date.now(), runtimeDir = null } = {}) {
    this.config = config;
    this.now = now;
    if (runtimeDir != null && (typeof runtimeDir !== 'string' || !path.isAbsolute(runtimeDir))) throw new Error('runtimeDir must be an absolute path');
    this.runtimeDir = runtimeDir;
    this.publicOrigin = normalizeOrigin(config.publicOrigin);
    const hostname = new URL(this.publicOrigin).hostname;
    const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(config.bindHost || '127.0.0.1')) throw new Error('Remote server must bind to loopback');
    if (new URL(this.publicOrigin).protocol !== 'https:' && !loopback) throw new Error('Production publicOrigin must use HTTPS');
    this.secureCookie = new URL(this.publicOrigin).protocol === 'https:';
    if (config.resumeRoots != null && (!Array.isArray(config.resumeRoots) || config.resumeRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root)))) throw new Error('resumeRoots must be an array of absolute paths');
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
    this.completedTurns = new Set();
    this.itemContexts = new Map();
    this.uploads = config.uploadDir ? new UploadStore({ root: config.uploadDir, limits: config.uploadLimits || {}, now }) : null;
    this.app = appServer || new AppServer(config);
    this.approvalSources = new Map();
    this.app.on('status', event => { if (!event.connected) { this.controlledThreads.clear(); this.activeTurns.clear(); this.threadProjects.clear(); this.pendingApprovals.clear(); this.approvalSources.clear(); } this.event('connection', event); });
    this.app.on('notification', event => this.receiveNotification(event));
    this.app.on('unsupportedRequest', event => this.event('unsupported', event));
    this.app.on('protocolError', error => process.stderr.write(`[app-server] ${sanitizeForLog(error?.message || error)}\n`));
    this.app.on('serverRequest', event => this.receiveApproval(event));
    this.app.on('serverRequestResolved', event => { this.pendingApprovals.delete(event.id); this.approvalSources.delete(String(event.id)); this.event('approvalResolved', event); });
    this.server = http.createServer((req, res) => this.handle(req, res).catch(error => this.fail(res, error, req)));
    // Bounded on purpose: a 20 MiB upload needs roughly 35 KB/s sustained to finish inside this window.
    this.server.requestTimeout = REQUEST_TIMEOUT;
  }

  event(type, data) {
    const entry = { cursor: ++this.cursor, at: this.now(), type, data };
    this.events.push(entry);
    if (this.events.length > EVENT_LIMIT) this.events.shift();
  }

  async start() {
    if (this.uploads) {
      await this.uploads.init(this.config.allowedRoots || []);
      await this.maintainUploads('startup');
      this.sweepTimer = setInterval(() => this.maintainUploads('interval'), 10 * 60_000); this.sweepTimer.unref();
    }
    try { await this.app.connect(); }
    catch (error) { this.app.close(); clearInterval(this.sweepTimer); throw error; }
    return new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.config.port, this.config.bindHost || '127.0.0.1', () => { this.server.off('error', reject); resolve(); }); });
  }
  async stop() { clearInterval(this.sweepTimer); this.app.close(); this.server.closeAllConnections?.(); return new Promise(resolve => this.server.close(resolve)); }
  address() { return this.server.address(); }

  // Upload index persistence failures are reported (event + stderr), never silently dropped; cleanup failing must
  // not block startup or unrelated uploads, and the next successful write carries the in-memory state.
  reportUploadError(context, error) {
    const message = String(error?.message || error).slice(0, 300);
    this.event('uploadStorageError', { context, message });
    process.stderr.write(`[uploads] ${context}: ${message}\n`);
  }
  async maintainUploads(context) { try { await this.sweepUploads(); } catch (error) { this.reportUploadError(`sweep/${context}`, error); } }

  fail(res, error, req) {
    // A response larger than the bridge accepts is dropped there; only that request fails (502), the connection stays.
    const status = error?.status || (error?.tooLarge ? 502 : 500);
    // Deliberate statuses (4xx, upload 503/507) are expected answers; anything without one is unexpected and logged.
    if (!error?.status) this.reportUnexpected(req, status, error);
    if (res.headersSent) { res.destroy(); return; }
    const message = status === 500 ? 'Internal server error' : error?.tooLarge && !error.status ? 'Codex response is too large' : error.message;
    json(res, status, { error: message, ...(error?.errorCode ? { code: error.errorCode } : {}) });
  }

  // Unexpected failures were previously invisible (plain 500). Log one sanitized line: route, status, message, RPC code.
  reportUnexpected(req, status, error) {
    let route = '?';
    try { route = `${req?.method || '?'} ${new URL(req?.url || '/', 'http://local').pathname}`; } catch { /* keep ? */ }
    const frame = String(error?.stack || '').split('\n').find(line => line.trim().startsWith('at '))?.trim() || '';
    const detail = [error?.rpcError ? `rpc ${error.code ?? '?'}` : '', frame ? sanitizeForLog(frame).slice(0, 160) : ''].filter(Boolean).join(' | ');
    process.stderr.write(`[server] ${status} ${sanitizeForLog(route).slice(0, 120)}: ${sanitizeForLog(error?.message || error)}${detail ? ` (${detail})` : ''}\n`);
  }

  expectedHost() { return new URL(this.publicOrigin).host; }
  checkHost(req) { return safeEqual(req.headers.host || '', this.expectedHost()); }
  checkOrigin(req) { return safeEqual(req.headers.origin || '', this.publicOrigin); }
  securityHeaders() {
    return {
      // blob: images only, for local thumbnails of files the user just picked (never fetched from elsewhere).
      'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'",
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
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      this.sessions.delete(session.id);
      if (this.uploads) await this.uploads.discardOwner(idKey(session.id)).catch(error => this.reportUploadError('logout', error));
      return json(res, 200, { ok: true }, { ...this.securityHeaders(), 'set-cookie': 'crw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (url.pathname === '/api/uploads' && req.method === 'GET') return this.listUploads(res, url, session);
    if (url.pathname === '/api/uploads' && req.method === 'POST') return this.receiveUpload(req, res, session);
    if (url.pathname === '/api/uploads/check' && req.method === 'POST') return this.checkUpload(res, await body(req), session);
    const uploadMatch = url.pathname.match(/^\/api\/uploads\/([A-Za-z0-9_-]{22})(\/content)?$/);
    if (uploadMatch && !uploadMatch[2] && req.method === 'DELETE') return this.removeUpload(res, uploadMatch[1], session);
    if (uploadMatch && uploadMatch[2] && req.method === 'GET') return this.uploadContent(res, uploadMatch[1], session);
    if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, this.state(Number(url.searchParams.get('cursor') || 0), session), this.securityHeaders());
    if (url.pathname === '/api/projects' && req.method === 'GET') return json(res, 200, { projects: await this.listProjects() }, this.securityHeaders());
    if (url.pathname === '/api/models' && req.method === 'GET') return json(res, 200, { models: await this.listModels() }, this.securityHeaders());
    if (url.pathname === '/api/tasks' && req.method === 'GET') return json(res, 200, await this.listTasks(), this.securityHeaders());
    if (url.pathname === '/api/tasks/read' && req.method === 'POST') return this.readThread(res, await body(req));
    if (url.pathname === '/api/tasks/turns' && req.method === 'POST') return this.readTurns(res, await body(req));
    if (url.pathname === '/api/tasks/start' && req.method === 'POST') return this.startThread(res, await body(req));
    if (url.pathname === '/api/tasks/resume' && req.method === 'POST') return this.resumeThread(res, await body(req));
    if (url.pathname === '/api/turns/start' && req.method === 'POST') return this.startTurn(res, await body(req), session);
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

  // Opening and resuming are judged by the thread's own recorded cwd (thread/read), not by membership in the task
  // list page, so any in-scope task can be opened by ID. Out-of-scope data is never returned (403).
  // Metadata-only read (includeTurns:false, ~1 KB even for 50 MiB rollouts); history comes from readTurns.
  async readScopedThread(threadId) {
    // Any listed-or-not ID now reaches Codex, so only plain ID characters are forwarded.
    if (!THREAD_ID.test(threadId)) throw httpError(404, 'Thread not found');
    let result;
    try { result = await this.app.request('thread/read', { threadId, includeTurns: false }); }
    catch (error) {
      if (error?.rpcError && THREAD_MISSING.test(String(error.message))) throw httpError(404, 'Thread not found');
      if (error?.rpcError) { this.reportUpstream('thread/read', error); throw httpError(502, 'Codex could not read this task', 'read_failed'); }
      throw error;
    }
    const thread = result?.thread || result || {};
    const scope = await this.threadScope(thread.cwd || thread.workspace?.cwd, await this.scopeRoots());
    return { result, thread, scope };
  }

  // Codex answered with an error we map to a deliberate status; still worth one sanitized stderr line.
  reportUpstream(method, error) { process.stderr.write(`[server] ${sanitizeForLog(method)} rejected: ${sanitizeForLog(error?.message || error)}${error?.code != null ? ` (rpc ${sanitizeForLog(error.code)})` : ''}\n`); }

  // Scope for open/history: in-scope cwd, or a thread this server started/resumed (cwd may not be persisted yet).
  async readableThread(params) {
    const threadId = String(params.threadId || '');
    if (!threadId) throw httpError(400, 'threadId is required');
    const read = await this.readScopedThread(threadId);
    if (!read.scope && !this.threadProjects.has(threadId)) throw httpError(403, 'Thread is not in an allowed project');
    return { threadId, ...read };
  }

  async readThread(res, params) {
    const { threadId, thread, scope } = await this.readableThread(params);
    this.event('commandCompleted', { method: 'thread/read', ok: true });
    const access = { location: scope?.location || null, folderMissing: scope ? !scope.exists : false, protected: Boolean(scope?.protected), status: this.threadState(thread), lock: await this.writerLock(threadId) };
    // Only what the UI can use; the raw Thread (rollout path, gitInfo, environments, …) stays on the server.
    const summary = { id: thread.id != null ? String(thread.id) : threadId, name: typeof thread.name === 'string' ? thread.name.slice(0, TASK_TEXT_LIMIT) : null, status: this.threadState(thread) || null };
    return json(res, 200, { result: { thread: summary }, access }, this.securityHeaders());
  }

  // One page of history, newest turns first from Codex, returned oldest→newest for rendering. Never fails because a
  // page is too large: 5 turns → 1 turn → that turn in summary view (partial) → that turn with items not loaded
  // (unavailable placeholder, but its cursor lets older history continue). Only if even that fails: 502.
  async readTurns(res, params) {
    if (params.cursor != null && typeof params.cursor !== 'string') throw httpError(400, 'Invalid history cursor');
    const { threadId } = await this.readableThread(params);
    const cursor = params.cursor ? params.cursor : null;
    if (cursor != null && cursor.length > 4096) throw httpError(400, 'Invalid history cursor');
    const page = async (limit, itemsView) => {
      const request = { threadId, limit, itemsView, sortDirection: 'desc' };
      if (cursor) request.cursor = cursor;
      return this.app.request('thread/turns/list', request);
    };
    let result = null; let usedView = 'full';
    try {
      for (const [limit, view] of [[TURN_PAGE_SIZE, 'full'], [1, 'full'], [1, 'summary'], [1, 'notLoaded']]) {
        try { result = await page(limit, view); usedView = view; break; }
        catch (error) { if (!error?.tooLarge || view === 'notLoaded') throw error; }
      }
    } catch (error) {
      if (error?.rpcError && error.code === -32600 && NO_HISTORY_YET.test(String(error.message))) return json(res, 200, { turns: [], nextCursor: null, empty: true }, this.securityHeaders());
      if (error?.rpcError && THREAD_MISSING.test(String(error.message))) throw httpError(404, 'Thread not found');
      if (error?.rpcError) { this.reportUpstream('thread/turns/list', error); throw httpError(502, 'Codex could not read this task', 'read_failed'); }
      throw error;
    }
    const turns = (Array.isArray(result?.data) ? result.data : []).map(turn => publicTurn(turn, usedView)).reverse();
    // A cursor that comes back unchanged would loop the "older history" button forever.
    const next = typeof result?.nextCursor === 'string' && result.nextCursor && result.nextCursor !== cursor ? result.nextCursor : null;
    return json(res, 200, { turns, nextCursor: next }, this.securityHeaders());
  }

  async resumeThread(res, params) {
    const threadId = String(params.threadId || '');
    if (!threadId) throw httpError(400, 'threadId is required');
    const { thread, scope } = await this.readScopedThread(threadId);
    if (!scope) throw httpError(403, 'Thread is not in an allowed project');
    // The panel's own runtime data (config, password hash, session key, uploads) must never fall inside a resumed cwd.
    if (scope.protected) throw httpError(409, PROTECTED_MESSAGE, 'thread_scope_protected');
    // Approvals are limited to the resumed cwd (assertAllowedApprovalCwd), which needs a real folder to anchor to.
    if (!scope.exists) throw httpError(409, FOLDER_MISSING_MESSAGE, 'thread_folder_missing');
    if (['active', 'running', 'in_progress', 'busy'].includes(this.threadState(thread)) && !this.controlledThreads.has(threadId)) throw httpError(409, 'Active thread cannot be taken over');
    let result;
    // excludeTurns: the UI pages history separately; full-history hydration is deprecated and can exceed the line limit.
    try { result = await this.app.request('thread/resume', { threadId, excludeTurns: true }); }
    catch (error) {
      if (error?.rpcError && ACTIVE_WRITER.test(String(error.message))) {
        this.event('resumeBlocked', { threadId, reason: 'active writer' });
        throw httpError(409, LOCKED_MESSAGE, 'thread_locked');
      }
      if (error?.rpcError) throw httpError(422, `Codex가 이어가기를 거부했습니다: ${String(error.message).slice(0, 300)}`, 'resume_rejected');
      throw error;
    }
    this.controlledThreads.add(threadId);
    this.threadProjects.set(threadId, scope.path);
    this.event('commandCompleted', { method: 'thread/resume', threadId, ok: true });
    return json(res, 200, { result }, this.securityHeaders());
  }

  threadState(thread) { return String(thread?.status?.type || thread?.status || thread?.turn?.status?.type || thread?.turn?.status || '').toLowerCase(); }

  async startTurn(res, params, session) {
    const requestId = String(params.requestId || ''); const threadId = String(params.threadId || ''); const prompt = String(params.prompt || '');
    const attachmentIds = params.attachments == null ? [] : params.attachments;
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 5 || attachmentIds.some(id => typeof id !== 'string' || !UPLOAD_ID.test(id)) || new Set(attachmentIds).size !== attachmentIds.length) throw Object.assign(new Error('Invalid attachment list'), { status: 400 });
    if (attachmentIds.length && !this.uploads) throw Object.assign(new Error('Uploads are not configured'), { status: 400 });
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(requestId) || !threadId || (!prompt && !attachmentIds.length) || Buffer.byteLength(prompt) > 16 * 1024) throw Object.assign(new Error('Invalid turn request'), { status: 400 });
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
    const digest = idKey(JSON.stringify([threadId, prompt, model || '', effort || '', attachmentIds]));
    const replay = () => {
      const prior = this.idempotency.get(requestId); if (!prior) return false;
      if (prior.digest !== digest) throw Object.assign(new Error('requestId conflicts with a different turn'), { status: 409 });
      json(res, prior.status, prior.body, this.securityHeaders()); return true;
    };
    if (replay()) return;
    let attachments = [];
    if (attachmentIds.length) {
      attachments = await this.uploads.resolveForTurn(attachmentIds, idKey(session.id), threadId, this.threadProjects.get(threadId));
      if (replay()) return;
      this.uploads.claim(attachments);
    }
    this.idempotency.set(requestId, { digest, status: 202, body: { status: 'dispatching' }, expires: this.now() + 10 * 60_000 });
    let outcome = 'uncertain';
    try {
      const input = prompt ? [{ type: 'text', text: prompt }] : [];
      if (attachments.length) input.push(...this.uploads.turnInput(attachments, Boolean(prompt)));
      const turnParams = { threadId, input };
      if (model) turnParams.model = model;
      const defaultEffort = choice?.supportedReasoningEfforts.some(value => value.reasoningEffort === choice.defaultReasoningEffort) ? choice.defaultReasoningEffort : null;
      if (effort || defaultEffort) turnParams.effort = effort || defaultEffort;
      const result = await this.app.request('turn/start', turnParams); outcome = 'sent';
      // Register the turn now so 중단 works before the turn/started notification arrives.
      const startedId = result?.turn?.id || result?.id || result?.turnId;
      if (startedId) this.markTurnActive(threadId, String(startedId));
      const response = { result }; this.idempotency.set(requestId, { digest, status: 200, body: response, expires: this.now() + 10 * 60_000 });
      this.event('commandCompleted', { method: 'turn/start', threadId, ok: true });
      return json(res, 200, response, this.securityHeaders());
    } catch (error) {
      if (error?.rpcError) {
        // The App Server answered turn/start with a JSON-RPC error: no turn was started.
        outcome = 'rejected';
        const response = { error: `Codex가 요청을 거부했습니다: ${String(error.message).slice(0, 300)}`, rejected: true };
        this.idempotency.set(requestId, { digest, status: 422, body: response, expires: this.now() + 10 * 60_000 });
        return json(res, 422, response, this.securityHeaders());
      }
      const response = { error: 'Turn dispatch failed; status is uncertain and will not be retried automatically', uncertain: true };
      this.idempotency.set(requestId, { digest, status: 409, body: response, expires: this.now() + 10 * 60_000 });
      return json(res, 409, response, this.securityHeaders());
    } finally {
      // Uncertain attachments stay on disk and are marked attempted: Codex may already reference them.
      if (attachments.length) await this.uploads.settle(attachments, outcome).catch(error => this.reportUploadError('settle', error));
    }
  }

  async sweepUploads() {
    if (!this.uploads) return 0;
    this.expireSessions();
    return this.uploads.sweep(new Set([...this.sessions.keys()].map(idKey)), new Set(this.controlledThreads));
  }

  listUploads(res, url, session) {
    const payload = { enabled: Boolean(this.uploads), limits: null, types: [...Object.keys(UPLOAD_TYPES), 'jpeg'], attachments: [] };
    if (this.uploads) {
      const { fileBytes, messageFiles, messageBytes } = this.uploads.limits; payload.limits = { fileBytes, messageFiles, messageBytes };
      payload.storage = this.uploads.storage();
      const threadId = url.searchParams.get('threadId');
      if (threadId) payload.attachments = this.uploads.list(idKey(session.id), threadId).map(publicAttachment);
    }
    return json(res, 200, payload, this.securityHeaders());
  }

  uploadTarget(threadId) {
    if (!this.uploads) throw Object.assign(new Error('이 서버에는 업로드 저장소가 구성되지 않았습니다.'), { status: 503 });
    const project = this.threadProjects.get(threadId);
    if (!threadId || !this.controlledThreads.has(threadId) || !project) throw Object.assign(new Error('이 작업을 이어가기 한 뒤 파일을 첨부할 수 있습니다.'), { status: 409 });
    return project;
  }

  // Optional metadata-only preflight so predictable rejections arrive as normal JSON before any file bytes are sent.
  // It reserves nothing; the real upload repeats every check.
  async checkUpload(res, params, session) {
    this.uploadTarget(String(params.threadId || ''));
    const size = Number(params.size);
    if (!Number.isSafeInteger(size)) throw Object.assign(new Error('파일 크기를 확인할 수 없습니다.'), { status: 400 });
    await this.maintainUploads('check');
    const { name, type } = this.uploads.precheck({ owner: idKey(session.id), threadId: String(params.threadId), name: String(params.name || ''), declaredType: String(params.type || ''), length: size });
    return json(res, 200, { ok: true, name, type: type.ext, label: type.label, storage: this.uploads.storage() }, this.securityHeaders());
  }

  async receiveUpload(req, res, session) {
    try {
      const threadId = String(req.headers['x-upload-thread'] || ''); const project = this.uploadTarget(threadId);
      const lengthHeader = String(req.headers['content-length'] || '');
      if (req.headers['transfer-encoding'] || !/^\d{1,12}$/.test(lengthHeader)) throw Object.assign(new Error('파일 크기 정보(Content-Length)가 필요합니다.'), { status: 411 });
      let name; try { name = decodeURIComponent(String(req.headers['x-upload-name'] || '')); } catch { throw Object.assign(new Error('파일 이름을 읽을 수 없습니다.'), { status: 400 }); }
      await this.maintainUploads('upload');
      const owner = idKey(session.id);
      const entry = await this.uploads.receive(req, { owner, threadId, project, name, declaredType: req.headers['content-type'], length: Number(lengthHeader) });
      if (res.destroyed || req.socket?.destroyed) {
        // The client is gone and will never learn this ID; do not leave a hidden staged file consuming its quota.
        await this.uploads.remove(entry.id, owner).catch(error => this.reportUploadError('discard-undelivered', error));
        return;
      }
      return json(res, 201, { attachment: publicAttachment(entry) }, this.securityHeaders());
    } catch (error) {
      // An unread upload body must not be parsed as the next request on this connection.
      if (!req.complete) res.setHeader('connection', 'close');
      throw error;
    }
  }

  async removeUpload(res, id, session) {
    if (!this.uploads) throw Object.assign(new Error('Route not found'), { status: 404 });
    const result = await this.uploads.remove(id, idKey(session.id));
    return json(res, 200, { ok: true, ...result }, this.securityHeaders());
  }

  async uploadContent(res, id, session) {
    const entry = this.uploads?.lookup(id, idKey(session.id));
    if (!entry || !UPLOAD_TYPES[entry.ext].image) return json(res, 404, { error: 'Not found' }, this.securityHeaders());
    let file; try { file = await this.uploads.verifyFile(entry); } catch { return json(res, 404, { error: 'Not found' }, this.securityHeaders()); }
    const encoded = encodeURIComponent(entry.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    res.writeHead(200, {
      ...this.securityHeaders(),
      'content-type': UPLOAD_TYPES[entry.ext].mime, 'content-length': entry.size, 'cache-control': 'private, no-store',
      'content-disposition': `inline; filename="attachment.${entry.ext}"; filename*=UTF-8''${encoded}`,
      'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin'
    });
    await pipeline(createReadStream(file), res).catch(() => res.destroy());
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

  // Active turn IDs only ever come from the App Server (turn/start result or turn/started), never from the client.
  // Completed IDs are remembered briefly so a reordered start result/notification cannot resurrect a finished turn.
  markTurnActive(threadId, turnId) { if (!this.completedTurns.has(turnId)) this.activeTurns.set(threadId, turnId); }
  rememberCompleted(turnId) {
    this.completedTurns.add(turnId);
    if (this.completedTurns.size > 1000) this.completedTurns.delete(this.completedTurns.values().next().value);
  }

  async interruptTurn(res, params) {
    const threadId = String(params.threadId || ''); const turnId = this.activeTurns.get(threadId);
    if (!this.controlledThreads.has(threadId) || !turnId) throw Object.assign(new Error('No controlled active turn to interrupt'), { status: 409 });
    // The client may name the turn it saw; it is only compared, so a stale click cannot stop a newer turn.
    if (params.turnId != null && String(params.turnId) !== turnId) throw Object.assign(new Error('The running turn changed; refresh and try again'), { status: 409 });
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
    // Even inside a controlled task, nothing runs from the panel's runtime/upload folders.
    const dirs = await this.protectedDirs();
    if (dirs.some(dir => hasPrefix(resolved, dir)) || await this.touchesProtected(candidate, resolved, 'inside', dirs)) throw Object.assign(new Error('Approval cwd is inside the web panel data folder'), { status: 403, protectedFolder: true });
    return resolved;
  }

  // Comparable real path for a protected-folder check (relative values resolved against base), or null when the
  // value cannot be compared safely (see win32Form).
  async protectedCandidate(value, base) {
    let text = String(value || '');
    // Drive-relative (C:data\x: Win32 resolves it against that drive's current directory, i.e. the process cwd) and NT
    // object paths (\??\C:\..., \??\UNC\...) cannot be tied to the approval cwd: refuse to compare (fail closed).
    if (path.sep === '\\' && (/^[A-Za-z]:(?![\\/])/.test(text) || /^[\\/]\?\?[\\/]/.test(text))) return null;
    if (!/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(text)) text = path.resolve(base || process.cwd(), text);
    const form = win32Form(text);
    return form.kind === 'foreign' ? null : loosePath(form.path);
  }

  // mode 'inside': value lies in a protected folder; 'overlap': also when it is an ancestor of one. A value that cannot
  // be compared (UNC/device/odd names) counts as touching whenever a protected folder is on a local drive.
  async touchesProtected(value, base, mode, dirs) {
    if (!dirs.length) return false;
    const candidate = await this.protectedCandidate(value, base);
    if (candidate == null) return dirs.some(dir => /^[A-Za-z]:/.test(dir)) || path.sep !== '\\';
    return mode === 'inside' ? dirs.some(dir => hasPrefix(candidate, dir)) : this.overlapsProtected(candidate, dirs);
  }

  // Real paths of the configured roots that exist right now. allowedRoots: direct child folders are projects (as for
  // new tasks). resumeRoots: any folder at any depth, the root itself included, may be listed, opened and resumed.
  async scopeRoots() {
    const real = async list => {
      const out = [];
      for (const root of list || []) { if (!existsSync(root)) continue; try { out.push(await realpath(root)); } catch { /* skip */ } }
      return out;
    };
    const resume = await real(this.config.resumeRoots);
    const labels = rootLabels(resume);
    return { allowed: await real(this.config.allowedRoots), resume: resume.map((root, index) => ({ path: root, label: labels[index] })), protected: await this.protectedDirs() };
  }

  // Runtime config folder and upload store, as real paths (a folder that does not exist yet is judged by its nearest
  // existing ancestor plus the rest, like task cwds).
  async protectedDirs() {
    const out = [];
    for (const dir of [this.runtimeDir, this.config.uploadDir]) {
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) continue;
      const form = win32Form(path.resolve(dir));
      out.push(await loosePath(form.kind === 'drive' ? form.path : path.resolve(dir)));
    }
    return out;
  }

  // Same folder, an ancestor of a protected folder, or inside one.
  overlapsProtected(candidate, dirs) { return dirs.some(dir => hasPrefix(candidate, dir) || hasPrefix(dir, candidate)); }

  // → { path, exists, location, protected } when the cwd is in scope, otherwise null. protected: the cwd overlaps the
  // panel's runtime/upload folders, so it may be listed and read but not resumed.
  async threadScope(rawCwd, roots) {
    if (typeof rawCwd !== 'string' || !rawCwd) return null;
    const lexical = plainPath(rawCwd);
    if (!path.isAbsolute(lexical)) return null;
    let resolved = null;
    try { resolved = await realpath(lexical); } catch { /* missing folder */ }
    // Judged on the real path and on the Win32-normalized recorded cwd (e.g. ...\data. is ...\data for Win32).
    const dirs = roots.protected || [];
    const mark = async scope => ({ ...scope, protected: this.overlapsProtected(scope.path, dirs) || await this.touchesProtected(rawCwd, null, 'overlap', dirs) });
    if (resolved) {
      let info; try { info = await stat(resolved); } catch { return null; }
      if (!info.isDirectory()) return null;
      for (const root of roots.allowed) if (path.dirname(resolved) === root) return mark({ path: resolved, exists: true, location: path.basename(resolved) });
    }
    const candidate = resolved || await loosePath(path.resolve(lexical));
    for (const root of roots.resume) {
      if (!hasPrefix(candidate, root.path)) continue;
      const relative = path.relative(root.path, candidate);
      return mark({ path: candidate, exists: Boolean(resolved), location: relative ? `${root.label}${path.sep}${relative}` : root.label });
    }
    return null;
  }

  codexHome() { return this.config.codexHome || process.env.CODEX_HOME || path.join(this.config.userProfile || os.homedir(), '.codex'); }

  // Best-effort hint only; thread/resume stays authoritative. Codex holds <CODEX_HOME>/thread-writer-locks/<id>.lock
  // with an OS lock while a process writes the thread; on Windows reading a locked file fails with EBUSY (verified
  // with the real binary). The file is only opened read-only, never created, changed or removed.
  async writerLock(threadId) {
    if (process.platform !== 'win32' || !THREAD_ID.test(threadId) || this.controlledThreads.has(threadId)) return null;
    const file = path.join(this.codexHome(), 'thread-writer-locks', `${threadId}.lock`);
    let handle;
    try { handle = await open(file, 'r'); } catch (error) { return error?.code === 'EBUSY' ? 'busy' : null; }
    try { await handle.read(Buffer.alloc(1), 0, 1, 0); return null; }
    catch (error) { return error?.code === 'EBUSY' ? 'busy' : null; }
    finally { await handle.close().catch(() => {}); }
  }

  publicTask(thread, scope, lock) {
    const clip = value => typeof value === 'string' && value ? value.slice(0, TASK_TEXT_LIMIT) : null;
    const time = value => Number.isFinite(value) ? value : null;
    return {
      id: String(thread.id), name: clip(thread.name), preview: clip(thread.preview) || '',
      cwd: scope.path, location: scope.location, folderMissing: !scope.exists, protected: Boolean(scope.protected),
      updatedAt: time(thread.recencyAt) ?? time(thread.updatedAt) ?? time(thread.createdAt),
      status: this.threadState(thread) || null, lock
    };
  }

  // Newest activity first (recency_at: the ordering key Codex documents for recency). The state DB listing is used
  // because the scan-and-repair listing was measured returning duplicate and missing threads across pages; if the state
  // DB yields nothing the scan listing is tried once. Bounded by TASK_MAX_PAGES and TASK_MAX_ITEMS; only the fields the
  // UI needs leave the server.
  async listTasks() {
    const roots = await this.scopeRoots();
    // truncated: 'items' = more in-scope tasks than the display cap; 'pages' = stopped scanning after the page cap, so
    // older in-scope tasks may exist but were not examined.
    let tasks = []; let truncated = null;
    for (const useStateDbOnly of [true, false]) {
      tasks = []; truncated = null;
      const seen = new Set(); const cursors = new Set(); let cursor = null; let raw = 0;
      for (let page = 0; ; page++) {
        const params = { limit: TASK_PAGE_SIZE, sortKey: 'recency_at', sortDirection: 'desc' };
        if (useStateDbOnly) params.useStateDbOnly = true;
        if (cursor) params.cursor = cursor;
        const result = await this.app.request('thread/list', params);
        const threads = Array.isArray(result) ? result : (result?.data || result?.threads || []);
        raw += threads.length;
        for (const thread of threads) {
          const id = thread?.id != null ? String(thread.id) : '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const scope = await this.threadScope(thread.cwd || thread.workspace?.cwd, roots);
          if (!scope) continue;
          if (tasks.length >= TASK_MAX_ITEMS) { truncated = 'items'; break; }
          tasks.push(this.publicTask(thread, scope, await this.writerLock(id)));
        }
        cursor = Array.isArray(result) ? null : result?.nextCursor || null;
        if (truncated || !cursor || cursors.has(cursor)) break;
        cursors.add(cursor);
        if (page + 1 >= TASK_MAX_PAGES) { truncated = 'pages'; break; }
      }
      if (!(useStateDbOnly && raw === 0)) break;
    }
    tasks.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return { tasks, truncated: Boolean(truncated), truncatedReason: truncated, limit: TASK_MAX_ITEMS, scanLimit: TASK_PAGE_SIZE * TASK_MAX_PAGES };
  }

  receiveNotification(event) {
    const params = event.params || {}; const threadId = String(params.threadId || params.thread?.id || params.item?.threadId || '');
    const item = params.item || {}; const itemId = String(params.itemId || item.id || '');
    if (event.method === 'item/started' && itemId && threadId && this.controlledThreads.has(threadId)) {
      this.itemContexts.set(itemId, { threadId, cwd: params.cwd || item.cwd || params.workspace?.cwd, item });
    }
    // The change list of a file-change item can grow after item/started; approvals must see the latest one.
    if (event.method === 'item/fileChange/patchUpdated' && itemId && threadId && this.controlledThreads.has(threadId) && Array.isArray(params.changes)) {
      const prior = this.itemContexts.get(itemId);
      this.itemContexts.set(itemId, { threadId, cwd: prior?.cwd, item: { ...(prior?.item || { id: itemId, type: 'fileChange' }), changes: params.changes } });
      this.refreshFileApprovals(itemId).catch(() => {});
    }
    if ((event.method === 'turn/started' || event.method === 'turn/completed') && threadId && this.controlledThreads.has(threadId)) {
      const turnId = params.turn?.id || params.turnId ? String(params.turn?.id || params.turnId) : '';
      if (event.method === 'turn/started' && turnId) this.markTurnActive(threadId, turnId);
      if (event.method === 'turn/completed') {
        if (turnId) this.rememberCompleted(turnId);
        // A late completion of an older turn must not clear a newer active one.
        if (!turnId || this.activeTurns.get(threadId) === turnId) this.activeTurns.delete(threadId);
      }
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
    this.verifyApproval(request.method, params, itemId, cwd, String(threadId)).then(({ item }) => {
      if (!this.app.incoming.has(String(request.id))) return;
      const approval = { id: request.id, method: request.method, threadId, cwd, display: this.approvalDisplay(request.method, params, item) || display, params: request.method.includes('requestUserInput') ? params : undefined };
      this.pendingApprovals.set(request.id, approval);
      this.approvalSources.set(String(request.id), { method: request.method, params, itemId, cwd, threadId: String(threadId) });
      this.event('approvalRequested', approval);
    }).catch(error => this.blockApproval(request.id, error));
  }

  blockApproval(id, error) {
    const protectedFolder = Boolean(error?.protectedFolder);
    this.pendingApprovals.delete(id); this.approvalSources.delete(String(id));
    this.app.failRequest(id, -32602, protectedFolder ? 'Approval is inside the web panel data folder' : 'Approval is outside allowed project roots');
    this.event('blockedApproval', { id, reason: protectedFolder ? 'protected folder' : 'outside allowed project' });
  }

  // cwd + target-path checks against the latest known change list; if item/fileChange/patchUpdated replaced the list
  // while checking, check again (bounded), so the card never shows a list that was not checked.
  async verifyApproval(method, params, itemId, cwd, threadId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const item = itemId ? this.itemContexts.get(itemId)?.item : undefined;
      const resolved = await this.assertAllowedApprovalCwd(cwd, threadId);
      await this.assertApprovalPaths(method, params, item, resolved);
      if ((itemId ? this.itemContexts.get(itemId)?.item : undefined) === item) return { item, resolved };
    }
    throw Object.assign(new Error('Approval changes did not settle'), { status: 403 });
  }

  // A pending file-change approval follows patchUpdated: re-checked against the new list, then shown with it (or refused).
  async refreshFileApprovals(itemId) {
    for (const [id, source] of this.approvalSources) {
      if (source.itemId !== itemId || source.method !== 'item/fileChange/requestApproval' || !this.pendingApprovals.has(id)) continue;
      try {
        const { item } = await this.verifyApproval(source.method, source.params, itemId, source.cwd, source.threadId);
        const pending = this.pendingApprovals.get(id); const display = this.approvalDisplay(source.method, source.params, item);
        if (!pending || !display) continue;
        const approval = { ...pending, display }; this.pendingApprovals.set(id, approval); this.event('approvalUpdated', approval);
      } catch (error) { if (this.pendingApprovals.has(id)) this.blockApproval(id, error); }
    }
  }

  // File-change approvals: every target path (changes[].path, move targets, path fields; relative ones resolved against
  // the approval cwd) and a requested grantRoot are compared with the protected folders, not only the cwd.
  async assertApprovalPaths(method, params, item, cwd) {
    if (method !== 'item/fileChange/requestApproval') return;
    const targets = []; const roots = [];
    const addChange = change => {
      if (typeof change === 'string') { const first = change.split('\n')[0].trim(); if (first) targets.push(first); return; }
      if (!change || typeof change !== 'object') return;
      for (const value of [change.path, change.movePath, change.move_path, change.kind?.movePath, change.kind?.move_path]) if (typeof value === 'string' && value) targets.push(value);
    };
    for (const list of [params.changes, params.files, params.item?.changes, params.item?.files, item?.changes, item?.files]) if (Array.isArray(list)) list.forEach(addChange);
    for (const value of [params.path, params.item?.path, item?.path]) if (typeof value === 'string' && value) targets.push(value);
    if (typeof params.grantRoot === 'string' && params.grantRoot) roots.push(params.grantRoot);
    const dirs = await this.protectedDirs();
    for (const target of targets) if (await this.touchesProtected(target, cwd, 'inside', dirs)) throw Object.assign(new Error('Approval changes files inside the web panel data folder'), { status: 403, protectedFolder: true });
    for (const root of roots) if (await this.touchesProtected(root, cwd, 'overlap', dirs)) throw Object.assign(new Error('Approval grant root overlaps the web panel data folder'), { status: 403, protectedFolder: true });
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
    const files = new Map([['/', 'index.html'], ['/app.js', 'app.js'], ['/styles.css', 'styles.css'], ['/icon.svg', 'icon.svg'], ['/ui-core.js', 'ui-core.js'], ['/dispatch-state.js', 'dispatch-state.js']]);
    const file = files.get(pathname); if (!file) return text(res, 404, 'Not found', this.securityHeaders());
    const content = await readFile(path.join(ROOT, 'public', file));
    const type = file.endsWith('.js') ? 'application/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', ...this.securityHeaders() }); res.end(content);
  }
}

async function main() {
  const configPath = process.env.CODEX_REMOTE_CONFIG || path.join(process.env.CODEX_REMOTE_DATA_DIR || 'C:\\Codex\\Apps\\CodexRemoteWeb\\data', 'runtime-config.json');
  const config = await loadConfig(configPath);
  // Attachments default to a private folder beside the runtime config (the setup-secured data directory).
  if (config.uploadDir === undefined) config.uploadDir = path.join(path.dirname(path.resolve(configPath)), 'uploads');
  const server = new RemoteServer(config, { runtimeDir: path.dirname(path.resolve(configPath)) });
  await server.start();
  process.on('SIGINT', () => server.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => server.stop().then(() => process.exit(0)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`Startup failed: ${error.message}\n`); process.exitCode = 1; });
