import type { AiChangeset } from '@galley/shared';
import { describe, expect, it } from 'vitest';
import { type AiMessage, applyEvent, historyFor, pendingHunksOf } from './ai.js';

const answer = (patch: Partial<AiMessage> = {}): AiMessage => ({
  id: 'a',
  role: 'assistant',
  mode: 'chat',
  text: '',
  tools: [],
  changesetIds: [],
  snippet: null,
  plan: null,
  usage: null,
  error: null,
  done: false,
  ...patch,
});

describe('applyEvent', () => {
  it('appends text and replaces a running tool by its outcome', () => {
    let message = answer();
    message = applyEvent(message, { type: 'text', delta: 'Je ' });
    message = applyEvent(message, {
      type: 'tool',
      name: 'read_file',
      status: 'running',
      detail: 'main.tex',
    });
    message = applyEvent(message, { type: 'tool', name: 'read_file', status: 'done' });
    message = applyEvent(message, { type: 'text', delta: 'lis.' });
    expect(message.text).toBe('Je lis.');
    expect(message.tools).toEqual([{ name: 'read_file', status: 'done', detail: 'main.tex' }]);
  });

  it('keeps the latest plan of the agent', () => {
    let message = answer({ mode: 'agent' });
    message = applyEvent(message, {
      type: 'plan',
      steps: [{ title: 'Lire', status: 'active' }],
    });
    message = applyEvent(message, {
      type: 'plan',
      steps: [
        { title: 'Lire', status: 'done' },
        { title: 'Modifier', status: 'active' },
      ],
    });
    expect(message.plan).toEqual([
      { title: 'Lire', status: 'done' },
      { title: 'Modifier', status: 'active' },
    ]);
  });

  it('records changesets, errors, usage and the end', () => {
    let message = answer();
    message = applyEvent(message, { type: 'changeset', changeset: { id: 'c1', hunks: [] } });
    message = applyEvent(message, { type: 'error', code: 'AI_RATE_LIMITED' });
    message = applyEvent(message, {
      type: 'usage',
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cachedInputTokens: 0,
        costMicros: null,
        currency: null,
      },
    });
    message = applyEvent(message, { type: 'done' });
    expect(message).toMatchObject({
      changesetIds: ['c1'],
      error: 'AI_RATE_LIMITED',
      usage: { outputTokens: 2 },
      done: true,
    });
  });
});

describe('historyFor', () => {
  it('sends chat, fix and agent exchanges, not inline edits nor unfinished answers', () => {
    const messages: AiMessage[] = [
      answer({ id: '1', role: 'user', text: 'Q1', done: true }),
      answer({ id: '2', text: 'R1', done: true }),
      answer({ id: '3', role: 'user', mode: 'inline', text: 'shorter', done: true }),
      answer({ id: '4', mode: 'inline', text: '```latex\nx\n```', done: true }),
      answer({ id: '5', role: 'user', mode: 'fix', text: 'Fix', done: true }),
      answer({ id: '6', mode: 'fix', text: '', done: true, error: 'AI_UNAVAILABLE' }),
      answer({ id: '7', role: 'user', mode: 'agent', text: 'Tâche', done: true }),
      answer({ id: '8', mode: 'agent', text: 'Fait.', done: true }),
    ];
    expect(historyFor(messages, 'Q2')).toEqual([
      { role: 'user', text: 'Q1' },
      { role: 'assistant', text: 'R1' },
      { role: 'user', text: 'Fix' },
      { role: 'user', text: 'Tâche' },
      { role: 'assistant', text: 'Fait.' },
      { role: 'user', text: 'Q2' },
    ]);
  });
});

describe('pendingHunksOf', () => {
  it('keeps the pending hunks of one file, with their changeset', () => {
    const hunk = {
      path: 'main.tex',
      start: 0,
      original: 'a',
      replacement: 'b',
      before: '',
      after: '',
    };
    const changesets: Record<string, AiChangeset> = {
      c1: {
        id: 'c1',
        hunks: [
          { ...hunk, id: 'h1', fileId: 'f1', status: 'pending' },
          { ...hunk, id: 'h2', fileId: 'f1', status: 'applied' },
          { ...hunk, id: 'h3', fileId: 'f2', status: 'pending' },
        ],
      },
    };
    expect(pendingHunksOf(changesets, 'f1').map((item) => [item.changesetId, item.id])).toEqual([
      ['c1', 'h1'],
    ]);
  });
});
