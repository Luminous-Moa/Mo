import { MIB, FILE_TYPES, formatBytes, extOf, baseName, pasteAction, parseUserContent, titleText } from './ui-core.js';
import { DispatchBook, draftAfterSend, reconcileTray, REPLAY_WINDOW_MS } from './dispatch-state.js';

const DEFAULT_LIMITS = { fileBytes: 20 * MIB, messageFiles: 5, messageBytes: 50 * MIB };
const KIND_ICON = { document: 'doc', table: 'table', text: 'text', image: 'image' };
const ACTIVE_STATES = ['active', 'running', 'busy', 'in_progress', 'inprogress'];
const EFFORT_LABELS = { none: '없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음' };
const DEFAULT_HINT = 'Ctrl+Enter로 보내기 · 모델과 추론 수준은 다음 메시지부터 적용됩니다';
const SERVER_MESSAGES = {
  'Login required': '로그인이 필요합니다.',
  'CSRF validation failed': '보안 확인에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.',
  'Thread is not in an allowed project': '허용된 범위의 작업이 아닙니다.',
  'Thread not found': '작업을 찾을 수 없습니다.',
  'threadId is required': '작업을 선택하세요.',
  'Codex response is too large': 'Codex 응답이 너무 커서 불러오지 못했습니다.',
  'Codex could not read this task': 'Codex가 이 작업을 읽지 못했습니다.',
  'Invalid history cursor': '기록 위치가 올바르지 않습니다. 작업을 다시 열어 주세요.',
  'Active thread cannot be taken over': '이 작업은 지금 실행 중이라 이어갈 수 없습니다. 끝난 뒤 다시 시도하세요.',
  'Resume this inactive allowed thread before sending a turn': '이 작업을 먼저 이어가기 해야 보낼 수 있습니다.',
  'No controlled active turn to interrupt': '중단할 실행 중인 작업이 없습니다.',
  'Selected model is unavailable': '선택한 모델을 사용할 수 없습니다.',
  'Selected reasoning effort is unsupported': '선택한 모델이 지원하지 않는 추론 수준입니다.',
  'A model is required when selecting reasoning effort': '추론 수준을 고르려면 모델도 선택하세요.',
  'requestId conflicts with a different turn': '같은 요청 번호로 다른 내용이 전송되었습니다. 다시 보내 주세요.',
  'Turn dispatch failed; status is uncertain and will not be retried automatically': '전송 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. 잠시 뒤 대화에 메시지가 보이지 않으면 다시 보내세요.',
  'Invalid turn request': '보낼 수 없는 요청입니다. 메시지 길이를 확인하세요.',
  'Invalid attachment list': '첨부 목록이 올바르지 않습니다.',
  'Uploads are not configured': '이 서버에서는 파일 첨부를 사용할 수 없습니다.',
  'Project is outside allowed roots': '허용 범위 밖의 프로젝트입니다.',
  'Project does not exist': '프로젝트 폴더를 찾을 수 없습니다.',
  'Approval is not pending': '이미 처리된 승인 요청입니다.',
  'Input request is not pending': '이미 처리된 질문입니다.',
  'Explicit accept or decline is required': '승인 또는 거부를 선택하세요.',
  'Request body too large': '요청이 너무 큽니다.',
  'Internal server error': '서버 오류가 발생했습니다.',
  'Try again later': '잠시 후 다시 시도하세요.',
  'Invalid access password': '접근 비밀번호가 올바르지 않습니다.',
  'Unexpected origin': '허용되지 않은 접속 주소입니다.',
  'The running turn changed; refresh and try again': '실행 중인 작업이 바뀌었습니다. 잠시 뒤 다시 시도하세요.'
};

// Shown when Codex refuses to resume because another process (usually the desktop app) holds the thread's writer lock.
const LOCKED_TITLE = '다른 Codex 프로세스가 사용 중인 작업입니다';
const LOCKED_GUIDE = '이 작업은 다른 Codex 프로세스(데스크톱 앱 등)가 사용 중입니다. 데스크톱 앱을 트레이까지 완전히 종료한 뒤 다시 시도하세요.';
// Tasks whose folder overlaps the panel's own runtime data are view-only here (server answers 409 thread_scope_protected).
const PROTECTED_TITLE = '웹에서 이어갈 수 없는 작업입니다';
const PROTECTED_GUIDE = '이 작업 폴더는 웹 패널의 운영 데이터 폴더를 포함하거나 그 안에 있어 웹에서 이어갈 수 없습니다. 데스크톱 앱에서 이어가세요.';

const state = {
  csrf: null, cursor: 0, thread: null, tasks: [], tasksTruncated: false, taskLimit: 0, controlled: new Set(), models: [], activeTurns: {},
  dispatch: new DispatchBook(), polling: false, connection: null, taskSignature: '',
  uploads: { enabled: false, status: 'unknown', limits: { ...DEFAULT_LIMITS }, storage: null, retries: 0 }, trays: new Map(), agentText: new Map(), drafts: new Map(), attachmentSeq: 0
};

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const friendly = message => SERVER_MESSAGES[message] || message;

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVG_NS, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use);
  return svg;
}

// Screen-reader status line for outcomes that are otherwise only visual (upload finished, reply complete).
function announce(message) {
  const region = $('sr-status'); region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 30);
}
function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID().replaceAll('-', '');
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function api(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf || '', ...(options.headers || {}) } }); }
  catch { throw Object.assign(new Error('서버에 연결할 수 없습니다. 네트워크 상태를 확인하세요.'), { status: 0 }); }
  const payload = await response.json().catch(() => ({ error: '응답을 읽을 수 없습니다.' }));
  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();
    throw Object.assign(new Error(friendly(payload.error) || '요청을 처리하지 못했습니다.'), { status: response.status, code: typeof payload.code === 'string' ? payload.code : null });
  }
  return payload;
}

/* ---------- Feedback ---------- */
function toast(message, kind = 'error') {
  const box = $('toasts');
  const node = el('div', { class: `toast is-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, icon(kind === 'error' ? 'alert' : 'info'), el('span', { class: 'toast-text', text: message }));
  const close = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '알림 닫기' }, icon('close'));
  close.addEventListener('click', () => node.remove());
  node.append(close); box.append(node);
  while (box.childElementCount > 4) box.firstElementChild.remove();
  setTimeout(() => node.remove(), kind === 'error' ? 9000 : 5000);
}

function notice(kind, title, text, actions = []) {
  const body = el('div', { class: 'notice-body' }, el('strong', { class: 'notice-title', text: title }), text ? el('span', { text }) : null);
  if (actions.length) body.append(el('div', { class: 'notice-actions' }, actions));
  return el('div', { class: `notice is-${kind}`, role: kind === 'error' ? 'alert' : null }, icon(kind === 'info' ? 'info' : 'alert'), body);
}
function addNotice(kind, title, text, actions) { const node = notice(kind, title, text, actions); appendNode(node); return node; }

function setConnection(mode) {
  if (state.connection === mode) return;
  state.connection = mode;
  $('connection').className = `conn is-${mode}`;
  $('connection-label').textContent = mode === 'online' ? 'Codex 연결됨' : mode === 'offline' ? 'Codex 오프라인' : '다시 연결하는 중';
}

/* ---------- Markdown (text-only DOM, no HTML parsing) ---------- */
function inline(text) {
  const out = []; const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g; let last = 0; let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(document.createTextNode(text.slice(last, match.index)));
    out.push(match[1] ? el('code', { text: match[1].slice(1, -1) }) : el('strong', { text: match[2].slice(2, -2) }));
    last = pattern.lastIndex;
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)));
  return out;
}

function renderMarkdown(source) {
  const fragment = document.createDocumentFragment(); const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  let paragraph = []; let i = 0;
  const flush = () => { if (paragraph.length) fragment.append(el('p', {}, inline(paragraph.join('\n')))); paragraph = []; };
  const listItem = line => line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flush(); const body = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++; fragment.append(el('pre', {}, el('code', { text: body.join('\n') }))); continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { flush(); fragment.append(el('p', { class: `md-h md-h${heading[1].length}` }, inline(heading[2]))); i++; continue; }
    const first = listItem(line);
    if (first) {
      flush(); const ordered = /\d/.test(first[1]); const list = el(ordered ? 'ol' : 'ul');
      while (i < lines.length) { const item = listItem(lines[i]); if (!item || /\d/.test(item[1]) !== ordered) break; list.append(el('li', {}, inline(item[2]))); i++; }
      fragment.append(list); continue;
    }
    if (/^\s*>/.test(line)) {
      flush(); const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      fragment.append(el('blockquote', {}, inline(quote.join('\n')))); continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    paragraph.push(line); i++;
  }
  flush();
  return fragment;
}

/* ---------- Conversation ---------- */
function findItem(id) { return id ? $('messages').querySelector(`[data-item-id="${CSS.escape(id)}"]`) : null; }

function syncEmpty() {
  const hasContent = $('messages').childElementCount > 0; $('empty').hidden = hasContent;
  $('feed').setAttribute('aria-busy', state.loadingThread ? 'true' : 'false');
  if (hasContent) return;
  const selected = Boolean(state.thread);
  $('empty').classList.toggle('is-loading', Boolean(state.loadingThread));
  $('empty-title').textContent = state.loadingThread ? '기록을 불러오는 중…' : selected ? '아직 대화가 없습니다' : '작업을 선택하세요';
  $('empty-text').textContent = state.loadingThread ? '잠시만 기다려 주세요.' : selected ? '아래 입력창에 요청을 적거나 파일을 첨부해 보내세요.' : '최근 작업을 고르거나 새 작업을 만들어 Codex와 대화를 시작하세요.';
}

function withAutoScroll(mutate) {
  const feed = $('feed'); const stick = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
  mutate(); syncEmpty();
  if (stick) feed.scrollTop = feed.scrollHeight;
}
function appendNode(node) { withAutoScroll(() => $('messages').append(node)); }
function upsert(node, id) {
  withAutoScroll(() => {
    const existing = findItem(id);
    if (id) node.dataset.itemId = id;
    if (existing?.querySelector('details')?.open) node.querySelector('details')?.setAttribute('open', '');
    if (existing) existing.replaceWith(node); else $('messages').append(node);
  });
}
function clearFeed() { $('messages').replaceChildren(); state.agentText.clear(); syncEmpty(); }

function fileChips(files) {
  return el('ul', { class: 'file-chips', 'aria-label': `첨부 파일 ${files.length}개` }, files.map(file => el('li', { class: 'file-chip', title: file.name },
    icon(KIND_ICON[file.kind] || 'doc'),
    el('span', { class: 'file-chip-text' }, el('span', { class: 'file-chip-name', text: file.name }), file.meta ? el('span', { class: 'file-chip-meta', text: file.meta }) : null))));
}

function userMessageNode(item) {
  const { texts, files } = parseUserContent(item.content, item.text || '');
  const node = el('article', { class: 'msg msg-user', 'aria-label': '내 메시지' });
  if (texts.length) node.append(el('div', { class: 'bubble', text: texts.join('\n\n') }));
  if (files.length) node.append(fileChips(files));
  return node;
}

function agentNode(text, streaming) {
  const body = el('div', { class: 'md' });
  if (text) body.append(renderMarkdown(text)); else body.append(el('p', { class: 'empty-text', text: streaming ? '응답을 작성하는 중…' : '(빈 응답)' }));
  const role = el('div', { class: 'msg-role' }, el('span', { class: 'brand-mark' }, icon('logo')), 'Codex');
  return el('article', { class: `msg msg-agent${streaming && text ? ' is-streaming' : ''}`, 'aria-label': 'Codex 응답', 'aria-busy': streaming ? 'true' : null }, role, body);
}

function statusInfo(status) {
  const value = String(status?.type || status || '').toLowerCase();
  if (['completed', 'success', 'succeeded', 'applied'].includes(value)) return ['완료', 'is-ok'];
  if (['failed', 'error'].includes(value)) return ['실패', 'is-bad'];
  if (['declined', 'rejected', 'denied'].includes(value)) return ['거부됨', 'is-bad'];
  if (['cancelled', 'canceled', 'interrupted'].includes(value)) return ['중단됨', 'is-bad'];
  return ['진행 중', 'is-live'];
}

function toolNode(iconName, title, status, bodyNodes) {
  const [label, cls] = statusInfo(status);
  const details = el('details', { class: 'tool' },
    el('summary', {}, icon(iconName), el('span', { class: 'tool-title' }, title), el('span', { class: `status ${cls}`, text: label })),
    el('div', { class: 'tool-body' }, bodyNodes));
  return el('article', { class: 'msg msg-tool' }, details);
}

function commandNode(item) {
  const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '명령');
  const output = item.aggregatedOutput || item.output || '';
  return toolNode('terminal', el('code', { text: command }), item.status, [el('pre', {}, el('code', { text: command })), output ? el('pre', {}, el('code', { text: output })) : null]);
}

function fileChangeNode(item) {
  const changes = (item.changes || item.files || []).map(change => typeof change === 'string' ? change : change.path || '변경 파일');
  const diff = item.diff || (item.changes || []).map(change => change?.diff).filter(Boolean).join('\n');
  return toolNode('edit', `파일 변경${changes.length ? ` ${changes.length}개` : ''}`, item.status, [
    changes.length ? el('ul', { class: 'tool-files' }, changes.map(change => el('li', { text: change }))) : null,
    item.summary ? el('p', { text: item.summary }) : null,
    diff ? el('pre', {}, el('code', { text: diff })) : null]);
}

function itemText(item) { return item.text ?? (Array.isArray(item.content) ? item.content.map(part => part.text || '').join('') : ''); }

function renderItem(item) {
  if (item.type === 'userMessage') return userMessageNode(item);
  if (item.type === 'agentMessage') { const text = itemText(item); if (item.id) state.agentText.set(item.id, text); return agentNode(text, false); }
  if (item.type === 'commandExecution') return commandNode(item);
  if (item.type === 'fileChange') return fileChangeNode(item);
  return null;
}

// History pages arrive oldest→newest within the page. The first page holds the newest turns; "이전 기록 더 보기"
// prepends the next older page and keeps the reader's scroll position.
function turnNodes(turns) {
  const nodes = [];
  for (const turn of turns || []) {
    for (const item of turn.items || []) {
      if (item.id && findItem(item.id)) continue;
      const node = renderItem(item); if (!node) continue;
      if (item.id) node.dataset.itemId = item.id;
      nodes.push(node);
    }
    if (turn.partial) nodes.push(notice('info', '이 turn은 너무 커서 요약만 표시합니다', '사용자 메시지와 Codex 응답만 보이며, 명령 실행·파일 변경 기록은 생략했습니다.'));
    if (turn.unavailable) nodes.push(notice('warn', '불러올 수 없는 turn입니다', '이 turn은 요약조차 너무 커서 웹에서 표시할 수 없습니다. 데스크톱 앱에서 확인하세요. 이전 기록은 계속 불러올 수 있습니다.'));
  }
  return nodes;
}

// older: prepend and keep the reader's place; focus then moves to the new "more" button, or the first new entry.
function renderHistoryPage(thread, page, older) {
  const box = $('messages'); const feed = $('feed');
  box.querySelector('.history-more')?.remove();
  const nodes = turnNodes(page.turns);
  if (older) { const before = feed.scrollHeight; box.prepend(...nodes); feed.scrollTop += feed.scrollHeight - before; }
  else { withAutoScroll(() => box.append(...nodes)); feed.scrollTop = feed.scrollHeight; }
  thread.historyCursor = page.nextCursor || null;
  const more = thread.historyCursor ? historyMoreButton(thread) : null;
  if (more) box.prepend(more);
  syncEmpty();
  if (older) {
    const target = more?.querySelector('button') || nodes[0];
    if (target) { if (target !== more?.querySelector('button')) target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
  }
}

function historyMoreButton(thread) {
  const button = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, '이전 기록 더 보기');
  button.addEventListener('click', async () => {
    if (state.thread !== thread || !thread.historyCursor) return;
    button.disabled = true; button.classList.add('is-busy');
    try {
      const page = await api('/api/tasks/turns', { method: 'POST', body: JSON.stringify({ threadId: thread.id, cursor: thread.historyCursor }) });
      if (state.thread === thread) renderHistoryPage(thread, page, true);
    } catch (error) {
      button.disabled = false; button.classList.remove('is-busy');
      if (error.status !== 401) toast(`이전 기록을 불러오지 못했습니다. ${error.message}`);
    }
  });
  return el('div', { class: 'history-more' }, button);
}

/* ---------- Header, tasks, controls ---------- */
function taskId(task) { return String(task.id || task.threadId || ''); }
function taskState(task) { return String(task.status?.type || task.status || task.turn?.status?.type || task.turn?.status || '').toLowerCase(); }
function taskTitle(task) { return titleText(task.name || task.title || task.preview || ''); }
function taskCwd(task) { return task.cwd || task.workspace?.cwd || ''; }
// Project name, or the path under the resume root (e.g. "Codex\2026-09-22\new-chat") so date folders stay distinct.
function taskLocation(task) { return task.location || baseName(taskCwd(task)); }
function relativeTime(value) {
  if (value == null || value === '') return '';
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60); if (hours < 24) return `${hours}시간 전`;
  const days = Math.round(hours / 24); if (days < 7) return `${days}일 전`;
  return new Date(ms).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}
const isRunning = id => Boolean(id && state.activeTurns?.[id]);

// Why the list stopped: the display cap (more tasks exist) or the scan cap (older tasks were not examined).
function truncationNote() {
  if (state.tasksTruncated === 'pages') return `최근 작업 ${state.taskScanLimit || '일부'}개까지만 검사했습니다. 그보다 오래된 작업은 목록에 나오지 않을 수 있습니다.`;
  return `최근 활동 순으로 ${state.taskLimit || state.tasks.length}개까지만 표시합니다. 더 오래된 작업은 목록에 나오지 않습니다.`;
}

function renderTasks(force = true) {
  const signature = JSON.stringify([state.tasks.map(task => [taskId(task), taskTitle(task), taskState(task), taskLocation(task), task.lock || '', Boolean(task.folderMissing), Boolean(task.protected)]), state.tasksTruncated, state.thread?.id, [...state.controlled], Object.keys(state.activeTurns || {})]);
  if (!force && signature === state.taskSignature) return;
  state.taskSignature = signature;
  const nav = $('tasks');
  // Rebuilding the list must not drop keyboard focus: remember which task button had it and restore it.
  const focusedTask = document.activeElement?.closest?.('#tasks .task')?.dataset.taskId;
  if (!state.tasks.length) { nav.replaceChildren(el('p', { class: 'task-list-empty', text: '아직 작업이 없습니다. 새 작업을 만들어 시작하세요.' })); return; }
  nav.replaceChildren(...state.tasks.map(task => {
    const id = taskId(task); const running = isRunning(id) || (!state.controlled.has(id) && ACTIVE_STATES.includes(taskState(task))); const controlled = state.controlled.has(id);
    // 'busy' is a read-only hint (writer lock held by another Codex process); resuming still decides for real.
    const busyElsewhere = !controlled && task.lock === 'busy';
    const when = running ? '실행 중' : busyElsewhere ? '다른 곳에서 사용 중' : relativeTime(task.updatedAt ?? task.createdAt);
    const sub = [taskLocation(task), task.protected ? '보호됨 · 기록만' : task.folderMissing ? '폴더 없음' : null, when].filter(Boolean).join(' · ');
    const button = el('button', { class: 'task', type: 'button', 'data-task-id': id, 'aria-current': state.thread?.id === id ? 'page' : null, title: taskCwd(task) || null },
      el('span', { class: `task-dot${running ? ' is-active' : controlled ? ' is-controlled' : busyElsewhere ? ' is-busy' : ''}`, 'aria-hidden': 'true' }),
      el('span', { class: 'task-text' }, el('span', { class: 'task-title', text: taskTitle(task) }), el('span', { class: `task-sub${busyElsewhere ? ' is-busy' : ''}`, text: sub })));
    button.addEventListener('click', () => selectTask(task));
    return button;
  }), ...(state.tasksTruncated ? [el('p', { class: 'task-list-note', text: truncationNote() })] : []));
  if (focusedTask) nav.querySelector(`[data-task-id="${CSS.escape(focusedTask)}"]`)?.focus();
}

function renderHeader() {
  const thread = state.thread;
  $('task-title').textContent = thread ? thread.title : '작업을 선택하세요';
  $('task-meta').textContent = thread?.project || '';
  document.title = thread ? `${thread.title} · Codex 원격` : 'Codex 원격 작업';
  const badge = $('task-badge');
  if (!thread) { badge.hidden = true; return; }
  const running = isRunning(thread.id);
  badge.hidden = false;
  badge.className = `badge${running ? ' is-running' : thread.controlled ? ' is-controlled' : ''}`;
  badge.textContent = running ? '실행 중' : thread.controlled ? '제어 중' : '기록 보기';
}

function updateControls() {
  const thread = state.thread; const controlled = Boolean(thread?.controlled); const running = isRunning(thread?.id);
  const tray = currentTray(); const busyUploads = tray.some(isBusyItem);
  const ready = tray.filter(item => item.status === 'ready'); const hasText = $('prompt').value.trim().length > 0;
  const here = dispatchingHere(); const entry = thread ? state.dispatch.get(thread.id) : null;
  const unresolved = entry?.phase === 'unresolved'; const confirming = entry?.phase === 'confirming';
  $('prompt').disabled = !controlled || here;
  $('attach').disabled = !controlled || here || !state.uploads.enabled;
  $('model').disabled = here || !state.models.length;
  $('effort').disabled = here || !state.models.length;
  // While a previous send's result is unknown, no new send is possible from this task: the draft stays editable
  // and is kept, and the only way forward is the explicit result check (same request) or giving it up.
  $('send').disabled = !controlled || running || Boolean(entry) || busyUploads || (!hasText && !ready.length);
  $('send').classList.toggle('is-busy', here);
  $('send-label').textContent = here ? (confirming ? '전송 확인 중' : '보내는 중') : '보내기';
  renderPendingAttempt();
  $('interrupt').hidden = !running;
  $('prompt').placeholder = !thread ? '작업을 선택하면 메시지를 보낼 수 있습니다'
    : !controlled ? '이어가기 후 메시지를 보낼 수 있습니다'
    : running ? 'Codex가 작업 중입니다. 다음 메시지를 미리 적어 둘 수 있습니다'
    : 'Codex에게 요청할 내용을 입력하세요';
  const hint = confirming ? '이전 전송이 아직 처리 중입니다. 같은 요청으로 결과를 확인하고 있습니다 (새 turn은 만들지 않음)'
    : unresolved ? '이전 전송의 결과를 먼저 확인하세요. 입력 중인 글과 선택은 그대로 보관됩니다'
    : busyUploads ? '업로드가 끝나면 보낼 수 있습니다'
    : thread && !controlled ? '이 작업을 이어가기 해야 메시지와 파일을 보낼 수 있습니다'
    : state.uploads.status === 'error' ? '첨부 설정을 불러오지 못했습니다. 작업 목록 옆 새로고침으로 다시 시도하세요'
    : state.uploads.refreshFailed ? '첨부 설정 새로고침에 실패해 마지막으로 받은 설정을 쓰고 있습니다. 자동으로 다시 시도합니다'
    : running && (hasText || ready.length) ? '현재 작업이 끝나면 보낼 수 있습니다'
    : ready.some(item => item.attempted) ? '전송 결과가 불확실했던 첨부가 있습니다. 다시 보내거나 목록에서 빼세요'
    : ready.length && !hasText ? '메시지 없이 보내면 Codex가 첨부 파일을 검토하고 요약합니다'
    : ready.length ? `첨부 ${ready.length}개 (${formatBytes(ready.reduce((sum, item) => sum + item.size, 0))})를 함께 보냅니다`
    : DEFAULT_HINT;
  $('composer-hint').textContent = hint;
  // Actionable hints stay visible on small screens; only the routine keyboard tip is hidden there.
  $('composer-hint').classList.toggle('is-actionable', hint !== DEFAULT_HINT);
  const guarded = thread ? state.dispatch.protectedIds(thread.id) : new Set();
  for (const node of $('attachments').querySelectorAll('.attachment')) {
    const item = tray.find(value => String(value.key) === node.dataset.key);
    node.querySelector('button').disabled = here || node.classList.contains('is-removing') || Boolean(item?.id && guarded.has(item.id));
  }
  renderHeader();
}
function dispatchingHere() { return Boolean(state.thread && state.dispatch.busy(state.thread.id)); }

/* ---------- Drafts (in memory only, per task) ---------- */
function saveDraft() {
  if (!state.thread) return;
  const value = $('prompt').value;
  if (value) state.drafts.set(state.thread.id, value); else state.drafts.delete(state.thread.id);
}
function restoreDraft(threadId) { $('prompt').value = state.drafts.get(threadId) || ''; autosize(); }
// After a successful send, remove exactly the text that was sent, wherever that task's draft now lives.
function consumeDraft(threadId, sent) {
  if (state.thread?.id === threadId) { $('prompt').value = draftAfterSend($('prompt').value, sent); autosize(); }
  const kept = draftAfterSend(state.drafts.get(threadId) || '', sent);
  if (kept) state.drafts.set(threadId, kept); else state.drafts.delete(threadId);
}

/* ---------- Models ---------- */
function resetModelChoices() {
  state.models = [];
  $('model').replaceChildren(new Option('작업 기본값', ''));
  $('effort').replaceChildren(new Option('작업 기본값', ''));
}
function resetTurnChoices() { $('model').value = ''; refreshEfforts(); }
function refreshEfforts(preferred) {
  const select = $('effort'); const model = state.models.find(value => String(value.model || value.id) === $('model').value);
  select.replaceChildren(new Option(model ? '모델 기본값' : '작업 기본값', ''));
  if (!model) { updateControls(); return; }
  const supported = model.supportedReasoningEfforts || [];
  for (const effort of supported) {
    const option = new Option(EFFORT_LABELS[effort.reasoningEffort] || effort.reasoningEffort, effort.reasoningEffort);
    if (effort.description) option.title = effort.description;
    select.add(option);
  }
  const validPreferred = supported.some(value => value.reasoningEffort === preferred);
  const validDefault = supported.some(value => value.reasoningEffort === model.defaultReasoningEffort);
  select.value = validPreferred ? preferred : validDefault ? model.defaultReasoningEffort : '';
  updateControls();
}
async function loadModels() {
  const priorModel = $('model').value; const priorEffort = $('effort').value;
  try {
    const data = await api('/api/models'); state.models = data.models || [];
    const select = $('model'); select.replaceChildren(new Option('작업 기본값', ''));
    for (const model of state.models) select.add(new Option(model.displayName || model.id, model.model || model.id));
    const keep = state.models.some(model => String(model.model || model.id) === priorModel);
    select.value = keep ? priorModel : '';
    refreshEfforts(keep ? priorEffort : '');
  } catch (error) {
    resetModelChoices(); updateControls();
    if (error.status !== 401) toast(`모델 목록을 불러오지 못했습니다. 작업 기본값으로 보냅니다. (${error.message})`);
  }
}

/* ---------- Tasks ---------- */
async function refreshTasks() {
  const data = await api('/api/tasks'); state.tasks = data.tasks || [];
  state.tasksTruncated = data.truncatedReason || (data.truncated ? 'items' : false); state.taskLimit = Number(data.limit) || 0; state.taskScanLimit = Number(data.scanLimit) || 0;
  const current = state.thread && state.tasks.find(task => taskId(task) === state.thread.id);
  if (current) { state.thread.title = taskTitle(current); state.thread.project ||= taskLocation(current); renderHeader(); }
  renderTasks();
}

async function selectTask(task) {
  const id = taskId(task);
  const thread = { id, title: taskTitle(task), project: taskLocation(task), controlled: state.controlled.has(id), status: taskState(task) };
  const fromDrawer = $('sidebar').classList.contains('is-open');
  saveDraft();
  state.thread = thread; state.loadingThread = thread;
  restoreDraft(id);
  clearFeed(); resetTurnChoices(); renderTasks(); renderTray(); closeSidebar(); updateControls();
  // Keep keyboard focus useful: on desktop the clicked task button keeps it (renderTasks restores it).
  // From the drawer on a touch device, focus the (non-editable) task heading so no on-screen keyboard pops up;
  // with a precise pointer (narrow desktop window) go straight to the composer when it is usable.
  if (fromDrawer) (matchMedia('(pointer: coarse)').matches || $('prompt').disabled ? $('task-title') : $('prompt')).focus();
  let data = null;
  try { data = await api('/api/tasks/read', { method: 'POST', body: JSON.stringify({ threadId: id }) }); }
  catch (error) { if (state.thread === thread && error.status !== 401) { state.loadingThread = null; addNotice('error', '작업을 불러오지 못했습니다', error.message); } }
  if (state.thread !== thread) { if (state.loadingThread === thread) { state.loadingThread = null; syncEmpty(); } return; }
  // History is a separate, paged request: newest turns first, older ones on demand. A failure here still leaves the
  // task open (access notices and resume stay available).
  let page = null; let historyError = null;
  if (data) {
    try { page = await api('/api/tasks/turns', { method: 'POST', body: JSON.stringify({ threadId: id }) }); }
    catch (error) { historyError = error; }
    if (state.thread !== thread) { if (state.loadingThread === thread) { state.loadingThread = null; syncEmpty(); } return; }
  }
  state.loadingThread = null;
  if (data) {
    if (page) renderHistoryPage(thread, page, false);
    else if (historyError && historyError.status !== 401) addNotice('error', '대화 기록을 불러오지 못했습니다', historyError.message);
    const access = data.access || {};
    if (access.location) thread.project = access.location;
    if (thread.controlled) syncTray(id).catch(error => { if (error.status !== 401) toast(`첨부 목록을 불러오지 못했습니다. ${error.message}`); });
    else if (ACTIVE_STATES.includes(access.status || thread.status)) addNotice('warn', '실행 중인 작업입니다', '이 작업은 지금 실행 중이라 여기서 이어갈 수 없습니다. 끝난 뒤 다시 열어 보세요. 기록은 볼 수 있습니다.');
    else if (access.protected) addNotice('info', PROTECTED_TITLE, PROTECTED_GUIDE);
    else if (access.folderMissing) addNotice('info', '작업 폴더가 없어 기록만 볼 수 있습니다', '이 작업을 시작한 폴더가 지금 없어서 이어갈 수 없습니다.');
    else addResumeNotice(thread, { locked: access.lock === 'busy' });
  }
  syncEmpty(); updateControls();
}

// locked: the writer lock looked held (hint) or Codex just refused with "active writer" (409 thread_locked).
function addResumeNotice(thread, { locked = false, message = LOCKED_GUIDE } = {}) {
  const button = el('button', { class: `btn ${locked ? 'btn-ghost' : 'btn-primary'} btn-sm`, type: 'button' }, icon('play'), locked ? '다시 시도' : '이 작업 이어가기');
  const node = locked
    ? notice('warn', LOCKED_TITLE, `${message} 웹에서 이어가면, 이 웹 서버가 켜져 있는 동안 데스크톱 앱에서는 이 작업을 보기만 할 수 있습니다.`, [button])
    : notice('info', '지금은 기록만 볼 수 있습니다', '이어가면 이 웹에서 새 메시지와 파일을 보낼 수 있습니다. 이어간 뒤에는 이 웹 서버가 켜져 있는 동안 데스크톱 앱에서 이 작업을 보기만 할 수 있습니다.', [button]);
  appendNode(node);
  button.addEventListener('click', async () => {
    button.disabled = true; button.classList.add('is-busy');
    try {
      await api('/api/tasks/resume', { method: 'POST', body: JSON.stringify({ threadId: thread.id }) });
      thread.controlled = true; state.controlled.add(thread.id); node.remove(); syncEmpty();
      if (state.thread === thread) { toast('작업을 이어갑니다. 이제 메시지를 보낼 수 있습니다.', 'info'); await syncTray(thread.id).catch(() => {}); updateControls(); $('prompt').focus(); }
    } catch (error) {
      button.disabled = false; button.classList.remove('is-busy');
      if (error.code === 'thread_locked' && state.thread === thread) {
        // Not a generic failure: explain the single-writer rule in place, with a retry button.
        node.remove(); addResumeNotice(thread, { locked: true, message: error.message || LOCKED_GUIDE });
        announce(LOCKED_TITLE);
      } else if (error.code === 'thread_scope_protected' && state.thread === thread) {
        node.remove(); addNotice('info', PROTECTED_TITLE, error.message || PROTECTED_GUIDE);
      } else if (error.code === 'thread_folder_missing' && state.thread === thread) {
        node.remove(); addNotice('info', '작업 폴더가 없어 기록만 볼 수 있습니다', error.message);
      } else if (error.status !== 401) toast(error.message);
    }
    renderTasks(); updateControls();
  });
  return node;
}

/* ---------- Attachments ---------- */
function trayFor(threadId) { if (!state.trays.has(threadId)) state.trays.set(threadId, []); return state.trays.get(threadId); }
function currentTray() { return state.thread ? trayFor(state.thread.id) : []; }
function canAttach() { return Boolean(state.thread?.controlled && state.uploads.enabled && !dispatchingHere()); }
function uploadsUnavailableMessage() {
  if (!state.thread?.controlled) return '작업을 이어가기 한 뒤 파일을 첨부할 수 있습니다.';
  if (state.uploads.status === 'error') return '첨부 설정을 아직 불러오지 못했습니다. 작업 목록 옆 새로고침으로 다시 시도하세요.';
  if (!state.uploads.enabled) return '이 서버에서는 파일 첨부를 사용할 수 없습니다.';
  return '지금은 파일을 첨부할 수 없습니다.';
}

const isBusyItem = item => ['checking', 'uploading', 'removing'].includes(item.status);

function fromServer(item, threadId) {
  return { key: ++state.attachmentSeq, threadId, id: item.id, name: item.name, size: item.size, kind: item.kind, label: FILE_TYPES[item.type]?.[1] || item.label, image: item.image, attempted: Boolean(item.attempted), status: 'ready', progress: 1, readyAt: Date.now() };
}

// status: 'enabled' | 'disabled' (server policy: no uploadDir) | 'error' (could not ask; retried by Refresh and,
// a few times, by polling). A failed request is never presented as the server having uploads turned off.
// A failed refresh after a good load keeps the last good settings (refreshFailed) instead of blocking attachments.
async function loadUploadConfig() {
  const retries = state.uploads.retries || 0; const wasEnabled = state.uploads.status === 'enabled';
  try {
    const data = await api('/api/uploads');
    state.uploads = { enabled: Boolean(data.enabled), status: data.enabled ? 'enabled' : 'disabled', limits: { ...DEFAULT_LIMITS, ...(data.limits || {}) }, storage: data.storage || null, retries: 0, refreshFailed: false };
    // Coming back to "enabled" (e.g. after a failed first load): bring the open task's tray in line with the server.
    if (!wasEnabled && state.uploads.enabled && state.thread?.controlled) syncTray(state.thread.id).catch(() => {});
  } catch (error) {
    if (error.status === 401) return;
    const retry = { retries: retries + 1, retryAt: Date.now() + 10_000 };
    state.uploads = wasEnabled ? { ...state.uploads, ...retry, refreshFailed: true } : { ...state.uploads, ...retry, enabled: false, status: 'error' };
  }
  const { limits, storage, status } = state.uploads;
  const usage = storage && storage.usedBytes > storage.limitBytes * 0.8 ? ` · 저장소 ${formatBytes(storage.usedBytes)} / ${formatBytes(storage.limitBytes)} 사용 중` : '';
  $('attach').title = status === 'enabled'
    ? `파일 첨부 · PDF, DOCX, CSV, XLSX, TXT, MD, JSON, PNG, JPEG, WEBP · 파일당 ${formatBytes(limits.fileBytes)}, 최대 ${limits.messageFiles}개${usage}`
    : status === 'error' ? '첨부 설정을 불러오지 못했습니다. 작업 목록 옆 새로고침으로 다시 시도하세요' : '이 서버에서는 파일 첨부를 사용할 수 없습니다';
  updateControls();
}

// Server list is the source of truth for staged files: it restores the tray after reloads and surfaces files the
// server accepted even though this tab cancelled or lost the response.
async function syncTray(threadId) {
  if (!state.uploads.enabled || !state.controlled.has(threadId)) { renderTray(); return; }
  const started = Date.now();
  const data = await api(`/api/uploads?threadId=${encodeURIComponent(threadId)}`);
  // Attachments of a dispatching or unresolved send are claimed/sent server-side and not listed; they stay in the tray.
  const { dropped, added } = reconcileTray(trayFor(threadId), data.attachments || [], state.dispatch.protectedIds(threadId), started);
  for (const item of dropped) removeFromTray(item);
  const tray = trayFor(threadId);
  for (const item of added) tray.push(fromServer(item, threadId));
  const restored = added.length;
  if (data.storage) state.uploads.storage = data.storage;
  renderTray(); updateControls();
  return restored;
}

function scheduleTraySync(threadId) {
  clearTimeout(state.traySyncTimer);
  state.traySyncTimer = setTimeout(async () => {
    try { const restored = await syncTray(threadId); if (restored && state.thread?.id === threadId) toast(`서버에 저장된 첨부 ${restored}개를 목록에 다시 표시했습니다.`, 'info'); }
    catch { /* the next thread open resyncs */ }
  }, 1500);
}

function revokePreview(item) { if (item.previewUrl) { URL.revokeObjectURL(item.previewUrl); item.previewUrl = null; } }
function removeFromTray(item) {
  revokePreview(item);
  const tray = state.trays.get(item.threadId); if (!tray) return;
  const index = tray.indexOf(item); if (index >= 0) tray.splice(index, 1);
}

function attachmentMeta(item) {
  if (item.status === 'checking') return `확인 중 · ${formatBytes(item.size)}`;
  if (item.status === 'uploading') return `업로드 중 ${Math.round(item.progress * 100)}% · ${formatBytes(item.size)}`;
  if (item.status === 'removing') return '제거하는 중…';
  if (item.status === 'error') return item.error;
  if (state.dispatch.protectedIds(item.threadId).has(item.id)) return state.dispatch.unresolved(item.threadId) ? '이전 전송 결과 확인 대기 · 보관 중' : '전송 중';
  if (item.attempted) return '전송 결과 불확실 · 다시 보내거나 뺄 수 있음';
  return `${item.label} · ${formatBytes(item.size)}`;
}

function attachmentNode(item) {
  const thumb = el('span', { class: 'attachment-thumb' });
  const source = item.status === 'error' ? null : item.previewUrl || (item.image && item.id ? `/api/uploads/${encodeURIComponent(item.id)}/content` : null);
  if (item.status === 'error') thumb.append(icon('alert'));
  else if (source) {
    const image = el('img', { src: source, alt: '' });
    image.addEventListener('error', () => image.replaceWith(icon('image')), { once: true });
    thumb.append(image);
  } else thumb.append(icon(KIND_ICON[item.kind] || 'doc'));
  const action = isBusyItem(item) && item.status !== 'removing' ? ['업로드 취소', `${item.name} 업로드 취소`]
    : item.status === 'error' ? ['닫기', `${item.name} 오류 닫기`]
    : item.attempted ? ['목록에서 빼기 (파일은 보관)', `${item.name} 목록에서 빼기`]
    : ['첨부 제거', `${item.name} 첨부 제거`];
  const button = el('button', { class: 'icon-btn', type: 'button', title: action[0], 'aria-label': action[1], disabled: item.status === 'removing' || state.dispatch.busy(item.threadId) || state.dispatch.protectedIds(item.threadId).has(item.id) }, icon('close'));
  button.addEventListener('click', () => attachmentAction(item));
  const node = el('li', { class: `attachment is-${item.status}${item.status === 'removing' ? ' is-busy' : ''}${item.attempted && item.status === 'ready' ? ' is-attempted' : ''}`, 'data-key': item.key },
    thumb, el('span', { class: 'attachment-text' }, el('span', { class: 'attachment-name', text: item.name, title: item.name }), el('span', { class: 'attachment-meta', text: attachmentMeta(item) })), button);
  if (item.status === 'uploading') {
    const bar = el('span', { class: 'attachment-progress', role: 'progressbar', 'aria-label': `${item.name} 업로드 진행률`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(item.progress * 100) });
    bar.style.width = `${Math.round(item.progress * 100)}%`; node.append(bar);
  }
  return node;
}

function renderTray() {
  const list = $('attachments'); const tray = currentTray();
  const focusedKey = document.activeElement?.closest?.('.attachment')?.dataset.key;
  list.replaceChildren(...tray.map(attachmentNode)); list.hidden = !tray.length;
  if (focusedKey) (list.querySelector(`[data-key="${CSS.escape(focusedKey)}"] button`) || $('prompt')).focus();
}

function updateProgress(item) {
  const node = $('attachments').querySelector(`[data-key="${item.key}"]`); if (!node) return;
  const percent = Math.round(item.progress * 100);
  node.querySelector('.attachment-meta').textContent = attachmentMeta(item);
  const bar = node.querySelector('.attachment-progress'); if (bar) { bar.style.width = `${percent}%`; bar.setAttribute('aria-valuenow', percent); }
}

function handleFiles(fileList) {
  const files = [...(fileList || [])]; if (!files.length) return;
  if (!canAttach()) { toast(uploadsUnavailableMessage()); return; }
  const { limits } = state.uploads; const tray = trayFor(state.thread.id);
  for (const file of files) {
    const live = tray.filter(item => item.status !== 'error');
    const type = FILE_TYPES[extOf(file.name)];
    const item = { key: ++state.attachmentSeq, threadId: state.thread.id, name: file.name, size: file.size, kind: type?.[0] || 'document', label: type?.[1] || '파일', image: type?.[0] === 'image', status: 'checking', progress: 0, previewUrl: null };
    let error = '';
    if (!type) error = '지원하지 않는 형식입니다';
    else if (!file.size) error = '빈 파일은 첨부할 수 없습니다';
    else if (file.size > limits.fileBytes) error = `파일당 최대 ${formatBytes(limits.fileBytes)}까지 첨부할 수 있습니다`;
    else if (live.length >= limits.messageFiles) error = `메시지당 최대 ${limits.messageFiles}개까지 첨부할 수 있습니다`;
    else if (live.reduce((sum, value) => sum + value.size, 0) + file.size > limits.messageBytes) error = `메시지당 합계 최대 ${formatBytes(limits.messageBytes)}입니다`;
    tray.push(item);
    if (error) { item.status = 'error'; item.error = error; announce(`${file.name} 첨부 불가: ${error}`); continue; }
    // Local thumbnail from the picked bytes; revoked whenever the chip leaves the tray or fails.
    if (item.image) item.previewUrl = URL.createObjectURL(file);
    startUpload(item, file);
  }
  renderTray(); updateControls();
}

function failItem(item, message) {
  Object.assign(item, { status: 'error', error: message }); revokePreview(item);
  announce(`${item.name} 업로드 실패: ${message}`);
}

async function startUpload(item, file) {
  // Metadata preflight: predictable rejections (type, size, count, storage full, not resumed) come back as
  // readable errors before any bytes are sent. The real upload still re-checks everything.
  try {
    await api('/api/uploads/check', { method: 'POST', body: JSON.stringify({ threadId: item.threadId, name: file.name, size: file.size, type: file.type || '' }) });
  } catch (error) {
    if (item.cancelled || error.status === 401) return;
    failItem(item, error.message); renderTray(); updateControls(); return;
  }
  if (item.cancelled) return;
  item.status = 'uploading'; renderTray(); updateControls();
  const xhr = new XMLHttpRequest(); item.xhr = xhr;
  xhr.open('POST', '/api/uploads');
  xhr.setRequestHeader('x-csrf-token', state.csrf || '');
  xhr.setRequestHeader('x-upload-thread', item.threadId);
  xhr.setRequestHeader('x-upload-name', encodeURIComponent(file.name));
  xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
  xhr.upload.addEventListener('progress', event => { if (event.lengthComputable) { item.progress = event.loaded / event.total; updateProgress(item); } });
  const finish = () => { item.xhr = null; renderTray(); updateControls(); };
  xhr.addEventListener('load', () => {
    let payload = {}; try { payload = JSON.parse(xhr.responseText); } catch { /* keep generic message */ }
    if (xhr.status === 401) { handleUnauthorized(); return; }
    if (xhr.status === 201 && payload.attachment) {
      const value = payload.attachment;
      // A background resync may already have listed this file; keep one chip.
      for (const other of [...trayFor(item.threadId)]) if (other !== item && other.id === value.id) removeFromTray(other);
      Object.assign(item, { status: 'ready', id: value.id, name: value.name, size: value.size, kind: value.kind, image: value.image, label: FILE_TYPES[value.type]?.[1] || value.label, attempted: false, progress: 1, readyAt: Date.now() });
      announce(`${item.name} 업로드 완료`);
    } else failItem(item, friendly(payload.error) || `업로드하지 못했습니다 (${xhr.status})`);
    finish();
  });
  xhr.addEventListener('error', () => {
    // Either the connection dropped or the server refused early and closed it. Check what the server kept.
    failItem(item, '업로드 중 연결이 끊겼습니다. 서버에 저장됐는지 확인해 목록을 다시 맞춥니다.');
    finish(); scheduleTraySync(item.threadId);
  });
  xhr.addEventListener('abort', () => { removeFromTray(item); announce(`${item.name} 업로드 취소됨`); finish(); scheduleTraySync(item.threadId); });
  xhr.send(file);
}

async function attachmentAction(item) {
  if (item.status === 'checking') { item.cancelled = true; removeFromTray(item); announce(`${item.name} 업로드 취소됨`); renderTray(); updateControls(); return; }
  if (item.status === 'uploading') { item.cancelled = true; item.xhr?.abort(); return; }
  if (item.status === 'error') { removeFromTray(item); renderTray(); updateControls(); return; }
  if (item.status !== 'ready') return;
  item.status = 'removing'; renderTray(); updateControls();
  try {
    const result = await api(`/api/uploads/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    removeFromTray(item);
    if (result.retained) toast(`'${item.name}'을(를) 목록에서 뺐습니다. Codex가 이미 받았을 수 있어 파일은 보관 기간 동안 서버에 남습니다.`, 'info');
    announce(`${item.name} 첨부 제거됨`);
  } catch (error) {
    if (error.status === 404) removeFromTray(item);
    else { item.status = 'ready'; if (error.status !== 401) toast(`첨부를 제거하지 못했습니다. ${error.message}`); }
  }
  renderTray(); updateControls();
}

/* ---------- Sending ---------- */
// Like api() but returns every HTTP answer ({ status, payload }); throws only when no answer arrived.
async function apiRaw(path, options = {}) {
  let response;
  try { response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', 'x-csrf-token': state.csrf || '', ...(options.headers || {}) } }); }
  catch { throw Object.assign(new Error('서버에 연결할 수 없습니다.'), { status: 0 }); }
  // Non-JSON bodies (proxy error pages) are reported as such so they can never finalize a send.
  const textBody = await response.text().catch(() => '');
  let payload = null; let json = false;
  try { payload = JSON.parse(textBody); json = true; } catch { /* not JSON */ }
  if (response.status === 401) handleUnauthorized();
  return { status: response.status, payload, json };
}

// Each task keeps at most one send whose result is not final (state.dispatch). Its body — text, attachment IDs,
// model, effort, requestId — is frozen when the user presses 보내기; later task switches, selector changes, draft edits
// or other tasks' sends never alter it. Result checks always replay exactly that body.
async function sendMessage() {
  const thread = state.thread;
  if (!thread?.controlled || state.dispatch.get(thread.id) || isRunning(thread.id)) return;
  const tray = trayFor(thread.id);
  if (tray.some(isBusyItem)) { toast('업로드가 끝난 뒤 보낼 수 있습니다.', 'info'); return; }
  const sentText = $('prompt').value; const prompt = sentText.trim();
  const ready = tray.filter(item => item.status === 'ready');
  if (!prompt && !ready.length) return;
  state.dispatch.begin({ threadId: thread.id, requestId: newRequestId(), prompt, sentText,
    attachments: ready.map(item => ({ id: item.id, name: item.name, size: item.size })),
    model: $('model').value || null, effort: $('effort').value || null });
  await runAttempt(thread.id, true);
}

async function runAttempt(threadId, firstCall) {
  renderTray(); updateControls();
  let result;
  try {
    // 202 = still in flight on the server: the identical body is replayed (bounded); nothing new is ever created.
    result = await state.dispatch.run(threadId, body => apiRaw('/api/turns/start', { method: 'POST', body }), { firstCall, onPending: () => updateControls() });
  } catch (error) { toast(error.message); return; }
  if (result.stale || result.outcome === 'auth' || !state.csrf) return;
  finishAttempt(threadId, result);
}

const UNKNOWN_REASONS = {
  network: '서버 응답을 받지 못했습니다.',
  server: '서버나 중간 프록시가 오류(5xx) 응답을 보냈습니다.',
  malformed: '서버 응답 형식을 알아볼 수 없습니다.',
  timeout: '전송이 아직 서버에서 처리 중입니다.',
  'no-record': '서버가 이 요청을 더는 기억하지 않습니다.'
};

async function finishAttempt(threadId, result) {
  const { record } = result;
  if (result.outcome === 'sent') {
    const sentIds = new Set(record.attachments.map(item => item.id));
    for (const item of [...trayFor(threadId)]) if (item.id && sentIds.has(item.id)) removeFromTray(item);
    consumeDraft(threadId, record.sentText);
    const value = result.payload.result; const turnId = value.turn?.id || value.id || value.turnId;
    if (turnId) state.activeTurns[threadId] = String(turnId);
    announce('메시지를 보냈습니다.');
  } else if (result.outcome === 'unknown') {
    toast(`${UNKNOWN_REASONS[result.reason] || '전송 결과를 알 수 없습니다.'} 보낸 글과 첨부는 그대로 보관합니다. 입력창 위 '결과 다시 확인'으로 같은 요청을 다시 확인하세요.`);
  } else if (result.outcome === 'expired') {
    toast('중복 방지 기록 보존 시간이 지나 더는 확인할 수 없습니다. 대화 기록에서 실제로 전송됐는지 확인한 뒤 확인을 포기하세요.');
  } else {
    // Final answer from the server (422 rejected, 409 uncertain, 4xx refusal): the attempt is closed.
    toast(friendly(result.payload?.error) || `보내지 못했습니다 (${result.status})`);
    await syncTray(threadId).catch(() => {});
  }
  renderTray(); updateControls();
  // Return focus to the composer only if the user has not moved it somewhere else meanwhile.
  const active = document.activeElement;
  if (state.thread?.id === threadId && !matchMedia('(pointer: coarse)').matches && !$('prompt').disabled && (!active || active === document.body || active === $('send') || active === $('pending-check'))) $('prompt').focus();
}

function renderPendingAttempt() {
  const box = $('pending-attempt'); const entry = state.thread ? state.dispatch.get(state.thread.id) : null;
  if (!entry || entry.phase === 'dispatching' || entry.phase === 'idle') { box.hidden = true; return; }
  const { record } = entry; box.hidden = false;
  const expired = state.dispatch.expired(record.threadId); const checking = entry.phase === 'confirming';
  const preview = record.sentText.trim() ? `"${record.sentText.trim().replace(/\s+/g, ' ').slice(0, 40)}${record.sentText.trim().length > 40 ? '…' : ''}"` : '(글 없이 첨부만)';
  const parts = [`보낸 내용 ${preview}`];
  if (record.attachments.length) parts.push(`첨부 ${record.attachments.length}개`);
  if (record.model) parts.push(`모델 ${record.model}${record.effort ? ` · 추론 ${EFFORT_LABELS[record.effort] || record.effort}` : ''}`);
  const title = checking ? '이전 전송 결과를 확인하는 중…' : '이전 전송의 결과를 아직 모릅니다';
  const detail = checking ? parts.join(' · ')
    : expired ? `${parts.join(' · ')}. 중복 방지 기록 보존 시간(${Math.round(REPLAY_WINDOW_MS / 60000)}분)이 지나 더는 확인할 수 없습니다. 대화 기록을 확인한 뒤 확인을 포기하세요.`
    : `${parts.join(' · ')}. ${UNKNOWN_REASONS[entry.reason] || ''} '결과 다시 확인'은 이 요청을 그대로 다시 보냅니다. 서버가 받은 적이 없다면 이때 한 번 전송되고, 두 번 실행되지는 않습니다.`;
  if ($('pending-title').textContent !== title) $('pending-title').textContent = title;
  if ($('pending-detail').textContent !== detail) $('pending-detail').textContent = detail;
  $('pending-check').hidden = checking || expired; $('pending-discard').hidden = checking;
}

$('pending-check').addEventListener('click', () => { if (state.thread && state.dispatch.unresolved(state.thread.id)) runAttempt(state.thread.id, false); });
$('pending-discard').addEventListener('click', () => {
  const thread = state.thread; if (!thread) return;
  const record = state.dispatch.discard(thread.id); if (!record) return;
  toast('이전 전송 확인을 그만두었습니다. 실제로 전송됐을 수 있으니 대화 기록을 확인한 뒤 필요할 때만 다시 보내세요.', 'info');
  syncTray(thread.id).catch(() => {}); renderTray(); updateControls();
});

/* ---------- Approvals ---------- */
function setCardBusy(card, busy) { for (const control of card.querySelectorAll('button, input, select')) control.disabled = busy; }

function approvalCard(item) {
  const kind = item.display?.kind;
  const title = kind === 'command' ? '명령 실행 승인 요청' : kind === 'files' ? '파일 변경 승인 요청' : 'Codex의 질문';
  const card = el('article', { class: 'approval', 'aria-label': title },
    el('div', { class: 'approval-head' }, icon('alert'), el('span', { text: title })),
    el('p', { class: 'approval-cwd', text: `폴더 · ${item.cwd}` }));
  if (kind === 'command') card.append(el('pre', { text: item.display.command }));
  if (kind === 'files') card.append(el('pre', { text: item.display.changes.map(value => typeof value === 'string' ? value : value.path || JSON.stringify(value)).join('\n') }));
  if (kind === 'input') {
    item.display.questions.forEach((question, index) => {
      const fieldId = `q-${String(item.id).replace(/[^A-Za-z0-9_-]/g, '')}-${index}`;
      const input = question.options?.length ? el('select', { class: 'input', id: fieldId }) : el('input', { class: 'input', id: fieldId, type: 'text' });
      if (question.options?.length) for (const option of question.options) input.append(new Option(option.label || option, option.value || option.label || option));
      input.dataset.questionId = question.id;
      card.append(el('label', { class: 'field', for: fieldId }, el('span', { class: 'field-label', text: question.question || question.text || question.header || question.id })), input);
    });
    const submit = el('button', { class: 'btn btn-primary btn-sm', type: 'button' }, '답변 보내기');
    submit.addEventListener('click', async () => {
      const answers = {}; card.querySelectorAll('[data-question-id]').forEach(input => { answers[input.dataset.questionId] = { answers: [input.value] }; });
      setCardBusy(card, true);
      try { await api(`/api/input/${encodeURIComponent(item.id)}`, { method: 'POST', body: JSON.stringify({ answers }) }); poll(); }
      catch (error) { setCardBusy(card, false); if (error.status !== 401) toast(error.message); }
    });
    card.append(el('div', { class: 'approval-actions' }, submit));
  } else {
    const actions = el('div', { class: 'approval-actions' });
    for (const [label, decision, cls] of [['거부', 'decline', 'btn btn-ghost btn-sm'], ['승인', 'accept', 'btn btn-primary btn-sm']]) {
      const button = el('button', { class: cls, type: 'button' }, label);
      button.addEventListener('click', async () => {
        setCardBusy(card, true);
        try { await api(`/api/approvals/${encodeURIComponent(item.id)}`, { method: 'POST', body: JSON.stringify({ decision }) }); poll(); }
        catch (error) { setCardBusy(card, false); if (error.status !== 401) toast(error.message); }
      });
      actions.append(button);
    }
    card.append(actions);
  }
  return card;
}

function renderApprovals(approvals) {
  const box = $('approvals'); const wanted = new Set(approvals.map(approval => String(approval.id)));
  for (const node of [...box.children]) if (!wanted.has(node.dataset.requestId)) node.remove();
  for (const approval of approvals) {
    // A file-change card is rebuilt when Codex updates its change list (server re-checked it; item/fileChange/patchUpdated).
    const signature = JSON.stringify(approval.display || null);
    const existing = box.querySelector(`[data-request-id="${CSS.escape(String(approval.id))}"]`);
    if (existing && existing.dataset.signature === signature) continue;
    const node = approvalCard(approval); node.dataset.requestId = String(approval.id); node.dataset.signature = signature;
    if (existing) { existing.replaceWith(node); continue; }
    box.append(node);
    announce(approval.display?.kind === 'input' ? 'Codex가 질문을 보냈습니다. 입력창 위에서 답하세요.' : '승인 요청이 도착했습니다. 입력창 위에서 승인하거나 거부하세요.');
  }
}

// Streams update the existing article in place (stable node, no repeated "new message" churn).
// terminal: optional label shown when the turn ended without a normal completion (partial text is kept).
function updateAgent(id, text, streaming, terminal = null) {
  const existing = findItem(id);
  if (!existing || !existing.classList.contains('msg-agent')) { upsert(agentNode(text, streaming), id); if (!terminal) return; }
  const node = findItem(id); const fresh = agentNode(text, streaming);
  if (!text && terminal) fresh.querySelector('.md').replaceChildren(el('p', { class: 'empty-text', text: '(응답을 받기 전에 끝났습니다)' }));
  withAutoScroll(() => {
    node.className = fresh.className;
    if (streaming) node.setAttribute('aria-busy', 'true'); else node.removeAttribute('aria-busy');
    node.querySelector('.md').replaceWith(fresh.querySelector('.md'));
    node.querySelector('.msg-terminal')?.remove();
    if (terminal) node.append(el('p', { class: 'msg-terminal', text: terminal }));
  });
}

// Ends every still-streaming reply of the open task (turn ended, errored, was interrupted, or Codex disconnected).
// Only the open task's feed is on screen and only its events reach here, so other tasks are never touched.
function finalizeStreaming(terminal) {
  for (const node of $('messages').querySelectorAll('.msg-agent[aria-busy="true"]')) {
    const id = node.dataset.itemId; updateAgent(id, state.agentText.get(id) || '', false, terminal);
  }
}

/* ---------- Polling ---------- */
function handleEvent(event, dirty, ending) {
  const params = event.data?.params || {};
  const thread = String(params.threadId || params.thread?.id || params.item?.threadId || '');
  if (thread && thread !== state.thread?.id) return;
  if (event.type === 'blockedApproval' || event.type === 'unsupported') { addNotice('warn', '승인 요청이 차단되었습니다', event.data?.reason === 'outside allowed project' ? '허용된 프로젝트 밖의 요청이라 자동으로 거부했습니다.' : event.data?.reason === 'protected folder' ? '웹 패널의 운영 데이터 폴더 안의 요청이라 자동으로 거부했습니다.' : '처리할 수 없는 형식의 요청이라 자동으로 거부했습니다.'); return; }
  if (event.type !== 'notification' || !state.thread) return;
  const method = event.data.method;
  if (method === 'item/agentMessage/delta') {
    const id = String(params.itemId || ''); if (!id) return;
    state.agentText.set(id, (state.agentText.get(id) || '') + String(params.delta || '')); dirty.add(id); return;
  }
  if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') {
    const item = params.item || {};
    if (item.type === 'agentMessage' && item.id) {
      const text = itemText(item);
      if (method === 'item/completed') {
        if (text) state.agentText.set(item.id, text); dirty.delete(item.id);
        const final = state.agentText.get(item.id) || ''; updateAgent(item.id, final, false);
        if (final) announce(`Codex 응답 완료: ${final.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      else { if (text && text.length > (state.agentText.get(item.id) || '').length) state.agentText.set(item.id, text); dirty.add(item.id); }
      return;
    }
    const node = renderItem(item); if (node) upsert(node, item.id);
    return;
  }
  if (method === 'turn/completed') {
    delete state.activeTurns[thread]; state.tasksStale = true;
    const error = params.turn?.error || params.error;
    const status = String(params.turn?.status?.type || params.turn?.status || '').toLowerCase();
    if (error) { addNotice('error', 'Codex 작업 중 오류가 발생했습니다', error.message || String(error)); ending.label = '오류로 끝남 · 여기까지 받은 내용입니다'; }
    else if (status === 'interrupted') { addNotice('info', '작업을 중단했습니다', ''); ending.label = '중단됨 · 여기까지 받은 내용입니다'; }
    else if (status === 'failed') ending.label = '실패로 끝남 · 여기까지 받은 내용입니다';
    ending.done = true;
  }
}

async function poll() {
  if (state.polling) return; state.polling = true;
  try {
    const data = await api(`/api/state?cursor=${state.cursor}`);
    state.csrf = data.csrf || state.csrf; state.cursor = data.cursor || state.cursor;
    // The first poll only establishes the cursor; history comes from thread/read when a task is opened.
    if (!state.primed) { data.events = []; state.primed = true; }
    state.controlled = new Set(data.controlledThreads || []); state.activeTurns = data.activeTurns || {};
    if (state.thread) state.thread.controlled = state.controlled.has(state.thread.id);
    const wasOnline = state.connection === 'online';
    setConnection(data.connected ? 'online' : 'offline');
    renderApprovals(data.approvals || []);
    const dirty = new Set(); const ending = { done: false, label: null };
    for (const event of data.events || []) handleEvent(event, dirty, ending);
    for (const id of dirty) updateAgent(id, state.agentText.get(id) || '', true);
    if (ending.done) finalizeStreaming(ending.label);
    else if (wasOnline && !data.connected) finalizeStreaming('Codex 연결이 끊겨 응답이 중단되었을 수 있습니다 · 여기까지 받은 내용입니다');
    renderTasks(false); updateControls();
    if (state.tasksStale) { state.tasksStale = false; refreshTasks().catch(() => {}); }
    if ((state.uploads.status === 'error' || state.uploads.refreshFailed) && state.uploads.retries < 5 && Date.now() >= (state.uploads.retryAt || 0)) loadUploadConfig();
  } catch (error) {
    if (error.status !== 401 && state.csrf) setConnection('retry');
  } finally { state.polling = false; }
}

/* ---------- Session & layout ---------- */
function resetSession() {
  for (const tray of state.trays.values()) for (const item of [...tray]) { item.cancelled = true; item.xhr?.abort(); revokePreview(item); }
  clearTimeout(state.traySyncTimer);
  Object.assign(state, { csrf: null, cursor: 0, primed: false, thread: null, loadingThread: null, tasks: [], activeTurns: {}, connection: null, taskSignature: '' });
  state.dispatch = new DispatchBook(); // in-memory only: unresolved sends are forgotten with the session
  state.controlled = new Set(); state.trays = new Map(); state.agentText = new Map(); state.drafts = new Map();
  state.uploads = { enabled: false, status: 'unknown', limits: { ...DEFAULT_LIMITS }, storage: null, retries: 0 };
  $('password').value = ''; $('prompt').value = ''; autosize();
  $('messages').replaceChildren(); $('approvals').replaceChildren(); $('tasks').replaceChildren(); $('toasts').replaceChildren();
  if ($('new-dialog').open) $('new-dialog').close();
  resetModelChoices(); closeSidebar(); renderTray(); syncEmpty(); updateControls();
}

function showLogin(message = '') {
  resetSession();
  $('app-view').hidden = true; $('login-view').hidden = false;
  $('login-error').textContent = message; $('password').focus();
}

function handleUnauthorized() { if (state.csrf) showLogin('세션이 만료되었습니다. 다시 로그인하세요.'); }

async function enterApp() {
  $('login-view').hidden = true; $('app-view').hidden = false;
  syncEmpty(); updateControls();
  const [tasks] = await Promise.allSettled([refreshTasks(), loadModels(), loadUploadConfig()]);
  if (tasks.status === 'rejected' && tasks.reason?.status !== 401) toast(`작업 목록을 불러오지 못했습니다. ${tasks.reason.message}`);
  await poll();
}

const drawerQuery = matchMedia('(max-width: 760px)');
// While the mobile drawer is open everything behind it is inert, so Tab and screen readers stay inside the drawer.
function setBackgroundInert(inert) { for (const node of [document.querySelector('.workspace'), $('toasts')]) node.inert = inert; }
function openSidebar() {
  $('sidebar').classList.add('is-open'); $('scrim').hidden = false; $('open-sidebar').setAttribute('aria-expanded', 'true');
  setBackgroundInert(true);
  setTimeout(() => $('new-task').focus(), 50);
}
function closeSidebar(returnFocus = false) {
  if (!$('sidebar').classList.contains('is-open')) return;
  $('sidebar').classList.remove('is-open'); $('scrim').hidden = true; $('open-sidebar').setAttribute('aria-expanded', 'false');
  setBackgroundInert(false);
  if (returnFocus) $('open-sidebar').focus();
}
drawerQuery.addEventListener('change', event => { if (!event.matches) closeSidebar(); });

function autosize() {
  const prompt = $('prompt');
  if (!prompt.offsetParent) { prompt.style.height = ''; return; }
  prompt.style.height = 'auto';
  prompt.style.height = `${Math.min(prompt.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
}

/* ---------- Wiring ---------- */
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('password').value; const button = $('login-submit');
  if (!password) { $('login-error').textContent = '접근 비밀번호를 입력하세요.'; $('password').focus(); return; }
  button.disabled = true; button.classList.add('is-busy'); button.textContent = '확인 중'; $('login-error').textContent = '';
  try {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(friendly(data.error) || '로그인하지 못했습니다.');
    $('password').value = ''; state.csrf = data.csrf;
    await enterApp();
  } catch (error) {
    $('login-error').textContent = error instanceof TypeError ? '서버에 연결할 수 없습니다.' : error.message;
    $('password').select();
  } finally { button.disabled = false; button.classList.remove('is-busy'); button.textContent = '로그인'; }
});

$('refresh').addEventListener('click', async () => {
  const button = $('refresh'); button.disabled = true;
  try { await Promise.all([refreshTasks(), loadModels(), loadUploadConfig()]); } catch (error) { if (error.status !== 401) toast(`새로고침하지 못했습니다. ${error.message}`); }
  finally { button.disabled = false; }
});

$('new-task').addEventListener('click', async () => {
  const button = $('new-task'); button.disabled = true;
  try {
    const data = await api('/api/projects'); const projects = data.projects || [];
    $('project').replaceChildren(...projects.map(project => new Option(project.name, project.path)));
    $('project-empty').hidden = projects.length > 0; $('project').disabled = !projects.length; $('create-task').disabled = !projects.length;
    closeSidebar(); $('new-dialog').showModal();
  } catch (error) { if (error.status !== 401) toast(`프로젝트 목록을 불러오지 못했습니다. ${error.message}`); }
  finally { button.disabled = false; }
});
$('cancel-task').addEventListener('click', () => $('new-dialog').close());
$('new-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('create-task'); if (button.disabled) return;
  button.disabled = true; button.classList.add('is-busy');
  try {
    const option = $('project').selectedOptions[0];
    const data = await api('/api/tasks/start', { method: 'POST', body: JSON.stringify({ cwd: $('project').value }) });
    const raw = data.result || {}; const id = String(raw.thread?.id || raw.id || raw.threadId || '');
    state.controlled.add(id);
    saveDraft();
    state.thread = { id, title: '새 작업', project: option?.textContent || '', controlled: true, status: 'idle' };
    state.loadingThread = null; restoreDraft(id);
    clearFeed(); resetTurnChoices(); renderTray(); $('new-dialog').close();
    await refreshTasks().catch(() => {});
    updateControls(); $('prompt').focus();
  } catch (error) { if (error.status !== 401) toast(`작업을 만들지 못했습니다. ${error.message}`); }
  finally { button.disabled = false; button.classList.remove('is-busy'); }
});

$('composer').addEventListener('submit', event => { event.preventDefault(); if (!$('send').disabled) sendMessage(); });
$('prompt').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); if (!$('send').disabled) sendMessage(); }
});
$('prompt').addEventListener('input', () => { autosize(); updateControls(); });
$('prompt').addEventListener('paste', event => {
  const data = event.clipboardData; if (!data) return;
  const action = pasteAction({ text: data.getData('text/plain') || '', fileCount: data.files?.length || 0, canAttach: canAttach() });
  if (action === 'attach') { event.preventDefault(); handleFiles(data.files); }
  else if (action === 'blocked') toast(uploadsUnavailableMessage(), 'info');
});
$('attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { handleFiles(event.target.files); event.target.value = ''; });

$('interrupt').addEventListener('click', async () => {
  const thread = state.thread; if (!thread) return;
  const button = $('interrupt'); button.disabled = true;
  // The turn ID shown here only guards against stopping a different turn; the server uses its own record.
  const turnId = state.activeTurns[thread.id];
  try { await api('/api/turns/interrupt', { method: 'POST', body: JSON.stringify({ threadId: thread.id, ...(turnId ? { turnId } : {}) }) }); delete state.activeTurns[thread.id]; }
  catch (error) { if (error.status !== 401) toast(`중단하지 못했습니다. ${error.message}`); }
  finally { button.disabled = false; updateControls(); }
});

$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch { /* session is cleared locally either way */ }
  showLogin();
});

$('model').addEventListener('change', () => refreshEfforts());
$('open-sidebar').addEventListener('click', openSidebar);
$('close-sidebar').addEventListener('click', () => closeSidebar(true));
$('scrim').addEventListener('click', () => closeSidebar(true));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && $('sidebar').classList.contains('is-open')) closeSidebar(true); });

let dragDepth = 0;
const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
function setDragging(active) { const show = active && canAttach(); $('drop-hint').hidden = !show; $('composer-card').classList.toggle('is-dragging', show); }
const workspace = document.querySelector('.workspace');
workspace.addEventListener('dragenter', event => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth++; setDragging(true); });
workspace.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = canAttach() ? 'copy' : 'none'; });
workspace.addEventListener('dragleave', event => { if (!hasFiles(event)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) setDragging(false); });
workspace.addEventListener('drop', event => {
  if (!hasFiles(event)) return;
  event.preventDefault(); dragDepth = 0; setDragging(false);
  if (canAttach()) handleFiles(event.dataTransfer.files);
  else toast(uploadsUnavailableMessage());
});
// Never let a stray drop navigate the tab to a local file.
window.addEventListener('dragover', event => { if (hasFiles(event)) event.preventDefault(); });
window.addEventListener('drop', event => { if (hasFiles(event)) event.preventDefault(); });

(async () => {
  await poll();
  if (state.csrf) await enterApp(); else showLogin();
})();
setInterval(() => { if (state.csrf) poll(); }, 1000);
