import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseBibtexLog, parseBiberLog } from './bib.js';
import { normalizeSegments, resolveLogPath } from './paths.js';

const context = { projectRoot: '/project', cwd: 'thesis', outDir: '/out' };

describe('parseBiberLog', () => {
  it('reads warnings and errors with the database they name', () => {
    const blg = [
      '[0] Config.pm:308> INFO - This is Biber 2.21',
      "[52] Biber.pm:131> WARN - Datamodel: Entry 'knuth' (refs.bib): Missing mandatory field 'title'",
      '[60] Utils.pm:409> ERROR - BibTeX subsystem: /tmp/biber_tmp_x/refs.bib_123.utf8, line 4, syntax error: found "}", expected "=" in \'refs.bib\'',
      '[61] Biber.pm:120> INFO - ERRORS: 1',
    ].join('\n');
    expect(parseBiberLog(blg, context)).toMatchObject([
      {
        level: 'warning',
        source: 'biber',
        file: 'thesis/refs.bib',
        line: null,
        message: "Datamodel: Entry 'knuth' (refs.bib): Missing mandatory field 'title'",
      },
      { level: 'error', file: 'thesis/refs.bib', line: 4 },
    ]);
  });

  it('keeps a database outside the project as external', () => {
    const blg = "[9] Biber.pm:1> WARN - Duplicate entry 'x' in '/usr/share/texmf/bib/global.bib'";
    expect(parseBiberLog(blg, context)).toMatchObject([
      { file: null, externalFile: '/usr/share/texmf/bib/global.bib' },
    ]);
  });

  it('leaves the file empty when the message names none', () => {
    expect(parseBiberLog('[3] Biber.pm:1> WARN - Something odd', context)).toMatchObject([
      { level: 'warning', file: null, line: null, message: 'Something odd' },
    ]);
  });
});

describe('parseBibtexLog', () => {
  it('finds nothing in a clean run', () => {
    const blg = readFileSync(new URL('./__fixtures__/natbib.blg', import.meta.url), 'utf8');
    expect(parseBibtexLog(blg, context)).toEqual([]);
  });

  it('reads warnings, located errors with their excerpt, and fatal errors', () => {
    const blg = [
      'Warning--I didn\'t find a database entry for "missing"',
      'Warning--empty journal in lamport1986',
      '--line 9 of file refs.bib',
      "I was expecting a `,' or a `}'---line 5 of file refs.bib",
      ' :   title = {Unfinished',
      ' :   year',
      "I'm skipping whatever remains of this entry",
      "I couldn't open database file nowhere.bib",
    ].join('\n');
    expect(parseBibtexLog(blg, context)).toMatchObject([
      {
        level: 'warning',
        file: null,
        line: null,
        message: 'I didn\'t find a database entry for "missing"',
      },
      {
        level: 'warning',
        file: 'thesis/refs.bib',
        line: 9,
        message: 'empty journal in lamport1986',
      },
      {
        level: 'error',
        file: 'thesis/refs.bib',
        line: 5,
        message: "I was expecting a `,' or a `}'",
        context: ' :   title = {Unfinished\n :   year',
      },
      { level: 'error', file: 'thesis/nowhere.bib', line: null },
    ]);
  });
});

describe('paths', () => {
  it('normalizes segments and refuses to climb above the root', () => {
    expect(normalizeSegments('a/./b/../c')).toBe('a/c');
    expect(normalizeSegments('../etc/passwd')).toBeNull();
  });

  it('classifies project, generated and external files', () => {
    expect(resolveLogPath('./a.tex', context)).toEqual({ kind: 'project', path: 'thesis/a.tex' });
    expect(resolveLogPath('../shared/b.tex', context)).toEqual({
      kind: 'project',
      path: 'shared/b.tex',
    });
    expect(resolveLogPath('/project/c.tex', context)).toEqual({ kind: 'project', path: 'c.tex' });
    expect(resolveLogPath('/out/main.aux', context)).toEqual({
      kind: 'generated',
      path: 'main.aux',
    });
    expect(resolveLogPath('/etc/passwd', context)).toEqual({
      kind: 'external',
      path: '/etc/passwd',
    });
    expect(resolveLogPath('../../x.tex', context)).toEqual({
      kind: 'external',
      path: '../../x.tex',
    });
    expect(resolveLogPath('/../x', context)).toEqual({ kind: 'external', path: '/../x' });
    expect(resolveLogPath('/project', context)).toEqual({ kind: 'external', path: '/project' });
  });
});
