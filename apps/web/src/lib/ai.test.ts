import { describe, expect, it } from 'vitest';
import {
  formatCost,
  hunkDiff,
  hunksByFile,
  preamblePackages,
  readImage,
  splitEvents,
} from './ai.js';

describe('splitEvents', () => {
  it('returns complete events and keeps the unfinished rest', () => {
    const { events, rest } = splitEvents(
      'data: {"type":"text","delta":"Bon"}\n\ndata: {"type":"text","delta":"jour"}\n\ndata: {"ty',
    );
    expect(events).toEqual([
      { type: 'text', delta: 'Bon' },
      { type: 'text', delta: 'jour' },
    ]);
    expect(rest).toBe('data: {"ty');
  });

  it('drops malformed or unknown events and accepts CRLF', () => {
    const { events } = splitEvents(
      'data: nope\r\n\r\ndata: {"type":"other"}\n\n: comment\n\ndata: {"type":"done"}\n\n',
    );
    expect(events).toEqual([{ type: 'done' }]);
  });
});

describe('hunkDiff', () => {
  it('shows unchanged lines as context, then removed and added lines', () => {
    expect(hunkDiff({ original: 'a\nb\nc', replacement: 'a\nB\nc' })).toEqual([
      { kind: 'context', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'context', text: 'c' },
    ]);
  });

  it('handles pure insertions', () => {
    expect(hunkDiff({ original: '', replacement: 'new\n' })).toEqual([
      { kind: 'added', text: 'new' },
    ]);
  });
});

describe('hunksByFile', () => {
  it('groups hunks by path in order of first appearance', () => {
    const groups = hunksByFile([
      { path: 'b.tex', id: '1' },
      { path: 'a.tex', id: '2' },
      { path: 'b.tex', id: '3' },
    ]);
    expect(groups.map(([path, hunks]) => [path, hunks.map((hunk) => hunk.id)])).toEqual([
      ['b.tex', ['1', '3']],
      ['a.tex', ['2']],
    ]);
  });
});

describe('preamblePackages', () => {
  it('lists packages once, options and lists included', () => {
    expect(
      preamblePackages(
        '\\usepackage[margin=1cm]{geometry}\n\\usepackage{tikz, pgfplots}\n\\usetikzlibrary{arrows}\n\\usepackage{tikz}',
      ),
    ).toEqual(['geometry', 'tikz', 'pgfplots']);
  });
});

describe('formatCost', () => {
  it('formats millionths of a currency', () => {
    expect(formatCost(1_250_000, 'EUR', 'en')).toBe('€1.25');
    expect(formatCost(1200, 'USD', 'en')).toBe('$0.0012');
  });
});

describe('readImage', () => {
  it('encodes an accepted image in base64', async () => {
    const result = await readImage(
      new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
    );
    expect(result).toEqual({ ok: true, image: { mediaType: 'image/png', data: 'AQID' } });
  });

  it('refuses other types and large files', async () => {
    expect(await readImage(new File(['x'], 'a.gif', { type: 'image/gif' }))).toEqual({
      ok: false,
      reason: 'type',
    });
    const large = new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'a.png', { type: 'image/png' });
    expect(await readImage(large)).toEqual({ ok: false, reason: 'size' });
  });
});
