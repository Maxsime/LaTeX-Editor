import { Popover } from 'radix-ui';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { previewPdfUrl, usePreview } from '../lib/compile.js';
import { fragmentAt } from '../lib/fragment.js';
import { currentSelection } from '../stores/editor.js';
import { ErrorAlert } from './ui.js';

const PdfViewer = lazy(() => import('./PdfViewer.js'));

/**
 * Compiles the selection, or the environment or formula around the cursor,
 * alone with the project's preamble, and shows it in a bubble. Nothing is
 * written to the project.
 */
export function FragmentPreview({
  projectId,
  fileId,
  read,
}: {
  projectId: string;
  fileId: string;
  read: () => string | null;
}) {
  const { t } = useTranslation();
  const preview = usePreview(projectId);
  const [open, setOpen] = useState(false);
  const [empty, setEmpty] = useState(false);
  const result = preview.data;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) return;
        const text = read();
        const selection = currentSelection();
        const fragment =
          text === null || selection?.fileId !== fileId
            ? null
            : fragmentAt(text, selection.from, selection.to);
        setEmpty(fragment === null);
        preview.reset();
        if (fragment !== null) preview.mutate(fragment);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          title={t('fragmentPreview.help')}
          className="ml-2 rounded px-2 py-0.5 text-xs hover:bg-slate-100"
        >
          {t('fragmentPreview.open')}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          aria-label={t('fragmentPreview.title')}
          className="z-20 w-96 space-y-2 rounded-md border border-slate-200 bg-white p-3 text-sm shadow-md"
          data-testid="fragment-preview"
        >
          {empty && <p>{t('fragmentPreview.nothing')}</p>}
          {preview.isPending && <p className="text-slate-600">{t('fragmentPreview.compiling')}</p>}
          <ErrorAlert error={preview.error} />
          {result !== undefined && (
            <>
              {result.outcome !== 'success' && (
                <p className="text-amber-900">{t(`fragmentPreview.outcome.${result.outcome}`)}</p>
              )}
              {result.errors.length > 0 && (
                <ul className="list-disc pl-5 font-mono text-xs text-red-900">
                  {result.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              )}
              {result.compileId !== null && (
                <div className="h-64 overflow-hidden rounded border border-slate-200">
                  <Suspense fallback={<p className="p-2 text-slate-600">{t('common.loading')}</p>}>
                    <PdfViewer
                      url={previewPdfUrl(projectId, result.compileId)}
                      downloadName="apercu.pdf"
                    />
                  </Suspense>
                </div>
              )}
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
