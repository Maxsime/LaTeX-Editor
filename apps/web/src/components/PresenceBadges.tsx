import { useTranslation } from 'react-i18next';
import { initials } from '../lib/presence.js';
import { useEditor } from '../stores/editor.js';
import { usePresence } from '../stores/presence.js';

/**
 * Badges of the other people in the project. Each names the file its person
 * is showing; a click opens that file here.
 */
export function PresenceBadges({ paths }: { paths: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  const participants = usePresence((state) => state.participants);
  const openTab = useEditor((state) => state.openTab);
  if (participants.length === 0) return null;
  return (
    <ul aria-label={t('presence.label')} className="flex -space-x-1">
      {participants.map(({ user, fileId }) => {
        const path = fileId === null ? undefined : paths.get(fileId);
        const label =
          path === undefined ? user.name : t('presence.inFile', { name: user.name, path });
        return (
          <li key={user.id}>
            <button
              type="button"
              title={label}
              aria-label={label}
              disabled={path === undefined || fileId === null}
              onClick={() => {
                if (fileId !== null) openTab(fileId);
              }}
              className="flex size-7 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white"
              style={{ backgroundColor: user.color }}
            >
              {initials(user.name)}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
