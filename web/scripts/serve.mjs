// Static server for the built app (web/dist), shared by the Playwright scripts (uicheck, audit, shots, probe).
// It listens on 127.0.0.1 only and never serves anything outside dist/, since the repo next door holds the
// git-ignored test-local/ folder.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(here, '..', 'dist');

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ttf': 'font/ttf',
};

/** Starts the server on a free port; resolves to its base URL (with a trailing slash) and a close(). */
export async function serveDist() {
  const server = http.createServer(async (req, res) => {
    let file = null;
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const abs = path.resolve(DIST, '.' + p);
      if (abs === DIST || abs.startsWith(DIST + path.sep)) file = abs;
    } catch {
      // a malformed %-escape: treated as not found
    }
    if (!file) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
