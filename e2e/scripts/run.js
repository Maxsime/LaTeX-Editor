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

const result = spawnSync('playwright', ['test', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, GALLEY_CA_DIR: caDir, NODE_EXTRA_CA_CERTS: join(caDir, 'root.crt') },
});
process.exit(result.status ?? 1);
