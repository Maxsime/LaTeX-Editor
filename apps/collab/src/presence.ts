/** Largest presence state relayed, as JSON: a cursor and a selection take a few hundred bytes. */
export const MAX_PRESENCE_STATE_BYTES = 16 * 1024;

/** Most presence entries one connection may hold in a document; a client announces one. */
export const MAX_PRESENCE_CLIENTS = 4;

/**
 * Filters the presence (Yjs awareness) entries a connection sends, in place.
 * Presence is relayed to every participant and kept in memory, and entries
 * are keyed by a client id the sender chooses, so a connection could
 * otherwise flood the others with large states, or move and remove the
 * cursors of other participants by reusing their ids.
 *
 * `owners` maps each client id of the document to the connection that first
 * announced it. Ids of connections that have gone (`connected` returns false)
 * are released first: a client that reconnects announces its id again.
 */
export function filterPresence<C>(
  owners: Map<number, C>,
  connection: C,
  connected: (owner: C) => boolean,
  states: Map<number, Record<string, unknown>>,
  removed: Set<number>,
): void {
  let held = 0;
  for (const [clientId, owner] of owners) {
    if (owner === connection) held += 1;
    else if (!connected(owner)) owners.delete(clientId);
  }

  const allowed = (clientId: number): boolean => {
    const owner = owners.get(clientId);
    if (owner === connection) return true;
    if (owner !== undefined || held >= MAX_PRESENCE_CLIENTS) return false;
    owners.set(clientId, connection);
    held += 1;
    return true;
  };

  for (const [clientId, state] of states) {
    const size = Buffer.byteLength(JSON.stringify(state), 'utf8');
    if (size > MAX_PRESENCE_STATE_BYTES || !allowed(clientId)) states.delete(clientId);
  }
  for (const clientId of removed) {
    if (!allowed(clientId)) removed.delete(clientId);
  }
}
