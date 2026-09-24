// Local stand-in for `codex app-server`, used by tests and the UI fixture. It never contacts a model.
// On turn/start it reads every attachment path the server forwarded, so the full upload→turn path is observable.
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const FAKE_MODELS = [
  { id: 'fixture-fast-id', model: 'fixture-fast', displayName: 'Fixture Fast', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '빠름' }, { reasoningEffort: 'medium', description: '보통' }] },
  { id: 'fixture-deep-id', model: 'fixture-deep', displayName: 'Fixture Deep', defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: '보통' }, { reasoningEffort: 'high', description: '깊게' }] }
];
const TEXT_TYPES = /\.(txt|md|csv|json)$/i;

// Fixture-only scenario commands, typed as the whole prompt (never part of the production UI):
//   /fixture approval  → command-approval card; accept/decline changes the outcome
//   /fixture input     → Codex question card (select + text); the reply echoes the answers
//   /fixture slow      → ~30 s streamed reply, so the 중단 button can be exercised
//   /fixture reject    → turn/start answered with a JSON-RPC error (definitive: no turn)
//   /fixture lost      → turn/start times out (uncertain outcome; attachments marked attempted)
export const SCENARIO_HELP = ['/fixture approval', '/fixture input', '/fixture slow', '/fixture reject', '/fixture lost'];

export class FakeCodex extends EventEmitter {
  // mergeHistory: thread/read returns each user message as ONE text part (prompt + attachment notice joined),
  // imitating an app-server that flattens stored input; live notifications keep separate parts.
  // true joins with '' (no separator, as codex-rs UserMessageItem::message() is understood to do); a string is used as
  // the separator (e.g. '\n\n'). thread/list also reports that flattened first message as `preview`.
  // turnStartGate: optional promise that turn/start awaits before answering (lets tests hold a dispatch in flight).
  constructor({ project, stepMs = 0, seedHistory = false, mergeHistory = false } = {}) {
    super();
    this.project = project; this.stepMs = stepMs; this.mergeHistory = mergeHistory; this.connected = false; this.incoming = new Map();
    this.calls = []; this.threads = new Map(); this.sequence = 0; this.failTurns = false; this.timers = new Set(); this.reports = []; this.waiters = new Map();
    if (seedHistory) {
      const now = Math.floor(Date.now() / 1000);
      this.threads.set('fixture-existing', { id: 'fixture-existing', name: 'UI 확인용 기존 작업', cwd: project, updatedAt: now - 3600, active: false, turns: [{ id: 'seed-turn', items: [
        { id: 'seed-user', type: 'userMessage', content: [{ type: 'text', text: '프로젝트 구조를 간단히 알려줘' }] },
        { id: 'seed-cmd', type: 'commandExecution', command: 'Get-ChildItem -Name', status: 'completed', aggregatedOutput: 'README.md\nsrc\ntest' },
        { id: 'seed-agent', type: 'agentMessage', text: '이 프로젝트는 다음처럼 구성되어 있습니다.\n\n- `README.md` — 소개 문서\n- `src/` — 소스 코드\n- `test/` — 테스트\n\n**fixture 기록**입니다. 이어가기 후 새 메시지를 보낼 수 있습니다.' }
      ] }] });
    }
  }

  async connect() { this.connected = true; this.emit('status', { connected: true }); }
  close() { this.connected = false; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
  resolveRequest(id, result) { this.incoming.delete(id); this.emit('serverRequestResolved', { id, result }); this.waiters.get(id)?.(result); this.waiters.delete(id); }
  failRequest(id) { this.incoming.delete(id); this.emit('serverRequestResolved', { id, failed: true }); this.waiters.get(id)?.(null); this.waiters.delete(id); }
  ask(method, params) {
    const id = `fx-request-${++this.sequence}`; this.incoming.set(id, { id, method, params });
    return new Promise(resolve => { this.waiters.set(id, resolve); this.emit('serverRequest', { id, method, params }); });
  }

  async request(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'model/list') return { data: FAKE_MODELS };
    if (method === 'thread/list') return { threads: [...this.threads.values()].map(thread => ({ id: thread.id, name: thread.name, preview: this.preview(thread), cwd: thread.cwd, updatedAt: thread.updatedAt, status: { type: thread.active ? 'active' : 'idle' } })) };
    if (method === 'thread/read') {
      const thread = this.threads.get(params.threadId); let turns = thread?.turns || [];
      if (this.mergeHistory !== false) turns = turns.map(turn => ({ ...turn, items: turn.items.map(item => item.type !== 'userMessage' ? item : { ...item, content: [
        { type: 'text', text: this.flatten(item) },
        ...item.content.filter(part => part.type !== 'text')] }) }));
      return { thread: { id: params.threadId, turns } };
    }
    if (method === 'thread/start') {
      const id = `fake-thread-${++this.sequence}`;
      this.threads.set(id, { id, name: '', cwd: params.cwd, updatedAt: Math.floor(Date.now() / 1000), active: false, turns: [] });
      return { thread: { id } };
    }
    if (method === 'thread/resume') return { thread: { id: params.threadId } };
    if (method === 'turn/interrupt') { this.interrupted = params.turnId; return {}; }
    if (method === 'turn/start') {
      if (this.turnStartGate) await this.turnStartGate;
      const command = params.input?.[0]?.type === 'text' ? params.input[0].text.trim() : '';
      // Same error shapes as bridge/app-server.mjs: JSON-RPC error → rpcError; timeout/disconnect → plain Error.
      if (this.failTurns === 'rpc' || command === '/fixture reject') throw Object.assign(new Error('fixture: model rejected this input'), { rpcError: true, code: -32602 });
      if (this.failTurns || command === '/fixture lost') throw new Error('turn/start timed out');
      const turnId = `fake-turn-${++this.sequence}`;
      this.later(() => this.runTurn(params, turnId));
      return { turn: { id: turnId } };
    }
    return {};
  }

  flatten(item) {
    const separator = typeof this.mergeHistory === 'string' ? this.mergeHistory : '';
    return item.content.filter(part => part.type === 'text').map(part => part.text).join(separator);
  }
  preview(thread) {
    const user = thread.turns[0]?.items.find(item => item.type === 'userMessage');
    return user ? this.flatten(user).slice(0, 200) : '';
  }

  later(fn, steps = 1) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, this.stepMs * steps);
    this.timers.add(timer);
  }
  wait(steps = 1) { return new Promise(resolve => this.later(resolve, steps)); }
  notify(method, params) { if (this.connected) this.emit('notification', { method, params }); }

  async inspect(name, file) {
    try {
      const data = await readFile(file);
      const firstLine = TEXT_TYPES.test(name) ? data.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).find(line => line.trim()) || '' : '';
      return { name, path: file, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), signature: data.subarray(0, 5).toString('latin1').replace(/[^\x20-\x7e]/g, '.'), firstLine: firstLine.slice(0, 60) };
    } catch (error) { return { name, path: file, error: error.code || error.message }; }
  }

  async readAttachments(input) {
    const files = [];
    const notice = input.find(part => part.type === 'text' && part.text.startsWith('[Codex 원격 웹 첨부 파일'));
    if (notice) {
      const lines = notice.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const entry = lines[i].match(/^\d+\.\s(.+)\s—\s/); const location = lines[i + 1]?.match(/^\s+경로: (.+)$/);
        if (entry && location) files.push(await this.inspect(entry[1], location[1].trim()));
      }
    }
    const images = [];
    for (const part of input.filter(value => value.type === 'localImage')) images.push(await this.inspect(part.path.split(/[\\/]/).pop(), part.path));
    return { files, images };
  }

  async runTurn(params, turnId) {
    const { threadId } = params; const thread = this.threads.get(threadId) || { id: threadId, turns: [] };
    const items = []; thread.turns.push({ id: turnId, items }); thread.active = true; thread.updatedAt = Math.floor(Date.now() / 1000);
    const prompt = params.input.find(part => part.type === 'text' && !part.text.startsWith('[Codex 원격 웹 첨부 파일'))?.text || '';
    const user = { id: `${turnId}-user`, type: 'userMessage', content: params.input }; items.push(user);
    if (this.interrupted === turnId) { thread.active = false; this.notify('turn/completed', { threadId, turnId, turn: { id: turnId, status: 'interrupted' } }); return; }
    this.notify('turn/started', { threadId, turnId, turn: { id: turnId } });
    this.notify('item/started', { threadId, item: user }); this.notify('item/completed', { threadId, item: user });
    await this.wait();
    if (this.interrupted === turnId) { thread.active = false; this.notify('turn/completed', { threadId, turnId, turn: { id: turnId, status: 'interrupted' } }); return; }
    const { files, images } = await this.readAttachments(params.input);
    const report = { threadId, turnId, prompt, model: params.model || null, effort: params.effort || null, files, images }; this.reports.push(report);
    if (files.length || images.length) {
      const command = { id: `${turnId}-read`, type: 'commandExecution', command: `fixture: 첨부 ${files.length}개 읽기`, status: 'inProgress' };
      this.notify('item/started', { threadId, item: command }); await this.wait(2);
      Object.assign(command, { status: 'completed', aggregatedOutput: files.map(file => file.error ? `${file.name}: 읽기 실패 (${file.error})` : `${file.name}: ${file.bytes} bytes, sha256 ${file.sha256}`).join('\n') });
      items.push(command); this.notify('item/completed', { threadId, item: command });
    }
    const lines = [`**fixture 응답** · 모델 \`${params.model || '작업 기본값'}\` · 추론 \`${params.effort || '작업 기본값'}\``, '', `요청: ${prompt ? `"${prompt}"` : '(메시지 없이 첨부만 전송)'}`];
    const scenario = prompt.trim();
    let chunks = 4; let stepsPerChunk = 1;
    if (scenario === '/fixture approval') {
      const command = { id: `${turnId}-approval-cmd`, type: 'commandExecution', command: 'Remove-Item .\\fixture-temp.txt', cwd: thread.cwd || this.project, status: 'inProgress' };
      this.notify('item/started', { threadId, cwd: command.cwd, item: command });
      const result = await this.ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: command.id, command: command.command, cwd: command.cwd });
      const accepted = result?.decision === 'accept';
      Object.assign(command, accepted ? { status: 'completed', aggregatedOutput: '(fixture) 실제로 실행하지 않았습니다. 승인 흐름만 확인합니다.' } : { status: 'declined' });
      items.push(command); this.notify('item/completed', { threadId, item: command });
      lines.push('', accepted ? '승인을 받아 명령 단계를 완료한 것으로 처리했습니다 (실제 실행 없음).' : '거부되어 명령을 실행하지 않았습니다.');
    } else if (scenario === '/fixture input') {
      const result = await this.ask('item/tool/requestUserInput', { threadId, turnId, itemId: `${turnId}-question`, cwd: thread.cwd || this.project, questions: [
        { id: 'color', question: '어떤 강조 색을 쓸까요?', options: [{ label: '초록', value: 'green' }, { label: '파랑', value: 'blue' }] },
        { id: 'title', question: '보고서 제목을 입력하세요' }] });
      const answer = key => result?.answers?.[key]?.answers?.[0] ?? '(없음)';
      lines.push('', `받은 답변: 색 \`${answer('color')}\`, 제목 "${answer('title')}"`);
    } else if (scenario === '/fixture slow') {
      lines.push('', ...Array.from({ length: 30 }, (_, i) => `- 느린 응답 ${i + 1}/30`));
      chunks = 30; stepsPerChunk = Math.max(1, Math.round(1000 / Math.max(this.stepMs, 1)));
    }
    if (files.length) {
      lines.push('', `첨부 파일 ${files.length}개를 서버가 넘긴 경로에서 직접 읽었습니다.`);
      for (const file of files) lines.push(file.error ? `- **${file.name}** — 읽기 실패 (${file.error})` : `- **${file.name}** — ${file.bytes.toLocaleString('en-US')} bytes · sha256 \`${file.sha256.slice(0, 12)}\`${file.firstLine ? ` · 첫 줄 "${file.firstLine}"` : ` · 서명 \`${file.signature}\``}`);
    }
    if (images.length) lines.push('', `이미지 입력(localImage) ${images.length}개를 받았습니다.`);
    const text = lines.join('\n'); const agent = { id: `${turnId}-agent`, type: 'agentMessage', text: '' };
    this.notify('item/started', { threadId, item: agent });
    const size = Math.ceil(text.length / chunks);
    for (let offset = 0; offset < text.length; offset += size) {
      await this.wait(stepsPerChunk);
      if (this.interrupted === turnId) { thread.active = false; this.notify('turn/completed', { threadId, turnId, turn: { id: turnId, status: 'interrupted' } }); return; }
      this.notify('item/agentMessage/delta', { threadId, turnId, itemId: agent.id, delta: text.slice(offset, offset + size) });
    }
    agent.text = text; items.push(agent); this.notify('item/completed', { threadId, item: agent });
    thread.active = false;
    this.notify('turn/completed', { threadId, turnId, turn: { id: turnId, status: 'completed' } });
  }
}
