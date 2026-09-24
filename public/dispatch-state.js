// Per-task record of turn dispatches whose final outcome is not yet known. DOM-free: used by app.js and the tests.
//
// Scope, stated honestly: records live in this page's memory only. A reload, logout or session expiry forgets them
// (no private prompt is written to browser storage). The server remembers a requestId for 10 minutes, so a result
// check is only offered inside REPLAY_WINDOW_MS; after that the server could no longer tell "already ran" apart from
// "never seen", and replaying might start a second turn.
export const REPLAY_WINDOW_MS = 9 * 60_000;
// 16 × 1.5 s ≈ 24 s, longer than the bridge's 20 s turn/start timeout, so an in-flight dispatch normally resolves.
export const CONFIRM_ATTEMPTS = 16;
export const CONFIRM_DELAY_MS = 1500;

// Only these trusted server shapes may finalize an attempt; anything else (gateway 5xx/52x, HTML error pages,
// malformed JSON, unexpected shapes) is 'unknown'. `firstCall`: a structured 4xx to the very first request is a
// definitive pre-dispatch refusal; on a later check it only means the server no longer has the record.
export function classifyResponse(response, { firstCall = false } = {}) {
  if (!response) return { kind: 'unknown', reason: 'network' };
  const { status, payload, json } = response;
  if (status === 401) return { kind: 'auth' };
  if (!json || !payload || typeof payload !== 'object' || Array.isArray(payload)) return { kind: 'unknown', reason: status >= 500 ? 'server' : 'malformed' };
  if (status === 200) return payload.result && typeof payload.result === 'object' ? { kind: 'sent' } : { kind: 'unknown', reason: 'malformed' };
  if (status === 202) return payload.status === 'dispatching' ? { kind: 'pending' } : { kind: 'unknown', reason: 'malformed' };
  if (status === 422 && payload.rejected === true && typeof payload.error === 'string') return { kind: 'rejected' };
  if (status === 409 && payload.uncertain === true) return { kind: 'uncertain' };
  if (status >= 400 && status < 500 && typeof payload.error === 'string') return firstCall ? { kind: 'failed' } : { kind: 'unknown', reason: 'no-record' };
  return { kind: 'unknown', reason: status >= 500 ? 'server' : 'malformed' };
}

// send() → { status, payload, json } (throws when no HTTP answer arrived). Replays the SAME send (same body) while the
// server answers 202, up to `attempts` times; never builds a new request.
// Outcomes: sent | rejected | uncertain | failed | unknown | auth.
export async function runDispatch(send, { firstCall = false, attempts = CONFIRM_ATTEMPTS, delayMs = CONFIRM_DELAY_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), onPending = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response = null;
    try { response = await send(); } catch { response = null; }
    const verdict = classifyResponse(response, { firstCall: firstCall && attempt === 0 });
    if (verdict.kind !== 'pending') return { outcome: verdict.kind, reason: verdict.reason, status: response?.status, payload: response?.payload };
    if (attempt >= attempts) return { outcome: 'unknown', reason: 'timeout', timedOut: true, status: 202 };
    onPending(attempt + 1);
    await sleep(delayMs);
  }
}

// Draft text left after a confirmed send: only the exact text that was sent is consumed.
export function draftAfterSend(current, sent) { return current === sent ? '' : current; }

// Merges the server's staged-attachment list into a task tray. Attachments that belong to a dispatching or unresolved
// attempt are kept even though the server no longer lists them (they are claimed or already sent).
export function reconcileTray(tray, serverItems, protectedIds, startedAt) {
  const listed = new Map(serverItems.map(item => [item.id, item]));
  const kept = []; const dropped = [];
  for (const item of tray) {
    if (item.status !== 'ready') { kept.push(item); continue; }
    const server = listed.get(item.id);
    if (server) { item.attempted = Boolean(server.attempted); kept.push(item); }
    else if (protectedIds.has(item.id) || item.readyAt >= startedAt) kept.push(item);
    else dropped.push(item);
  }
  const known = new Set(kept.map(item => item.id).filter(Boolean));
  return { kept, dropped, added: serverItems.filter(item => !known.has(item.id)) };
}

export class DispatchBook {
  constructor({ now = () => Date.now() } = {}) { this.entries = new Map(); this.now = now; }

  get(threadId) { return this.entries.get(threadId) || null; }
  busy(threadId) { const entry = this.get(threadId); return Boolean(entry && entry.phase !== 'unresolved'); }
  unresolved(threadId) { return this.get(threadId)?.phase === 'unresolved'; }
  protectedIds(threadId) { return new Set(this.get(threadId)?.record.attachments.map(item => item.id) || []); }
  expired(threadId) { const entry = this.get(threadId); return Boolean(entry && this.now() - entry.record.createdAt >= REPLAY_WINDOW_MS); }

  // Freezes everything that defines the attempt; later selector, draft or tray changes cannot alter it.
  begin({ threadId, requestId, prompt, sentText, attachments = [], model = null, effort = null }) {
    if (this.entries.has(threadId)) throw new Error('This task already has an unresolved send');
    const body = { threadId, prompt };
    if (attachments.length) body.attachments = attachments.map(item => item.id);
    if (model) body.model = model;
    if (effort) body.effort = effort;
    body.requestId = requestId;
    const record = Object.freeze({ threadId, requestId, body: JSON.stringify(body), sentText, model, effort, createdAt: this.now(),
      attachments: Object.freeze(attachments.map(item => Object.freeze({ ...item }))) });
    const entry = { record, phase: 'idle', reason: null };
    this.entries.set(threadId, entry);
    return entry;
  }

  // Runs the first dispatch (firstCall) or a result check of an unresolved attempt with the exact stored body.
  async run(threadId, transport, { firstCall = false, ...options } = {}) {
    const entry = this.get(threadId);
    if (!entry) throw new Error('No send to run for this task');
    if (entry.phase === 'dispatching' || entry.phase === 'confirming') throw new Error('This send is already being checked');
    if (!firstCall && this.expired(threadId)) return { outcome: 'expired', record: entry.record };
    entry.phase = firstCall ? 'dispatching' : 'confirming'; entry.reason = null;
    const result = await runDispatch(() => transport(entry.record.body), { ...options, firstCall,
      onPending: attempt => { entry.phase = 'confirming'; options.onPending?.(attempt); } });
    if (this.get(threadId) !== entry) return { ...result, record: entry.record, stale: true };
    if (result.outcome === 'unknown') { entry.phase = 'unresolved'; entry.reason = result.reason; }
    else this.entries.delete(threadId); // final (sent/rejected/uncertain/failed) or auth (session is being cleared)
    return { ...result, record: entry.record };
  }

  // Explicit user decision to stop checking an unresolved attempt (e.g. after the replay window).
  discard(threadId) {
    const entry = this.get(threadId);
    if (!entry || entry.phase !== 'unresolved') return null;
    this.entries.delete(threadId);
    return entry.record;
  }

  clear() { this.entries.clear(); }
}
