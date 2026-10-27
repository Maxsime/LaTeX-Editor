import {
  bibTool as bibTools,
  type CompileRun,
  engine as engines,
  type ProjectDetails,
  shellEscapeMode as shellEscapeModes,
} from '@galley/shared';
import { Popover } from 'radix-ui';
import { WritingOptions } from './WritingOptions.js';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  countLevels,
  diagnosticStep,
  isCompileShortcut,
  isForwardSearchShortcut,
  isPending,
  navigableDiagnostics,
  nextStop,
  outputUrl,
  useCancelCompile,
  useCompile,
  useCompilerInfo,
} from '../lib/compile.js';
import { useUpdateProject } from '../lib/projects.js';
import { type SynctexNotice, useSynctex } from '../lib/synctex.js';
import { AUTO_COMPILE_DELAYS, useCompilePreferences, useCompileStore } from '../stores/compile.js';
import { useEditor } from '../stores/editor.js';
import { LogPanel } from './LogPanel.js';
import { Button, ErrorAlert } from './ui.js';

// pdf.js is the largest dependency of the client; it loads with the first PDF shown.
const PdfViewer = lazy(() => import('./PdfViewer.js'));

interface CompilePaneProps {
  project: ProjectDetails;
  /** Latest compilation, whatever its state. */
  latest: CompileRun | null;
  /** Latest compilation that produced a PDF. */
  lastPdf: CompileRun | null;
  /** Whether the latest compilation query has answered, so a first compilation can start. */
  loaded: boolean;
  canEdit: boolean;
  fileIds: ReadonlyMap<string, string>;
}

function Options({ project, canEdit }: { project: ProjectDetails; canEdit: boolean }) {
  const { t } = useTranslation();
  const update = useUpdateProject(project.id);
  const info = useCompilerInfo();
  const { autoCompile, autoCompileDelay, setAutoCompile, setAutoCompileDelay } =
    useCompilePreferences();
  const { draft, haltOnError, setDraft, setHaltOnError } = useCompileStore();
  const select = 'rounded border border-slate-300 px-1 py-0.5 disabled:bg-slate-100';
  return (
    <div className="w-72 space-y-3 text-sm">
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-slate-600 uppercase">
          {t('compile.options.project')}
        </legend>
        <label className="flex items-center justify-between gap-2">
          {t('compile.options.engine')}
          <select
            className={select}
            disabled={!canEdit}
            value={project.engine}
            onChange={(event) => {
              update.mutate({ engine: engines.parse(event.currentTarget.value) });
            }}
          >
            {engines.options.map((value) => (
              <option key={value} value={value}>
                {t(`compile.engines.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          {t('compile.options.bibTool')}
          <select
            className={select}
            disabled={!canEdit}
            value={project.bibTool}
            onChange={(event) => {
              update.mutate({ bibTool: bibTools.parse(event.currentTarget.value) });
            }}
          >
            {bibTools.options.map((value) => (
              <option key={value} value={value}>
                {t(`compile.bibTools.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2">
          {t('compile.options.shellEscape')}
          <select
            className={select}
            disabled={!canEdit}
            value={project.shellEscape}
            onChange={(event) => {
              update.mutate({ shellEscape: shellEscapeModes.parse(event.currentTarget.value) });
            }}
          >
            {shellEscapeModes.options.map((value) => (
              <option key={value} value={value}>
                {t(`compile.shellEscapeModes.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <ErrorAlert error={update.error} />
      </fieldset>
      <WritingOptions project={project} canEdit={canEdit} />
      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-slate-600 uppercase">
          {t('compile.options.session')}
        </legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={autoCompile}
            onChange={(event) => {
              setAutoCompile(event.currentTarget.checked);
            }}
          />
          {t('compile.options.auto')}
          <select
            className={`${select} ml-auto`}
            disabled={!autoCompile}
            aria-label={t('compile.options.autoDelay')}
            value={autoCompileDelay}
            onChange={(event) => {
              setAutoCompileDelay(Number(event.currentTarget.value));
            }}
          >
            {AUTO_COMPILE_DELAYS.map((delay) => (
              <option key={delay} value={delay}>
                {t('compile.options.seconds', { count: delay / 1000 })}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.checked);
            }}
          />
          {t('compile.options.draft')}
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={haltOnError}
            onChange={(event) => {
              setHaltOnError(event.currentTarget.checked);
            }}
          />
          {t('compile.options.haltOnError')}
        </label>
      </fieldset>
      <p className="text-xs text-slate-600">
        {t('compile.texlive', { release: info.data?.texlive ?? '…' })}
      </p>
    </div>
  );
}

function Notice({ notice }: { notice: SynctexNotice | null }) {
  const { t } = useTranslation();
  if (notice === null) return null;
  return (
    <p
      role="status"
      data-testid="synctex-notice"
      className="border-b border-slate-200 bg-amber-50 px-2 py-1 text-xs text-amber-900"
    >
      {notice.kind === 'external'
        ? t('compile.synctex.external', { file: notice.file })
        : t(`compile.synctex.${notice.kind}`)}
    </p>
  );
}

function Status({ run }: { run: CompileRun | null }) {
  const { t } = useTranslation();
  if (run === null) return null;
  const counts = countLevels(run.diagnostics);
  let text: string;
  if (isPending(run)) text = t(`compile.status.${run.status}`);
  else if (run.status === 'success' && counts.error === 0)
    text = t('compile.status.successIn', { seconds: ((run.durationMs ?? 0) / 1000).toFixed(1) });
  else text = t(`compile.status.${run.status}`);
  return (
    <span
      data-testid="compile-status"
      data-status={run.status}
      aria-live="polite"
      className="truncate text-xs text-slate-700"
    >
      {text}
    </span>
  );
}

/**
 * Right-hand pane of the editor: compile toolbar, PDF and log. Also owns the
 * compile triggers: shortcuts, compilation after a typing pause, and a first
 * compilation when the project opens.
 */
export function CompilePane({
  project,
  latest,
  lastPdf,
  loaded,
  canEdit,
  fileIds,
}: CompilePaneProps) {
  const { t } = useTranslation();
  const compile = useCompile(project.id);
  const cancel = useCancelCompile(project.id);
  const { autoCompile, autoCompileDelay } = useCompilePreferences();
  const editCount = useEditor((state) => state.editCount);
  const revealAt = useEditor((state) => state.revealAt);
  const [logOpen, setLogOpen] = useState(false);
  const pending = isPending(latest) || compile.isPending;
  const shown = latest !== null && !isPending(latest) ? latest : lastPdf;
  const counts = countLevels(shown?.diagnostics ?? []);

  const { mutate } = compile;
  const start = useCallback(
    (clean = false) => {
      const { draft, haltOnError } = useCompileStore.getState();
      mutate({ draft, haltOnError, clean });
    },
    [mutate],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isCompileShortcut(event)) return;
      // Captured before CodeMirror and the browser's "save page".
      event.preventDefault();
      event.stopPropagation();
      start();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [start]);

  const pdfRun = lastPdf;
  const synctex = useSynctex(project.id, pdfRun?.pdf != null ? pdfRun.id : null);
  const { toPdf } = synctex;

  // F8 walks through the errors and warnings of the compilation shown, in log order.
  const shownDiagnostics = shown?.diagnostics;
  const stops = useMemo(() => navigableDiagnostics(shownDiagnostics ?? []), [shownDiagnostics]);
  const shownId = shown?.id ?? null;
  const [stop, setStop] = useState({ runId: shownId, index: -1 });
  const stopIndex = stop.runId === shownId ? stop.index : -1;
  const goToStop = useCallback(
    (direction: 1 | -1, from = stopIndex) => {
      const index = nextStop(stops.length, from, direction);
      const target = stops[index];
      if (target?.file == null || target.line === null) return;
      setStop({ runId: shownId, index });
      const fileId = fileIds.get(target.file);
      if (fileId !== undefined) revealAt({ fileId, line: target.line });
    },
    [stops, stopIndex, shownId, fileIds, revealAt],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const step = diagnosticStep(event);
      if (step !== null) {
        event.preventDefault();
        goToStop(step);
      } else if (isForwardSearchShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        void toPdf();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [goToStop, toPdf]);

  useEffect(() => {
    if (!autoCompile || editCount === 0) return;
    const timer = setTimeout(() => {
      start();
    }, autoCompileDelay);
    return () => {
      clearTimeout(timer);
    };
  }, [editCount, autoCompile, autoCompileDelay, start]);

  const opened = useRef(false);
  useEffect(() => {
    if (!loaded || opened.current) return;
    opened.current = true;
    if (autoCompile || lastPdf === null) start();
  }, [loaded, autoCompile, lastPdf, start]);

  // Show the log when a compilation fails without leaving anything to look at.
  const failedId =
    shown !== null && shown.status !== 'success' && shown.pdf === null ? shown.id : null;
  const [seenFailure, setSeenFailure] = useState<string | null>(null);
  if (failedId !== seenFailure) {
    setSeenFailure(failedId);
    if (failedId !== null) setLogOpen(true);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1">
        <Button
          variant="primary"
          disabled={compile.isPending}
          onClick={() => {
            start();
          }}
          title={t('compile.shortcut')}
        >
          {pending ? t('compile.compiling') : t('compile.compile')}
        </Button>
        {latest !== null && isPending(latest) && (
          <Button
            variant="ghost"
            onClick={() => {
              cancel.mutate(latest.id);
            }}
          >
            {t('compile.cancel')}
          </Button>
        )}
        <Status run={latest} />
        <Button
          variant="ghost"
          disabled={pdfRun?.pdf == null}
          onClick={() => {
            void toPdf();
          }}
          title={t('compile.synctex.toPdfTitle')}
          className="ml-auto"
        >
          {t('compile.synctex.toPdf')}
        </Button>
        <Button
          variant="ghost"
          aria-pressed={logOpen}
          onClick={() => {
            // Opening the log also takes the editor to the first error.
            if (!logOpen && counts.error > 0) {
              goToStop(1, -1);
            }
            setLogOpen(!logOpen);
          }}
          title={t('compile.logButtonTitle')}
        >
          {t('compile.logButton', {
            errors: t('compile.errorCount', { count: counts.error }),
            warnings: t('compile.warningCount', { count: counts.warning }),
          })}
        </Button>
        <Popover.Root>
          <Popover.Trigger asChild>
            <Button variant="ghost">{t('compile.options.title')}</Button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              align="end"
              sideOffset={4}
              className="z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-md border border-slate-200 bg-white p-3 shadow-lg"
            >
              <Options project={project} canEdit={canEdit} />
              <Button
                className="mt-3 w-full"
                onClick={() => {
                  start(true);
                }}
              >
                {t('compile.cleanAndCompile')}
              </Button>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      </div>
      <ErrorAlert error={compile.error ?? cancel.error} />
      <Notice notice={synctex.notice} />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className={logOpen ? 'min-h-0 flex-[3]' : 'min-h-0 flex-1'}>
          {pdfRun?.pdf != null ? (
            <Suspense
              fallback={<p className="p-4 text-sm text-slate-600">{t('common.loading')}</p>}
            >
              <PdfViewer
                url={outputUrl(project.id, pdfRun.id, pdfRun.pdf)}
                downloadName={`${project.name}.pdf`}
                onSynctex={(point) => {
                  void synctex.toSource(point);
                }}
                highlight={synctex.highlight}
              />
            </Suspense>
          ) : (
            <p className="p-4 text-sm text-slate-600">
              {pending ? t('compile.firstCompile') : t('compile.noPdf')}
            </p>
          )}
        </div>
        {logOpen && shown !== null && (
          <div className="min-h-0 flex-[2] border-t border-slate-300 bg-white">
            <LogPanel projectId={project.id} run={shown} fileIds={fileIds} />
          </div>
        )}
      </div>
    </div>
  );
}
