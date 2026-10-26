import { describe, expect, it } from 'vitest';
import {
  fileDocumentName,
  parseDocumentName,
  projectDocumentName,
  projectEventMessage,
} from './collab.js';

const id = '0b8e4c1e-8f0a-4d2b-9c51-3f1f8f0f6a10';

describe('document names', () => {
  it('round-trips file and project names', () => {
    expect(parseDocumentName(fileDocumentName(id))).toEqual({ kind: 'file', id });
    expect(parseDocumentName(projectDocumentName(id))).toEqual({ kind: 'project', id });
  });

  it('rejects anything else', () => {
    for (const name of ['', id, `user:${id}`, 'file:', `file:${id}x`, `file:${id.toUpperCase()}`]) {
      expect(parseDocumentName(name)).toBeNull();
    }
  });
});

describe('projectEventMessage', () => {
  it('accepts known events and rejects the rest', () => {
    expect(projectEventMessage.safeParse({ type: 'tree.changed', projectId: id }).success).toBe(
      true,
    );
    expect(projectEventMessage.safeParse({ type: 'tree.changed' }).success).toBe(false);
    expect(projectEventMessage.safeParse({ type: 'shell', projectId: id }).success).toBe(false);
  });
});
