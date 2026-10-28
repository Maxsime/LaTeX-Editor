import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { initials } from '../lib/presence.js';
import { useEditor } from '../stores/editor.js';
import { usePresence } from '../stores/presence.js';

/**
 * Badges of the other people in the project. Each names the file its person
 * is showing; a click follows them: their file opens here and the editor
 * keeps their cursor in view, until the reader types or clicks in it.
 */
export function PresenceBadges({ paths }: { paths: ReadonlyMap<string, string> }) {
  const { t } = useTranslation();
  const participants = usePresence((state) => state.participants);
  const following = usePresence((state) => state.following);
  const setFollowing = usePresence((state) => state.setFollowing);
  const openTab = useEditor((state) => state.openTab);
  const followed = participants.find(({ user }) => user.id === following);
  const followedFile = followed?.fileId ?? null;
  // The followed person's file opens here whenever they switch to another one.
  useEffect(() => {
    if (followedFile !== null) openTab(followedFile);
  }, [followedFile, openTab]);
  if (participants.length === 0) return null;
  return (
    <div className="flex items-center gap-2">
      {followed !== undefined && (
        <span className="flex items-center gap-1 text-xs text-slate-700" role="status">
          {t('presence.following', { name: followed.user.name })}
          <button
            type="button"
            className="underline"
            onClick={() => {
              setFollowing(null);
            }}
          >
            {t('presence.stop')}
          </button>
        </span>
      )}
      <ul aria-label={t('presence.label')} className="flex -space-x-1">
        {participants.map(({ user, fileId }) => {
          const path = fileId === null ? undefined : paths.get(fileId);
          const where =
            path === undefined ? user.name : t('presence.inFile', { name: user.name, path });
          const isFollowed = user.id === following;
          const label = isFollowed
            ? t('presence.unfollow', { where })
            : t('presence.follow', { where });
          return (
            <li key={user.id}>
              <button
                type="button"
                title={label}
                aria-label={label}
                aria-pressed={isFollowed}
                onClick={() => {
                  setFollowing(isFollowed ? null : user.id);
                  if (!isFollowed && fileId !== null) openTab(fileId);
                }}
                className="flex size-7 items-center justify-center rounded-full border-2 border-white text-xs font-semibold text-white aria-pressed:ring-2 aria-pressed:ring-accent"
                style={{ backgroundColor: user.color }}
              >
                {initials(user.name)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
