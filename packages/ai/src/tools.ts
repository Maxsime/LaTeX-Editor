import { type AiToolName, MAX_PLAN_STEPS, type PlanStep, planStep } from '@galley/shared';
import { type Tool, tool, zodSchema } from 'ai';
import * as z from 'zod/mini';

/** A refusal the model should read and act on, e.g. a search text not found. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface ProposedEdit {
  path: string;
  search: string;
  replace: string;
}

export interface LiteratureResult {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  venue: string | null;
}

/**
 * What the tools do, provided by the API for one request: every method checks
 * access and limits itself, and throws {@link ToolError} for a refusal the
 * model can fix. The package never reaches the project on its own.
 */
export interface ToolHost {
  listFiles(): Promise<{ path: string; kind: 'text' | 'binary' }[]>;
  readFile(
    path: string,
    startLine?: number,
    endLine?: number,
  ): Promise<{
    path: string;
    firstLine: number;
    lastLine: number;
    totalLines: number;
    text: string;
  }>;
  searchProject(
    pattern: string,
    regex: boolean,
  ): Promise<{ path: string; line: number; text: string }[]>;
  getOutline(): Promise<{ level: number; title: string; file: string; line: number }[]>;
  getCompileLog(): Promise<{
    status: string;
    errors: { file?: string | undefined; line?: number | undefined; message: string }[];
  } | null>;
  compileSnippet(latex: string): Promise<{ outcome: string; errors: string[] }>;
  proposeChanges(
    edits: ProposedEdit[],
  ): Promise<{ changesetId: string; hunks: number; files: string[] }>;
  searchLiterature(query: string): Promise<LiteratureResult[]>;
  fetchBibtex(identifier: {
    doi?: string | undefined;
    arxivId?: string | undefined;
    isbn?: string | undefined;
  }): Promise<{ key: string; bibtex: string }>;
  /** Agent mode: shows the plan to the user. */
  updatePlan(steps: PlanStep[]): Promise<void>;
  /** Agent mode: applies edits to the draft, which later reads see. */
  editDraft(edits: ProposedEdit[]): Promise<{ files: string[] }>;
  /** Agent mode: compiles the whole project with the draft applied. */
  compileDraft(): Promise<{ outcome: string; errors: string[] }>;
  /** Agent mode: proposes the whole draft to the user, once. */
  submitChanges(): Promise<{ changesetId: string; hunks: number; files: string[] }>;
  /** Told about a tool that failed for another reason than a {@link ToolError}. */
  onFailure(name: AiToolName, error: unknown): void;
}

const path = z.string().check(z.minLength(1), z.maxLength(500));
const line = z.number().check(z.int(), z.positive());

const edits = z
  .array(
    z.object({
      path,
      search: z.string().check(z.maxLength(50_000)),
      replace: z.string().check(z.maxLength(100_000)),
    }),
  )
  .check(z.minLength(1), z.maxLength(50));

const schemas = {
  list_files: z.object({}),
  read_file: z.object({ path, startLine: z.optional(line), endLine: z.optional(line) }),
  search_project: z.object({
    pattern: z.string().check(z.minLength(1), z.maxLength(200)),
    regex: z.optional(z.boolean()),
  }),
  get_outline: z.object({}),
  get_compile_log: z.object({}),
  compile_snippet: z.object({ latex: z.string().check(z.minLength(1), z.maxLength(50_000)) }),
  propose_changes: z.object({ edits }),
  search_literature: z.object({ query: z.string().check(z.minLength(2), z.maxLength(300)) }),
  fetch_bibtex: z.object({
    doi: z.optional(z.string().check(z.maxLength(300))),
    arxivId: z.optional(z.string().check(z.maxLength(100))),
    isbn: z.optional(z.string().check(z.maxLength(40))),
  }),
  update_plan: z.object({
    steps: z.array(planStep).check(z.minLength(1), z.maxLength(MAX_PLAN_STEPS)),
  }),
  edit_draft: z.object({ edits }),
  compile_draft: z.object({}),
  submit_changes: z.object({}),
} satisfies Record<AiToolName, z.ZodMiniType>;

const descriptions: Record<AiToolName, string> = {
  list_files: 'List the files of the project with their kind (text or binary).',
  read_file:
    'Read a text file of the project, whole or between two line numbers (1-based, inclusive).',
  search_project:
    'Search the text files of the project for a string, or a regular expression if regex is true. Returns matching lines.',
  get_outline: 'Get the outline of the document: sections with their file and line.',
  get_compile_log: 'Get the status and the errors and warnings of the last compilation.',
  compile_snippet:
    'Compile a LaTeX fragment (or a complete standalone document) with pdfLaTeX to check that it compiles. Returns the errors.',
  propose_changes:
    'Propose changes to files for the user to review. Each edit replaces `search`, copied exactly from the current file and occurring once, by `replace`. An empty `search` appends `replace` at the end of an existing file, or creates the file when the path does not exist. Nothing is written until the user accepts.',
  search_literature:
    'Search scholarly literature (Crossref, arXiv, OpenAlex) for a query. Returns titles, authors, years and identifiers.',
  fetch_bibtex:
    'Get a verified BibTeX entry for a DOI, an arXiv identifier or an ISBN (give exactly one). The entry may then be added to a .bib file with propose_changes or edit_draft.',
  update_plan:
    'Show the user your plan: the whole list of steps, each pending, active or done. Call it first, then again whenever a step changes.',
  edit_draft:
    'Edit the draft: the private copy of the project you work on. Same edits as propose_changes, applied at once to the draft; read_file, search_project and get_outline then see the draft. The project itself is unchanged until the user accepts.',
  compile_draft:
    'Compile the whole project with the draft applied, in the sandbox, and return the errors. Use it to check your edits before submitting.',
  submit_changes:
    'Submit every change of the draft to the user as one proposal, which they accept or reject. Call it once, at the end.',
};

/** What the interface shows of a tool call: the file read, the query searched. */
export function toolDetail(name: AiToolName, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const record = input as Record<string, unknown>; // Inputs are validated objects of the schemas above.
  if (name === 'edit_draft' && Array.isArray(record.edits)) {
    const paths = new Set<string>();
    const list: unknown[] = record.edits;
    for (const item of list) {
      if (typeof item === 'object' && item !== null && 'path' in item) {
        if (typeof item.path === 'string') paths.add(item.path);
      }
    }
    return [...paths].join(', ').slice(0, 120);
  }
  const value =
    name === 'read_file'
      ? record.path
      : name === 'search_project'
        ? record.pattern
        : name === 'search_literature'
          ? record.query
          : name === 'fetch_bibtex'
            ? (record.doi ?? record.arxivId ?? record.isbn)
            : undefined;
  return typeof value === 'string' ? value.slice(0, 120) : undefined;
}

async function guarded<T>(
  host: ToolHost,
  name: AiToolName,
  run: () => Promise<T>,
): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ToolError) return { error: error.message };
    host.onFailure(name, error);
    return { error: 'The tool failed. Do not retry it.' };
  }
}

/** The SDK tools among `names`, executed by `host`. */
export function buildTools(host: ToolHost, names: readonly AiToolName[]): Record<string, Tool> {
  const all: Record<AiToolName, Tool> = {
    list_files: tool({
      description: descriptions.list_files,
      inputSchema: zodSchema(schemas.list_files),
      execute: () => guarded(host, 'list_files', () => host.listFiles()),
    }),
    read_file: tool({
      description: descriptions.read_file,
      inputSchema: zodSchema(schemas.read_file),
      execute: (input) =>
        guarded(host, 'read_file', () => host.readFile(input.path, input.startLine, input.endLine)),
    }),
    search_project: tool({
      description: descriptions.search_project,
      inputSchema: zodSchema(schemas.search_project),
      execute: (input) =>
        guarded(host, 'search_project', () =>
          host.searchProject(input.pattern, input.regex ?? false),
        ),
    }),
    get_outline: tool({
      description: descriptions.get_outline,
      inputSchema: zodSchema(schemas.get_outline),
      execute: () => guarded(host, 'get_outline', () => host.getOutline()),
    }),
    get_compile_log: tool({
      description: descriptions.get_compile_log,
      inputSchema: zodSchema(schemas.get_compile_log),
      execute: () =>
        guarded(
          host,
          'get_compile_log',
          async () =>
            (await host.getCompileLog()) ?? {
              status: 'never compiled',
              errors: [],
            },
        ),
    }),
    compile_snippet: tool({
      description: descriptions.compile_snippet,
      inputSchema: zodSchema(schemas.compile_snippet),
      execute: (input) => guarded(host, 'compile_snippet', () => host.compileSnippet(input.latex)),
    }),
    propose_changes: tool({
      description: descriptions.propose_changes,
      inputSchema: zodSchema(schemas.propose_changes),
      execute: (input) =>
        guarded(host, 'propose_changes', async () => ({
          ...(await host.proposeChanges(input.edits)),
          note: 'Proposed to the user, who will accept or reject it. Nothing is written yet.',
        })),
    }),
    search_literature: tool({
      description: descriptions.search_literature,
      inputSchema: zodSchema(schemas.search_literature),
      execute: (input) =>
        guarded(host, 'search_literature', () => host.searchLiterature(input.query)),
    }),
    fetch_bibtex: tool({
      description: descriptions.fetch_bibtex,
      inputSchema: zodSchema(schemas.fetch_bibtex),
      execute: (input) =>
        guarded(host, 'fetch_bibtex', () => {
          const given = [input.doi, input.arxivId, input.isbn].filter(
            (value) => value !== undefined && value !== '',
          );
          if (given.length !== 1) {
            throw new ToolError('Give exactly one of doi, arxivId or isbn.');
          }
          return host.fetchBibtex(input);
        }),
    }),
    update_plan: tool({
      description: descriptions.update_plan,
      inputSchema: zodSchema(schemas.update_plan),
      execute: (input) =>
        guarded(host, 'update_plan', async () => {
          await host.updatePlan(input.steps);
          return { shown: true };
        }),
    }),
    edit_draft: tool({
      description: descriptions.edit_draft,
      inputSchema: zodSchema(schemas.edit_draft),
      execute: (input) =>
        guarded(host, 'edit_draft', async () => ({
          ...(await host.editDraft(input.edits)),
          note: 'Applied to the draft only. Submit it with submit_changes when done.',
        })),
    }),
    compile_draft: tool({
      description: descriptions.compile_draft,
      inputSchema: zodSchema(schemas.compile_draft),
      execute: () => guarded(host, 'compile_draft', () => host.compileDraft()),
    }),
    submit_changes: tool({
      description: descriptions.submit_changes,
      inputSchema: zodSchema(schemas.submit_changes),
      execute: () =>
        guarded(host, 'submit_changes', async () => ({
          ...(await host.submitChanges()),
          note: 'Proposed to the user, who will accept or reject it. Nothing is written yet. Finish with a short summary.',
        })),
    }),
  };
  return Object.fromEntries(names.map((name) => [name, all[name]]));
}
