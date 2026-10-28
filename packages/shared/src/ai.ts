import * as z from 'zod/mini';

// --- Providers ------------------------------------------------------------------

export const aiProviders = ['anthropic', 'openai', 'mistral', 'openai-compatible'] as const;
export const aiProvider = z.enum(aiProviders);
export type AiProvider = z.infer<typeof aiProvider>;

/** What a model can do; the interface hides what it cannot (SPEC §6.8). */
export const aiCapabilities = z.object({
  vision: z.boolean(),
  tools: z.boolean(),
  contextTokens: z.number().check(z.int(), z.positive()),
  promptCache: z.boolean(),
});
export type AiCapabilities = z.infer<typeof aiCapabilities>;

const modelName = z.string().check(z.trim(), z.minLength(1), z.maxLength(200));
const baseUrl = z.url({ protocol: /^https?$/ }).check(z.maxLength(500));

/** Longest API key accepted; real ones are under 200 characters. */
export const MAX_API_KEY_LENGTH = 500;

/** A user's provider configuration as the API shows it: the key only by its last characters. */
export const aiProviderConfig = z.object({
  provider: aiProvider,
  model: modelName,
  baseUrl: z.nullable(z.string()),
  keyHint: z.nullable(z.string()),
});
export type AiProviderConfig = z.infer<typeof aiProviderConfig>;

/** Response of `GET /api/me/ai/provider`. */
export const aiProviderSettings = z.object({
  config: z.nullable(aiProviderConfig),
  /** The instance default, used when the user has none. */
  instance: z.nullable(z.object({ provider: aiProvider, model: z.string() })),
  /** Whether users may point a provider at an address of their choice. */
  allowUserEndpoints: z.boolean(),
  enabled: z.boolean(),
});
export type AiProviderSettings = z.infer<typeof aiProviderSettings>;

/** Body of `PUT /api/me/ai/provider`; an absent key keeps the stored one. */
export const putAiProviderRequest = z.object({
  provider: aiProvider,
  model: modelName,
  baseUrl: z.optional(z.nullable(baseUrl)),
  apiKey: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(MAX_API_KEY_LENGTH))),
});
export type PutAiProviderRequest = z.input<typeof putAiProviderRequest>;

/** Response of `GET /api/projects/:id/ai/status`. */
export const aiStatus = z.object({
  available: z.boolean(),
  reason: z.nullable(z.enum(['instance-disabled', 'project-disabled', 'not-configured'])),
  provider: z.nullable(aiProvider),
  model: z.nullable(z.string()),
  capabilities: z.nullable(aiCapabilities),
});
export type AiStatus = z.infer<typeof aiStatus>;

// --- Chat -----------------------------------------------------------------------

export const aiModes = ['chat', 'inline', 'fix', 'generate', 'image', 'agent'] as const;
export const aiMode = z.enum(aiModes);
export type AiMode = z.infer<typeof aiMode>;

/** What `generate` and `image` produce. */
export const generateKind = z.enum(['table', 'figure', 'plot', 'formula', 'auto']);
export type GenerateKind = z.infer<typeof generateKind>;

/** Longest single message of a conversation. */
export const MAX_AI_MESSAGE_LENGTH = 20_000;
/** Messages of a conversation sent back with each request. */
export const MAX_AI_MESSAGES = 40;
/** Largest image sent to a model, before base64. */
export const MAX_AI_IMAGE_BYTES = 4 * 1024 * 1024;

export const aiImageTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;

const position = z.number().check(z.int(), z.gte(0));

/** Body of `POST /api/projects/:id/ai/chat`. */
export const aiChatRequest = z.object({
  conversationId: z.optional(z.string().check(z.regex(/^[A-Za-z0-9_-]{8,64}$/))),
  mode: aiMode,
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().check(z.maxLength(MAX_AI_MESSAGE_LENGTH)),
      }),
    )
    .check(z.minLength(1), z.maxLength(MAX_AI_MESSAGES)),
  context: z._default(
    z.object({
      fileId: z.optional(z.uuid()),
      cursor: z.optional(position),
      selection: z.optional(z.object({ from: position, to: position })),
    }),
    {},
  ),
  /** `fix`: the log entry to explain. */
  diagnostic: z.optional(
    z.object({
      file: z.optional(z.string().check(z.maxLength(500))),
      line: z.optional(z.number().check(z.int(), z.positive())),
      message: z.string().check(z.minLength(1), z.maxLength(4000)),
    }),
  ),
  /** `generate` and `image`. */
  kind: z.optional(generateKind),
  image: z.optional(
    z.object({
      mediaType: z.enum(aiImageTypes),
      // Base64 grows data by a third.
      data: z
        .string()
        .check(
          z.maxLength(Math.ceil((MAX_AI_IMAGE_BYTES * 4) / 3) + 4),
          z.regex(/^[A-Za-z0-9+/]+={0,2}$/),
        ),
    }),
  ),
});
export type AiChatRequest = z.input<typeof aiChatRequest>;

// --- Changesets -----------------------------------------------------------------

/** One replacement proposed by the assistant, located in the text it was computed on. */
export const aiHunk = z.object({
  id: z.string().check(z.minLength(1), z.maxLength(64)),
  /** Null for a file the changeset creates. */
  fileId: z.nullable(z.uuid()),
  path: z.string(),
  start: position,
  original: z.string(),
  replacement: z.string(),
  /** Text right before and after `original`, to find it again if the file moved. */
  before: z.string(),
  after: z.string(),
});
export type AiHunk = z.infer<typeof aiHunk>;

export const hunkStatus = z.enum(['pending', 'applied', 'rejected', 'conflict']);
export type HunkStatus = z.infer<typeof hunkStatus>;

export const aiChangeset = z.object({
  id: z.string(),
  hunks: z.array(z.extend(aiHunk, { status: hunkStatus })),
});
export type AiChangeset = z.infer<typeof aiChangeset>;

/** Body of `POST /api/projects/:id/ai/changesets/:changesetId/apply` and `/reject`. */
export const changesetDecisionRequest = z.object({
  hunkIds: z.array(z.string().check(z.maxLength(64))).check(z.minLength(1), z.maxLength(500)),
});
export type ChangesetDecisionRequest = z.infer<typeof changesetDecisionRequest>;

/** Body of collab's `POST /internal/documents/:fileId/edit`. */
export const editDocumentRequest = z.object({
  userId: z.uuid(),
  hunks: z.array(aiHunk).check(z.minLength(1), z.maxLength(500)),
});
export type EditDocumentRequest = z.infer<typeof editDocumentRequest>;

export const editDocumentResponse = z.object({
  results: z.array(z.object({ id: z.string(), status: z.enum(['applied', 'conflict']) })),
});
export type EditDocumentResponse = z.infer<typeof editDocumentResponse>;

// --- Stream ---------------------------------------------------------------------

export const aiToolNames = [
  'list_files',
  'read_file',
  'search_project',
  'get_outline',
  'get_compile_log',
  'compile_snippet',
  'propose_changes',
  'search_literature',
  'fetch_bibtex',
  'update_plan',
  'edit_draft',
  'compile_draft',
  'submit_changes',
] as const;
export const aiToolName = z.enum(aiToolNames);
export type AiToolName = z.infer<typeof aiToolName>;

export const aiUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  /** Estimated cost in millionths of `currency`; null when the model has no price. */
  costMicros: z.nullable(z.number()),
  currency: z.nullable(z.string()),
});
export type AiUsage = z.infer<typeof aiUsage>;

export const snippetPreview = z.object({
  /** Code to insert in the document. */
  code: z.string(),
  /** Preamble lines the code needs, e.g. `\usepackage{tikz}`. */
  preamble: z.string(),
  /** Compilation of the standalone preview; null when none could run. */
  compileId: z.nullable(z.string()),
  outcome: z.enum(['success', 'failure', 'timeout', 'error', 'skipped']),
  errors: z.array(z.string()),
});
export type SnippetPreview = z.infer<typeof snippetPreview>;

/** Model calls one request of the agent mode may make (SPEC §3.8). */
export const AGENT_MAX_STEPS = 30;
/** Bounds of the administrator's token budget for one agent request. */
export const MIN_AGENT_TOKEN_BUDGET = 10_000;
export const MAX_AGENT_TOKEN_BUDGET = 10_000_000;
/** Most steps of a plan the agent announces. */
export const MAX_PLAN_STEPS = 20;

export const planStepStatus = z.enum(['pending', 'active', 'done']);
export const planStep = z.object({
  title: z.string().check(z.minLength(1), z.maxLength(200)),
  status: planStepStatus,
});
export type PlanStep = z.infer<typeof planStep>;

/** Events of the `text/event-stream` answer of the chat route, one JSON per `data:` line. */
export const aiStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('conversation'), id: z.string() }),
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({
    type: z.literal('tool'),
    name: aiToolName,
    status: z.enum(['running', 'done', 'error']),
    /** Short description for the interface, e.g. the file read. */
    detail: z.optional(z.string()),
  }),
  z.object({ type: z.literal('changeset'), changeset: aiChangeset }),
  z.object({ type: z.literal('snippet'), snippet: snippetPreview }),
  /** Agent mode: the plan as it stands, sent whole at each change. */
  z.object({ type: z.literal('plan'), steps: z.array(planStep) }),
  z.object({ type: z.literal('usage'), usage: aiUsage }),
  z.object({ type: z.literal('error'), code: z.string() }),
  z.object({ type: z.literal('done') }),
]);
export type AiStreamEvent = z.infer<typeof aiStreamEvent>;

// --- Usage and prices -----------------------------------------------------------

export const aiUsageSummary = z.object({
  since: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  /** Estimated cost per currency, in millionths; prices may be set in several currencies. */
  costs: z.array(z.object({ currency: z.string(), micros: z.number() })),
  /** Requests whose model had no price: their cost is missing from `costs`. */
  unpricedRequests: z.number(),
  byModel: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      requests: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costMicros: z.nullable(z.number()),
      currency: z.nullable(z.string()),
    }),
  ),
});
export type AiUsageSummary = z.infer<typeof aiUsageSummary>;

const pricePerMTok = z.number().check(z.gte(0), z.lte(10_000));

export const aiModelPrice = z.object({
  provider: aiProvider,
  model: modelName,
  inputPerMTok: pricePerMTok,
  outputPerMTok: pricePerMTok,
  cachedInputPerMTok: z.nullable(pricePerMTok),
  currency: z.string().check(z.regex(/^[A-Z]{3}$/)),
});
export type AiModelPrice = z.infer<typeof aiModelPrice>;

/** Body of `PUT /api/admin/ai/prices`: the whole table. */
export const putAiPricesRequest = z.object({
  prices: z.array(aiModelPrice).check(z.maxLength(500)),
});
export type PutAiPricesRequest = z.infer<typeof putAiPricesRequest>;
