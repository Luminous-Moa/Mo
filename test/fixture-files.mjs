// Synthetic attachment samples built from scratch with Node stdlib. No personal or external data.
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
export function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

// Minimal stored (uncompressed) ZIP container.
export function zip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8'); const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'); const crc = crc32(body);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function png(width = 64, height = 64) {
  const chunk = (type, data) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const tag = Buffer.from(type, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tag, data]))); return Buffer.concat([head, tag, data, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) { row[1 + x * 3] = 40 + Math.round(80 * x / width); row[2 + x * 3] = 120 + Math.round(90 * y / height); row[3 + x * 3] = 140; }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

export function pdf(text = 'Codex Remote Web synthetic test PDF') {
  const stream = `BT /F1 18 Tf 72 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let out = '%PDF-1.4\n'; const offsets = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function docx(paragraphs = ['Codex 원격 웹 합성 DOCX 문서입니다.'], { macro = false } = {}) {
  const body = paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`).join('');
  const entries = [
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: `${XML_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>` }
  ];
  // The "macro" part is inert placeholder bytes; it only exercises the vbaProject.bin rejection rule.
  if (macro) entries.push({ name: 'word/vbaProject.bin', data: 'synthetic placeholder, not a macro' });
  return zip(entries);
}

export function xlsx(rows = [['항목', '수량'], ['사과', 3], ['배', 5]]) {
  const column = index => String.fromCharCode(65 + index);
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => typeof value === 'number'
    ? `<c r="${column(c)}${r + 1}"><v>${value}</v></c>`
    : `<c r="${column(c)}${r + 1}" t="inlineStr"><is><t>${xml(value)}</t></is></c>`).join('')}</row>`).join('');
  return zip([
    { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>` },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', data: `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>` }
  ]);
}

// accept: the server must store it; reject: the server must refuse it with 415.
export function sampleFiles() {
  return [
    { name: 'sample-report.pdf', type: 'application/pdf', data: pdf(), expect: 'accept' },
    { name: 'sample-notes.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx(['Codex 원격 웹 합성 DOCX 문서입니다.', '두 번째 문단입니다.']), expect: 'accept' },
    { name: 'sample-table.csv', type: 'text/csv', data: Buffer.from('\ufeff항목,수량,단가\n사과,3,1200\n배,5,2300\n', 'utf8'), expect: 'accept' },
    { name: 'sample-sheet.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data: xlsx(), expect: 'accept' },
    { name: 'sample-readme.txt', type: 'text/plain', data: Buffer.from('Codex 원격 웹 합성 텍스트 파일입니다.\n둘째 줄입니다.\n', 'utf8'), expect: 'accept' },
    { name: 'sample-guide.md', type: 'text/markdown', data: Buffer.from('# 합성 안내서\n\n- 항목 하나\n- 항목 둘\n', 'utf8'), expect: 'accept' },
    { name: 'sample-data.json', type: 'application/json', data: Buffer.from(JSON.stringify({ sample: true, items: [1, 2, 3], note: '합성 데이터' }, null, 2), 'utf8'), expect: 'accept' },
    { name: 'sample-image.png', type: 'image/png', data: png(), expect: 'accept' },
    { name: 'reject-macro.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: docx(['매크로 부품이 들어 있는 합성 문서'], { macro: true }), expect: 'reject' },
    { name: 'reject-fake-image.png', type: 'image/png', data: Buffer.from('this is text pretending to be a png', 'utf8'), expect: 'reject' },
    { name: 'reject-invalid-utf8.txt', type: 'text/plain', data: Buffer.from([0x48, 0x69, 0xff, 0xfe, 0x21]), expect: 'reject' },
    { name: 'reject-unsupported.zip', type: 'application/zip', data: zip([{ name: 'inside.txt', data: 'archive member' }]), expect: 'reject' }
  ];
}
