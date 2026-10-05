// Visual audit: serves dist/, opens every app on its own (maximised-free, at its default size), every menu of its
// menu bar and every tab, and screenshots each into ../test-local/audit. Also a mid-drag shot of the move frame.
// usage: npm run build && node scripts/audit.mjs [filter ...]
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveDist } from './serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', '..', 'test-local', 'audit');

const server = await serveDist();
const base = server.base;
await mkdir(out, { recursive: true });
const want = process.argv.slice(2);
const run = (name) => !want.length || want.some((w) => name.includes(w));

const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
pg.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && errors.push(`[${m.type()}] ${m.text()}`));
await pg.goto(base);
await pg.waitForTimeout(3000);
await pg.locator('text=Try a sample photo').first().click().catch(() => {});
await pg.waitForTimeout(2500);

const shot = async (name, clip) => {
  await pg.screenshot({ path: path.join(out, name + '.png'), clip });
  console.log('shot', name);
};
const closeAll = () =>
  pg.evaluate(() => {
    for (const m of document.querySelectorAll('.menu')) m.remove();
    for (const w of [...document.querySelectorAll('.win')]) w.querySelector('.tbtn.close')?.click();
  });
const winClip = async () => {
  const b = await pg.locator('.win.active').boundingBox();
  if (!b) return undefined;
  const x = Math.max(0, b.x - 8);
  const y = Math.max(0, b.y - 8);
  return { x, y, width: Math.min(1366 - x, b.width + 16), height: Math.min(768 - y, b.height + 16) };
};

// characters the pixel font has (anything else falls back to a system font and breaks the pixel grid)
const glyphSrc = await readFile(path.resolve(here, 'glyphs.txt'), 'utf8');
const have = new Set([0x20, 0xa0, 0x0a, 0x09]);
for (const l of glyphSrc.split(/\r?\n/)) if (l.startsWith('= ')) have.add(l.slice(2).startsWith('U+') ? parseInt(l.slice(4), 16) : l.codePointAt(2));
const problems = [];
const report = (tag, msg) => {
  problems.push(`${tag}: ${msg}`);
  console.log(`!! ${tag}: ${msg}`);
};

/** In the active window: content clipped without a way to scroll, things sticking out of the window, and
 *  visible characters the pixel font lacks. */
async function layoutChecks(tag) {
  const r = await pg.evaluate(() => {
    const win = document.querySelector('.win.active');
    if (!win) return { clipped: [], out: [], chars: '' };
    const wr = win.getBoundingClientRect();
    const name = (e) => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '');
    const clipped = [];
    const out = [];
    let chars = '';
    for (const e of win.querySelectorAll('*')) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const b = e.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      const hid = (v) => v === 'hidden' || v === 'clip';
      if ((hid(cs.overflowY) && e.scrollHeight > e.clientHeight + 3) || (hid(cs.overflowX) && e.scrollWidth > e.clientWidth + 3 && cs.textOverflow !== 'ellipsis' && cs.whiteSpace !== 'nowrap'))
        clipped.push(`${name(e)} ${e.clientWidth}x${e.clientHeight} content ${e.scrollWidth}x${e.scrollHeight}`);
      const clippedByAncestor = () => {
        for (let p = e.parentElement; p && p !== win; p = p.parentElement) if (getComputedStyle(p).overflow !== 'visible') return true;
        return false;
      };
      if ((b.right > wr.right + 1 || b.bottom > wr.bottom + 1) && !clippedByAncestor()) out.push(`${name(e)} ends at ${Math.round(b.right - wr.left)},${Math.round(b.bottom - wr.top)} (win ${Math.round(wr.width)}x${Math.round(wr.height)})`);
      for (const c of e.childNodes) if (c.nodeType === 3) chars += c.textContent;
      if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') chars += e.value ?? '';
    }
    return { clipped: clipped.slice(0, 8), out: out.slice(0, 8), chars };
  });
  for (const c of r.clipped) report(tag, 'clipped ' + c);
  for (const o of r.out) report(tag, 'outside window: ' + o);
  const missing = [...new Set([...r.chars].filter((c) => !have.has(c.codePointAt(0))))];
  if (missing.length) report(tag, 'chars not in the pixel font: ' + missing.map((c) => `${c} U+${c.codePointAt(0).toString(16)}`).join(' '));
}

if (run('desk')) {
  await closeAll();
  await pg.waitForTimeout(400);
  await shot('desk-empty');
  await pg.locator('.start').click();
  await pg.waitForTimeout(400);
  await shot('desk-start');
  const progs = pg.locator('.menu .mi.sub').first();
  if (await progs.count()) {
    await progs.hover();
    await pg.waitForTimeout(700);
    await shot('desk-start-sub');
  }
  await pg.keyboard.press('Escape');
  await pg.keyboard.press('Escape');
}

const apps = ['editor', 'pictures', 'card', 'presets', 'recycle', 'help', 'about', 'display', 'hex', 'webcam', 'video', 'export'];
for (const id of apps) {
  if (!run(id)) continue;
  await closeAll();
  await pg.waitForTimeout(300);
  await pg.evaluate((id) => window.__refrag.openApp(id), id);
  await pg.waitForTimeout(1500);
  await shot(`app-${id}`, await winClip());
  await layoutChecks(id);
  // every menu of the menu bar
  const titles = pg.locator('.win.active .win-menu > button');
  const n = await titles.count();
  for (let i = 0; i < n; i++) {
    const label = (await titles.nth(i).innerText()).trim().replace(/\W+/g, '');
    await titles.nth(i).click();
    await pg.waitForTimeout(250);
    const mn = await pg.evaluate(() => {
      const out = [];
      for (const m of document.querySelectorAll('.menu')) {
        const seen = new Map();
        for (const it of m.querySelectorAll(':scope > .mi')) {
          const label = it.querySelector('.mlabel')?.textContent ?? '';
          const u = it.querySelector('.mlabel u')?.textContent?.toLowerCase();
          if (!u) out.push(`no access key: "${label}"`);
          else if (seen.has(u)) out.push(`access key ${u} twice: "${seen.get(u)}" and "${label}"`);
          else seen.set(u, label);
        }
      }
      return out;
    });
    for (const p of mn) report(`${id}/menu ${label}`, p);
    const mb = await pg.locator('.menu').first().boundingBox();
    const wb = await winClip();
    if (mb && wb) {
      const x = Math.min(wb.x, mb.x - 4);
      const y = Math.min(wb.y, mb.y - 4);
      await shot(`app-${id}-menu-${label}`, { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(1366 - Math.max(0, x), Math.max(wb.x + wb.width, mb.x + mb.width + 4) - x), height: Math.min(768 - Math.max(0, y), Math.max(wb.y + wb.height, mb.y + mb.height + 4) - y) });
    }
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(100);
  }
  // every tab
  const tabs = pg.locator('.win.active .tab');
  const tn = await tabs.count();
  for (let i = 1; i < tn; i++) {
    const label = (await tabs.nth(i).innerText()).trim().replace(/\W+/g, '');
    await tabs.nth(i).click().catch(() => {});
    await pg.waitForTimeout(500);
    await shot(`app-${id}-tab-${label}`, await winClip());
    await layoutChecks(`${id}/${label}`);
  }
}

if (run('dither')) {
  await closeAll();
  await pg.waitForTimeout(400);
  await pg.evaluate(() => window.__refrag.openApp('about'));
  await pg.waitForTimeout(80);
  await shot('dither-open');
  await pg.waitForTimeout(600);
  await pg.evaluate(() => document.querySelector('.win.active .tbtn.close')?.click());
  await pg.waitForTimeout(90);
  await shot('dither-close');
  await pg.waitForTimeout(400);
  const left = await pg.locator('.win').count();
  if (left) report('dither', `${left} window(s) still in the DOM after closing`);
}

if (run('drag')) {
  await closeAll();
  await pg.evaluate(() => window.__refrag.openApp('help'));
  await pg.waitForTimeout(800);
  const t = await pg.locator('.win.active .win-title').boundingBox();
  await pg.mouse.move(t.x + 120, t.y + 8);
  await pg.mouse.down();
  await pg.mouse.move(t.x + 260, t.y + 120, { steps: 5 });
  await pg.waitForTimeout(100);
  await shot('drag-move');
  await pg.mouse.up();
  await pg.waitForTimeout(200);
  await shot('drag-after');
}

await browser.close();
server.close();
console.log(`\n${problems.length} layout/font problems`);
if (errors.length) console.log('--- console ---\n' + [...new Set(errors)].slice(0, 40).join('\n'));
