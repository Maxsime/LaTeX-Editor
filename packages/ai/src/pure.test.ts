import { describe, expect, it } from 'vitest';
import { buildContext, contextBudget, type ProjectSummary, windowAround } from './context.js';
import { estimateCost } from './cost.js';
import { capabilitiesOf, UNKNOWN_MODEL_CAPABILITIES } from './models.js';
import { fencedBlocks, generatedCode, inlineReplacement, standaloneDocument } from './output.js';
import { PROMPT_FILES, systemPrompt } from './prompts.js';

describe('capabilitiesOf', () => {
  it('knows the main families', () => {
    expect(capabilitiesOf('anthropic', 'claude-sonnet-4-5')).toMatchObject({
      vision: true,
      promptCache: true,
    });
    expect(capabilitiesOf('openai', 'gpt-4o-mini').vision).toBe(true);
    expect(capabilitiesOf('mistral', 'pixtral-large-latest').vision).toBe(true);
    expect(capabilitiesOf('mistral', 'open-mistral-nemo').vision).toBe(false);
    expect(capabilitiesOf('openai-compatible', 'llama3.2-vision:11b').vision).toBe(true);
  });

  it('falls back to prudent defaults, which the instance may override', () => {
    expect(capabilitiesOf('openai-compatible', 'qwen2.5:7b')).toEqual(UNKNOWN_MODEL_CAPABILITIES);
    expect(capabilitiesOf('openai-compatible', 'qwen2.5:7b', { vision: true }).vision).toBe(true);
  });
});

const project: ProjectSummary = {
  mainFile: 'main.tex',
  files: [
    { path: 'main.tex', kind: 'text' },
    { path: 'img', kind: 'folder' },
    { path: 'img/a.png', kind: 'binary' },
  ],
  outline: [
    { level: 1, title: 'Introduction', file: 'main.tex', line: 5 },
    { level: 2, title: 'Contexte', file: 'main.tex', line: 9 },
  ],
  labels: ['sec:intro'],
  citationKeys: ['dupont2024'],
  packages: ['amsmath'],
  commands: [{ name: 'R', arguments: 0 }],
};

describe('buildContext', () => {
  it('puts the index in the stable part and the file in the variable part', () => {
    const text = '\\documentclass{article}\n\\begin{document}\nBonjour.\n\\end{document}\n';
    const built = buildContext({
      project,
      current: { path: 'main.tex', text, cursor: 45, selection: { from: 41, to: 49 } },
      logErrors: [{ file: 'main.tex', line: 3, message: 'Undefined control sequence.' }],
      budget: contextBudget(32_000),
    });
    expect(built.stable).toContain('Main file: main.tex');
    expect(built.stable).toContain('img/a.png');
    expect(built.stable).not.toContain('img,');
    expect(built.stable).toContain('  Contexte (main.tex:9)');
    expect(built.stable).toContain('\\R[0]');
    expect(built.variable).toContain('main.tex:3: Undefined control sequence.');
    expect(built.variable).toContain('# Selection in main.tex (from line 3)\nBonjour.');
    expect(built.variable).toContain('(whole file, cursor on line 3)');
  });

  it('does not depend on the file or the cursor in its stable part', () => {
    const one = buildContext({ project, logErrors: [], budget: 50_000 });
    const two = buildContext({
      project,
      current: { path: 'main.tex', text: 'x', cursor: 0 },
      logErrors: [],
      budget: 50_000,
    });
    expect(one.stable).toBe(two.stable);
    expect(one.variable).toBe('');
  });

  it('cuts long lists and long files', () => {
    const many = { ...project, labels: Array.from({ length: 400 }, (_, i) => `l${String(i)}`) };
    const text = Array.from({ length: 2000 }, (_, i) => `ligne ${String(i + 1)}`).join('\n');
    const built = buildContext({
      project: many,
      current: { path: 'main.tex', text, cursor: text.indexOf('ligne 1000') },
      logErrors: [],
      budget: 6000,
    });
    expect(built.stable).toContain('(+100 more)');
    expect(built.variable).toMatch(/lines \d+ to \d+; use read_file/);
    expect(built.variable).toContain('ligne 1000');
    expect(built.stable.length + built.variable.length).toBeLessThan(6000);
  });
});

describe('windowAround', () => {
  it('keeps whole lines around the center', () => {
    const text = 'aaaa\nbbbb\ncccc\ndddd\neeee\n';
    const window = windowAround(text, 12, 9);
    expect(window.complete).toBe(false);
    expect(window.text.split('\n').every((line) => line.length === 0 || line.length === 4)).toBe(
      true,
    );
    expect(window.text).toContain('cccc');
  });
});

describe('output parsing', () => {
  it('reads fenced blocks', () => {
    expect(fencedBlocks('Voici :\n```latex\n\\alpha\n```\nfin')).toEqual([
      { language: 'latex', code: '\\alpha' },
    ]);
  });

  it('takes the inline replacement from the block, or the whole answer', () => {
    expect(inlineReplacement('```latex\nNouveau texte.\n```')).toBe('Nouveau texte.');
    expect(inlineReplacement('  Nouveau texte.  ')).toBe('Nouveau texte.');
    expect(inlineReplacement('   ')).toBeNull();
  });

  it('separates generated code from its preamble', () => {
    expect(
      generatedCode(
        '```latex-preamble\n\\usepackage{booktabs}\n```\n```latex\n\\begin{tabular}{ll}\\toprule a & b\\\\\\bottomrule\\end{tabular}\n```',
      ),
    ).toEqual({
      code: '\\begin{tabular}{ll}\\toprule a & b\\\\\\bottomrule\\end{tabular}',
      preamble: '\\usepackage{booktabs}',
    });
    expect(
      generatedCode('```latex\n\\usepackage{tikz}\n\\begin{tikzpicture}\\end{tikzpicture}\n```'),
    ).toEqual({ code: '\\begin{tikzpicture}\\end{tikzpicture}', preamble: '\\usepackage{tikz}' });
    expect(generatedCode('pas de code')).toBeNull();
  });

  it('wraps a fragment in a standalone document, and keeps a full one', () => {
    const document = standaloneDocument('$x$', '\\usepackage{tikz}');
    expect(document).toContain('\\documentclass[varwidth=true,border=6pt]{standalone}');
    expect(document).toContain('\\usepackage{tikz}\n\\begin{document}\n$x$\n\\end{document}');
    const full = '\\documentclass{standalone}\\begin{document}x\\end{document}';
    expect(standaloneDocument(full)).toBe(full);
  });
});

describe('estimateCost', () => {
  it('prices cached input apart, in micro-units', () => {
    const price = { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 };
    expect(
      estimateCost({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800 }, price),
    ).toBe(Math.round(200 * 3 + 800 * 0.3 + 100 * 15));
    expect(
      estimateCost(
        { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 2000 },
        { ...price, cachedInputPerMTok: null },
      ),
    ).toBe(3000);
  });
});

describe('prompts', () => {
  it('loads a versioned prompt for every mode', () => {
    for (const mode of Object.keys(PROMPT_FILES) as (keyof typeof PROMPT_FILES)[]) {
      const prompt = systemPrompt(mode);
      expect(prompt.id).toMatch(/^[a-z]+\.v\d+$/);
      expect(prompt.text.length).toBeGreaterThan(100);
    }
    expect(systemPrompt('chat').text).toContain('propose_changes');
  });
});

describe('edge cases', () => {
  it('describes an empty project', () => {
    const built = buildContext({
      project: {
        mainFile: null,
        files: [],
        outline: [],
        labels: [],
        citationKeys: [],
        packages: [],
        commands: [],
      },
      current: { path: 'a.tex', text: '' },
      logErrors: [{ message: 'Emergency stop.' }],
      budget: 4000,
    });
    expect(built.stable).toContain('Main file: (none)');
    expect(built.stable).toContain('Labels: (none)');
    expect(built.stable).toContain('Outline:\n(empty)');
    expect(built.variable).toContain('- ?: Emergency stop.');
    expect(built.variable).toContain('# Current file: a.tex (whole file)');
  });

  it('reads blocks without a language and clips huge lists', () => {
    expect(inlineReplacement('```\nx\n```')).toBe('x');
    expect(generatedCode('```tex\n\\usepackage{tikz}\n```')).toBeNull();
    const huge = buildContext({
      project: {
        ...project,
        citationKeys: Array.from({ length: 5000 }, (_, i) => `key${String(i)}`),
      },
      logErrors: [],
      budget: 1000,
    });
    expect(huge.stable).toContain('[... truncated]');
  });
});
