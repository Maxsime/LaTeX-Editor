// Plays the fixed scenarios of the assistant against a real model and checks
// that each result compiles (SPEC §6.8). Build the package first:
//
//   pnpm --filter @galley/ai build
//   EVAL_PROVIDER=anthropic EVAL_MODEL=<model> EVAL_API_KEY=... pnpm --filter @galley/ai eval
//   EVAL_PROVIDER=openai-compatible EVAL_MODEL=llama3.1 \
//     EVAL_BASE_URL=http://localhost:11434/v1 pnpm --filter @galley/ai eval
//
// Documents are compiled with pdflatex when it is on the PATH, otherwise in the
// galley/compiler image (EVAL_COMPILER_IMAGE), without network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilitiesOf, createModel } from '../dist/index.js';
import { runEvaluation, SCENARIOS } from '../dist/eval/harness.js';

const provider = process.env.EVAL_PROVIDER;
const model = process.env.EVAL_MODEL;
const print = (line) => process.stdout.write(`${line}\n`);

if (!provider || !model) {
  process.stderr.write('Set EVAL_PROVIDER and EVAL_MODEL (and EVAL_API_KEY or EVAL_BASE_URL).\n');
  process.exit(2);
}
const image = process.env.EVAL_COMPILER_IMAGE ?? 'galley/compiler:dev';
const local = spawnSync('pdflatex', ['--version'], { stdio: 'ignore' }).status === 0;

const args = ['-interaction=nonstopmode', '-halt-on-error', '-no-shell-escape', 'doc.tex'];

/** Compiles a document; resolves to the end of the log on failure, null on success. */
function compile(document) {
  if (!local) {
    // The document goes in on stdin: nothing of the host is mounted in the container.
    const run = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--entrypoint',
        'sh',
        image,
        '-c',
        `cd "$(mktemp -d)" && cat > doc.tex && pdflatex ${args.join(' ')}`,
      ],
      { input: document, encoding: 'utf8', timeout: 120_000 },
    );
    return Promise.resolve(run.status === 0 ? null : (run.stdout ?? '').slice(-800));
  }
  const dir = mkdtempSync(join(tmpdir(), 'galley-eval-'));
  try {
    writeFileSync(join(dir, 'doc.tex'), document);
    const run = spawnSync('pdflatex', args, { cwd: dir, encoding: 'utf8', timeout: 60_000 });
    return Promise.resolve(run.status === 0 ? null : (run.stdout ?? '').slice(-800));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const config = {
  provider,
  model,
  apiKey: process.env.EVAL_API_KEY,
  baseUrl: process.env.EVAL_BASE_URL || null,
};
const results = await runEvaluation({
  model: createModel(config),
  provider,
  capabilities: capabilitiesOf(provider, model, {}),
  scenarios: SCENARIOS,
  compile,
});
for (const result of results) {
  print(`${result.passed ? 'PASS' : 'FAIL'} ${result.id}`);
  if (result.failure) print(`  ${result.failure.replace(/\n/g, '\n  ')}`);
}
const failed = results.filter((result) => !result.passed).length;
print(`${String(results.length - failed)}/${String(results.length)} scenarios passed`);
process.exit(failed === 0 ? 0 : 1);
