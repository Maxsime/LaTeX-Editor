import { type BibSort, formatBibtex } from '@galley/latex-index';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useEditor } from '../stores/editor.js';
import { Button } from './ui.js';

const SORTS: readonly BibSort[] = ['key', 'author', 'year', 'none'];

/**
 * Sorts and formats the open `.bib` file. The result goes through the editor
 * as the person's own edit: undoable, and a suggestion in suggesting mode.
 */
export function BibToolbar({ fileId, read }: { fileId: string; read: () => string | null }) {
  const { t } = useTranslation();
  const insert = useEditor((state) => state.insert);
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<BibSort>('key');
  const [align, setAlign] = useState(true);
  const [invalid, setInvalid] = useState(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setInvalid(false);
      }}
    >
      <Popover.Trigger asChild>
        <Button variant="ghost" className="px-2 py-0.5 text-xs">
          {t('bibFormat.open')}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          className="z-20 w-64 space-y-3 rounded-md border border-slate-200 bg-white p-3 text-sm shadow-md"
        >
          <fieldset className="space-y-1">
            <legend className="mb-1 font-medium">{t('bibFormat.sort')}</legend>
            {SORTS.map((value) => (
              <label key={value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="bib-sort"
                  checked={sort === value}
                  onChange={() => {
                    setSort(value);
                  }}
                />
                {t(`bibFormat.sorts.${value}`)}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={align}
              onChange={(event) => {
                setAlign(event.currentTarget.checked);
              }}
            />
            {t('bibFormat.align')}
          </label>
          {invalid && (
            <p role="alert" className="text-xs text-red-800">
              {t('bibFormat.invalid')}
            </p>
          )}
          <Button
            variant="primary"
            className="w-full"
            onClick={() => {
              const text = read();
              const formatted = text === null ? null : formatBibtex(text, { sort, align });
              if (formatted === null) {
                setInvalid(true);
                return;
              }
              insert({ fileId, text: formatted, at: 'document' });
              setOpen(false);
            }}
          >
            {t('bibFormat.apply')}
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
