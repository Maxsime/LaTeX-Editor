import type { AiCapabilities, AiMode, AiProvider, AiToolName } from '@galley/shared';
import { aiToolName } from '@galley/shared';
import {
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type SystemModelMessage,
  type UserContent,
} from 'ai';
import type { BuiltContext } from './context.js';
import type { TokenUsage } from './cost.js';
import { systemPrompt } from './prompts.js';
import { buildTools, type ToolHost, toolDetail } from './tools.js';

/** What the assistant reports while it works. */
export type AssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; name: AiToolName; status: 'running' | 'done' | 'error'; detail?: string };

export interface AssistantRequest {
  model: LanguageModel;
  provider: AiProvider;
  capabilities: AiCapabilities;
  mode: AiMode;
  context: BuiltContext;
  messages: { role: 'user' | 'assistant'; text: string }[];
  image?: { mediaType: string; data: string } | undefined;
  /** Tools offered to the model, run by `host`; none for a model without tool use. */
  tools?: { host: ToolHost; names: readonly AiToolName[] } | undefined;
  abortSignal?: AbortSignal | undefined;
  /** Model calls in one request, tool round trips included (SPEC §6.8). */
  maxSteps?: number;
  maxOutputTokens?: number;
  onEvent(event: AssistantEvent): void;
}

export interface AssistantResult {
  /** Text of the last step: the final answer once tools are done. */
  text: string;
  usage: TokenUsage;
  /** Version of the system prompt used, for the usage log. */
  promptId: string;
}

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

function systemMessages(request: AssistantRequest, prompt: string): string | SystemModelMessage[] {
  const parts = [prompt, request.context.stable, request.context.variable].filter(
    (part) => part !== '',
  );
  if (request.provider !== 'anthropic') {
    // Several system messages confuse the chat templates of some local models.
    return parts.join('\n\n');
  }
  return [
    { role: 'system', content: prompt },
    {
      role: 'system',
      content: request.context.stable,
      // Cache point after the stable prefix: prompt and index are reused between requests.
      ...(request.capabilities.promptCache
        ? { providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }
        : {}),
    },
    ...(request.context.variable === ''
      ? []
      : [{ role: 'system' as const, content: request.context.variable }]),
  ];
}

function conversation(request: AssistantRequest): ModelMessage[] {
  const messages: ModelMessage[] = request.messages.map((message, index) => {
    const last = index === request.messages.length - 1;
    if (message.role === 'assistant') return { role: 'assistant', content: message.text };
    if (!last || request.image === undefined) return { role: 'user', content: message.text };
    const content: UserContent = [
      { type: 'image', image: request.image.data, mediaType: request.image.mediaType },
      { type: 'text', text: message.text },
    ];
    return { role: 'user', content };
  });
  if (messages.at(-1)?.role !== 'user') throw new Error('the conversation must end with the user');
  return messages;
}

function numberOf(value: number | undefined): number {
  return value ?? 0;
}

/**
 * Runs one request of the assistant: streams text and tool activity through
 * `onEvent` and returns the final text and token usage. Provider failures are
 * thrown as the SDK's errors; see `classifyProviderError`.
 */
export async function runAssistant(request: AssistantRequest): Promise<AssistantResult> {
  const prompt = systemPrompt(request.mode);
  const tools =
    request.tools === undefined || !request.capabilities.tools
      ? undefined
      : buildTools(request.tools.host, request.tools.names);
  const result = streamText({
    model: request.model,
    instructions: systemMessages(request, prompt.text),
    messages: conversation(request),
    ...(tools === undefined ? {} : { tools }),
    stopWhen: stepCountIs(request.maxSteps ?? DEFAULT_MAX_STEPS),
    maxOutputTokens: request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    // Retries would multiply the cost of a failing request; the user retries.
    maxRetries: 0,
    ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
  });

  let stepText = '';
  for await (const part of result.stream) {
    switch (part.type) {
      case 'start-step':
        stepText = '';
        break;
      case 'text-delta':
        stepText += part.text;
        request.onEvent({ type: 'text', delta: part.text });
        break;
      case 'tool-call': {
        const name = aiToolName.safeParse(part.toolName);
        if (!name.success) break;
        const detail = toolDetail(name.data, part.input);
        request.onEvent({
          type: 'tool',
          name: name.data,
          status: 'running',
          ...(detail === undefined ? {} : { detail }),
        });
        break;
      }
      case 'tool-result': {
        const name = aiToolName.safeParse(part.toolName);
        if (!name.success) break;
        const failed =
          typeof part.output === 'object' && part.output !== null && 'error' in part.output;
        request.onEvent({ type: 'tool', name: name.data, status: failed ? 'error' : 'done' });
        break;
      }
      case 'tool-error': {
        const name = aiToolName.safeParse(part.toolName);
        if (name.success) request.onEvent({ type: 'tool', name: name.data, status: 'error' });
        break;
      }
      case 'error':
        throw part.error;
      default:
        break;
    }
  }
  const usage = await result.usage;
  return {
    text: stepText,
    usage: {
      inputTokens: numberOf(usage.inputTokens),
      outputTokens: numberOf(usage.outputTokens),
      cachedInputTokens: numberOf(usage.inputTokenDetails.cacheReadTokens),
    },
    promptId: prompt.id,
  };
}
