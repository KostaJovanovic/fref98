// Reads the user's Foldy lines from docs/foldy-lines.xlsx and writes src/foldy/lines.gen.json.
// Column A is the line ID, the "YOUR LINE" column the user's text. " | " separates alternatives (one is picked at
// random); "—" means he says nothing there; an empty cell keeps the built-in line.
// usage (from web/): npm run lines
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const XLSX = path.resolve(here, '..', '..', 'docs', 'foldy-lines.xlsx');
const OUT = path.resolve(here, '..', 'src', 'foldy', 'lines.gen.json');

/** The files of a ZIP (stored or deflated), read from its central directory. */
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataAt, dataAt + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unxml = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Text of every <t> inside a fragment (rich text has several runs). */
const texts = (frag) => [...frag.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

function readSheet(files) {
  const shared = files.has('xl/sharedStrings.xml')
    ? [...files.get('xl/sharedStrings.xml').toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]))
    : [];
  const xml = files.get('xl/worksheets/sheet1.xml').toString('utf8');
  const rows = [];
  for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, col, attrs, body = ''] = c;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let v = '';
      if (type === 's') v = shared[Number(/<v>(\d+)<\/v>/.exec(body)?.[1])] ?? '';
      else if (type === 'inlineStr') v = texts(body);
      else v = unxml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      row[col] = v;
    }
    rows.push(row);
  }
  return rows;
}

const rows = readSheet(unzip(readFileSync(XLSX)));
const head = rows.shift() ?? {};
const yourCol = Object.keys(head).find((k) => /YOUR LINE/i.test(head[k]));
if (!yourCol) throw new Error('no "YOUR LINE" column in the header row');
const out = {};
for (const row of rows) {
  const id = (row.A ?? '').trim();
  const text = (row[yourCol] ?? '').trim();
  if (!id || !text) continue;
  out[id] = text === '—' || text === '-' ? [] : text.split(' | ').map((s) => s.trim()).filter(Boolean);
}
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`${Object.keys(out).length} of your lines -> ${path.relative(process.cwd(), OUT)}`);
