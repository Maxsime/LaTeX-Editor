/**
 * After an upgrade, a tab opened on the previous version asks for chunks whose hashed
 * names no longer exist. The fix is a reload, done once automatically; a second failure
 * within the window is a real outage and is left to the error page.
 */

const RELOAD_KEY = 'galley.staleChunkReload';
/** Two automatic reloads closer than this would loop on a server that is down. */
export const STALE_RELOAD_WINDOW_MS = 30_000;

const STALE_CHUNK_MESSAGES = [
  // Chromium, Firefox and Safari, in that order.
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
  // Vite's preload helper, for the style sheets of a chunk.
  'Unable to preload CSS',
];

/** Tells whether an error comes from loading a chunk of the application. */
export function isStaleChunkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return STALE_CHUNK_MESSAGES.some((message) => error.message.includes(message));
}

/** The parts of the browser that {@link reloadForStaleChunk} uses, replaced in tests. */
export interface ReloadEnvironment {
  storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  now: () => number;
  reload: () => void;
}

/** Reloads the page unless it already did so recently; returns whether it reloaded. */
export function reloadForStaleChunk(environment: ReloadEnvironment): boolean {
  const { storage, now, reload } = environment;
  // Without storage the guard cannot work: never reload automatically then.
  if (storage === null) return false;
  const time = now();
  try {
    const stored = storage.getItem(RELOAD_KEY);
    const last = stored === null ? Number.NaN : Number(stored);
    if (Number.isFinite(last) && time - last < STALE_RELOAD_WINDOW_MS) return false;
    storage.setItem(RELOAD_KEY, String(time));
  } catch {
    // Storage blocked (private browsing, policy): same reasoning as above.
    return false;
  }
  reload();
  return true;
}

/** The browser's own environment for {@link reloadForStaleChunk}. */
export function browserReloadEnvironment(): ReloadEnvironment {
  let storage: Storage | null;
  try {
    storage = window.sessionStorage;
  } catch {
    // Reading sessionStorage throws when the browser blocks site data.
    storage = null;
  }
  return {
    storage,
    now: Date.now,
    reload: () => {
      window.location.reload();
    },
  };
}
