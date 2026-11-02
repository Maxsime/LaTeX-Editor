import { type RefObject, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_SPLIT, splitAt, splitForKey, splitTracks } from '../lib/split.js';

interface PaneSplitterProps {
  /** Grid holding the editor, this separator and the PDF, in that order. */
  grid: RefObject<HTMLElement | null>;
  /** Share of the width given to the editor. */
  split: number;
  onChange: (split: number) => void;
}

/** Writes the two tracks on the grid, outside React, so that a drag never re-renders the editor. */
function applyTracks(grid: HTMLElement, split: number): void {
  const tracks = splitTracks(split);
  grid.style.setProperty('--editor-fr', tracks.editor);
  grid.style.setProperty('--pdf-fr', tracks.pdf);
}

/**
 * Draggable separator between the editor and the PDF. The pane widths follow
 * the pointer frame by frame; the share is stored once the button is
 * released. Arrow keys move it too, and a double-click (or Enter) puts it back
 * in the middle.
 */
export function PaneSplitter({ grid, split, onChange }: PaneSplitterProps) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const live = useRef(split);
  const frame = useRef<number | null>(null);

  const bounds = (handle: HTMLElement): { start: number; end: number } | null => {
    // The handle sits in a zero-width grid track, between the two panes.
    const track = handle.parentElement;
    const editor = track?.previousElementSibling;
    const pdf = track?.nextElementSibling;
    if (!editor || !pdf) return null;
    return { start: editor.getBoundingClientRect().left, end: pdf.getBoundingClientRect().right };
  };

  return (
    <div className="relative hidden md:block">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('compile.view.split')}
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(split * 100)}
        title={t('compile.view.splitTitle')}
        tabIndex={0}
        data-dragging={dragging || undefined}
        // The grab area spills over both gaps; the line shows only on hover, focus or drag.
        className="group absolute inset-y-0 -left-2 flex w-4 cursor-col-resize touch-none justify-center outline-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          live.current = split;
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          const area = bounds(event.currentTarget);
          const element = grid.current;
          if (!area || !element) return;
          live.current = splitAt(event.clientX, area.start, area.end);
          // One layout per frame, however fast the pointer reports.
          frame.current ??= requestAnimationFrame(() => {
            frame.current = null;
            applyTracks(element, live.current);
          });
        }}
        onPointerUp={(event) => {
          if (!dragging) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          frame.current = null;
          setDragging(false);
          if (grid.current) applyTracks(grid.current, live.current);
          onChange(live.current);
        }}
        onPointerCancel={() => {
          setDragging(false);
          if (grid.current) applyTracks(grid.current, split);
        }}
        onDoubleClick={() => {
          onChange(DEFAULT_SPLIT);
        }}
        onKeyDown={(event) => {
          const next = splitForKey(split, event.key, event.shiftKey);
          if (next === null) return;
          event.preventDefault();
          onChange(next);
        }}
      >
        <div className="h-full w-0.5 rounded-full bg-transparent transition-colors duration-150 group-hover:bg-accent/40 group-focus-visible:bg-accent group-data-dragging:bg-accent" />
        <div className="absolute top-1/2 h-10 w-1.5 -translate-y-1/2 rounded-full bg-slate-300 transition-colors duration-150 group-hover:bg-accent/70 group-focus-visible:bg-accent group-data-dragging:bg-accent" />
      </div>
    </div>
  );
}
