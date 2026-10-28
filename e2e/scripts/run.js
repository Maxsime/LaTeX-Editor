// Runs the end-to-end suite against the running compose stack.
//
// The certificates of Caddy's local CA are copied out of the stack so that
// HTTPS is verified for real: Node trusts the root through NODE_EXTRA_CA_CERTS,
// and Chromium is told to accept that CA only (see playwright.config.ts).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const caDir = process.env.GALLEY_CA_DIR ?? join(root, '.ca');

if (!process.env.GALLEY_CA_DIR) {
  mkdirSync(caDir, { recursive: true });
  for (const name of ['root.crt', 'intermediate.crt']) {
    execFileSync(
      'docker',
      ['compose', 'cp', `caddy:/data/caddy/pki/authorities/local/${name}`, join(caDir, name)],
      { cwd: join(root, '..'), stdio: 'inherit' },
    );
  }
}

const env = { ...process.env, GALLEY_CA_DIR: caDir, NODE_EXTRA_CA_CERTS: join(caDir, 'root.crt') };
const playwright = (args, extraEnv = {}) =>
  spawnSync('playwright', ['test', ...args], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...env, ...extraEnv },
  }).status ?? 1;

const args = process.argv.slice(2);
// The whole suite runs the timing tests (project `perf`) last and on their own,
// so that no other browser competes with them for the CPU. Explicit arguments
// are passed through as they are.
let status;
if (args.length > 0) {
  status = playwright(args);
} else {
  const main = playwright(['--project=chromium']);
  // Its own output folders: each run empties those it writes to.
  const perf = playwright(['--project=perf', '--output=test-results/perf'], {
    PLAYWRIGHT_HTML_OUTPUT_DIR: 'playwright-report/perf',
  });
  status = perf || main;
}
process.exit(status);
