import { EditorState, Text } from '@codemirror/state';
import type { Diagnostic } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import {
  bibtexMarkers,
  compileMarkersOf,
  editorIssues,
  lintExtension,
  setCompileMarkers,
  toLintDiagnostics,
} from './lint.js';

const doc = Text.of(['\\documentclass{article}', '\\begin{document}', '\\foo', '\\end{document}']);
const diagnostic = (level: Diagnostic['level'], line: number | null): Diagnostic => ({
  level,
  source: 'tex',
  file: 'main.tex',
  line,
  message: 'message',
  context: '',
});

describe('toLintDiagnostics', () => {
  it('marks the whole line with a matching severity', () => {
    const [marker] = toLintDiagnostics(doc, [diagnostic('error', 3)]);
    expect(marker).toMatchObject({ from: doc.line(3).from, to: doc.line(3).to, severity: 'error' });
  });

  it('shows bad boxes as information and clamps lines past the end', () => {
    const markers = toLintDiagnostics(doc, [diagnostic('badbox', 99), diagnostic('warning', 0)]);
    expect(markers.map((m) => m.severity)).toEqual(['info', 'warning']);
    expect(markers[0]?.from).toBe(doc.line(4).from);
    expect(markers[1]?.from).toBe(0);
  });

  it('skips diagnostics without a line', () => {
    expect(toLintDiagnostics(doc, [diagnostic('error', null)])).toEqual([]);
  });

  it('offers to turn off the rule of a chktex warning', () => {
    const disabled: number[] = [];
    const [marker] = toLintDiagnostics(
      doc,
      [{ ...diagnostic('warning', 3), source: 'chktex', context: '2' }],
      'Compilation',
      { name: 'Disable', disable: (rule) => disabled.push(rule) },
    );
    expect(marker).toMatchObject({ severity: 'info', source: 'chktex 2' });
    marker?.actions?.[0]?.apply(null as never, 0, 0);
    expect(disabled).toEqual([2]);
  });
});

describe('bibtexMarkers', () => {
  it('marks syntax errors and keys defined in another file', () => {
    const text = '@book{dup,\n  title = {A}\n  year = 2000,\n}\n@book{,\n}';
    const markers = bibtexMarkers(text, new Set(['dup']), (issue) => issue.code, 'Editor');
    expect(markers.map((marker) => marker.message)).toEqual([
      'duplicateKeyElsewhere',
      'expectedComma',
      'missingKey',
    ]);
    for (const marker of markers) {
      expect(marker.to).toBeGreaterThan(marker.from);
      expect(marker.to).toBeLessThanOrEqual(text.length);
    }
  });
});

describe('editorIssues', () => {
  const text =
    '\\label{a}\\ref{a}\\ref{other}\\ref{missing}\\cite{k}\\cite{nope}\n\\begin{itemize}\n';
  const codes = (issues: ReturnType<typeof editorIssues>) =>
    issues.map((issue) => `${issue.code}:${issue.name}`);

  it('checks references and citations against the project and the live text', () => {
    const project = {
      labelCounts: new Map([['other', 1]]),
      citationKeys: new Set(['k']),
      otherBibKeys: new Set<string>(),
    };
    expect(codes(editorIssues(text, project))).toEqual([
      'unknownReference:missing',
      'unknownCitation:nope',
      'unclosedEnvironment:itemize',
    ]);
  });

  it('counts a label defined here and elsewhere as duplicate', () => {
    const project = {
      labelCounts: new Map([['a', 1]]),
      citationKeys: new Set<string>(),
      otherBibKeys: new Set<string>(),
    };
    expect(codes(editorIssues('\\label{a}', project))).toEqual(['duplicateLabel:a']);
  });

  it('checks citations only when the project has a bibliography', () => {
    const project = {
      labelCounts: new Map(),
      citationKeys: new Set<string>(),
      otherBibKeys: new Set<string>(),
    };
    expect(codes(editorIssues('\\cite{x}', project))).toEqual([]);
    expect(codes(editorIssues('\\bibitem{y}\\cite{x}', project))).toEqual(['unknownCitation:x']);
  });

  it('checks only environments before the project index is known', () => {
    expect(codes(editorIssues(text, null))).toEqual(['unclosedEnvironment:itemize']);
  });
});

describe('compile markers', () => {
  it('follow the text as it is edited', () => {
    let state = EditorState.create({
      doc: 'one\ntwo',
      extensions: lintExtension({
        check: null,
        project: () => null,
        translate: () => '',
        translateBib: () => '',
        source: 'Editor',
      }),
    });
    state = state.update({
      effects: setCompileMarkers.of([{ from: 4, to: 7, severity: 'error', message: 'm' }]),
    }).state;
    state = state.update({ changes: { from: 0, insert: 'zero\n' } }).state;
    expect(compileMarkersOf(state)[0]).toMatchObject({ from: 9, to: 12 });
  });
});
