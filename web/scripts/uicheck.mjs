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
async function rightClick(name, find, esc = true) {
  // (Esc closes an open menu, and also a dialog that has the focus)
  if (esc) {
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(100);
  }
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
}, false);
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
    // A closed window stays in the DOM for its dissolve (marked .closing and inert).
    check('Esc closes the message box', (await pg.locator('.win:not(.closing) .msgbox').count()) === 0);
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
// 5. dialog keys and focus (audit B5)
{
  const active = () => pg.evaluate(() => {
    const a = document.activeElement;
    const w = a?.closest('.win');
    return { inActive: !!w && w.classList.contains('active'), msg: !!w?.querySelector('.msgbox'), tag: a?.tagName, label: a?.getAttribute('aria-label') ?? '', tab: a?.classList.contains('tab') ? a.textContent : null };
  });
  const liveBoxes = () => pg.locator('.win:not(.closing) .msgbox').count();
  await pg.evaluate(() => window.__refrag.openApp('export'));
  await pg.waitForTimeout(500);
  const name = pg.locator('.win.active .sa-grid .field > input').first();
  await name.click();
  const newFolder = pg.locator('.win.active [aria-label="Create New Folder"]');
  const openBox = async () => {
    await newFolder.click();
    await pg.waitForTimeout(400);
  };
  // 01-2: with the focus on the caption (a click there), Esc and Enter still reach the box
  await openBox();
  await pg.locator('.win.active .win-title .ttl').click();
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);
  check('Esc closes a message box after a click on its caption', (await liveBoxes()) === 0);
  await openBox();
  await pg.locator('.win.active .win-title .ttl').click();
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(300);
  check('Enter presses the default button with the focus on the caption', (await liveBoxes()) === 0);
  // 01-3: Tab and Shift+Tab stay inside the modal box
  await openBox();
  let inside = true;
  for (const k of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await pg.keyboard.press(k);
    const a = await active();
    inside &&= a.inActive && a.msg;
  }
  check('Tab and Shift+Tab stay inside a modal message box', inside);
  // 01-5: closing it gives the focus back to the control that had it (the button that opened it)
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);
  const back = await active();
  check('closing a modal box puts the focus back on the owner’s control', back.inActive && back.label === 'Create New Folder' && !back.msg, JSON.stringify(back));
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);
  check('Esc closes Save As', (await pg.locator('.win:not(.closing)[aria-label="Save As"]').count()) === 0);

  // 02-13 + 06-16: tabs keep the focus on the arrow keys; Ctrl+PgDn/PgUp switch tabs
  await pg.evaluate(() => window.__refrag.openApp('display'));
  await pg.waitForTimeout(500);
  await pg.locator('.win.active .tab', { hasText: 'Background' }).click();
  await pg.keyboard.press('ArrowRight');
  await pg.keyboard.press('ArrowRight');
  const t2 = await active();
  check('arrow keys walk along the tabs with the focus on them', t2.tab === 'Appearance', JSON.stringify(t2));
  await pg.keyboard.press('Control+PageDown');
  const t3 = await pg.locator('.win.active .tab.on').textContent();
  check('Ctrl+PgDn picks the next tab', t3 === 'Settings', String(t3));
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);

  // 06-3: Ctrl+O runs the editor's own Open (our file picker), never the browser's Open dialog
  await pg.evaluate(() => window.__refrag.openApp('editor'));
  await pg.waitForTimeout(400);
  await pg.locator('.win.active .win-title .ttl').click();
  const chooser = pg.waitForEvent('filechooser', { timeout: 2000 }).then(() => true, () => false);
  await pg.keyboard.press('Control+o');
  check('Ctrl+O opens the active window’s Open command', await chooser);

  // 01-18: closing a window during keyboard Move ends the move (no outline left behind)
  await pg.evaluate(() => window.__refrag.openApp('about'));
  await pg.waitForTimeout(500);
  await pg.keyboard.press('Alt+Space');
  await pg.waitForTimeout(150);
  await pg.keyboard.press('m');
  await pg.waitForTimeout(100);
  const framed = await pg.locator('.drag-frame').count();
  await pg.keyboard.press('Alt+F4');
  await pg.waitForTimeout(300);
  check('closing a window ends its keyboard Move', framed === 1 && (await pg.locator('.drag-frame').count()) === 0, `frame before ${framed}`);

  // 01-8: a drag whose pointer capture is lost drops its outline frame
  await pg.evaluate(() => window.__refrag.openApp('about'));
  await pg.waitForTimeout(500);
  const cap = await pg.locator('.win.active .win-title .ttl').boundingBox();
  await pg.mouse.move(cap.x + 4, cap.y + 4);
  await pg.mouse.down();
  await pg.mouse.move(cap.x + 40, cap.y + 30, { steps: 4 });
  await pg.waitForTimeout(100);
  const dragging = await pg.locator('.drag-frame').count();
  await pg.evaluate(() => document.querySelector('.win.active .win-title').dispatchEvent(new PointerEvent('lostpointercapture', { pointerId: 1 })));
  await pg.waitForTimeout(50);
  check('a drag that loses its pointer capture ends', dragging === 1 && (await pg.locator('.drag-frame').count()) === 0, `frame before ${dragging}`);
  await pg.mouse.up();
  await pg.keyboard.press('Alt+F4');
  await pg.waitForTimeout(300);

  // 01-14: a window maximised on a bigger screen restores inside the smaller one
  await pg.evaluate(() => window.__refrag.openApp('help'));
  await pg.waitForTimeout(500);
  await pg.evaluate(() => (document.querySelector('.win.active').style.left = '1100px'));
  await pg.locator('.win.active .tbtn.max').click();
  await pg.waitForTimeout(400);
  await pg.setViewportSize({ width: 900, height: 700 });
  await pg.waitForTimeout(400);
  await pg.locator('.win.active .tbtn.max').click();
  await pg.waitForTimeout(500);
  const rb = await pg.locator('.win.active').boundingBox();
  check('restore keeps the window on a screen that shrank', rb.x >= 0 && rb.x + rb.width <= 900, JSON.stringify(rb));
  await pg.setViewportSize({ width: 1280, height: 800 });
  await pg.waitForTimeout(400);
}

// ------------------------------------------------------------------ Windows 98 visual rules (audit B7)
{
  // Display Properties ▸ Screen Saver has a spin box ("Wait")
  await pg.evaluate(() => window.__refrag.openApp('display'));
  await pg.waitForTimeout(500);
  await pg.locator('.win.active .tab', { hasText: 'Screen Saver' }).first().click().catch(() => {});
  await pg.waitForTimeout(300);
  const v = await pg.evaluate(() => {
    const help = document.querySelector('.win[aria-label="File Refragmenter Help"]');
    const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
    const view = document.querySelector('canvas.view');
    const b = document.createElement('button');
    b.className = 'btn';
    b.disabled = true;
    const img = document.createElement('img');
    img.className = 'ico';
    b.append(img);
    document.body.append(b);
    const filt = getComputedStyle(img).filter;
    b.remove();
    const spins = [...document.querySelectorAll('.spin-btns > span')].map((s) => s.getBoundingClientRect().height);
    const save = [...document.querySelectorAll('.ed-toolbar .btn')].map((x) => x.textContent.trim()).filter(Boolean);
    return {
      help: !!help,
      meta,
      view: view ? getComputedStyle(view).imageRendering : 'no canvas.view',
      filt,
      emboss: !!document.getElementById('emboss98'),
      spins,
      primary: document.querySelectorAll('.btn.primary').length,
      save,
    };
  });
  check('the Help window is "File Refragmenter Help" (06-25)', v.help);
  check('theme colour is 98 navy (12-8)', v.meta === '#000080', String(v.meta));
  check('the photo view is drawn pixelated (03-5)', v.view === 'pixelated', v.view);
  check('disabled icons use the 98 emboss filter (03-19)', v.emboss && /emboss98/.test(v.filt), v.filt);
  check('spin buttons split into whole pixels (03-17)', v.spins.length > 0 && v.spins.every((hgt) => Number.isInteger(hgt)), v.spins.join(','));
  check('the editor says Save As…, not Export, and no bold .primary buttons (06-23)', v.save.includes('Save As…') && !v.save.includes('Export…') && v.primary === 0, `${v.save.join(' | ')}; primary ${v.primary}`);

  // the emboss itself: a black square comes out as #808080 over a white copy, nothing else (98 colours only)
  await pg.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const x = c.getContext('2d');
    x.fillRect(4, 4, 8, 8);
    const b = document.createElement('button');
    b.className = 'btn';
    b.disabled = true;
    b.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:40px;min-width:0;padding:0';
    const img = document.createElement('img');
    img.src = c.toDataURL();
    img.className = 'ico';
    img.width = img.height = 16;
    b.append(img);
    b.id = 'emb-probe';
    document.body.append(b);
    return new Promise((r) => (img.complete ? r(0) : (img.onload = () => r(0))));
  });
  await pg.waitForTimeout(100);
  const png = await pg.locator('#emb-probe img').screenshot();
  const colours = await pg.evaluate(async (b64) => {
    const im = new Image();
    im.src = 'data:image/png;base64,' + b64;
    await im.decode();
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    const x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    const set = new Set();
    for (let i = 0; i < d.length; i += 4) set.add(((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]).toString(16).padStart(6, '0'));
    document.getElementById('emb-probe').remove();
    return [...set].sort();
  }, png.toString('base64'));
  const ok98 = new Set(['808080', 'ffffff', 'c0c0c0']);
  check('the emboss draws #808080 over white on the button face', colours.includes('808080') && colours.includes('ffffff') && colours.every((c) => ok98.has(c)), colours.join(','));

  // the focus rectangle on a selected Help topic is the XOR yellow, not black on navy (03-15)
  await pg.evaluate(() => window.__refrag.openApp('help'));
  await pg.waitForTimeout(500);
  if (!(await pg.locator('.win.active .hh-tree .hh-leaf').count())) await pg.locator('.win.active .hh-tree .hh-node > .hh-lbl').first().click();
  await pg.waitForTimeout(150);
  await pg.locator('.win.active .hh-tree .hh-leaf > .hh-lbl').first().click();
  await pg.waitForTimeout(300);
  const fo = await pg.evaluate(() => {
    document.querySelector('.win.active .hh-tree')?.focus();
    const l = document.querySelector('.win.active .hh-tree:focus .hh-node.sel > .hh-lbl');
    return l ? getComputedStyle(l).outlineStyle + ' ' + getComputedStyle(l).outlineColor : 'no focused selected topic';
  });
  check('focus on a selected Help topic is the XOR colour', fo === 'dotted rgb(255, 255, 127)', fo);
}

await audits('after interaction');
await shot(pg, 'desktop');

// ------------------------------------------------------------------ phone (audit B6)
{
  const pctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const ph = await pctx.newPage();
  ph.on('pageerror', (e) => errors.push('[phone pageerror] ' + e.message));
  await ph.goto(base);
  await ph.waitForTimeout(3000);
  // close what opened by itself, so the desktop shows
  await ph.evaluate(() => {
    for (const m of document.querySelectorAll('.menu')) m.remove();
    for (const w of [...document.querySelectorAll('.win')]) w.querySelector('.tbtn.close')?.click();
  });
  await ph.waitForTimeout(500);
  const small = (sel, dims = 'both') =>
    ph.evaluate(
      ({ sel, dims }) =>
        [...document.querySelectorAll(sel)]
          .filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden')
          .map((e) => [e, e.getBoundingClientRect()])
          .filter(([, r]) => (dims !== 'w' && r.height < 43.5) || (dims !== 'h' && r.width < 43.5))
          .map(([e, r]) => `${e.className} ${Math.round(r.width)}x${Math.round(r.height)}`),
      { sel, dims },
    );
  // 03-1: the icons flow in rows
  const rows = await ph.evaluate(() => {
    const ics = [...document.querySelectorAll('.dicons .dicon')];
    return { n: ics.length, firstRow: ics.filter((i) => Math.abs(i.offsetTop - ics[0].offsetTop) < 2).length };
  });
  check('phone: desktop icons flow in rows', rows.firstRow >= 2, JSON.stringify(rows));
  await shot(ph, 'phone-desktop');
  // 03-2: Start menu rows (and a cascade's) are finger-sized
  await ph.locator('.start').click();
  await ph.waitForTimeout(400);
  const sub = ph.locator('.menu.startmenu .mi.sub').first();
  if (await sub.count()) {
    await sub.click();
    await ph.waitForTimeout(600);
  }
  await shot(ph, 'phone-start');
  const levels = await ph.locator('.menu').count();
  const smallRows = await small('.menu .mi', 'h');
  check('phone: Start menu and cascade rows are at least 44 px', levels >= 2 && smallRows.length === 0, `${levels} levels; ` + smallRows.slice(0, 4).join(' | '));
  await ph.keyboard.press('Escape');
  await ph.keyboard.press('Escape');
  await ph.waitForTimeout(200);
  // 03-4: transport buttons, tray icons, the caption Menu button, swatches, spinners and drop-down options
  const tooSmall = [];
  await ph.evaluate(() => window.__refrag.openApp('video'));
  await ph.waitForTimeout(800);
  tooSmall.push(...(await small('.win.active .mp-btn, .tray .tray-ico, .win.active .tmenu')));
  await shot(ph, 'phone-video');
  await ph.evaluate(() => window.__refrag.openApp('display'));
  await ph.waitForTimeout(800);
  tooSmall.push(...(await small('.win.active .dp-sw')));
  await ph.locator('.win.active .tab', { hasText: 'Screen Saver' }).click();
  await ph.waitForTimeout(400);
  tooSmall.push(...(await small('.win.active .spin-btns', 'w')));
  const combo = ph.locator('.win.active .combo').first();
  if (await combo.count()) {
    await combo.click();
    await ph.waitForTimeout(300);
    tooSmall.push(...(await small('.combo-opt', 'h')));
    await ph.keyboard.press('Escape');
  }
  check('phone: every touch target is at least 44 px', tooSmall.length === 0, tooSmall.slice(0, 6).join(' | '));
  // 03-21: the big heading stays bigger than body text
  await ph.evaluate(() => window.__refrag.openApp('editor'));
  await ph.waitForTimeout(800);
  const h1 = await ph.evaluate(() => {
    const e = document.querySelector('h1.big');
    return e ? [parseFloat(getComputedStyle(e).fontSize), parseFloat(getComputedStyle(document.body).fontSize), parseFloat(getComputedStyle(e.closest('.win') ?? document.body).fontSize)] : null;
  });
  check('phone: h1.big is bigger than body text', !!h1 && h1[0] >= h1[2] * 1.5, JSON.stringify(h1));
  // phone status bar: Hex Doctor keeps its offset readout
  await ph.evaluate(() => window.__refrag.openApp('hex'));
  await ph.waitForTimeout(800);
  const st = await ph.evaluate(() => {
    const s = document.querySelector('.win.active .win-status');
    return s ? getComputedStyle(s).display : 'none';
  });
  check('phone: Hex Doctor shows its status bar', st !== 'none', st);
  await shot(ph, 'phone-hex');
  // 01-24: the paste fallback tells a phone user how to paste there
  await ph.evaluate(() => window.__refrag.openApp('export'));
  await ph.waitForTimeout(800);
  const pin = ph.locator('.win.active .field > input').first();
  let pasteText = '';
  if (await pin.count()) {
    const b = await pin.boundingBox();
    await ph.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
    await ph.waitForTimeout(250);
    await ph.locator('.menu .mi', { hasText: 'Paste' }).click().catch(() => {});
    await ph.waitForTimeout(600);
    pasteText = (await ph.locator('.win.active .msg-text').textContent().catch(() => '')) ?? '';
    await ph.keyboard.press('Escape');
  }
  check('phone: the paste fallback has no Ctrl+V', !!pasteText && !/Ctrl\+V/.test(pasteText), pasteText);
  // 01-16: a long press opens the context menu (iOS never fires contextmenu)
  await ph.evaluate(() => {
    for (const w of [...document.querySelectorAll('.win')]) w.querySelector('.tbtn.close')?.click();
  });
  await ph.waitForTimeout(500);
  const lp = await ph.evaluate(async () => {
    let x = 0;
    let y = 0;
    for (y = 60; y < innerHeight - 80 && !x; y += 23)
      for (let xx = innerWidth - 10; xx > 10; xx -= 17) {
        const e = document.elementFromPoint(xx, y);
        if (e && e.closest('.desktop') && !e.closest('.dicon, .win, button')) {
          x = xx;
          break;
        }
      }
    if (!x) return 'no free desktop spot';
    const t = document.elementFromPoint(x, y);
    const ev = (type) => t.dispatchEvent(new PointerEvent(type, { pointerType: 'touch', isPrimary: true, pointerId: 7, bubbles: true, clientX: x, clientY: y }));
    ev('pointerdown');
    await new Promise((r) => setTimeout(r, 700));
    const open = document.querySelectorAll('.menu').length;
    ev('pointerup');
    return open;
  });
  check('phone: a long press opens the context menu', lp > 0, String(lp));
  await ph.keyboard.press('Escape');
  await pctx.close();
}

// ------------------------------------------------------------------ tablet: touch with the desktop layout (01-15)
{
  const tctx = await browser.newContext({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1, hasTouch: true });
  const tb = await tctx.newPage();
  await tb.goto(base);
  await tb.waitForTimeout(3000);
  await tb.evaluate(() => window.__refrag.openApp('help'));
  await tb.waitForTimeout(800);
  const z = await tb.evaluate(() => {
    const n = document.querySelector('.win.active .win-rz[data-edge="n"]');
    const c = document.querySelector('.win.active .tbtn.close');
    return { coarse: matchMedia('(pointer: coarse)').matches, top: n?.style.top, h: n?.style.height, btnHit: c ? parseFloat(getComputedStyle(c, '::before').height) : 0 };
  });
  check('tablet: resize zones and caption buttons take a finger', z.coarse && z.top === '-6px' && z.h === '10px' && z.btnHit >= 28, JSON.stringify(z));
  await tctx.close();
}

// ------------------------------------------------------------------ Large Fonts (2×) on the desktop (03-3)
{
  const lctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await lctx.addInitScript(() => localStorage.setItem('refragmenter.settings.v1', JSON.stringify({ bigText: true })));
  const lg = await lctx.newPage();
  await lg.goto(base);
  await lg.waitForTimeout(3000);
  for (const id of ['help', 'export', 'pictures', 'hex']) {
    await lg.evaluate((id) => window.__refrag.openApp(id), id);
    await lg.waitForTimeout(700);
  }
  const clipped = await lg.evaluate(() =>
    [...document.querySelectorAll('.win-title, .win-menu > button, .win-status > *, .hh-node, .sa-file, .sa-head, .fv-row, .fv-cell, .fv-hd, .v-small .fv-item, .v-list .fv-item, .cd-details .cd-item, .cd-head')]
      .filter((e) => e.getClientRects().length)
      .filter((e) => e.getBoundingClientRect().height < 32)
      .map((e) => `${e.className} ${Math.round(e.getBoundingClientRect().height)}px`),
  );
  check('Large Fonts: text rows are at least one 32 px line tall', clipped.length === 0, clipped.slice(0, 6).join(' | '));
  const lgMisc = await lg.evaluate(() => {
    const out = [];
    for (const e of document.querySelectorAll('.start, .task, .tray')) if (e.getBoundingClientRect().height < 32) out.push(`${e.className} ${Math.round(e.getBoundingClientRect().height)}px`);
    const s = document.querySelector('.start');
    if (s && s.scrollWidth > s.clientWidth + 1) out.push(`Start clipped ${s.clientWidth}/${s.scrollWidth}`);
    // desktop icons don't overlap each other
    const r = [...document.querySelectorAll('.dicons .dicon')].map((e) => e.getBoundingClientRect());
    for (let i = 0; i < r.length; i++)
      for (let j = i + 1; j < r.length; j++)
        if (r[i].left < r[j].right - 1 && r[j].left < r[i].right - 1 && r[i].top < r[j].bottom - 1 && r[j].top < r[i].bottom - 1) out.push(`icons ${i} and ${j} overlap`);
    return out;
  });
  check('Large Fonts: taskbar and desktop icons fit', lgMisc.length === 0, lgMisc.slice(0, 6).join(' | '));
  await shot(lg, 'large-fonts');
  await lctx.close();
}

await browser.close();
server.close();
console.log('\n' + '-'.repeat(78));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.name}`);
const fails = results.filter((r) => !r.ok).length;
console.log('-'.repeat(78));
console.log(`${results.length - fails} passed, ${fails} failed`);
if (errors.length) console.log('page errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'));
process.exitCode = fails ? 1 : 0;
