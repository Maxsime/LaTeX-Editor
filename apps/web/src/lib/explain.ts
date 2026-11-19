import { explainMessage } from '@galley/latex-log';
import type { Diagnostic } from '@galley/shared';
import type { TFunction } from 'i18next';

/**
 * Plain-language remedy for a TeX message, for the common cases (SPEC §3.3),
 * or null. Shared by the log and the editor's markers, so both give the same
 * advice. Bad boxes are layout notices, not errors to fix.
 */
export function explainDiagnostic(diagnostic: Diagnostic, t: TFunction): string | null {
  if (diagnostic.source !== 'tex' || diagnostic.level === 'badbox') return null;
  const explanation = explainMessage(diagnostic.message, diagnostic.context);
  if (explanation === null) return null;
  return t(`compile.explain.${explanation.code}`, { name: explanation.name || '…' });
}
