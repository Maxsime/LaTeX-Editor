// Compiles fixtures/projects/ with the real sandbox, inside the compiler image
// and with the container settings of compose.yaml: pnpm --filter @galley/compiler test:corpus [filter]
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const result = spawnSync(
  'docker',
  [
    'compose',
    'run',
    '--rm',
    '--no-deps',
    '--volume',
    `${join(repo, 'fixtures', 'projects')}:/fixtures:ro`,
    'compiler',
    'node',
    'dist/corpus-cli.js',
    '/fixtures',
    ...process.argv.slice(2),
  ],
  { cwd: repo, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
