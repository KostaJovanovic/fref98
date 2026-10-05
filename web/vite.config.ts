import { defineConfig, type Plugin } from 'vite';

// The Content-Security-Policy is injected into index.html for production builds only (Vite's dev server
// needs inline styles for hot reload). public/_headers sends the same policy (plus frame-ancestors) on
// Cloudflare Pages.
export const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: mediastream:",
  "style-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'refragmenter-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [csp()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  worker: {
    format: 'es',
  },
  // No server.fs.allow: the dev server listens on the LAN (server.bat --host, for phone testing), and
  // widening it past web/ would serve the git-ignored test-local/ folder to anyone on the network.
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as never);
