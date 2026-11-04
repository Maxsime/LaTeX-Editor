import { readFileSync } from 'node:fs';
import type { AiMode } from '@galley/shared';

/** Prompt file of each mode, with its version; bump the version to change a prompt. */
export const PROMPT_FILES: Record<AiMode, string> = {
  chat: 'chat.v2',
  inline: 'inline.v2',
  fix: 'fix.v2',
  generate: 'generate.v2',
  image: 'image.v2',
  agent: 'agent.v2',
};

export interface SystemPrompt {
  /** Name and version, recorded with the usage, e.g. `chat.v2`. */
  id: string;
  text: string;
}

const cache = new Map<string, string>();

/**
 * The system prompt of a mode, read from `packages/ai/prompts/` (SPEC §6.8).
 * The folder sits beside `src/` and `dist/`, so one relative path serves both.
 */
export function systemPrompt(mode: AiMode): SystemPrompt {
  const id = PROMPT_FILES[mode];
  let text = cache.get(id);
  if (text === undefined) {
    text = readFileSync(new URL(`../prompts/${id}.md`, import.meta.url), 'utf8').trim();
    cache.set(id, text);
  }
  return { id, text };
}
