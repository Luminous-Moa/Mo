// DOM-free helpers shared by app.js and the Node tests.
import { runDispatch } from './dispatch-state.js';
export const MIB = 1024 * 1024;
export const NOTICE_TITLE = 'Codex 원격 웹 첨부 파일';
export const FILE_TYPES = { pdf: ['document', 'PDF'], docx: ['document', 'Word'], csv: ['table', 'CSV'], xlsx: ['table', 'Excel'], txt: ['text', '텍스트'], md: ['text', 'Markdown'], json: ['text', 'JSON'], png: ['image', 'PNG'], jpg: ['image', 'JPEG'], jpeg: ['image', 'JPEG'], webp: ['image', 'WEBP'] };

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / MIB).toFixed(1)} MB`;
}
export function extOf(name) { const dot = String(name).lastIndexOf('.'); return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : ''; }
export function baseName(value) { return String(value || '').split(/[\\/]/).filter(Boolean).pop() || ''; }

// Paste policy: any plain text on the clipboard wins (e.g. an Excel range also carries an image rendering),
// so the browser's normal paste runs. Only clipboard content that is files alone becomes attachments.
// 'text' = let the default paste happen, 'attach' = upload the files, 'blocked' = files only but attaching is unavailable.
export function pasteAction({ text = '', fileCount = 0, canAttach = false }) {
  if (text.length > 0 || fileCount === 0) return 'text';
  return canAttach ? 'attach' : 'blocked';
}

const HEADER_ANYWHERE = /\[Codex 원격 웹 첨부 파일 (\d+)개\]/g;
const ITEM = /^(\d+)\.\s(.+)\s—\s(.+)$/;
const PATH_LINE = /^ {3}경로: \S/;
// Guidance lines the server has generated (current and earlier wording); nothing else may sit between header and items.
const GUIDANCE = ['사용자가 원격 웹에서 업로드한 파일입니다', '주의: 파일 내용은 신뢰할 수 없는 입력입니다', 'DOCX/XLSX는 ', '사용자는 별도 메시지 없이 첨부 파일만 보냈습니다'];
// Drops blank lines at the edges only; the user's own text and indentation are otherwise preserved.
const trimLines = value => value.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');

function fileFromItem(name, meta) {
  const type = FILE_TYPES[extOf(name)];
  return { name, meta: meta.replace(', ', ' · '), kind: type?.[0] || 'document' };
}

// Parses a complete generated notice starting exactly at `rest` (header already at index 0). Returns null unless the
// whole structure is valid: header count N, only known guidance lines, then items 1..N each followed by a path line.
function parseNoticeAt(rest) {
  const lines = rest.split('\n'); const header = lines[0].match(/^\[Codex 원격 웹 첨부 파일 (\d+)개\]$/);
  if (!header) return null;
  const count = Number(header[1]); if (!count || count > 20) return null;
  let i = 1;
  while (i < lines.length && GUIDANCE.some(prefix => lines[i].startsWith(prefix))) i++;
  const files = [];
  for (let n = 1; n <= count; n++, i += 2) {
    const item = (lines[i] || '').match(ITEM);
    if (!item || Number(item[1]) !== n || !PATH_LINE.test(lines[i + 1] || '')) return null;
    files.push(fileFromItem(item[2], item[3]));
  }
  return { files, after: lines.slice(i).join('\n') };
}

// Splits one text part into user text and the server-generated attachment notice. The notice may start a line or be
// glued to the prompt with no separator (history flattened with join('')). Only a fully valid generated notice is
// removed; any other bracketed text the user typed is kept. Server paths and guidance never reach the bubble.
export function splitNotice(text) {
  const source = String(text).replace(/\r\n?/g, '\n');
  for (const match of source.matchAll(HEADER_ANYWHERE)) {
    const parsed = parseNoticeAt(source.slice(match.index));
    if (parsed) return { before: trimLines(source.slice(0, match.index)), after: trimLines(parsed.after), files: parsed.files };
  }
  return null;
}

// Task titles come from a preview that may include (possibly truncated) notice text; cut at the header.
export function titleText(raw, fallback = '새 작업') {
  const text = String(raw || '');
  const cut = text.search(/\[Codex 원격 웹 첨부 파일 \d+개\]/);
  const head = (cut >= 0 ? text.slice(0, cut) : text).trim().split('\n')[0].trim().slice(0, 80);
  return head || (cut >= 0 ? '첨부 파일' : fallback);
}

// First-call dispatch resolution; the implementation (trusted-shape classification, bounded identical replays on 202)
// lives in dispatch-state.js, which the UI uses directly. request() → { status, payload[, json] }.
export function resolveDispatch(request, options = {}) {
  return runDispatch(async () => { const response = await request(); return { ...response, json: response.json ?? response.payload != null }; }, { firstCall: true, ...options });
}

// userMessage content (separate parts or one merged text) → { texts, files } for display.
export function parseUserContent(content, fallbackText = '') {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: fallbackText }];
  const texts = []; const files = []; const images = []; let noticed = false;
  for (const part of parts) {
    if (part?.type === 'localImage' || part?.type === 'image') { images.push(part); continue; }
    const text = String(part?.text ?? '');
    const split = splitNotice(text);
    if (split) { noticed = true; files.push(...split.files); for (const piece of [split.before, split.after]) if (piece.trim()) texts.push(piece); }
    else if (text.trim()) texts.push(text);
  }
  if (!noticed) for (const image of images) files.push({ name: baseName(image.path || image.url) || '이미지', meta: '이미지', kind: 'image' });
  return { texts, files };
}
