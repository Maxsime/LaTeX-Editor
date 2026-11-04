import { type ErrorComponentProps, Link } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  browserReloadEnvironment,
  isStaleChunkError,
  reloadForStaleChunk,
} from '../lib/stale-chunk.js';
import { Button } from './ui.js';

/** Shown by the router when a page fails to load or to render. */
export function RouteError({ error }: ErrorComponentProps) {
  const { t } = useTranslation();
  const stale = isStaleChunkError(error);
  useEffect(() => {
    if (stale) reloadForStaleChunk(browserReloadEnvironment());
  }, [stale]);
  return (
    <div role="alert" className="mx-auto my-16 max-w-lg space-y-4 text-center">
      <h1 className="font-serif text-xl font-semibold">{t('pageError.title')}</h1>
      <p className="text-sm text-slate-600">
        {stale ? t('pageError.stale') : t('pageError.unexpected')}
      </p>
      <div className="flex justify-center gap-3">
        <Button
          variant="primary"
          onClick={() => {
            window.location.reload();
          }}
        >
          {t('pageError.reload')}
        </Button>
        <Link to="/projects" className="inline-flex items-center px-3 py-1.5 text-sm underline">
          {t('pageError.home')}
        </Link>
      </div>
    </div>
  );
}
