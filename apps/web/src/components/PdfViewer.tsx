import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ReadingPosition, restorePosition, savePosition } from '../lib/pdf-position.js';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Zoom choices: pdf.js named scales, then percentages. */
const NAMED_SCALES = ['page-width', 'page-fit', 'auto'] as const;
const PERCENT_SCALES = ['0.5', '0.75', '1', '1.25', '1.5', '2'] as const;
const SCALES: readonly string[] = [...NAMED_SCALES, ...PERCENT_SCALES];

function percent(scale: string): string {
  return `${String(Math.round(Number(scale) * 100))} %`;
}

interface PdfViewerProps {
  /** URL of the PDF; each compilation has its own. */
  url: string;
  downloadName: string;
}

/**
 * pdf.js viewer. Loading a new PDF keeps the zoom and the reading position, so
 * a recompilation does not send the reader back to the first page.
 */
export default function PdfViewer({ url, downloadName }: PdfViewerProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<PDFViewer | null>(null);
  const linkRef = useRef<PDFLinkService | null>(null);
  const position = useRef<ReadingPosition | null>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const [scale, setScale] = useState<string>('page-width');
  const [pages, setPages] = useState(0);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
    });
    const viewer = new PDFViewer({ container: element, eventBus, linkService });
    linkService.setViewer(viewer);
    eventBus.on('pagesinit', () => {
      restorePosition(viewer, element, position.current);
    });
    eventBus.on(
      'scalechanging',
      ({ presetValue, scale: value }: { presetValue?: string; scale: number }) => {
        setScale(presetValue ?? String(value));
      },
    );
    viewerRef.current = viewer;
    linkRef.current = linkService;
    return () => {
      viewerRef.current = null;
      linkRef.current = null;
      viewer.cleanup();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const element = container.current;
    if (!viewer || !element) return;
    let settled = false;
    const task = getDocument({
      url,
      // A compiled PDF is small enough to fetch whole; the API serves no ranges.
      disableRange: true,
    });
    task.promise.then(
      (loaded) => {
        settled = true;
        // The previous PDF stays on screen until this one replaces it.
        const previous = documentRef.current;
        position.current = previous ? savePosition(viewer, element) : null;
        viewer.setDocument(loaded);
        linkRef.current?.setDocument(loaded);
        documentRef.current = loaded;
        void previous?.loadingTask.destroy();
        setPages(loaded.numPages);
        setLoadedUrl(url);
        setFailed(false);
      },
      () => {
        settled = true;
        setFailed(true);
      },
    );
    return () => {
      // A newer URL supersedes a load still in flight; a loaded PDF stays until replaced.
      if (!settled) void task.destroy();
    };
  }, [url]);

  useEffect(
    () => () => {
      void documentRef.current?.loadingTask.destroy();
      documentRef.current = null;
    },
    [],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-2 py-1 text-xs">
        <label className="flex items-center gap-1">
          <span className="sr-only">{t('pdf.zoom')}</span>
          <select
            value={SCALES.includes(scale) ? scale : ''}
            onChange={(event) => {
              const viewer = viewerRef.current;
              if (viewer) viewer.currentScaleValue = event.currentTarget.value;
            }}
            className="rounded border border-slate-300 px-1 py-0.5"
            aria-label={t('pdf.zoom')}
          >
            {!SCALES.includes(scale) && <option value="">{percent(scale)}</option>}
            {NAMED_SCALES.map((value) => (
              <option key={value} value={value}>
                {t(`pdf.scale.${value}`)}
              </option>
            ))}
            {PERCENT_SCALES.map((value) => (
              <option key={value} value={value}>
                {percent(value)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-slate-600">{t('pdf.pages', { count: pages })}</span>
        <a href={url} download={downloadName} className="ml-auto text-accent underline">
          {t('pdf.download')}
        </a>
      </div>
      {failed && (
        <p role="alert" className="bg-red-50 px-3 py-2 text-sm text-red-900">
          {t('pdf.loadFailed')}
        </p>
      )}
      <div className="relative min-h-0 flex-1 bg-slate-200">
        <div
          ref={container}
          data-testid="pdf-viewer"
          data-url={loadedUrl ?? ''}
          data-pages={pages}
          className="absolute inset-0 overflow-auto"
        >
          <div className="pdfViewer" />
        </div>
      </div>
    </div>
  );
}
