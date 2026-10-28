import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunReport, runCorpus } from './corpus.js';
import { detectTexLive } from './texlive.js';

/**
 * Compiles the corpus inside the worker image: `node dist/corpus-cli.js <dir> [filter]`.
 * Started by `pnpm --filter @galley/compiler test:corpus` through Docker Compose,
 * so that the sandbox runs with the same container settings as in production.
 */
async function main(): Promise<void> {
  const root = process.argv[2] ?? '/fixtures';
  const filter = process.argv[3];
  // Planted in this process's environment: the sandbox must never let a document read it.
  const canary = `galley-canary-${randomUUID()}`;
  process.env.GALLEY_CANARY = canary;

  const texlive = await detectTexLive();
  const workRoot = join(
    process.env.COMPILER_WORK_DIR ?? '/var/lib/galley/work',
    `corpus-${randomUUID()}`,
  );
  await mkdir(workRoot, { recursive: true });
  const assetsDir = process.env.COMPILER_ASSETS_DIR ?? '/opt/galley';
  process.stdout.write(`Corpus ${root} with ${texlive.release}\n`);

  const print = (report: RunReport) => {
    const seconds = (report.durationMs / 1000).toFixed(1);
    const hot =
      report.hotDurationMs === undefined
        ? ''
        : `, hot ${(report.hotDurationMs / 1000).toFixed(1)} s`;
    const plain =
      report.plainDurationMs === undefined
        ? ''
        : `, hot without the format ${(report.plainDurationMs / 1000).toFixed(1)} s`;
    const synctex =
      report.synctexMedianMs === undefined
        ? ''
        : `, SyncTeX median ${report.synctexMedianMs.toFixed(0)} ms, accuracy ${((report.synctexAccuracy ?? 0) * 100).toFixed(0)} %`;
    const mark = report.failures.length === 0 ? 'ok  ' : 'FAIL';
    process.stdout.write(
      `${mark} ${report.project}/${report.main} (${report.engine}) ${seconds} s${hot}${plain}${synctex}\n`,
    );
    for (const failure of report.failures) process.stdout.write(`       - ${failure}\n`);
  };

  const reports = await runCorpus(root, {
    canary,
    ...(filter === undefined ? {} : { filter }),
    onReport: print,
    environment: {
      workRoot,
      texliveDir: texlive.dir,
      assetsDir,
      // The limits of SPEC §6.3; the corpus lowers the time limit per run where it needs to.
      limits: {
        timeoutMs: 180_000,
        memoryBytes: 2048 * 1024 * 1024,
        maxProcesses: 64,
        maxOutputBytes: 500 * 1024 * 1024,
      },
      // Shell-escape cases run in full mode, the worst case for the sandbox.
      allowFullShellEscape: true,
      texlive: texlive.release,
      fetchBlob: () => Promise.reject(new Error('replaced per project')),
    },
  });
  const failed = reports.filter((report) => report.failures.length > 0);
  process.stdout.write(
    `${String(reports.length - failed.length)}/${String(reports.length)} runs as expected\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `corpus failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
