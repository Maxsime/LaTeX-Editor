import { useTranslation } from 'react-i18next';
import { ServiceStatus } from '../components/ServiceStatus.js';

export function StatusPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-3">
        <h1 className="font-serif text-4xl font-semibold">{t('app.name')}</h1>
        <p className="text-lg text-slate-700">{t('app.tagline')}</p>
        <p className="text-slate-600">{t('home.intro')}</p>
      </div>
      <ServiceStatus />
    </div>
  );
}
