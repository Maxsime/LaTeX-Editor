import { useTranslation } from 'react-i18next';
import { useNotificationSettings, useUpdateNotificationSettings } from '../lib/notifications.js';
import { useAuthConfig } from '../lib/session.js';
import { ErrorAlert } from './ui.js';

/** E-mail notifications; shown only when the instance sends e-mail. */
export function NotificationsSection() {
  const { t } = useTranslation();
  const config = useAuthConfig();
  const settings = useNotificationSettings();
  const update = useUpdateNotificationSettings();
  if (config.data?.mail !== true) return null;
  return (
    <section aria-labelledby="notifications-title" className="max-w-2xl space-y-3">
      <h2 id="notifications-title" className="text-lg font-semibold">
        {t('account.notifications.title')}
      </h2>
      <p className="text-sm text-slate-700">{t('account.notifications.intro')}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          disabled={settings.data === undefined || update.isPending}
          checked={settings.data?.emailMentions ?? false}
          onChange={(event) => {
            update.mutate({ emailMentions: event.currentTarget.checked });
          }}
        />
        {t('account.notifications.mentions')}
      </label>
      <ErrorAlert error={settings.error ?? update.error} />
    </section>
  );
}
