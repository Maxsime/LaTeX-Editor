import type { SynctexBox, SynctexEditResponse, SynctexViewResponse } from '@galley/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '../stores/editor.js';
import { api } from './api.js';

/** A page's view box in PDF user space: `[x0, y0, x1, y1]`, origin at the bottom left. */
export type ViewBox = readonly [number, number, number, number];

/**
 * Converts a point of a page from PDF user space to SyncTeX's coordinates:
 * big points from the top-left corner of the page.
 */
export function toSynctexPoint(viewBox: ViewBox, x: number, y: number): { x: number; y: number } {
  return { x: Math.max(0, x - viewBox[0]), y: Math.max(0, viewBox[3] - y) };
}

/** Converts a SyncTeX box to a rectangle in PDF user space, `[x0, y0, x1, y1]`. */
export function toPdfRect(viewBox: ViewBox, box: SynctexBox): [number, number, number, number] {
  const left = viewBox[0] + box.x;
  const top = viewBox[3] - box.y;
  return [left, top - box.height, left + box.width, top];
}

/**
 * Boxes worth highlighting: those of the first page the line reaches. A line
 * split across a page break would otherwise send the reader to two places.
 */
export function boxesToShow(boxes: readonly SynctexBox[]): SynctexBox[] {
  const first = boxes[0];
  return first === undefined ? [] : boxes.filter((box) => box.page === first.page);
}

/** Asks which project file and line produced a point of the PDF. */
export function synctexEdit(
  projectId: string,
  compileId: string,
  point: { page: number; x: number; y: number },
): Promise<SynctexEditResponse> {
  return api<SynctexEditResponse>(
    'GET',
    `/api/projects/${projectId}/compiles/${compileId}/synctex/edit`,
    { query: { page: String(point.page), x: point.x.toFixed(2), y: point.y.toFixed(2) } },
  );
}

/** Asks where a line of a project file appears in the PDF. */
export function synctexView(
  projectId: string,
  compileId: string,
  position: { fileId: string; line: number },
): Promise<SynctexViewResponse> {
  return api<SynctexViewResponse>(
    'GET',
    `/api/projects/${projectId}/compiles/${compileId}/synctex/view`,
    { query: { fileId: position.fileId, line: String(position.line) } },
  );
}

/** Why a SyncTeX jump did not happen, for the message shown in its place. */
export type SynctexNotice =
  | { kind: 'external'; file: string }
  | { kind: 'notFound' }
  | { kind: 'notInPdf' }
  | { kind: 'failed' };

/** Boxes to highlight in the PDF; the nonce shows the same place twice. */
export interface SynctexHighlight {
  boxes: SynctexBox[];
  nonce: number;
}

/** How long a notice stays before it clears itself. */
const NOTICE_MS = 4000;

/**
 * SyncTeX navigation against the compilation whose PDF is shown: `toSource`
 * opens the file and line under a point of the PDF, `toPdf` highlights the
 * cursor's line in the PDF. Answers to a superseded request are dropped.
 */
export function useSynctex(projectId: string, compileId: string | null) {
  const revealAt = useEditor((state) => state.revealAt);
  const [highlight, setHighlight] = useState<SynctexHighlight | null>(null);
  const [notice, setNotice] = useState<SynctexNotice | null>(null);
  const request = useRef(0);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => {
      setNotice(null);
    }, NOTICE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [notice]);

  const toSource = useCallback(
    async (point: { page: number; x: number; y: number }) => {
      if (compileId === null) return;
      const id = ++request.current;
      try {
        const answer = await synctexEdit(projectId, compileId, point);
        if (id !== request.current) return;
        if (answer.file !== null && answer.line !== null) {
          setNotice(null);
          revealAt({ fileId: answer.file.id, line: answer.line, column: answer.column ?? 0 });
        } else if (answer.externalFile !== null) {
          setNotice({ kind: 'external', file: answer.externalFile });
        } else {
          setNotice({ kind: 'notFound' });
        }
      } catch {
        if (id === request.current) setNotice({ kind: 'failed' });
      }
    },
    [projectId, compileId, revealAt],
  );

  const toPdf = useCallback(async () => {
    const { activeId, cursorLine } = useEditor.getState();
    if (compileId === null || activeId === null) return;
    const id = ++request.current;
    try {
      const answer = await synctexView(projectId, compileId, {
        fileId: activeId,
        line: cursorLine,
      });
      if (id !== request.current) return;
      const boxes = boxesToShow(answer.boxes);
      if (boxes.length === 0) {
        setNotice({ kind: 'notInPdf' });
        return;
      }
      setNotice(null);
      setHighlight({ boxes, nonce: Date.now() + Math.random() });
    } catch {
      if (id === request.current) setNotice({ kind: 'failed' });
    }
  }, [projectId, compileId]);

  return { toSource, toPdf, highlight, notice };
}
