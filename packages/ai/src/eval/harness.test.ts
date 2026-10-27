import { describe, expect, it } from 'vitest';
import { createModel } from '../providers.js';
import { startFakeProvider } from '../testing/fake-provider.js';
import { applyProposed, runEvaluation, SCENARIOS } from './harness.js';

const capabilities = { vision: false, tools: true, contextTokens: 32_000, promptCache: false };

const block = (code: string) => `Voici le code.\n\n\`\`\`latex\n${code}\n\`\`\``;

describe('evaluation harness', () => {
  it('passes every scenario with answers that follow the prompts', async () => {
    const fake = await startFakeProvider('openai', [
      { toolCalls: [{ name: 'read_file', input: { path: 'main.tex' } }] },
      {
        toolCalls: [
          {
            name: 'propose_changes',
            input: {
              edits: [{ path: 'main.tex', search: 'that teh output', replace: 'that the output' }],
            },
          },
        ],
      },
      { text: 'Fixed "teh".' },
      { text: block('\\begin{tabular}{lrr}\nR1 & 100 & 5\\% \\\\\n\\end{tabular}') },
      { text: block('H(j\\omega) = \\frac{1}{1 + j\\omega RC}') },
      {
        text: block(
          '\\usepackage{tikz}\n\\begin{tikzpicture}\\draw (0,0) -- (1,0);\\end{tikzpicture}',
        ),
      },
    ]);
    const documents: string[] = [];
    try {
      const results = await runEvaluation({
        model: createModel({ provider: 'openai-compatible', model: 'fake', baseUrl: fake.url }),
        provider: 'openai-compatible',
        capabilities,
        scenarios: SCENARIOS,
        compile: (document) => {
          documents.push(document);
          return Promise.resolve(null);
        },
      });
      expect(results).toEqual(
        SCENARIOS.map((scenario) => ({
          id: scenario.id,
          passed: true,
          failure: null,
          compiled: true,
        })),
      );
      expect(documents[0]).toContain('that the output voltage');
      expect(documents[3]).toContain('\\usepackage{tikz}');
    } finally {
      await fake.close();
    }
  });

  it('reports wrong, empty and failed answers', async () => {
    const fake = await startFakeProvider('openai', [
      { text: 'There is no typo.' },
      { text: 'I cannot do that.' },
      { text: block('x^2') },
      { status: 500 },
    ]);
    try {
      const results = await runEvaluation({
        model: createModel({ provider: 'openai-compatible', model: 'fake', baseUrl: fake.url }),
        provider: 'openai-compatible',
        capabilities,
        scenarios: SCENARIOS,
      });
      expect(
        results.map((result) => [result.id, result.passed, result.failure?.slice(0, 20)]),
      ).toEqual([
        ['fix-typo', false, 'no change was propos'],
        ['table', false, 'no LaTeX code block '],
        ['formula', false, 'the code lacks \\\\fra'],
        ['tikz', false, 'model call failed: I'],
      ]);
    } finally {
      await fake.close();
    }
  });

  it('answers the read tools from the project and refuses the others', async () => {
    const fake = await startFakeProvider('openai', [
      {
        toolCalls: [
          { name: 'list_files', input: {} },
          { name: 'search_project', input: { pattern: 'TEH' } },
          { name: 'read_file', input: { path: 'missing.tex' } },
        ],
      },
      {
        toolCalls: [
          {
            name: 'propose_changes',
            input: { edits: [{ path: 'main.tex', search: 'e', replace: 'x' }] },
          },
        ],
      },
      { text: 'Done.' },
    ]);
    try {
      const [scenario] = SCENARIOS;
      if (scenario === undefined) throw new Error('no scenario');
      const [result] = await runEvaluation({
        model: createModel({ provider: 'openai-compatible', model: 'fake', baseUrl: fake.url }),
        provider: 'openai-compatible',
        capabilities,
        scenarios: [scenario],
      });
      expect(result).toMatchObject({ passed: false, failure: 'no change was proposed' });
      const results = JSON.stringify(fake.requests[1]?.body);
      expect(results).toContain('main.tex');
      expect(results).toContain('that teh output');
      expect(results).toContain('No file missing.tex.');
      expect(JSON.stringify(fake.requests[2]?.body)).toContain('exactly once');
    } finally {
      await fake.close();
    }
  });

  it('survives calls to tools it was not offered', async () => {
    const fake = await startFakeProvider('openai', [
      {
        toolCalls: [
          { name: 'get_outline', input: {} },
          { name: 'get_compile_log', input: {} },
        ],
      },
      { text: block('\\begin{tabular}{l}a\\end{tabular}') },
    ]);
    try {
      const table = SCENARIOS.find((scenario) => scenario.id === 'table');
      if (table === undefined) throw new Error('no scenario');
      const [result] = await runEvaluation({
        model: createModel({ provider: 'openai-compatible', model: 'fake', baseUrl: fake.url }),
        provider: 'openai-compatible',
        capabilities,
        scenarios: [{ ...table, mode: 'chat' }],
      });
      expect(result?.passed).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('applies edits as the API does', () => {
    expect(
      applyProposed({ 'a.tex': 'x y' }, [{ path: 'a.tex', search: 'y', replace: 'z' }]),
    ).toEqual({
      'a.tex': 'x z',
    });
    expect(applyProposed({ 'a.tex': 'x' }, [{ path: 'a.tex', search: '', replace: 'y' }])).toEqual({
      'a.tex': 'x\ny',
    });
    expect(applyProposed({}, [{ path: 'b.tex', search: '', replace: 'y' }])).toEqual({
      'b.tex': 'y',
    });
    expect(() =>
      applyProposed({ 'a.tex': 'x x' }, [{ path: 'a.tex', search: 'x', replace: '' }]),
    ).toThrow(/exactly once/);
    expect(() => applyProposed({}, [{ path: 'c.tex', search: 'x', replace: '' }])).toThrow(
      /No file/,
    );
  });
});
