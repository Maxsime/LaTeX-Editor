import type { SynctexBox } from '@galley/shared';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  EventBus,
  LinkTarget,
  PDFLinkService,
  type PDFPageView,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type ReadingPosition, restorePosition, savePosition } from '../lib/pdf-position.js';
import { toPdfRect, toSynctexPoint, type ViewBox } from '../lib/synctex.js';
import { useCompilePreferences } from '../stores/compile.js';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Zoom choices: pdf.js named scales, then percentages. */
const NAMED_SCALES = ['page-width', 'page-fit', 'auto'] as const;
const PERCENT_SCALES = ['0.5', '0.75', '1', '1.25', '1.5', '2'] as const;
const SCALES: readonly string[] = [...NAMED_SCALES, ...PERCENT_SCALES];

function percent(scale: string): string {
  return `${String(Math.round(Number(scale) * 100))} %`;
}

/** Boxes to point out in the PDF; a new nonce shows the same boxes again. */
export interface PdfHighlight {
  boxes: readonly SynctexBox[];
  nonce: number;
}

interface PdfViewerProps {
  /** URL of the PDF; each compilation has its own. */
  url: string;
  downloadName: string;
  /** Called on a double-click in a page, with the point in SyncTeX coordinates. */
  onSynctex?: (point: { page: number; x: number; y: number }) => void;
  highlight?: PdfHighlight | null;
  /** Extra buttons at the end of the toolbar. */
  actions?: ReactNode;
}

/** How long a highlight stays on screen. */
const HIGHLIGHT_MS = 2000;

function pageViewOf(viewer: PDFViewer, pageNumber: number): PDFPageView | undefined {
  // pdf.js types getPageView as any; it returns the PDFPageView of a 0-based index.
  return viewer.getPageView(pageNumber - 1) as PDFPageView | undefined;
}

function viewBoxOf(view: PDFPageView): ViewBox {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = view.viewport.viewBox;
  return [x0, y0, x1, y1];
}

/** A box's rectangle in CSS pixels, relative to the page's content area. */
function cssRect(view: PDFPageView, box: SynctexBox) {
  const [x0, y0, x1, y1] = toPdfRect(viewBoxOf(view), box);
  // pdf.js types the converted points as any[]; they are [x, y] numbers.
  const [ax, ay] = view.viewport.convertToViewportPoint(x0, y0) as [number, number];
  const [bx, by] = view.viewport.convertToViewportPoint(x1, y1) as [number, number];
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/**
 * pdf.js viewer. Loading a new PDF keeps the zoom and the reading position, so
 * a recompilation does not send the reader back to the first page.
 */
export default function PdfViewer({
  url,
  downloadName,
  onSynctex,
  highlight,
  actions,
}: PdfViewerProps) {
  const { t } = useTranslation();
  const { pdfDark, setPdfDark } = useCompilePreferences();
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

  // The handler may change on every render; the listener reads the latest one.
  const onSynctexRef = useRef(onSynctex);
  useEffect(() => {
    onSynctexRef.current = onSynctex;
  }, [onSynctex]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onDoubleClick = (event: MouseEvent) => {
      const viewer = viewerRef.current;
      const target = event.target instanceof Element ? event.target : null;
      const page = target?.closest<HTMLElement>('.page[data-page-number]');
      if (!viewer || !page) return;
      const pageNumber = Number(page.dataset.pageNumber);
      const view = pageViewOf(viewer, pageNumber);
      if (!view) return;
      // Page coordinates start inside the page's border, where the canvas is.
      const content = page.querySelector('.canvasWrapper') ?? page;
      const bounds = content.getBoundingClientRect();
      const [x, y] = view.viewport.convertToPdfPoint(
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      ) as [number, number];
      onSynctexRef.current?.({ page: pageNumber, ...toSynctexPoint(viewBoxOf(view), x, y) });
    };
    element.addEventListener('dblclick', onDoubleClick);
    return () => {
      element.removeEventListener('dblclick', onDoubleClick);
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    const first = highlight?.boxes[0];
    if (!viewer || !highlight || first === undefined || viewer.pagesCount === 0) return;
    const marks: HTMLElement[] = [];
    for (const box of highlight.boxes) {
      const view = pageViewOf(viewer, box.page);
      if (!view) continue;
      const rect = cssRect(view, box);
      const mark = document.createElement('div');
      mark.dataset.testid = 'synctex-highlight';
      mark.className =
        'pointer-events-none absolute z-10 rounded-sm bg-amber-300/40 ring-2 ring-amber-500';
      // CSSOM assignments, allowed by the CSP that forbids inline style attributes.
      mark.style.left = `${String(rect.left)}px`;
      mark.style.top = `${String(rect.top)}px`;
      mark.style.width = `${String(rect.width)}px`;
      mark.style.height = `${String(rect.height)}px`;
      view.div.append(mark);
      marks.push(mark);
    }
    const firstView = pageViewOf(viewer, first.page);
    if (firstView) {
      const [, , , top] = toPdfRect(viewBoxOf(firstView), first);
      // Leave some context above the line rather than putting it at the very top.
      viewer.scrollPageIntoView({
        pageNumber: first.page,
        destArray: [null, { name: 'XYZ' }, null, top + 72, null],
        allowNegativeOffset: true,
      });
    }
    const timer = setTimeout(() => {
      for (const mark of marks) mark.remove();
    }, HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
      for (const mark of marks) mark.remove();
    };
  }, [highlight]);

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
        <button
          type="button"
          aria-pressed={pdfDark}
          onClick={() => {
            setPdfDark(!pdfDark);
          }}
          className="rounded px-1 py-0.5 hover:bg-slate-200 aria-pressed:bg-slate-700 aria-pressed:text-white"
        >
          {t('pdf.dark')}
        </button>
        <a href={url} download={downloadName} className="ml-auto text-accent underline">
          {t('pdf.download')}
        </a>
        {actions}
      </div>
      {failed && (
        <p role="alert" className="bg-red-50 px-3 py-2 text-sm text-red-900">
          {t('pdf.loadFailed')}
        </p>
      )}
      <div
        className={`relative min-h-0 flex-1 ${pdfDark ? 'pdf-dark bg-slate-800' : 'bg-slate-200'}`}
      >
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
