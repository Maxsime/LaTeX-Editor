import { acceptedText, RANGES_KEY } from '@galley/review';
import { TEXT_KEY } from '@galley/shared';
import * as Y from 'yjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });

/** Encodes a text file as a fresh Yjs document state. */
export function textToState(content: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText(TEXT_KEY).insert(0, content);
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return state;
}

/** Reads the text of a stored Yjs document state. */
export function stateToText(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const content = doc.getText(TEXT_KEY).toJSON();
  doc.destroy();
  return content;
}

/** Reads a stored Yjs document state with every suggestion rejected. */
export function stateToOriginalText(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const content = acceptedText(doc.getText(TEXT_KEY), doc.getMap(RANGES_KEY));
  doc.destroy();
  return content;
}

/** UTF-8 bytes of a text file, as written to disk for export or compilation. */
export function textBytes(content: string): Uint8Array {
  return encoder.encode(content);
}

/** Inverse of {@link textBytes} for bytes already known to be valid UTF-8. */
export function bytesToText(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}
