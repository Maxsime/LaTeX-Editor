import { explainMessage } from '@galley/latex-log';
import type { CompileRun, Diagnostic } from '@galley/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAiStatus } from '../lib/ai.js';
import { countLevels, outputUrl } from '../lib/compile.js';
import { useAi } from '../stores/ai.js';
import { useEditor } from '../stores/editor.js';

type Tab = 'issues' | 'raw' | 'files';

/** Compiler codes whose context is console output worth showing. */
const CONSOLE_CODES = new Set(['NO_OUTPUT', 'PREAMBLE_FORMAT_FAILED']);

const LEVEL_STYLE: Record<Diagnostic['level'], string> = {
  error: 'border-red-600 bg-red-50',
  warning: 'border-amber-500 bg-amber-50',
  badbox: 'border-slate-400 bg-slate-50',
};

interface LogPanelProps {
  projectId: string;
  run: CompileRun;
  /** File id by project-relative path, to open the file a diagnostic points at. */
  fileIds: ReadonlyMap<string, string>;
}

/** Message of a diagnostic: compiler codes are translated, TeX messages shown as written. */
function useDiagnosticMessage(): (diagnostic: Diagnostic) => string {
  const { t } = useTranslation();
  return (diagnostic) =>
    diagnostic.source === 'compiler'
      ? t(`compile.codes.${diagnostic.message}`, {
          value: diagnostic.context,
          defaultValue: diagnostic.message,
        })
      : diagnostic.message;
}

/** Plain-language hint under a TeX message, for the common cases (SPEC §3.3). */
function Explanation({ diagnostic }: { diagnostic: Diagnostic }) {
  const { t } = useTranslation();
  if (diagnostic.source !== 'tex' || diagnostic.level === 'badbox') return null;
  const explanation = explainMessage(diagnostic.message, diagnostic.context);
  if (explanation === null) return null;
  return (
    <span data-testid="explanation" className="mt-1 block text-[11px] text-slate-800">
      {t(`compile.explain.${explanation.code}`, { name: explanation.name || '…' })}
    </span>
  );
}

function RawLog({ projectId, run }: { projectId: string; run: CompileRun }) {
  const { t } = useTranslation();
  const log = run.outputs.find((output) => output.name.endsWith('.log'));
  const query = useQuery({
    queryKey: ['compile-log', run.id],
    enabled: log !== undefined,
    // A compilation's files never change.
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const response = await fetch(outputUrl(projectId, run.id, log?.name ?? ''), { signal });
      if (!response.ok) throw new Error(String(response.status));
      return response.text();
    },
  });
  if (log === undefined) return <p className="p-3 text-sm text-slate-600">{t('compile.noLog')}</p>;
  if (query.isPending) return <p className="p-3 text-sm text-slate-600">{t('common.loading')}</p>;
  if (query.isError) return <p className="p-3 text-sm text-red-800">{t('compile.logFailed')}</p>;
  return (
    <pre className="overflow-auto p-3 font-mono text-xs leading-snug whitespace-pre-wrap">
      {query.data}
    </pre>
  );
}

/**
 * Errors and warnings of a compilation, its raw log and the files it produced.
 * A diagnostic located in a project file opens that file at its line.
 */
export function LogPanel({ projectId, run, fileIds }: LogPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('issues');
  const [showBadBoxes, setShowBadBoxes] = useState(false);
  const revealAt = useEditor((state) => state.revealAt);
  const message = useDiagnosticMessage();
  const counts = countLevels(run.diagnostics);
  const shown = run.diagnostics.filter((d) => showBadBoxes || d.level !== 'badbox');
  const aiStatus = useAiStatus(projectId);
  const busy = useAi((state) => state.busy);
  const fix =
    aiStatus.data?.available === true
      ? (diagnostic: Diagnostic, fileId: string | undefined) => {
          const ai = useAi.getState();
          ai.show();
          void ai.send({
            mode: 'fix',
            text: t('ai.fix.prompt'),
            context: fileId === undefined ? {} : { fileId },
            diagnostic: {
              // The TeX context shows the offending line, as the user sees it.
              message: [
                message(diagnostic),
                diagnostic.source === 'compiler' ? '' : diagnostic.context,
              ]
                .filter((part) => part !== '')
                .join('\n')
                .slice(0, 4000),
              ...(diagnostic.file === null ? {} : { file: diagnostic.file }),
              ...(diagnostic.line === null ? {} : { line: diagnostic.line }),
            },
          });
        }
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label={t('compile.log')}
        className="flex gap-1 border-b border-slate-200 px-2 py-1"
      >
        {(['issues', 'raw', 'files'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => {
              setTab(name);
            }}
            className="rounded px-2 py-0.5 text-xs aria-selected:bg-slate-200 aria-selected:font-medium hover:bg-slate-100"
          >
            {t(`compile.tabs.${name}`, counts)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'issues' && (
          <div className="space-y-1 p-2">
            {run.shellEscapeDowngraded && (
              <p className="rounded border-l-4 border-amber-500 bg-amber-50 px-2 py-1 text-xs">
                {t('compile.shellEscapeDowngraded')}
              </p>
            )}
            {run.truncated && (
              <p className="px-2 text-xs text-slate-600">{t('compile.truncated')}</p>
            )}
            {counts.badbox > 0 && (
              <label className="flex items-center gap-1 px-1 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={showBadBoxes}
                  onChange={(event) => {
                    setShowBadBoxes(event.currentTarget.checked);
                  }}
                />
                {t('compile.showBadBoxes', { count: counts.badbox })}
              </label>
            )}
            {shown.length === 0 && (
              <p className="p-2 text-sm text-slate-600">{t('compile.noIssues')}</p>
            )}
            <ul className="space-y-1" data-testid="diagnostics">
              {shown.map((diagnostic, index) => {
                const fileId = diagnostic.file === null ? undefined : fileIds.get(diagnostic.file);
                const location =
                  diagnostic.file === null
                    ? (diagnostic.externalFile ?? '')
                    : `${diagnostic.file}${diagnostic.line === null ? '' : `:${String(diagnostic.line)}`}`;
                const body = (
                  <>
                    <span className="flex items-baseline gap-2">
                      <span className="font-medium">{message(diagnostic)}</span>
                      {location !== '' && (
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-slate-600">
                          {location}
                        </span>
                      )}
                    </span>
                    {diagnostic.context !== '' && diagnostic.source !== 'compiler' && (
                      <span className="mt-0.5 block font-mono text-[11px] whitespace-pre-wrap text-slate-700">
                        {diagnostic.context}
                      </span>
                    )}
                    <Explanation diagnostic={diagnostic} />
                    {CONSOLE_CODES.has(diagnostic.message) && diagnostic.context !== '' && (
                      <span className="mt-0.5 block max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-slate-700">
                        {diagnostic.context}
                      </span>
                    )}
                  </>
                );
                return (
                  <li
                    // Diagnostics have no identity; their order is fixed for a given run.
                    key={index}
                    data-level={diagnostic.level}
                    className={`rounded border-l-4 text-xs ${LEVEL_STYLE[diagnostic.level]}`}
                  >
                    {fileId !== undefined && diagnostic.line !== null ? (
                      <button
                        type="button"
                        className="block w-full px-2 py-1 text-left hover:brightness-95"
                        onClick={() => {
                          revealAt({ fileId, line: diagnostic.line ?? 1 });
                        }}
                      >
                        {body}
                      </button>
                    ) : (
                      <div className="px-2 py-1">{body}</div>
                    )}
                    {fix && diagnostic.level === 'error' && (
                      <div className="px-2 pb-1">
                        <button
                          type="button"
                          className="text-[11px] text-accent underline disabled:text-slate-400"
                          disabled={busy}
                          onClick={() => {
                            fix(diagnostic, fileId);
                          }}
                        >
                          {t('ai.fix.button')}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {tab === 'raw' && <RawLog projectId={projectId} run={run} />}
        {tab === 'files' && (
          <ul className="space-y-1 p-3 text-sm">
            {run.outputs.map((output) => (
              <li key={output.name}>
                <a
                  href={outputUrl(projectId, run.id, output.name)}
                  download={output.name.slice(output.name.lastIndexOf('/') + 1)}
                  className="text-accent underline"
                >
                  {output.name}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
