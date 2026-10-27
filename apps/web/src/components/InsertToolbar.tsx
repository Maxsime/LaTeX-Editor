import { Popover } from 'radix-ui';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { searchSymbols, symbolCategories, type SymbolCategory } from '../editor/symbols.js';
import {
  alignLatex,
  type ColumnAlign,
  figureLatex,
  graphicsPath,
  missingPackages,
  requiredPackages,
  tableLatex,
} from '../lib/assistants.js';
import { useEditor } from '../stores/editor.js';
import { Button, Dialog } from './ui.js';

interface InsertToolbarProps {
  /** Text file receiving the insertions; null disables the toolbar. */
  fileId: string | null;
  /** Project-relative paths of the images of the project. */
  images: readonly string[];
  mainPath: string | null;
  /** Packages loaded by the project, for the reminders. */
  packages: readonly string[];
}

const input = 'rounded border border-slate-300 px-2 py-1 text-sm';
const MAX_TABLE = 20;

function PackageReminder({ required, loaded }: { required: string[]; loaded: readonly string[] }) {
  const { t } = useTranslation();
  const missing = missingPackages(required, loaded);
  if (missing.length === 0) return null;
  return (
    <p role="note" className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
      {t('insert.missingPackages', {
        packages: missing.map((name) => `\\usepackage{${name}}`).join(', '),
      })}
    </p>
  );
}

function SymbolPalette({ onPick }: { onPick: (command: string) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SymbolCategory | null>(null);
  const symbols = searchSymbols(query, category);
  return (
    <div className="w-80 space-y-2 text-sm">
      <input
        type="search"
        aria-label={t('insert.symbols.search')}
        placeholder={t('insert.symbols.search')}
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
        }}
        className={`${input} w-full`}
      />
      <select
        aria-label={t('insert.symbols.category')}
        value={category ?? ''}
        onChange={(event) => {
          const value = symbolCategories.find((name) => name === event.currentTarget.value);
          setCategory(value ?? null);
        }}
        className={`${input} w-full`}
      >
        <option value="">{t('insert.symbols.all')}</option>
        {symbolCategories.map((name) => (
          <option key={name} value={name}>
            {t(`insert.symbols.categories.${name}`)}
          </option>
        ))}
      </select>
      <ul
        className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto"
        aria-label={t('insert.symbols.title')}
      >
        {symbols.map((symbol) => (
          <li key={symbol.command}>
            <button
              type="button"
              title={
                symbol.package === null
                  ? symbol.command
                  : `${symbol.command} (${t('insert.symbols.package', { name: symbol.package })})`
              }
              aria-label={symbol.command}
              onClick={() => {
                onPick(symbol.command);
              }}
              className="flex h-8 w-full items-center justify-center rounded border border-slate-200 text-base hover:bg-slate-100"
            >
              {symbol.glyph}
            </button>
          </li>
        ))}
      </ul>
      {symbols.length === 0 && <p className="text-slate-600">{t('insert.symbols.none')}</p>}
    </div>
  );
}

function TableDialog({
  open,
  onOpenChange,
  packages,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packages: readonly string[];
  onInsert: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(3);
  const [columns, setColumns] = useState(3);
  const [cells, setCells] = useState<string[][]>([]);
  const [align, setAlign] = useState<ColumnAlign[]>([]);
  const [header, setHeader] = useState(true);
  const [booktabs, setBooktabs] = useState(true);
  const [caption, setCaption] = useState('');
  const [label, setLabel] = useState('');
  const cell = (row: number, column: number) => cells[row]?.[column] ?? '';
  const grid = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => cell(row, column)),
  );
  const alignments = Array.from({ length: columns }, (_, column) => align[column] ?? 'l');
  const size = (value: string) => Math.min(Math.max(Number(value) || 1, 1), MAX_TABLE);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('insert.table.title')} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          onInsert(
            tableLatex({ cells: grid, align: alignments, header, booktabs, caption, label }),
          );
          onOpenChange(false);
        }}
      >
        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1">
            {t('insert.table.rows')}
            <input
              type="number"
              min={1}
              max={MAX_TABLE}
              value={rows}
              onChange={(event) => {
                setRows(size(event.currentTarget.value));
              }}
              className={`${input} w-16`}
            />
          </label>
          <label className="flex items-center gap-1">
            {t('insert.table.columns')}
            <input
              type="number"
              min={1}
              max={MAX_TABLE}
              value={columns}
              onChange={(event) => {
                setColumns(size(event.currentTarget.value));
              }}
              className={`${input} w-16`}
            />
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={header}
              onChange={(event) => {
                setHeader(event.currentTarget.checked);
              }}
            />
            {t('insert.table.header')}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={booktabs}
              onChange={(event) => {
                setBooktabs(event.currentTarget.checked);
              }}
            />
            {t('insert.table.booktabs')}
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="border-collapse">
            <thead>
              <tr>
                {alignments.map((value, column) => (
                  <th key={column} className="p-0.5">
                    <select
                      aria-label={t('insert.table.align', { column: column + 1 })}
                      value={value}
                      onChange={(event) => {
                        const next = [...alignments];
                        const chosen = event.currentTarget.value;
                        next[column] = chosen === 'c' || chosen === 'r' ? chosen : 'l';
                        setAlign(next);
                      }}
                      className={`${input} w-full`}
                    >
                      <option value="l">{t('insert.table.left')}</option>
                      <option value="c">{t('insert.table.center')}</option>
                      <option value="r">{t('insert.table.right')}</option>
                    </select>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((values, row) => (
                <tr key={row}>
                  {values.map((value, column) => (
                    <td key={column} className="p-0.5">
                      <input
                        aria-label={t('insert.table.cell', { row: row + 1, column: column + 1 })}
                        value={value}
                        onChange={(event) => {
                          const next = grid.map((line) => [...line]);
                          const target = next[row];
                          if (target) target[column] = event.currentTarget.value;
                          setCells(next);
                        }}
                        className={`${input} w-28 ${row === 0 && header ? 'font-semibold' : ''}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <CaptionFields
          caption={caption}
          label={label}
          setCaption={setCaption}
          setLabel={setLabel}
          prefix="tab:"
        />
        <PackageReminder required={requiredPackages('table', { booktabs })} loaded={packages} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            {t('insert.insert')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function CaptionFields({
  caption,
  label,
  setCaption,
  setLabel,
  prefix,
}: {
  caption: string;
  label: string;
  setCaption: (value: string) => void;
  setLabel: (value: string) => void;
  prefix: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="space-y-1">
        <span className="block">{t('insert.caption')}</span>
        <input
          value={caption}
          onChange={(event) => {
            setCaption(event.currentTarget.value);
          }}
          className={`${input} w-full`}
        />
      </label>
      <label className="space-y-1">
        <span className="block">{t('insert.label')}</span>
        <input
          value={label}
          placeholder={`${prefix}…`}
          onChange={(event) => {
            setLabel(event.currentTarget.value.replace(/[\s{}\\%#]/g, ''));
          }}
          className={`${input} w-full font-mono`}
        />
      </label>
    </div>
  );
}

function FigureDialog({
  open,
  onOpenChange,
  images,
  mainPath,
  packages,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  images: readonly string[];
  mainPath: string | null;
  packages: readonly string[];
  onInsert: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [image, setImage] = useState('');
  const [width, setWidth] = useState(0.8);
  const [caption, setCaption] = useState('');
  const [label, setLabel] = useState('');
  const chosen = image === '' ? (images[0] ?? '') : image;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('insert.figure.title')}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          onInsert(figureLatex({ path: graphicsPath(chosen, mainPath), width, caption, label }));
          onOpenChange(false);
        }}
      >
        {images.length === 0 ? (
          <p className="text-slate-600">{t('insert.figure.noImages')}</p>
        ) : (
          <label className="block space-y-1">
            <span className="block">{t('insert.figure.image')}</span>
            <select
              value={chosen}
              onChange={(event) => {
                setImage(event.currentTarget.value);
              }}
              className={`${input} w-full`}
            >
              {images.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2">
          {t('insert.figure.width')}
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            value={width}
            onChange={(event) => {
              setWidth(Number(event.currentTarget.value));
            }}
          />
          <span>{Math.round(width * 100)} %</span>
        </label>
        <CaptionFields
          caption={caption}
          label={label}
          setCaption={setCaption}
          setLabel={setLabel}
          prefix="fig:"
        />
        <PackageReminder required={requiredPackages('figure')} loaded={packages} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={chosen === ''}>
            {t('insert.insert')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AlignDialog({
  open,
  onOpenChange,
  packages,
  onInsert,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packages: readonly string[];
  onInsert: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState(2);
  const [numbered, setNumbered] = useState(true);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('insert.align.title')}>
      <form
        className="space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          onInsert(alignLatex({ rows, starred: !numbered }));
          onOpenChange(false);
        }}
      >
        <label className="flex items-center gap-2">
          {t('insert.align.rows')}
          <input
            type="number"
            min={1}
            max={50}
            value={rows}
            onChange={(event) => {
              setRows(Math.min(Math.max(Number(event.currentTarget.value) || 1, 1), 50));
            }}
            className={`${input} w-16`}
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={numbered}
            onChange={(event) => {
              setNumbered(event.currentTarget.checked);
            }}
          />
          {t('insert.align.numbered')}
        </label>
        <PackageReminder required={requiredPackages('align')} loaded={packages} />
        <div className="flex justify-end">
          <Button type="submit" variant="primary">
            {t('insert.insert')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Symbol palette and insertion assistants, inserting at the cursor of the active file. */
export function InsertToolbar({ fileId, images, mainPath, packages }: InsertToolbarProps) {
  const { t } = useTranslation();
  const insert = useEditor((state) => state.insert);
  const [dialog, setDialog] = useState<'table' | 'figure' | 'align' | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const onInsert = (text: string) => {
    if (fileId !== null) insert({ fileId, text, at: 'cursor' });
  };
  const close = (open: boolean) => {
    if (!open) setDialog(null);
  };
  const disabled = fileId === null;
  return (
    <div
      className="flex items-center gap-1 px-1 text-xs"
      role="group"
      aria-label={t('insert.group')}
    >
      <Popover.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
        <Popover.Trigger asChild>
          <Button variant="ghost" disabled={disabled} className="px-2 py-0.5 text-xs">
            {t('insert.symbols.open')}
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={4}
            className="z-20 rounded-md border border-slate-200 bg-white p-3 shadow-lg"
          >
            <SymbolPalette
              onPick={(command) => {
                onInsert(command);
                setPaletteOpen(false);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {(['table', 'figure', 'align'] as const).map((kind) => (
        <Button
          key={kind}
          variant="ghost"
          disabled={disabled}
          className="px-2 py-0.5 text-xs"
          onClick={() => {
            setDialog(kind);
          }}
        >
          {t(`insert.${kind}.open`)}
        </Button>
      ))}
      <TableDialog
        open={dialog === 'table'}
        onOpenChange={close}
        packages={packages}
        onInsert={onInsert}
      />
      <FigureDialog
        open={dialog === 'figure'}
        onOpenChange={close}
        images={images}
        mainPath={mainPath}
        packages={packages}
        onInsert={onInsert}
      />
      <AlignDialog
        open={dialog === 'align'}
        onOpenChange={close}
        packages={packages}
        onInsert={onInsert}
      />
    </div>
  );
}
