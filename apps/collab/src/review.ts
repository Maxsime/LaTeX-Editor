import { acceptedText, RANGES_KEY } from '@galley/review';
import { INVALID_UPDATE_REASON, TEXT_KEY } from '@galley/shared';
import * as Y from 'yjs';

/**
 * Update refused from a reviewer. Hocuspocus closes the document's connection
 * and passes `reason` on to the client, which then drops its copy and loads
 * the document again.
 */
export class InvalidUpdate extends Error {
  readonly code = 4422;
  readonly reason = INVALID_UPDATE_REASON;

  constructor(readonly detail: string) {
    super(`invalid update: ${detail}`);
    this.name = 'InvalidUpdate';
  }
}

const ROOTS = new Set([TEXT_KEY, RANGES_KEY]);

/** Changes a document holds back until the history they build on arrives, as one comparable string. */
function pendingOf(doc: Y.Doc): string {
  const { pendingStructs, pendingDs } = doc.store;
  return [pendingStructs?.update, pendingDs]
    .map((bytes) => (bytes ? Buffer.from(bytes).toString('base64') : ''))
    .join('/');
}

function authorOf(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'author' in value
    ? value.author
    : undefined;
}

/**
 * Checks what a reviewer sends before it reaches the document: the update may
 * change the visible text, but not the accepted text, and may only touch the
 * reviewer's own suggestions and comment anchors. Anything else would let a
 * reviewer edit the project in all but name.
 *
 * Applies the update to a copy, so a refused update leaves no trace.
 */
export function checkReviewerUpdate(document: Y.Doc, update: Uint8Array, userId: string): void {
  const probe = new Y.Doc();
  Y.applyUpdate(probe, Y.encodeStateAsUpdate(document));
  const pending = pendingOf(probe);
  let text: Y.Text;
  let ranges: Y.Map<unknown>;
  try {
    text = probe.getText(TEXT_KEY);
    ranges = probe.getMap<unknown>(RANGES_KEY);
  } catch {
    // A root of another type: the document was not written by Galley.
    throw new InvalidUpdate('root');
  }
  const before = acceptedText(text, ranges);
  const entries = new Map([...ranges.entries()].map(([id, value]) => [id, JSON.stringify(value)]));
  const attributes = text._map.size;

  try {
    Y.applyUpdate(probe, update);
  } catch {
    throw new InvalidUpdate('malformed');
  }
  for (const name of probe.share.keys()) {
    if (!ROOTS.has(name)) throw new InvalidUpdate('root');
  }
  // Changes waiting for missing history would be applied, unchecked, by
  // whichever later update completes them; a client in sync never sends any.
  if (pendingOf(probe) !== pending) {
    throw new InvalidUpdate('incomplete');
  }
  if (text._map.size !== attributes) throw new InvalidUpdate('attributes');
  if (acceptedText(text, ranges) !== before) throw new InvalidUpdate('accepted-text');

  const ids = new Set([...entries.keys(), ...ranges.keys()]);
  for (const id of ids) {
    const previous = entries.get(id);
    const next = ranges.get(id);
    if (previous === JSON.stringify(next)) continue;
    // Only one's own entries: before the change, after it, or both.
    if (previous !== undefined && authorOf(JSON.parse(previous)) !== userId) {
      throw new InvalidUpdate('foreign-entry');
    }
    if (next !== undefined && authorOf(next) !== userId) {
      throw new InvalidUpdate('foreign-entry');
    }
  }
}
