import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

// Longest accepted JSONL line, in UTF-16 code units. thread/read (full history) and thread/list pages carry untrimmed
// previews and outputs, so 1 MiB was reachable in normal use (a measured 50-thread page was ~83 K). A longer line is
// discarded on its own and only the request it answers fails (tooLarge); the connection is never dropped for it.
export const MAX_LINE = 16 * 1024 * 1024;
// Responses are serialized as {"id":…,"result":…} (verified against the real binary), so the id is at the front.
const LEADING_ID = /^\s*\{\s*"id"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+)/;

export class AppServer extends EventEmitter {
  constructor(config, { spawnImpl = spawn, maxLine = MAX_LINE } = {}) {
    super();
    this.config = config;
    this.spawnImpl = spawnImpl;
    this.maxLine = maxLine;
    this.discarding = false;
    this.child = null;
    this.sequence = 0;
    this.pending = new Map();
    this.incoming = new Map();
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.stderr = '';
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    const command = this.config.codexExe || 'codex';
    const args = this.config.transport === 'proxy' ? ['app-server', 'proxy'] : ['app-server'];
    const env = { ...process.env };
    if (this.config.codexHome) env.CODEX_HOME = this.config.codexHome;
    if (this.config.userProfile) { env.USERPROFILE = this.config.userProfile; env.HOME = this.config.userProfile; }
    this.child = this.spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.child.stdout.on('data', (chunk) => this.#read(this.decoder.write(chunk)));
    this.child.stdout.on('end', () => this.#read(this.decoder.end()));
    this.child.stderr.on('data', (chunk) => this.#stderr(chunk));
    this.child.on('error', (error) => this.#disconnect(error));
    this.child.on('exit', (code, signal) => this.#disconnect(new Error(`App Server exited (${code ?? signal})`)));
    await this.request('initialize', { clientInfo: { name: 'codex-remote-web', version: '0.1.0' } }, 10_000);
    this.notify('initialized', {});
    this.connected = true;
    this.emit('status', { connected: true });
  }

  async request(method, params = {}, timeout = 20_000) {
    if (!this.child || this.child.killed) throw new Error('App Server is unavailable');
    const id = `web-${++this.sequence}`;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.#write(payload); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  resolveRequest(id, result) {
    const request = this.incoming.get(String(id));
    if (!request) throw new Error('Approval request is no longer pending');
    this.incoming.delete(String(id));
    this.#write({ jsonrpc: '2.0', id: request.id, result });
    this.emit('serverRequestResolved', { id: String(id) });
  }

  failRequest(id, code = -32601, message = 'Unsupported App Server request') {
    const request = this.incoming.get(String(id));
    if (!request) return;
    this.incoming.delete(String(id));
    this.#write({ jsonrpc: '2.0', id: request.id, error: { code, message } });
    this.emit('serverRequestResolved', { id: String(id), failed: true, message });
  }

  close() {
    if (this.child && !this.child.killed) this.child.kill();
    this.#disconnect(new Error('App Server stopped'));
  }

  #write(value) {
    if (!this.child?.stdin?.writable) throw new Error('App Server input is unavailable');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #read(chunk) {
    let text = chunk;
    while (text.length) {
      const end = text.indexOf('\n');
      if (this.discarding) {
        // Skipping the rest of an oversized line until its newline.
        if (end < 0) return;
        this.discarding = false; text = text.slice(end + 1); continue;
      }
      if (end < 0) {
        this.buffer += text;
        if (this.buffer.length > this.maxLine) { const head = this.buffer.slice(0, 256); this.buffer = ''; this.discarding = true; this.#dropLine(head); }
        return;
      }
      const raw = this.buffer + text.slice(0, end);
      this.buffer = ''; text = text.slice(end + 1);
      if (raw.length > this.maxLine) { this.#dropLine(raw.slice(0, 256)); continue; }
      const line = raw.trim();
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.emit('protocolError', new Error('Invalid App Server JSONL')); continue; }
      this.#message(message);
    }
  }

  // Fails only the request the oversized line answered (when its id is readable); everything else keeps working.
  #dropLine(head) {
    let id = null;
    const match = head.match(LEADING_ID);
    if (match) { try { id = String(JSON.parse(match[1])); } catch { id = null; } }
    const call = id != null ? this.pending.get(id) : null;
    if (call) {
      this.pending.delete(id); clearTimeout(call.timer);
      call.reject(Object.assign(new Error(`${call.method} response exceeded ${this.maxLine} characters`), { tooLarge: true }));
    }
    this.emit('protocolError', new Error(`App Server JSONL line over ${this.maxLine} characters was discarded${call ? ` (${call.method})` : ''}`));
  }

  #message(message) {
    if (Object.hasOwn(message, 'id') && !message.method) {
      const call = this.pending.get(String(message.id));
      if (!call) return;
      this.pending.delete(String(message.id));
      clearTimeout(call.timer);
      // rpcError marks a definitive answer from the App Server, as opposed to timeouts or disconnects.
      if (message.error) call.reject(Object.assign(new Error(message.error.message || 'App Server request failed'), { rpcError: true, code: message.error.code ?? null }));
      else call.resolve(message.result);
      return;
    }
    if (message.method && Object.hasOwn(message, 'id')) {
      const id = String(message.id);
      const supported = new Set([
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/tool/requestUserInput',
        'tool/requestUserInput'
      ]);
      if (!supported.has(message.method)) {
        this.incoming.set(id, message);
        this.failRequest(id, -32601, `Unsupported App Server request: ${message.method}`);
        this.emit('unsupportedRequest', { id, method: message.method });
        return;
      }
      this.incoming.set(id, message);
      this.emit('serverRequest', { id, method: message.method, params: message.params || {} });
      return;
    }
    if (message.method === 'serverRequest/resolved') {
      const id = String(message.params?.id || message.params?.requestId || '');
      if (id) this.incoming.delete(id);
      this.emit('serverRequestResolved', { id });
      return;
    }
    if (message.method) this.emit('notification', { method: message.method, params: message.params || {} });
  }

  #disconnect(error) {
    const wasConnected = this.connected || this.child;
    this.connected = false;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
    for (const [id] of this.incoming) {
      this.incoming.delete(id);
      this.emit('serverRequestResolved', { id, failed: true, message: 'App Server disconnected' });
    }
    if (wasConnected) this.emit('status', { connected: false, error: `${error.message}${this.stderr ? `: ${this.stderr}` : ''}` });
  }

  #stderr(chunk) {
    const sanitized = String(chunk).replace(/(password|secret|token)\s*[=:]\s*\S+/gi, '$1=[redacted]').replace(/[\r\n]+/g, ' ').trim();
    if (!sanitized) return;
    this.stderr = `${this.stderr} ${sanitized}`.trim().slice(-2000);
  }
}
