import { Dialog as RadixDialog } from 'radix-ui';
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiRequestError, errorMessageKey } from '../lib/api.js';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent/90 disabled:bg-accent/50',
  secondary: 'border border-slate-300 bg-white text-ink hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:bg-red-300',
  ghost: 'text-ink hover:bg-slate-100 disabled:text-slate-400',
};

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

/** Labelled input showing the field error returned by the API, if any. */
export function TextField({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | undefined;
}) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm aria-[invalid]:border-red-600"
        {...props}
      />
      {error ? (
        <p id={`${id}-error`} className="text-sm text-red-700">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-slate-600">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

/** Translated error of a failed call, field errors excepted. */
export function ErrorAlert({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  // The key comes from the API contract (errors.*, archive.*, validation.*).
  const message = t(errorMessageKey(error) as 'errors.INTERNAL_ERROR');
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
      {message}
    </p>
  );
}

/** Translated error for one form field, from a VALIDATION_FAILED response. */
export function useFieldError(error: unknown): (field: string) => string | undefined {
  const { t } = useTranslation();
  return (field) => {
    if (!(error instanceof ApiRequestError)) return undefined;
    const issue = error.fields.find((item) => item.path === field);
    // Field keys come from the API contract (validation.*), like errorMessageKey.
    return issue ? t(issue.messageKey as 'validation.custom') : undefined;
  };
}

/** Modal dialog with a title and an optional description. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 bg-slate-900/40" />
        <RadixDialog.Content className="fixed top-1/2 left-1/2 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-lg bg-white p-5 shadow-xl">
          <RadixDialog.Title className="text-lg font-semibold">{title}</RadixDialog.Title>
          {description ? (
            <RadixDialog.Description className="text-sm text-slate-700">
              {description}
            </RadixDialog.Description>
          ) : (
            <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
          )}
          {children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Confirmation dialog for destructive actions. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={description}>
      <div className="flex justify-end gap-2">
        <Button
          onClick={() => {
            onOpenChange(false);
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button variant="danger" disabled={pending} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

/** Small form inside a dialog asking for one name. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  label,
  initialValue = '',
  submitLabel,
  onSubmit,
  error,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initialValue?: string;
  submitLabel: string;
  onSubmit: (value: string) => void;
  error: unknown;
  pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('name');
          if (typeof value === 'string' && value.trim() !== '') onSubmit(value.trim());
        }}
      >
        <TextField label={label} name="name" defaultValue={initialValue} autoFocus required />
        <ErrorAlert error={error} />
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
