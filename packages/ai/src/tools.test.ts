import { describe, expect, it } from 'vitest';
import { buildTools, ToolError, type ToolHost, toolDetail } from './tools.js';
import { aiToolNames } from '@galley/shared';

function recordingHost(): { host: ToolHost; calls: unknown[][]; failures: string[] } {
  const calls: unknown[][] = [];
  const failures: string[] = [];
  const record =
    <T>(name: string, value: T) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(value);
    };
  return {
    calls,
    failures,
    host: {
      listFiles: record('listFiles', []),
      readFile: record('readFile', {
        path: 'a',
        firstLine: 1,
        lastLine: 1,
        totalLines: 1,
        text: '',
      }),
      searchProject: record('searchProject', []),
      getOutline: record('getOutline', []),
      getCompileLog: record('getCompileLog', null),
      compileSnippet: record('compileSnippet', { outcome: 'success', errors: [] }),
      proposeChanges: () => Promise.reject(new Error('database down')),
      searchLiterature: record('searchLiterature', []),
      fetchBibtex: record('fetchBibtex', { key: 'k', bibtex: '@misc{k,}' }),
      onFailure: (name) => failures.push(name),
    },
  };
}

async function call(
  tools: ReturnType<typeof buildTools>,
  name: string,
  input: unknown,
): Promise<unknown> {
  const execute = tools[name]?.execute;
  if (execute === undefined) throw new Error(`no tool ${name}`);
  const options: Parameters<typeof execute>[1] = { toolCallId: '1', messages: [], context: {} };
  const output: unknown = await execute(input, options);
  return output;
}

describe('buildTools', () => {
  it('offers only the tools asked for', () => {
    const { host } = recordingHost();
    expect(Object.keys(buildTools(host, ['read_file', 'get_outline']))).toEqual([
      'read_file',
      'get_outline',
    ]);
    expect(Object.keys(buildTools(host, aiToolNames))).toHaveLength(9);
  });

  it('forwards each tool to the host', async () => {
    const { host, calls, failures } = recordingHost();
    const tools = buildTools(host, aiToolNames);
    await call(tools, 'list_files', {});
    await call(tools, 'read_file', { path: 'main.tex', startLine: 2 });
    await call(tools, 'search_project', { pattern: 'x' });
    await call(tools, 'get_outline', {});
    expect(await call(tools, 'get_compile_log', {})).toEqual({
      status: 'never compiled',
      errors: [],
    });
    await call(tools, 'compile_snippet', { latex: '$x$' });
    await call(tools, 'search_literature', { query: 'graph theory' });
    await call(tools, 'fetch_bibtex', { arxivId: '2101.00001' });
    expect(await call(tools, 'propose_changes', { edits: [] })).toEqual({
      error: 'The tool failed. Do not retry it.',
    });
    expect(failures).toEqual(['propose_changes']);
    expect(calls.map((entry) => entry[0])).toEqual([
      'listFiles',
      'readFile',
      'searchProject',
      'getOutline',
      'getCompileLog',
      'compileSnippet',
      'searchLiterature',
      'fetchBibtex',
    ]);
    expect(calls[1]).toEqual(['readFile', 'main.tex', 2, undefined]);
    expect(calls[2]).toEqual(['searchProject', 'x', false]);
  });

  it('turns a ToolError into an answer for the model', async () => {
    const { host } = recordingHost();
    const tools = buildTools(
      { ...host, proposeChanges: () => Promise.reject(new ToolError('Unknown citation key x.')) },
      ['propose_changes'],
    );
    expect(await call(tools, 'propose_changes', { edits: [] })).toEqual({
      error: 'Unknown citation key x.',
    });
  });

  it('notes a successful proposal as pending', async () => {
    const { host } = recordingHost();
    const tools = buildTools(
      {
        ...host,
        proposeChanges: () => Promise.resolve({ changesetId: 'c', hunks: 1, files: ['a.tex'] }),
      },
      ['propose_changes'],
    );
    expect(await call(tools, 'propose_changes', { edits: [] })).toMatchObject({
      changesetId: 'c',
      note: expect.stringContaining('Nothing is written yet') as unknown,
    });
  });
});

describe('toolDetail', () => {
  it('describes calls for the interface', () => {
    expect(toolDetail('read_file', { path: 'a.tex' })).toBe('a.tex');
    expect(toolDetail('search_project', { pattern: 'foo' })).toBe('foo');
    expect(toolDetail('search_literature', { query: 'q' })).toBe('q');
    expect(toolDetail('fetch_bibtex', { isbn: '978' })).toBe('978');
    expect(toolDetail('list_files', {})).toBeUndefined();
    expect(toolDetail('read_file', null)).toBeUndefined();
  });
});
