import { describe, expect, it } from 'vitest';
import {
  aiChatRequest,
  aiStreamEvent,
  changesetDecisionRequest,
  putAiPricesRequest,
  putAiProviderRequest,
} from './ai.js';

describe('AI schemas', () => {
  it('accepts a chat request and fills the context', () => {
    const parsed = aiChatRequest.parse({
      mode: 'chat',
      messages: [{ role: 'user', text: 'Salut' }],
    });
    expect(parsed.context).toEqual({});
  });

  it('rejects empty conversations, unknown modes and bad images', () => {
    expect(aiChatRequest.safeParse({ mode: 'chat', messages: [] }).success).toBe(false);
    expect(
      aiChatRequest.safeParse({ mode: 'agent', messages: [{ role: 'user', text: 'x' }] }).success,
    ).toBe(false);
    expect(
      aiChatRequest.safeParse({
        mode: 'image',
        messages: [{ role: 'user', text: 'x' }],
        image: { mediaType: 'image/svg+xml', data: 'AAAA' },
      }).success,
    ).toBe(false);
  });

  it('keeps API keys bounded and base URLs to http(s)', () => {
    expect(
      putAiProviderRequest.safeParse({
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'k'.repeat(501),
      }).success,
    ).toBe(false);
    expect(
      putAiProviderRequest.safeParse({
        provider: 'openai-compatible',
        model: 'qwen',
        baseUrl: 'file:///etc/passwd',
      }).success,
    ).toBe(false);
    expect(
      putAiProviderRequest.safeParse({
        provider: 'openai-compatible',
        model: 'qwen',
        baseUrl: 'http://host.docker.internal:11434/v1',
      }).success,
    ).toBe(true);
  });

  it('validates stream events, decisions and prices', () => {
    expect(aiStreamEvent.safeParse({ type: 'text', delta: 'a' }).success).toBe(true);
    expect(aiStreamEvent.safeParse({ type: 'tool', name: 'rm_rf', status: 'done' }).success).toBe(
      false,
    );
    expect(changesetDecisionRequest.safeParse({ hunkIds: [] }).success).toBe(false);
    expect(
      putAiPricesRequest.safeParse({
        prices: [
          {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5',
            inputPerMTok: 3,
            outputPerMTok: 15,
            cachedInputPerMTok: 0.3,
            currency: 'USD',
          },
        ],
      }).success,
    ).toBe(true);
  });
});
