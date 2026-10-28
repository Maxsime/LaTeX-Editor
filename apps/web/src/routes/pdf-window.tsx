import { type PdfChannelMessage } from '@galley/shared';
import { useParams } from '@tanstack/react-router';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PdfHighlight } from '../components/PdfViewer.js';
import { usePdfChannel } from '../lib/pdf-window.js';

const PdfViewer = lazy(() => import('../components/PdfViewer.js'));

/**
 * The PDF of a project in a window of its own, for a second screen. It shows
 * what the project page sends and hands double-clicks back for SyncTeX.
 */
export function PdfWindowPage() {
  const { t } = useTranslation();
  const { projectId } = useParams({ from: '/projects/$projectId/pdf' });
  const [pdf, setPdf] = useState<{ url: string; downloadName: string } | null>(null);
  const [highlight, setHighlight] = useState<PdfHighlight | null>(null);
  const post = usePdfChannel(projectId, (message: PdfChannelMessage) => {
    if (message.type === 'pdf') setPdf({ url: message.url, downloadName: message.downloadName });
    else if (message.type === 'highlight') setHighlight(message);
    else if (message.type === 'close') window.close();
  });

  useEffect(() => {
    post({ type: 'hello' });
    const leave = () => {
      post({ type: 'bye' });
    };
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
    };
  }, [post]);

  useEffect(() => {
    document.title = t('pdf.windowTitle');
  }, [t]);

  return (
    <div className="h-screen">
      {pdf === null ? (
        <p className="p-4 text-sm text-slate-600">{t('pdf.waiting')}</p>
      ) : (
        <Suspense fallback={<p className="p-4 text-sm text-slate-600">{t('common.loading')}</p>}>
          <PdfViewer
            url={pdf.url}
            downloadName={pdf.downloadName}
            highlight={highlight}
            onSynctex={(point) => {
              post({ type: 'synctex', ...point });
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
