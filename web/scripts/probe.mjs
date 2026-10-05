// Dev helper: open the built app and run a JS snippet (argv[2]) in the page, print the result.
import { chromium } from 'playwright';
import { serveDist } from './serve.mjs';

const server = await serveDist();
const browser = await chromium.launch();
const pg = await browser.newPage({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: Number(process.env.DSF ?? 1) });
pg.on('console', (m) => console.log('[console]', m.type(), m.text()));
pg.on('pageerror', (e) => console.log('[pageerror]', e.message));
await pg.goto(server.base);
await pg.waitForTimeout(Number(process.env.WAIT ?? 2500));
const r = await pg.evaluate(process.argv[2] ?? '1');
console.log(JSON.stringify(r, null, 1));
if (process.env.SHOT) await pg.screenshot({ path: process.env.SHOT });
await browser.close();
server.close();
