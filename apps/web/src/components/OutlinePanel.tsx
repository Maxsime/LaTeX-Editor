import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useOutline } from '../lib/editor.js';
import { activeOutlineIndex, relativeDepths } from '../lib/outline.js';
import { useEditor } from '../stores/editor.js';
import { ErrorAlert } from './ui.js';

/** Document outline from the main file, following inclusions; clicking a heading reveals it. */
export function OutlinePanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const outline = useOutline(projectId);
  const activeId = useEditor((state) => state.activeId);
  const cursorLine = useEditor((state) => state.cursorLine);
  const revealAt = useEditor((state) => state.revealAt);
  const activeRef = useRef<HTMLButtonElement>(null);

  const entries = outline.data?.entries ?? [];
  const depths = relativeDepths(entries);
  const current = activeOutlineIndex(entries, activeId, cursorLine);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  if (outline.error) return <ErrorAlert error={outline.error} />;
  if (outline.isLoading) return <p className="text-sm text-slate-600">{t('common.loading')}</p>;
  if (outline.data?.mainFileId === null) {
    return <p className="text-sm text-slate-600">{t('editor.outline.noMain')}</p>;
  }
  if (entries.length === 0) {
    return <p className="text-sm text-slate-600">{t('editor.outline.empty')}</p>;
  }
  return (
    <nav aria-label={t('editor.outline.title')} data-testid="outline">
      <ol className="space-y-0.5 text-sm">
        {entries.map((entry, index) => (
          <li key={`${entry.fileId}:${String(entry.line)}:${String(index)}`}>
            <button
              ref={index === current ? activeRef : undefined}
              type="button"
              aria-current={index === current ? 'location' : undefined}
              title={`${entry.path}:${String(entry.line)}`}
              style={{ paddingLeft: `${String(0.25 + (depths[index] ?? 0) * 0.75)}rem` }}
              onClick={() => {
                revealAt({ fileId: entry.fileId, line: entry.line });
              }}
              className="block w-full truncate rounded py-0.5 pr-1 text-left hover:bg-slate-100 aria-[current]:bg-sky-100 aria-[current]:font-medium"
            >
              {entry.title === '' ? t('editor.outline.untitled') : entry.title}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
