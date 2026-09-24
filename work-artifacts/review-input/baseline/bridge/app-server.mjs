import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE = 1024 * 1024;

export class AppServer extends EventEmitter {
  constructor(config, { spawnImpl = spawn } = {}) {
    super();
    this.config = config;
    this.spawnImpl = spawnImpl;
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
      this.#write(payload);
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
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE) return this.#disconnect(new Error('App Server JSONL line is too large'));
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.emit('protocolError', new Error('Invalid App Server JSONL')); continue; }
      this.#message(message);
    }
  }

  #message(message) {
    if (Object.hasOwn(message, 'id') && !message.method) {
      const call = this.pending.get(String(message.id));
      if (!call) return;
      this.pending.delete(String(message.id));
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message || 'App Server request failed'));
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
    const sanitized = String(chunk).replace(/(?:password|secret|token)\s*[=:]\s*\S+/gi, '$1=[redacted]').replace(/[\r\n]+/g, ' ').trim();
    if (!sanitized) return;
    this.stderr = `${this.stderr} ${sanitized}`.trim().slice(-2000);
  }
}
