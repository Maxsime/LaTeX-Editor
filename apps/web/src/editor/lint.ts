import type { Diagnostic as LintDiagnostic } from '@codemirror/lint';
import type { Text } from '@codemirror/state';
import type { Diagnostic } from '@galley/shared';

const SEVERITY: Record<Diagnostic['level'], LintDiagnostic['severity']> = {
  error: 'error',
  warning: 'warning',
  badbox: 'info',
};

/**
 * Turns compilation diagnostics of one file into editor markers spanning their
 * line. Lines past the end, from a compilation of an older version of the
 * file, are clamped to the last line rather than dropped.
 */
export function toLintDiagnostics(doc: Text, diagnostics: readonly Diagnostic[]): LintDiagnostic[] {
  const markers: LintDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.line === null) continue;
    const line = doc.line(Math.min(Math.max(diagnostic.line, 1), doc.lines));
    markers.push({
      from: line.from,
      to: line.to,
      severity: SEVERITY[diagnostic.level],
      source: diagnostic.source,
      message: diagnostic.message,
    });
  }
  return markers;
}
