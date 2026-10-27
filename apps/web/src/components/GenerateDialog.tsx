import { type AiStatus, type GenerateKind, generateKind } from '@galley/shared';
import { lazy, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type AiImage,
  preamblePackages,
  readImage,
  snippetPdfUrl,
  useGeneration,
} from '../lib/ai.js';
import { missingPackages } from '../lib/assistants.js';
import { Button, Dialog } from './ui.js';

const PdfViewer = lazy(() => import('./PdfViewer.js'));

const KINDS = generateKind.options;

interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  status: AiStatus;
  fileId: string | null;
  /** Packages loaded by the project, to point out those the code needs. */
  packages: readonly string[];
  onInsert: (code: string) => void;
}

/**
 * Generation of a table, a figure or a formula from a description or an
 * image (SPEC §3.8). The code is compiled alone for the preview and inserted
 * only when the user asks; the packages it needs are pointed out, not added.
 */
export function GenerateDialog({
  open,
  onOpenChange,
  projectId,
  status,
  fileId,
  packages,
  onInsert,
}: GenerateDialogProps) {
  const { t } = useTranslation();
  const { state, run, reset } = useGeneration(projectId);
  const [kind, setKind] = useState<GenerateKind>('auto');
  const [text, setText] = useState('');
  const [image, setImage] = useState<AiImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const vision = status.capabilities?.vision === true;
  const snippet = state.snippet;
  const missing =
    snippet === null ? [] : missingPackages(preamblePackages(snippet.preamble), packages);
  const input = 'rounded border border-slate-300 px-2 py-1 text-sm';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
      title={t('ai.generate.title')}
      wide
    >
      <form
        className="space-y-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void run({
            kind,
            text: text.trim() === '' ? t('ai.generate.imagePrompt') : text,
            ...(image === null ? {} : { image }),
            ...(fileId === null ? {} : { fileId }),
          });
        }}
      >
        <label className="flex items-center gap-2">
          {t('ai.generate.kind')}
          <select
            className={input}
            value={kind}
            onChange={(event) => {
              setKind(generateKind.parse(event.currentTarget.value));
            }}
          >
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`ai.generate.kinds.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="block">{t('ai.generate.description')}</span>
          <textarea
            className={`${input} w-full`}
            rows={3}
            maxLength={20_000}
            placeholder={t('ai.generate.descriptionPlaceholder')}
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
            }}
          />
        </label>
        {vision ? (
          <label className="block space-y-1">
            <span className="block">{t('ai.generate.image')}</span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              data-testid="ai-image"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                setImage(null);
                setImageError(null);
                if (file === undefined) return;
                void readImage(file).then((result) => {
                  if (result.ok) setImage(result.image);
                  else
                    setImageError(
                      t(
                        result.reason === 'size'
                          ? 'ai.generate.imageTooLarge'
                          : 'ai.generate.imageHint',
                      ),
                    );
                });
              }}
            />
            <span className="block text-xs text-slate-600">
              {imageError ?? t('ai.generate.imageHint')}
            </span>
          </label>
        ) : (
          <p className="text-xs text-slate-600">{t('ai.generate.noVision')}</p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={state.busy || (text.trim() === '' && image === null)}
          >
            {state.busy ? t('ai.thinking') : t('ai.generate.submit')}
          </Button>
        </div>
        {state.tools.length > 0 && state.busy && (
          <p className="text-xs text-slate-600">
            {t(`ai.tools.${state.tools.at(-1) ?? 'compile_snippet'}`)} …
          </p>
        )}
        {state.error !== null && (
          <p role="alert" className="rounded-md bg-red-50 px-2 py-1 text-xs text-red-900">
            {t(`errors.${state.error}` as 'errors.INTERNAL_ERROR', {
              defaultValue: t('errors.INTERNAL_ERROR'),
            })}
          </p>
        )}
        {snippet !== null && (
          <div className="space-y-2" data-testid="ai-snippet" data-outcome={snippet.outcome}>
            <p className={snippet.outcome === 'success' ? 'text-emerald-800' : 'text-amber-900'}>
              {t(`ai.generate.outcome.${snippet.outcome}`)}
            </p>
            {snippet.errors.length > 0 && (
              <ul className="list-disc pl-5 font-mono text-xs text-red-900">
                {snippet.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            )}
            {snippet.compileId !== null && snippet.outcome === 'success' && (
              <div className="h-72 overflow-hidden rounded border border-slate-200">
                <Suspense fallback={<p className="p-2 text-slate-600">{t('common.loading')}</p>}>
                  <PdfViewer
                    url={snippetPdfUrl(projectId, snippet.compileId)}
                    downloadName="snippet.pdf"
                  />
                </Suspense>
              </div>
            )}
            <label className="block space-y-1">
              <span className="block font-medium">{t('ai.generate.code')}</span>
              <textarea
                readOnly
                rows={8}
                value={snippet.code}
                className={`${input} w-full font-mono text-xs`}
                data-testid="ai-snippet-code"
              />
            </label>
            {snippet.preamble.trim() !== '' && (
              <label className="block space-y-1">
                <span className="block font-medium">{t('ai.generate.preamble')}</span>
                <textarea
                  readOnly
                  rows={Math.min(6, snippet.preamble.split('\n').length)}
                  value={snippet.preamble}
                  className={`${input} w-full font-mono text-xs`}
                />
              </label>
            )}
            {missing.length > 0 && (
              <p role="note" className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">
                {t('insert.missingPackages', {
                  packages: missing.map((name) => `\\usepackage{${name}}`).join(', '),
                })}
              </p>
            )}
            <Button
              variant="primary"
              disabled={fileId === null}
              onClick={() => {
                onInsert(snippet.code);
                reset();
                onOpenChange(false);
              }}
            >
              {t('ai.generate.insert')}
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  );
}
