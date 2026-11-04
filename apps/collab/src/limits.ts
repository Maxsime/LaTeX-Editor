import { MAX_DOCUMENT_STATE_BYTES, MAX_TEXT_BYTES, TEXT_KEY } from '@galley/shared';
import * as Y from 'yjs';
import { InvalidUpdate } from './review.js';

/** Sizes a document may not grow beyond through a WebSocket. */
export interface DocumentLimits {
  /** UTF-8 bytes of the visible text. */
  text: number;
  /** Bytes of the encoded Yjs state: what PostgreSQL stores and every client loads. */
  state: number;
}

export const DOCUMENT_LIMITS: DocumentLimits = {
  text: MAX_TEXT_BYTES,
  state: MAX_DOCUMENT_STATE_BYTES,
};

/** Exact sizes of a document; encoding it costs a few milliseconds per megabyte. */
function measure(document: Y.Doc): DocumentLimits {
  return {
    text: Buffer.byteLength(document.getText(TEXT_KEY).toJSON(), 'utf8'),
    state: Y.encodeStateAsUpdate(document).byteLength,
  };
}

/**
 * Keeps the documents edited over WebSocket within {@link DocumentLimits}.
 * Every other way in (upload, import, assistant) checks the size already;
 * without this an editor could grow a document until collab, PostgreSQL and
 * every participant's browser run out of memory.
 *
 * Measuring a document at each keystroke would be too slow, so the guard
 * keeps upper bounds instead: an update cannot add more text or state than
 * its own length (Yjs writes inserted text as UTF-8, without compression).
 * Only an update that may cross a limit is applied to a copy and measured;
 * it is refused if it grows a size beyond its limit, so that a document
 * already too large can still shrink.
 */
export class DocumentSizeGuard {
  private readonly bounds = new Map<string, DocumentLimits>();

  constructor(private readonly limits: DocumentLimits = DOCUMENT_LIMITS) {}

  /** Throws {@link InvalidUpdate} if `update` would make the document too large. */
  check(name: string, document: Y.Doc, update: Uint8Array): void {
    const known = this.bounds.get(name) ?? measure(document);
    this.bounds.set(name, known);
    if (
      known.text + update.byteLength <= this.limits.text &&
      known.state + update.byteLength <= this.limits.state
    ) {
      return;
    }
    const before = measure(document);
    this.bounds.set(name, before);
    const probe = new Y.Doc();
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(document));
    let after: DocumentLimits;
    try {
      Y.applyUpdate(probe, update);
      after = measure(probe);
    } catch {
      throw new InvalidUpdate('malformed');
    } finally {
      probe.destroy();
    }
    if (
      (after.text > this.limits.text && after.text > before.text) ||
      (after.state > this.limits.state && after.state > before.state)
    ) {
      throw new InvalidUpdate('too-large');
    }
  }

  /** Accounts for a change applied to the document, whatever its origin. */
  record(name: string, update: Uint8Array): void {
    const known = this.bounds.get(name);
    if (known === undefined) return;
    known.text += update.byteLength;
    known.state += update.byteLength;
  }

  /** Forgets an unloaded document. */
  forget(name: string): void {
    this.bounds.delete(name);
  }
}
