// Native-UI audit (Phase 2): serves dist/, opens every app from the registry and checks that no browser UI
// can show up: no `title` attributes, every <select> hidden behind our drop-down, every visible text in our
// pixel font, right-click menus on each surface (with the browser menu prevented), and the 8 resize zones.
// Also saves screenshots of a cascaded menu, a message box and an open drop-down.
// usage: npm run build && node scripts/uicheck.mjs [outdir]   (default: ../test-local/uicheck)
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveDist } from './serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] ?? path.resolve(here, '..', '..', 'test-local', 'uicheck'));

const server = await serveDist();
const base = server.base;
await mkdir(out, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const shot = async (pg, name, clip) => {
  await pg.screenshot({ path: path.join(out, name + '.png'), clip });
  console.log('shot', name);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const pg = await ctx.newPage();
const errors = [];
pg.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
pg.on('console', (m) => m.type() === 'error' && errors.push('[console] ' + m.text()));
await pg.goto(base);
await pg.waitForTimeout(2500);
// records whether the browser's own menu would have shown (window bubble listener runs after ours)
await pg.evaluate(() => {
  window.__cm = [];
  window.addEventListener('contextmenu', (e) => window.__cm.push(e.defaultPrevented));
});

// a photo makes the editor, Export and Hex Doctor show their full controls
await pg.locator('text=Try a sample photo').first().click().catch(() => {});
await pg.waitForTimeout(2500);

// ------------------------------------------------------------------ open every app from the registry
const appIds = ['editor', 'pictures', 'card', 'presets', 'recycle', 'help', 'about', 'display', 'hex', 'webcam', 'video', 'export'];
for (const id of appIds) {
  await pg.evaluate((id) => window.__refrag.openApp(id), id);
  await pg.waitForTimeout(700);
}
await pg.waitForTimeout(800);
const opened = await pg.locator('.win').count();
check('apps opened from the registry', opened >= appIds.length - 2, `${opened} windows for ${appIds.length} apps`);

// ------------------------------------------------------------------ static audits (everything open at once)
async function audits(tag) {
  const titles = await pg.evaluate(() => [...document.querySelectorAll('[title]')].map((e) => e.tagName.toLowerCase() + '.' + e.className + ': ' + e.getAttribute('title')));
  check(`no [title] attributes (${tag})`, titles.length === 0, titles.slice(0, 5).join(' | '));
  const sel = await pg.evaluate(() => {
    const all = [...document.querySelectorAll('select')];
    const bad = all.filter((s) => getComputedStyle(s).display !== 'none' || !s.closest('.combo'));
    return { n: all.length, bad: bad.map((s) => s.outerHTML.slice(0, 60)) };
  });
  check(`every <select> hidden behind a 98 drop-down (${tag})`, sel.bad.length === 0, `${sel.n} selects; ${sel.bad.slice(0, 3).join(' | ')}`);
  const fonts = await pg.evaluate(() => {
    const bad = new Map();
    let n = 0;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none';
    };
    for (const el of document.querySelectorAll('#app *')) {
      const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()) || ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'range');
      if (!hasText || !visible(el)) continue;
      n++;
      const ff = getComputedStyle(el).fontFamily.replace(/["']/g, '');
      if (!ff.startsWith('Refragmenter Pixel')) bad.set(el.tagName.toLowerCase() + '.' + String(el.className).slice(0, 30), ff);
    }
    return { n, bad: [...bad].map(([k, v]) => `${k}: ${v}`) };
  });
  check(`visible text in Refragmenter Pixel (${tag})`, fonts.bad.length === 0, `${fonts.n} text elements; ${fonts.bad.slice(0, 5).join(' | ')}`);
  const drag = await pg.evaluate(() => [...document.querySelectorAll('#app img')].filter((i) => i.draggable).length);
  check(`no draggable images (${tag})`, drag === 0, `${drag} draggable`);
}
await audits('all apps open');

// ------------------------------------------------------------------ right-click surfaces
async function rightClick(name, find) {
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(100);
  const pt = await pg.evaluate(find);
  if (!pt || (!pt.x && !pt.y)) return check(`right-click: ${name}`, false, pt?.what ?? 'no target found');
  const before = await pg.evaluate(() => window.__cm.length);
  await pg.mouse.click(pt.x, pt.y, { button: 'right' });
  await pg.waitForTimeout(250);
  const menus = await pg.locator('.menu').count();
  const prevented = await pg.evaluate((b) => window.__cm.slice(b), before);
  const items = menus ? (await pg.locator('.menu .mi').allInnerTexts()).map((s) => s.trim().replace(/\s+/g, ' ')).join(' | ') : '';
  if (menus) {
    const b = await pg.locator('.menu').first().boundingBox();
    await shot(pg, 'context-' + name.replace(/\W+/g, '-'), { x: Math.max(0, b.x - 30), y: Math.max(0, b.y - 30), width: Math.min(1280 - Math.max(0, b.x - 30), b.width + 60), height: Math.min(800 - Math.max(0, b.y - 30), b.height + 60) });
  }
  check(`right-click: ${name}`, menus > 0 && prevented.length > 0 && prevented.every(Boolean), `${pt.what}; menu: ${items || 'none'}; browser menu prevented: ${prevented.every(Boolean)}`);
  return menus > 0;
}
// close everything but the editor so the desktop is reachable
await pg.evaluate(() => {
  for (const w of [...document.querySelectorAll('.win')]) if (!w.querySelector('.win-menu')) w.querySelector('.tbtn.close')?.click();
});
await pg.waitForTimeout(400);
await rightClick('desktop', () => {
  for (let y = 40; y < innerHeight - 60; y += 23)
    for (let x = innerWidth - 20; x > 100; x -= 37) {
      const e = document.elementFromPoint(x, y);
      if (e && e.closest('.desktop') && !e.closest('.dicon, .win, button')) return { x, y, what: 'desktop (' + e.className + ')' };
    }
  return null;
});
await rightClick('window body', () => {
  const b = document.querySelector('.win.active .win-body') ?? document.querySelector('.win .win-body');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, what: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.className };
});
await pg.evaluate(() => window.__refrag.openApp('export'));
await pg.waitForTimeout(800);
await pg.locator('.win[aria-label="Save As"] .win-title').click({ position: { x: 120, y: 8 } }).catch(() => {});
await pg.waitForTimeout(200);
await rightClick('text field', () => {
  const hit = (i) => {
    const r = i.getBoundingClientRect();
    return r.width > 4 && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === i;
  };
  const all = [...document.querySelectorAll('.field > input')];
  const f = all.find(hit);
  if (!f) return { x: 0, y: 0, what: `none of ${all.length} inputs reachable: ` + all.map((i) => { const r = i.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.className; }).join(',') };
  const r = f.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, what: 'input[type=' + f.type + ']' };
});
await rightClick('taskbar', () => {
  const t = document.querySelector('.taskbar');
  if (!t) return null;
  const r = t.getBoundingClientRect();
  for (let x = r.right - 200; x > r.left + 60; x -= 7) {
    const e = document.elementFromPoint(x, r.top + r.height / 2);
    if (e && !e.closest('button') && t.contains(e)) return { x, y: r.top + r.height / 2, what: e.className };
  }
  return null;
});
await pg.keyboard.press('Escape');

// ------------------------------------------------------------------ resize zones (Agent A's frame)
await pg.evaluate(() => window.__refrag.openApp('help'));
await pg.waitForTimeout(800);
{
  const win = pg.locator('.win.active');
  const want = { n: [0, -1, 0, 1], s: [0, 0, 0, 1], e: [0, 0, 1, 0], w: [-1, 0, 1, 0], ne: [0, -1, 1, 1], nw: [-1, -1, 1, 1], se: [0, 0, 1, 1], sw: [-1, 0, 1, 1] };
  for (const [edge, [ex, ey, ew, eh]] of Object.entries(want)) {
    const zl = win.locator(`.win-rz[data-edge="${edge}"]`);
    if (!(await zl.count())) {
      check(`resize zone ${edge}`, false, 'no .win-rz handle');
      continue;
    }
    const z = await zl.boundingBox();
    const gx = edge.includes('w') ? z.x + 1 : edge.includes('e') ? z.x + z.width - 2 : z.x + z.width / 2;
    const gy = edge.startsWith('n') ? z.y + 1 : edge.startsWith('s') ? z.y + z.height - 2 : z.y + z.height / 2;
    const before = await win.boundingBox();
    const d = 30;
    await pg.mouse.move(gx, gy);
    await pg.mouse.down();
    await pg.mouse.move(gx + (edge.includes('w') ? -d : edge.includes('e') ? d : 0), gy + (edge.startsWith('n') ? -d : edge.startsWith('s') ? d : 0), { steps: 4 });
    await pg.mouse.up();
    const after = await win.boundingBox();
    const got = [after.x - before.x, after.y - before.y, after.width - before.width, after.height - before.height].map(Math.round);
    check(`resize zone ${edge}`, got.every((g, i) => Math.abs(g - [ex, ey, ew, eh][i] * d) <= 1), `changed ${got.join(',')}`);
  }
}

// ------------------------------------------------------------------ screenshots for a visual 98 comparison
// 1. editor View menu with the "Missing blocks" submenu cascaded
await pg.evaluate(() => window.__refrag.openApp('editor'));
await pg.waitForTimeout(600);
const viewTitle = pg.locator('.win.active .win-menu > button', { hasText: 'View' });
if (await viewTitle.count()) {
  await viewTitle.click();
  await pg.waitForTimeout(150);
  const sub = pg.locator('.menu .mi.sub').first();
  if (await sub.count()) {
    await sub.hover();
    await pg.waitForTimeout(600);
  }
  const subs = await pg.locator('.menu').count();
  check('submenu cascades beside its parent (hover 400 ms)', subs >= 2, `${subs} menu levels open`);
  // the submenu must sit beside, not over, its parent
  if (subs >= 2) {
    const [a, b] = [await pg.locator('.menu').nth(0).boundingBox(), await pg.locator('.menu').nth(1).boundingBox()];
    check('submenu placed beside the parent menu', b.x >= a.x + a.width - 4 || b.x + b.width <= a.x + 4, `parent x ${a.x}..${a.x + a.width}, sub x ${b.x}..${b.x + b.width}`);
  }
  const mb = await pg.locator('.menu').first().boundingBox();
  await shot(pg, 'menu-submenu', { x: Math.max(0, mb.x - 80), y: Math.max(0, mb.y - 40), width: 640, height: 360 });
  // keyboard: Right on a menu bar title walks along the bar
  await pg.keyboard.press('Escape');
  await pg.keyboard.press('Escape');
  await pg.keyboard.press('ArrowRight');
  await pg.waitForTimeout(150);
  await pg.keyboard.press('Escape');
}
// menu-bar hover tracking
{
  const titles = pg.locator('.win.active .win-menu > button');
  if ((await titles.count()) >= 2) {
    await titles.nth(0).click();
    await pg.waitForTimeout(100);
    await titles.nth(1).hover();
    await pg.waitForTimeout(150);
    const open = await titles.nth(1).evaluate((b) => b.classList.contains('open'));
    check('menu bar tracks the pointer once a menu is open', open);
    await pg.keyboard.press('Escape');
  }
}
// 2. message box
await pg.evaluate(() => document.querySelector('.win.active input, .win.active .btn')?.focus());
await pg.evaluate(() => window.__refrag.openApp('recycle'));
await pg.waitForTimeout(600);
const empty = pg.locator('.win.active .btn', { hasText: 'Empty' });
let msgShown = false;
if (await empty.count()) {
  if (await empty.first().isEnabled()) {
    await empty.first().click();
    await pg.waitForTimeout(400);
    msgShown = true;
  }
}
if (!msgShown) {
  // the Recycle Bin is empty: trigger a Paste failure box instead (clipboard read is denied headless)
  await pg.evaluate(() => window.__refrag.openApp('export'));
  await pg.waitForTimeout(600);
  const inp = pg.locator('.win.active .field > input').first();
  if (await inp.count()) {
    await inp.click({ button: 'right' });
    await pg.waitForTimeout(150);
    await pg.locator('.menu .mi', { hasText: 'Paste' }).click();
    await pg.waitForTimeout(600);
  }
}
{
  const mbox = pg.locator('.win.active .msgbox');
  check('message box opens (98 layout)', (await mbox.count()) > 0);
  if (await mbox.count()) {
    const wb = await pg.locator('.win.active').boundingBox();
    await shot(pg, 'message-box', { x: Math.max(0, wb.x - 20), y: Math.max(0, wb.y - 20), width: Math.min(1280, wb.width + 40), height: wb.height + 40 });
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(200);
    check('Esc closes the message box', (await pg.locator('.msgbox').count()) === 0);
  }
}
// 3. drop-down list open
await pg.evaluate(() => window.__refrag.openApp('display'));
await pg.waitForTimeout(600);
await pg.locator('.win.active .tab', { hasText: 'Screen Saver' }).click().catch(() => {});
await pg.waitForTimeout(300);
{
  const combo = pg.locator('.win.active .combo').first();
  if (await combo.count()) {
    await combo.click();
    await pg.waitForTimeout(200);
    const list = pg.locator('.combo-list');
    check('drop-down list opens (no native popup)', (await list.count()) === 1);
    const cb = await combo.boundingBox();
    await shot(pg, 'dropdown-open', { x: Math.max(0, cb.x - 60), y: Math.max(0, cb.y - 60), width: 420, height: 260 });
    await pg.keyboard.press('ArrowDown');
    await pg.keyboard.press('Escape');
    check('Esc closes the drop-down list', (await list.count()) === 0);
  } else check('drop-down list opens (no native popup)', false, 'no .combo in Display Properties');
}
// 4. tooltip
{
  const t = pg.locator('[data-tip]').filter({ visible: true }).first();
  if (await t.count()) {
    await t.hover();
    await pg.waitForTimeout(800);
    const tip = await pg.locator('.tooltip').count();
    check('98 tooltip after hover', tip === 1);
    if (tip) {
      const b = await pg.locator('.tooltip').boundingBox();
      await shot(pg, 'tooltip', { x: Math.max(0, b.x - 60), y: Math.max(0, b.y - 40), width: Math.min(500, b.width + 120), height: b.height + 60 });
    }
  }
}
await audits('after interaction');
await shot(pg, 'desktop');

await browser.close();
server.close();
console.log('\n' + '-'.repeat(78));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}`);
const fails = results.filter((r) => !r.ok).length;
console.log('-'.repeat(78));
console.log(`${results.length - fails} passed, ${fails} failed`);
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
process.exitCode = fails ? 1 : 0;
