import { describe, expect, it } from 'vitest';
import { parseSynctexEdit, parseSynctexView, synctexArgs, synctexSandboxArgs } from './synctex.js';

// Captured from the synctex binary of TeX Live 2026.
const editOutput = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/out/main.pdf
Input:/project/./chapters/intro.tex
Line:12
Column:-1
Offset:0
Context:
SyncTeX result end
`;

const viewOutput = `This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:/out/main.pdf
Page:1
x:173.895706
y:134.764618
h:133.768356
v:136.909348
W:343.711060
H:9.063227
before:
offset:-1
middle:
after:
Output:/out/main.pdf
Page:1
x:179.856689
y:132.722305
h:133.768356
v:136.909348
W:343.711060
H:9.063227
before:
offset:-1
middle:
after:
Output:/out/main.pdf
Page:2
x:90
y:100
h:72
v:150
W:200
H:10
before:
offset:-1
middle:
after:
SyncTeX result end
`;

describe('parseSynctexEdit', () => {
  it('reads the input, line and missing column', () => {
    expect(parseSynctexEdit(editOutput)).toEqual({
      input: '/project/./chapters/intro.tex',
      line: 12,
      column: null,
    });
  });

  it('returns null when nothing is under the point', () => {
    expect(parseSynctexEdit('This is SyncTeX command line utility, version 1.5\n')).toBe(null);
    expect(
      parseSynctexEdit(
        'SyncTeX result begin\nOutput:/out/main.pdf\nInput:\nLine:0\nSyncTeX result end\n',
      ),
    ).toBe(null);
  });
});

describe('parseSynctexView', () => {
  it('returns each distinct box by its top-left corner', () => {
    const boxes = parseSynctexView(viewOutput);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]?.page).toBe(1);
    expect(boxes[0]?.x).toBeCloseTo(133.768356);
    expect(boxes[0]?.y).toBeCloseTo(136.909348 - 9.063227);
    expect(boxes[0]?.width).toBeCloseTo(343.71106);
    expect(boxes[1]).toEqual({ page: 2, x: 72, y: 140, width: 200, height: 10 });
  });

  it('ignores incomplete records', () => {
    expect(
      parseSynctexView('SyncTeX result begin\nOutput:x\nPage:1\nSyncTeX result end\n'),
    ).toEqual([]);
  });
});

describe('synctexArgs', () => {
  const target = {
    compileId: '0193f9f0-4d0a-7c3e-8f5a-1b2c3d4e5f60',
    synctexFile: 'main.synctex.gz',
  };

  it('builds edit and view queries against the sandboxed data', () => {
    expect(synctexArgs({ kind: 'edit', ...target, page: 3, x: 10.5, y: 200 })).toEqual([
      'edit',
      '-o',
      '3:10.5:200:/out/main.pdf',
    ]);
    expect(
      synctexArgs({ kind: 'view', ...target, file: 'chapters/intro.tex', line: 7, column: 0 }),
    ).toEqual(['view', '-i', '7:0:/project/chapters/intro.tex', '-o', '/out/main.pdf']);
  });
});

describe('synctexSandboxArgs', () => {
  it('confines the query: no network, empty environment, read-only data', () => {
    const args = synctexSandboxArgs('/tl/bin', '/cache/abc', ['edit']);
    expect(args.slice(0, 4)).toEqual([
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--clearenv',
    ]);
    const data = args.indexOf('/cache/abc');
    expect(args[data - 1]).toBe('--ro-bind');
    expect(args[data + 1]).toBe('/out');
    expect(args).not.toContain('--bind');
    expect(args.at(-2)).toBe('/tl/bin/synctex');
  });
});
