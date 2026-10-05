// Builds the Rust engine to WASM and runs wasm-bindgen into web/src/wasm/pkg.
// Run from web/: `npm run wasm`.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  // cargo and wasm-bindgen are real executables on Windows too: no shell (and no DEP0190 warning)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: false });
  if (r.error) {
    console.error(`${cmd} could not start: ${r.error.message}`);
    if (cmd === 'wasm-bindgen') console.error('Install it with: cargo install wasm-bindgen-cli --version 0.2.100');
    else console.error('Install Rust from https://rustup.rs, then: rustup target add wasm32-unknown-unknown');
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('cargo', ['build', '-p', 'refragmenter-wasm', '--target', 'wasm32-unknown-unknown', '--release']);
run('wasm-bindgen', [
  'target/wasm32-unknown-unknown/release/refragmenter_wasm.wasm',
  '--target', 'web',
  '--out-dir', 'web/src/wasm/pkg',
]);
console.log('wasm ok -> web/src/wasm/pkg');
