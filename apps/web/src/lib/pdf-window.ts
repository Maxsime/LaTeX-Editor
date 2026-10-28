import { pdfChannelMessage, type PdfChannelMessage, pdfChannelName } from '@galley/shared';
import { useCallback, useEffect, useRef } from 'react';

/** Parses a message of the PDF channel; anything else is ignored. */
export function readPdfMessage(data: unknown): PdfChannelMessage | null {
  const parsed = pdfChannelMessage.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * Joins the channel between a project page and its detached PDF window.
 * Returns a function that posts a message to the other side.
 */
export function usePdfChannel(
  projectId: string,
  onMessage: (message: PdfChannelMessage) => void,
): (message: PdfChannelMessage) => void {
  const channel = useRef<BroadcastChannel | null>(null);
  const handler = useRef(onMessage);
  useEffect(() => {
    handler.current = onMessage;
  }, [onMessage]);
  useEffect(() => {
    // Missing in some embedded browsers: the PDF then simply cannot be detached.
    if (typeof BroadcastChannel === 'undefined') return;
    const current = new BroadcastChannel(pdfChannelName(projectId));
    current.onmessage = (event: MessageEvent<unknown>) => {
      const message = readPdfMessage(event.data);
      if (message !== null) handler.current(message);
    };
    channel.current = current;
    return () => {
      current.close();
      channel.current = null;
    };
  }, [projectId]);
  return useCallback((message: PdfChannelMessage) => {
    channel.current?.postMessage(message);
  }, []);
}

/** Opens (or brings forward) the detached PDF window of a project. */
export function openPdfWindow(projectId: string): Window | null {
  return window.open(
    `/projects/${projectId}/pdf`,
    pdfChannelName(projectId),
    'popup,width=900,height=1000',
  );
}
