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
import { ChevronLeft, ChevronRight, Download, Moon, ZoomIn, ZoomOut } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_SCALE, restorePosition, savePosition } from '../lib/pdf-position.js';
import { toPdfRect, toSynctexPoint, type ViewBox } from '../lib/synctex.js';
import { useCompilePreferences } from '../stores/compile.js';
import { IconButton } from './ui.js';

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
  /** Extra buttons at the end of the floating toolbar. */
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
/** How long a new PDF may take to paint before it replaces the old one anyway. */
const SWAP_TIMEOUT_MS = 1500;
/** Length of the cross-fade between two PDFs, as in the slot classes below. */
const SWAP_FADE_MS = 160;

/** One of the two viewers: the one on screen, or the one preparing the next PDF. */
interface Slot {
  element: HTMLDivElement;
  viewer: PDFViewer;
  link: PDFLinkService;
  eventBus: EventBus;
  document: PDFDocumentProxy | null;
}

type SlotIndex = 0 | 1;

/**
 * pdf.js viewer. Loading a new PDF keeps the zoom and the reading position, so
 * a recompilation does not send the reader back to the first page.
 *
 * Two viewers take turns: the new PDF is laid out and painted in the hidden
 * one, at the same zoom and position, and only then fades in over the old one.
 * A recompilation therefore never shows blank pages or a jump to the top.
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
  const stage = useRef<HTMLDivElement>(null);
  const firstContainer = useRef<HTMLDivElement>(null);
  const secondContainer = useRef<HTMLDivElement>(null);
  const slots = useRef<[Slot, Slot] | null>(null);
  const activeRef = useRef<SlotIndex>(0);
  const viewerRef = useRef<PDFViewer | null>(null);
  const [active, setActive] = useState<SlotIndex>(0);
  const [scale, setScale] = useState<string>(DEFAULT_SCALE);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const first = firstContainer.current;
    const second = secondContainer.current;
    if (!first || !second) return;
    const make = (element: HTMLDivElement, index: SlotIndex): Slot => {
      const eventBus = new EventBus();
      const link = new PDFLinkService({
        eventBus,
        externalLinkTarget: LinkTarget.BLANK,
        externalLinkRel: 'noopener noreferrer nofollow',
      });
      const viewer = new PDFViewer({ container: element, eventBus, linkService: link });
      link.setViewer(viewer);
      // Only the viewer on screen drives the toolbar.
      eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
        if (activeRef.current === index) setPage(pageNumber);
      });
      eventBus.on(
        'scalechanging',
        ({ presetValue, scale: value }: { presetValue?: string; scale: number }) => {
          if (activeRef.current === index) setScale(presetValue ?? String(value));
        },
      );
      return { element, viewer, link, eventBus, document: null };
    };
    const made: [Slot, Slot] = [make(first, 0), make(second, 1)];
    slots.current = made;
    viewerRef.current = made[activeRef.current].viewer;
    return () => {
      slots.current = null;
      viewerRef.current = null;
      for (const slot of made) {
        slot.viewer.cleanup();
        void slot.document?.loadingTask.destroy();
      }
    };
  }, []);

  useEffect(() => {
    const pair = slots.current;
    if (!pair) return;
    let settled = false;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const unlisten: (() => void)[] = [];
    const current = pair[activeRef.current];
    const nextIndex: SlotIndex = activeRef.current === 0 ? 1 : 0;
    const next = pair[nextIndex];
    const task = getDocument({
      url,
      // A compiled PDF is small enough to fetch whole; the API serves no ranges.
      disableRange: true,
    });

    const swap = () => {
      if (cancelled) return;
      cancelled = true;
      // The reader may have scrolled while the new PDF was painting.
      if (current.document !== null) {
        next.element.scrollTop = current.element.scrollTop;
        next.element.scrollLeft = current.element.scrollLeft;
      }
      activeRef.current = nextIndex;
      viewerRef.current = next.viewer;
      setActive(nextIndex);
      setPage(next.viewer.currentPageNumber);
      setScale(next.viewer.currentScaleValue || DEFAULT_SCALE);
      setPages(next.document?.numPages ?? 0);
      setLoadedUrl(url);
      setFailed(false);
      // Once the fade is over, the old PDF leaves the page and memory.
      const old = current.document;
      current.document = null;
      setTimeout(() => {
        // Null empties a viewer.
        if (activeRef.current === nextIndex) current.viewer.setDocument(null);
        void old?.loadingTask.destroy();
      }, SWAP_FADE_MS + 40);
    };

    task.promise.then(
      (loaded) => {
        settled = true;
        if (cancelled) {
          void loaded.loadingTask.destroy();
          return;
        }
        const position =
          current.document !== null ? savePosition(current.viewer, current.element) : null;
        const onInit = () => {
          restorePosition(next.viewer, next.element, position);
        };
        const onRendered = () => {
          swap();
        };
        next.eventBus.on('pagesinit', onInit, { once: true });
        next.eventBus.on('pagerendered', onRendered, { once: true });
        unlisten.push(
          () => {
            next.eventBus.off('pagesinit', onInit);
          },
          () => {
            next.eventBus.off('pagerendered', onRendered);
          },
        );
        timers.push(setTimeout(swap, SWAP_TIMEOUT_MS));
        void next.document?.loadingTask.destroy();
        next.document = loaded;
        next.viewer.setDocument(loaded);
        next.link.setDocument(loaded);
      },
      () => {
        settled = true;
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      // A newer URL supersedes this one, loading or still painting.
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
      for (const off of unlisten) off();
      if (!settled) void task.destroy();
    };
  }, [url]);

  // The handler may change on every render; the listener reads the latest one.
  const onSynctexRef = useRef(onSynctex);
  useEffect(() => {
    onSynctexRef.current = onSynctex;
  }, [onSynctex]);

  useEffect(() => {
    const element = stage.current;
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

  const viewer = (): PDFViewer | null => viewerRef.current;
  const slotProps = (index: SlotIndex) =>
    index === active
      ? {
          // Tests and the reading position address the viewer on screen.
          'data-testid': 'pdf-viewer',
          'data-url': loadedUrl ?? '',
          'data-pages': pages,
          className:
            'absolute inset-0 z-10 overflow-auto opacity-100 transition-opacity duration-150 ease-out',
        }
      : {
          'aria-hidden': true,
          inert: true,
          // Stays painted under the new PDF for the length of its fade, then hides.
          className:
            'pointer-events-none invisible absolute inset-0 z-0 overflow-auto opacity-0 transition-[opacity,visibility] delay-150 duration-0',
        };
  return (
    <div className="flex h-full min-h-0 flex-col">
      {failed && (
        <p role="alert" className="bg-red-50 px-3 py-2 text-sm text-red-900">
          {t('pdf.loadFailed')}
        </p>
      )}
      <div
        ref={stage}
        className={`relative min-h-0 flex-1 ${pdfDark ? 'pdf-dark bg-slate-800 dark:bg-slate-50' : 'bg-slate-200'}`}
      >
        <div ref={firstContainer} {...slotProps(0)}>
          {/* Room under the last page, so the floating toolbar never hides its bottom. */}
          <div className="pdfViewer pb-16" />
        </div>
        <div ref={secondContainer} {...slotProps(1)}>
          <div className="pdfViewer pb-16" />
        </div>
        {/* Floating toolbar, as in Prism: the PDF keeps the whole height of the pane. */}
        <div
          role="toolbar"
          aria-label={t('pdf.toolbar')}
          className="absolute bottom-3 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-full border border-slate-200 bg-white/95 px-2 py-1 text-xs text-ink shadow-lg backdrop-blur"
        >
          <IconButton
            label={t('pdf.previousPage')}
            disabled={page <= 1}
            onClick={() => {
              viewer()?.previousPage();
            }}
          >
            <ChevronLeft aria-hidden className="size-4" />
          </IconButton>
          <label className="flex items-center gap-1 whitespace-nowrap tabular-nums">
            <input
              type="number"
              min={1}
              max={Math.max(pages, 1)}
              value={page}
              aria-label={t('pdf.page')}
              onChange={(event) => {
                const target = Number(event.currentTarget.value);
                const current = viewer();
                if (current && Number.isInteger(target) && target >= 1 && target <= pages)
                  current.currentPageNumber = target;
              }}
              className="w-10 rounded border border-slate-300 px-1 py-0.5 text-center"
            />
            <span className="text-slate-600">/ {pages}</span>
            <span className="sr-only">{t('pdf.pages', { count: pages })}</span>
          </label>
          <IconButton
            label={t('pdf.nextPage')}
            disabled={page >= pages}
            onClick={() => {
              viewer()?.nextPage();
            }}
          >
            <ChevronRight aria-hidden className="size-4" />
          </IconButton>
          <span aria-hidden className="mx-1 h-4 w-px bg-slate-300" />
          <IconButton
            label={t('pdf.zoomOut')}
            onClick={() => {
              viewer()?.decreaseScale();
            }}
          >
            <ZoomOut aria-hidden className="size-4" />
          </IconButton>
          <select
            value={SCALES.includes(scale) ? scale : ''}
            onChange={(event) => {
              const current = viewer();
              if (current) current.currentScaleValue = event.currentTarget.value;
            }}
            className="rounded border border-slate-300 bg-white px-1 py-0.5"
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
          <IconButton
            label={t('pdf.zoomIn')}
            onClick={() => {
              viewer()?.increaseScale();
            }}
          >
            <ZoomIn aria-hidden className="size-4" />
          </IconButton>
          <span aria-hidden className="mx-1 h-4 w-px bg-slate-300" />
          <IconButton
            label={t('pdf.dark')}
            aria-pressed={pdfDark}
            onClick={() => {
              setPdfDark(!pdfDark);
            }}
          >
            <Moon aria-hidden className="size-4" />
          </IconButton>
          <a
            href={url}
            download={downloadName}
            aria-label={t('pdf.download')}
            title={t('pdf.download')}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-slate-700 hover:bg-slate-200"
          >
            <Download aria-hidden className="size-4" />
          </a>
          {actions}
        </div>
      </div>
    </div>
  );
}
