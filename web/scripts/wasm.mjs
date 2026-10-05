// Builds the Rust engine to WASM and runs wasm-bindgen into web/src/wasm/pkg.
// Run from web/: `npm run wasm`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('cargo', ['build', '-p', 'refragmenter-wasm', '--target', 'wasm32-unknown-unknown', '--release']);
run('wasm-bindgen', [
  'target/wasm32-unknown-unknown/release/refragmenter_wasm.wasm',
  '--target', 'web',
  '--out-dir', 'web/src/wasm/pkg',
]);
console.log('wasm ok -> web/src/wasm/pkg');
