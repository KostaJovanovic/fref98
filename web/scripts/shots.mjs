// Serves dist/ and takes screenshots at desktop 1366×768 and phone 390×844 into shots/.
// usage: npm run build && node scripts/shots.mjs [scenario ...]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveDist } from './serve.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..', 'shots');

const server = await serveDist();
const base = server.app;
await mkdir(out, { recursive: true });

const want = process.argv.slice(2);
const run = (name) => !want.length || want.some((w) => name.includes(w));

const browser = await chromium.launch();
const errors = [];

async function page(opts) {
  const ctx = await browser.newContext(opts);
  const pg = await ctx.newPage();
  pg.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()} @ ${m.location().url}`);
  });
  pg.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  pg.on('response', (r) => {
    if (r.status() >= 400) errors.push(`[http ${r.status()}] ${r.url()}`);
  });
  await pg.goto(base);
  await pg.waitForTimeout(2500);
  return { ctx, pg };
}

async function shot(pg, name) {
  await pg.screenshot({ path: path.join(out, name + '.png') });
  console.log('shot', name);
}

async function clickText(pg, text) {
  await pg.locator(`text=${text}`).first().click();
}

const desktop = { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 };
const desktop125 = { viewport: { width: 1093, height: 614 }, deviceScaleFactor: 1.25 };
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

if (run('desk')) {
  const { ctx, pg } = await page(desktop);
  await shot(pg, 'desk-1-first-run');
  await clickText(pg, 'Try a sample photo');
  await pg.waitForTimeout(2500);
  await shot(pg, 'desk-2-sample');
  await clickText(pg, 'Dead SD card');
  await pg.waitForTimeout(3000);
  await shot(pg, 'desk-3-preset');
  await pg.locator('.start').click();
  await pg.waitForTimeout(400);
  await shot(pg, 'desk-4-start');
  await pg.keyboard.press('Escape');
  // the editor's Expert tab
  await pg.locator('.win .tab', { hasText: 'Expert' }).first().click();
  await pg.waitForTimeout(1500);
  await shot(pg, 'desk-5-expert');
  await ctx.close();
}

if (run('apps')) {
  const { ctx, pg } = await page(desktop);
  await clickText(pg, 'Try a sample photo');
  await pg.waitForTimeout(2000);
  for (const [app, label] of [['pictures', 'My Pictures'], ['card', 'Removable Disk (E:)'], ['presets', 'Presets'], ['help', 'Help'], ['recycle', 'Recycle Bin']]) {
    await pg.locator(`.dicon[data-app="${app}"]`).dblclick();
    await pg.waitForTimeout(1500);
    await shot(pg, 'apps-' + app);
    void label;
  }
  await ctx.close();
}

if (run('hex')) {
  const { ctx, pg } = await page(desktop);
  await clickText(pg, 'Try a sample photo');
  await pg.waitForTimeout(2000);
  await clickText(pg, 'Cosmic ray');
  await pg.waitForTimeout(2000);
  // Hex Doctor lives in Start ▸ Programs ▸ Accessories
  await pg.evaluate(() => window.__refrag.openApp('hex'));
  await pg.waitForTimeout(2500);
  await shot(pg, 'hex-1');
  await ctx.close();
}

if (run('scale')) {
  const { ctx, pg } = await page(desktop125);
  await clickText(pg, 'Try a sample photo');
  await pg.waitForTimeout(2500);
  await shot(pg, 'scale-125');
  await ctx.close();
}

if (run('phone')) {
  const { ctx, pg } = await page(phone);
  await shot(pg, 'phone-1-first-run');
  await clickText(pg, 'Try a sample photo');
  await pg.waitForTimeout(2500);
  await shot(pg, 'phone-2-sample');
  await clickText(pg, 'Forwarded 40× on WhatsApp');
  await pg.waitForTimeout(4000);
  await shot(pg, 'phone-3-preset');
  await pg.locator('.start').click();
  await pg.waitForTimeout(400);
  await shot(pg, 'phone-4-start');
  await ctx.close();
}

await browser.close();
server.close();
if (errors.length) {
  console.log('--- console errors/warnings ---');
  for (const e of [...new Set(errors)].slice(0, 40)) console.log(e);
}
