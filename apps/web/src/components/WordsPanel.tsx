import type { WordCount } from '@galley/shared';
import { useTranslation } from 'react-i18next';

/** Word count of the last compilation, in total and by section (SPEC §3.7). */
export function WordsPanel({ count }: { count: WordCount | null }) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.resolvedLanguage);
  if (count === null) return <p className="text-sm text-slate-600">{t('words.none')}</p>;
  const { total } = count;
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
        <dt>{t('words.text')}</dt>
        <dd data-testid="words-total" className="text-right font-semibold tabular-nums">
          {number.format(total.text)}
        </dd>
        <dt>{t('words.headers')}</dt>
        <dd className="text-right tabular-nums">{number.format(total.headers)}</dd>
        <dt>{t('words.captions')}</dt>
        <dd className="text-right tabular-nums">{number.format(total.captions)}</dd>
      </dl>
      {count.sections.length > 0 && (
        <table className="w-full text-left">
          <caption className="mb-1 text-left text-xs font-semibold text-slate-600 uppercase">
            {t('words.bySection')}
          </caption>
          <thead className="sr-only">
            <tr>
              <th>{t('words.section')}</th>
              <th>{t('words.text')}</th>
            </tr>
          </thead>
          <tbody>
            {count.sections.map((section, index) => (
              <tr key={`${String(index)}:${section.title}`} className="border-t border-slate-100">
                <td className="py-1 pr-2">
                  {section.title === '' ? t('words.untitled') : section.title}
                </td>
                <td className="py-1 text-right tabular-nums">{number.format(section.text)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-slate-600">{t('words.hint')}</p>
    </div>
  );
}
