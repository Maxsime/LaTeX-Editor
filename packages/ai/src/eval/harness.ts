import type { AiCapabilities, AiMode, AiProvider, GenerateKind } from '@galley/shared';
import type { LanguageModel } from 'ai';
import { buildContext, contextBudget, type ProjectSummary } from '../context.js';
import { generatedCode, standaloneDocument } from '../output.js';
import { runAssistant } from '../run.js';
import { type ProposedEdit, ToolError, type ToolHost } from '../tools.js';

/** One fixed task of the evaluation suite (SPEC §6.8). */
export interface Scenario {
  id: string;
  mode: Extract<AiMode, 'chat' | 'generate'>;
  kind?: GenerateKind;
  prompt: string;
  /** Files of the project the scenario runs in. */
  files: Record<string, string>;
  /**
   * Checks the outcome: the document to compile when the result is right,
   * or the reason it is wrong.
   */
  check(outcome: Outcome): { document: string } | { failure: string };
}

/** What the model produced: its final text and the edits it proposed, applied. */
export interface Outcome {
  text: string;
  edits: ProposedEdit[];
  /** The project's files after the proposed edits. */
  files: Record<string, string>;
}

export interface ScenarioResult {
  id: string;
  passed: boolean;
  /** Why it failed; null when it passed. */
  failure: string | null;
  /** Whether the document was compiled; false when no compiler was given. */
  compiled: boolean;
}

/** Compiles a full LaTeX document; resolves to the error, or null when it compiled. */
export type Compile = (document: string) => Promise<string | null>;

export interface EvaluationOptions {
  model: LanguageModel;
  provider: AiProvider;
  capabilities: AiCapabilities;
  scenarios: readonly Scenario[];
  /** Absent: results are checked without compiling, as in CI with a simulated model. */
  compile?: Compile;
}

function summary(files: Record<string, string>): ProjectSummary {
  const paths = Object.keys(files).sort();
  return {
    mainFile: paths.find((path) => path.endsWith('.tex')) ?? null,
    files: paths.map((path) => ({ path, kind: 'text' as const })),
    outline: [],
    labels: [],
    citationKeys: [],
    packages: [],
    commands: [],
  };
}

/** Applies proposed edits as the API would: unique search, or append when empty. */
export function applyProposed(
  files: Record<string, string>,
  edits: readonly ProposedEdit[],
): Record<string, string> {
  const result = { ...files };
  for (const edit of edits) {
    const text = result[edit.path];
    if (text === undefined) {
      if (edit.search !== '') throw new ToolError(`No file ${edit.path}.`);
      result[edit.path] = edit.replace;
      continue;
    }
    if (edit.search === '') {
      result[edit.path] = `${text}${text.endsWith('\n') ? '' : '\n'}${edit.replace}`;
      continue;
    }
    const first = text.indexOf(edit.search);
    if (first === -1 || text.includes(edit.search, first + 1)) {
      throw new ToolError(`The search text must occur exactly once in ${edit.path}.`);
    }
    result[edit.path] = text.replace(edit.search, () => edit.replace);
  }
  return result;
}

/** A project held in memory, answering the read tools and collecting proposals. */
function memoryHost(files: Record<string, string>, edits: ProposedEdit[]): ToolHost {
  const refuse = () => Promise.reject(new ToolError('Not available in this evaluation.'));
  return {
    listFiles: () =>
      Promise.resolve(Object.keys(files).map((path) => ({ path, kind: 'text' as const }))),
    readFile: (path) => {
      const text = files[path];
      if (text === undefined) return Promise.reject(new ToolError(`No file ${path}.`));
      const total = text.split('\n').length;
      return Promise.resolve({ path, firstLine: 1, lastLine: total, totalLines: total, text });
    },
    searchProject: (pattern) =>
      Promise.resolve(
        Object.entries(files).flatMap(([path, text]) =>
          text
            .split('\n')
            .flatMap((line, index) =>
              line.toLowerCase().includes(pattern.toLowerCase())
                ? [{ path, line: index + 1, text: line }]
                : [],
            ),
        ),
      ),
    getOutline: () => Promise.resolve([]),
    getCompileLog: () => Promise.resolve(null),
    compileSnippet: refuse,
    proposeChanges: (proposed) => {
      // Refused like the API refuses it, so that the model may correct itself.
      applyProposed(files, [...edits, ...proposed]);
      edits.push(...proposed);
      return Promise.resolve({
        changesetId: `eval-${String(edits.length)}`,
        hunks: proposed.length,
        files: [...new Set(proposed.map((edit) => edit.path))],
      });
    },
    searchLiterature: refuse,
    fetchBibtex: refuse,
    updatePlan: refuse,
    editDraft: refuse,
    compileDraft: refuse,
    submitChanges: refuse,
    onFailure: () => undefined,
  };
}

/** Runs one scenario and checks its result, compiling it when a compiler is given. */
export async function runScenario(
  options: Omit<EvaluationOptions, 'scenarios'>,
  scenario: Scenario,
): Promise<ScenarioResult> {
  const edits: ProposedEdit[] = [];
  let text: string;
  try {
    const result = await runAssistant({
      model: options.model,
      provider: options.provider,
      capabilities: options.capabilities,
      mode: scenario.mode,
      context: buildContext({
        project: summary(scenario.files),
        logErrors: [],
        budget: contextBudget(options.capabilities.contextTokens),
      }),
      messages: [
        {
          role: 'user',
          text:
            scenario.kind === undefined
              ? scenario.prompt
              : `${scenario.prompt}\n\n(Kind of code wanted: ${scenario.kind}.)`,
        },
      ],
      tools: {
        host: memoryHost(scenario.files, edits),
        names:
          scenario.mode === 'chat'
            ? ['list_files', 'read_file', 'search_project', 'propose_changes']
            : ['list_files', 'read_file'],
      },
      onEvent: () => undefined,
    });
    text = result.text;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      id: scenario.id,
      passed: false,
      failure: `model call failed: ${reason}`,
      compiled: false,
    };
  }
  const checked = scenario.check({ text, edits, files: applyProposed(scenario.files, edits) });
  if ('failure' in checked) {
    return { id: scenario.id, passed: false, failure: checked.failure, compiled: false };
  }
  if (options.compile === undefined) {
    return { id: scenario.id, passed: true, failure: null, compiled: false };
  }
  const error = await options.compile(checked.document);
  return { id: scenario.id, passed: error === null, failure: error, compiled: true };
}

/** Runs every scenario in turn. */
export async function runEvaluation(options: EvaluationOptions): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const scenario of options.scenarios) results.push(await runScenario(options, scenario));
  return results;
}

/** A generated fragment that must contain `marker`, compiled alone. */
function generated(marker: RegExp) {
  return ({ text }: Outcome) => {
    const code = generatedCode(text);
    if (code === null) return { failure: 'no LaTeX code block in the answer' };
    if (!marker.test(code.code)) return { failure: `the code lacks ${marker.source}` };
    return { document: standaloneDocument(code.code, code.preamble) };
  };
}

const ARTICLE = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{Results}',
  'The measurements show that teh output voltage rises with temperature.',
  '\\end{document}',
  '',
].join('\n');

/** The fixed scenarios of `pnpm --filter @galley/ai eval`. */
export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'fix-typo',
    mode: 'chat',
    prompt: 'Fix the typo in main.tex.',
    files: { 'main.tex': ARTICLE },
    check: ({ edits, files }) => {
      const text = files['main.tex'] ?? '';
      if (edits.length === 0) return { failure: 'no change was proposed' };
      if (!text.includes('the output voltage') || text.includes('teh')) {
        return { failure: 'the typo is still there' };
      }
      if (!text.includes('rises with temperature')) {
        return { failure: 'the rest of the sentence was changed' };
      }
      return { document: text };
    },
  },
  {
    id: 'table',
    mode: 'generate',
    kind: 'table',
    prompt: 'A table of three resistors (R1, R2, R3) with their resistance in ohms and tolerance.',
    files: { 'main.tex': ARTICLE },
    check: generated(/\\begin\{tabular/),
  },
  {
    id: 'formula',
    mode: 'generate',
    kind: 'formula',
    prompt: 'The transfer function of a first-order RC low-pass filter, H(jω).',
    files: { 'main.tex': ARTICLE },
    check: generated(/\\frac|\\dfrac/),
  },
  {
    id: 'tikz',
    mode: 'generate',
    kind: 'figure',
    prompt: 'A TikZ drawing of a voltage divider: a source and two resistors in series.',
    files: { 'main.tex': ARTICLE },
    check: generated(/\\begin\{tikzpicture\}|\\begin\{circuitikz\}/),
  },
];
