import type { Diagnostic } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import {
  countLevels,
  diagnosticStep,
  diagnosticsByFile,
  isCompileShortcut,
  isForwardSearchShortcut,
  isPending,
  navigableDiagnostics,
  nextStop,
  outputUrl,
} from './compile.js';

const diagnostic = (overrides: Partial<Diagnostic>): Diagnostic => ({
  level: 'error',
  source: 'tex',
  file: 'main.tex',
  line: 1,
  message: 'Undefined control sequence',
  context: '',
  ...overrides,
});

describe('compile helpers', () => {
  it('builds output URLs with encoded path segments', () => {
    expect(outputUrl('p', 'c', 'chapitres/intro été.aux')).toBe(
      '/api/projects/p/compiles/c/output/chapitres/intro%20%C3%A9t%C3%A9.aux',
    );
  });

  it('tells pending compilations from finished ones', () => {
    expect(isPending(null)).toBe(false);
    expect(isPending({ status: 'queued' })).toBe(true);
    expect(isPending({ status: 'running' })).toBe(true);
    expect(isPending({ status: 'failure' })).toBe(false);
  });

  it('counts diagnostics by level', () => {
    const counts = countLevels([
      diagnostic({}),
      diagnostic({ level: 'warning' }),
      diagnostic({ level: 'warning' }),
      diagnostic({ level: 'badbox' }),
    ]);
    expect(counts).toEqual({ error: 1, warning: 2, badbox: 1 });
  });

  it('groups located diagnostics by file and skips the others', () => {
    const grouped = diagnosticsByFile([
      diagnostic({ file: 'main.tex', line: 3 }),
      diagnostic({ file: 'chapters/one.tex', line: 9 }),
      diagnostic({ file: 'main.tex', line: 7 }),
      diagnostic({ file: null }),
      diagnostic({ file: 'main.tex', line: null }),
    ]);
    expect([...grouped.keys()]).toEqual(['main.tex', 'chapters/one.tex']);
    expect(grouped.get('main.tex')?.map((d) => d.line)).toEqual([3, 7]);
  });

  it('recognises the compile shortcuts only', () => {
    const key = (overrides: Partial<KeyboardEvent>) => ({
      key: 's',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides,
    });
    expect(isCompileShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isCompileShortcut(key({ metaKey: true, key: 'Enter' }))).toBe(true);
    expect(isCompileShortcut(key({ ctrlKey: true, key: 'S' }))).toBe(true);
    expect(isCompileShortcut(key({}))).toBe(false);
    expect(isCompileShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isCompileShortcut(key({ ctrlKey: true, key: 'f' }))).toBe(false);
  });

  it('keeps only located errors and warnings for F8 navigation', () => {
    const list = [
      diagnostic({ message: 'a' }),
      diagnostic({ level: 'badbox', message: 'b' }),
      diagnostic({ file: null, message: 'c' }),
      diagnostic({ level: 'warning', line: null, message: 'd' }),
      diagnostic({ level: 'warning', message: 'e' }),
    ];
    expect(navigableDiagnostics(list).map((d) => d.message)).toEqual(['a', 'e']);
  });

  it('cycles through the diagnostics in both directions', () => {
    expect(nextStop(0, -1, 1)).toBe(-1);
    expect(nextStop(3, -1, 1)).toBe(0);
    expect(nextStop(3, -1, -1)).toBe(2);
    expect(nextStop(3, 2, 1)).toBe(0);
    expect(nextStop(3, 0, -1)).toBe(2);
    expect(nextStop(3, 1, 1)).toBe(2);
  });

  it('maps F8 and Shift+F8 to a direction', () => {
    const key = (overrides: Partial<KeyboardEvent>) => ({
      key: 'F8',
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...overrides,
    });
    expect(diagnosticStep(key({}))).toBe(1);
    expect(diagnosticStep(key({ shiftKey: true }))).toBe(-1);
    expect(diagnosticStep(key({ ctrlKey: true }))).toBeNull();
    expect(diagnosticStep(key({ key: 'F7' }))).toBeNull();
  });

  it('recognises the forward search shortcut by physical key', () => {
    const key = (overrides: Partial<KeyboardEvent>) => ({
      code: 'KeyJ',
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      ...overrides,
    });
    expect(isForwardSearchShortcut(key({}))).toBe(true);
    expect(isForwardSearchShortcut(key({ ctrlKey: false, metaKey: true }))).toBe(true);
    expect(isForwardSearchShortcut(key({ altKey: false }))).toBe(false);
    expect(isForwardSearchShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isForwardSearchShortcut(key({ code: 'KeyK' }))).toBe(false);
  });
});
