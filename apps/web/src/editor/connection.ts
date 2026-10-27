import { RANGES_KEY } from '@galley/review';
import {
  COLLAB_PATH,
  fileDocumentName,
  INVALID_UPDATE_REASON,
  type PresenceUser,
  projectDocumentName,
  projectEventMessage,
  type ProjectEventMessage,
  TEXT_KEY,
} from '@galley/shared';
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
  WebSocketStatus,
} from '@hocuspocus/provider';
import * as Y from 'yjs';
import { type Participant, participantsOf } from '../lib/presence.js';

/**
 * Synchronisation state of one open document, as shown on its tab:
 * `connecting` until the first sync, `saved` when the server holds every
 * local change, `saving` while changes are in flight, `offline` when the
 * connection is down (edits are kept and sent on reconnection), `denied`
 * when the server refused the document.
 */
export type SyncStatus = 'connecting' | 'saved' | 'saving' | 'offline' | 'denied';

/** A document opened on the shared connection. */
export interface OpenDocument {
  fileId: string;
  doc: Y.Doc;
  text: Y.Text;
  /** Suggestions and comment anchors of the text (`@galley/review`). */
  ranges: Y.Map<unknown>;
  provider: HocuspocusProvider;
  /** Whether the server granted write access; known after authentication. */
  readOnly: boolean;
}

interface Entry {
  document: OpenDocument;
  users: number;
  /** Whether the content arrived once; the provider forgets it at each disconnection. */
  loaded: boolean;
}

/** WebSocket URL of collab, behind the same origin as the application. */
export function collabUrl(location: Pick<Location, 'protocol' | 'host'>): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${COLLAB_PATH}`;
}

/**
 * One WebSocket per open project, multiplexing the project's event channel
 * and every document open in a tab. Documents are reference-counted so that
 * a file shown twice shares one Y.Doc.
 */
export class ProjectConnection {
  private readonly socket: HocuspocusProviderWebsocket;
  private readonly events: HocuspocusProvider;
  private readonly entries = new Map<string, Entry>();
  private online = false;
  private user: PresenceUser | null = null;

  constructor(
    readonly projectId: string,
    /** Read at each event, so the handler can change without reconnecting. */
    private readonly onEvent: { readonly current: (event: ProjectEventMessage) => void },
    private readonly onStatus: (fileId: string, status: SyncStatus) => void,
    private readonly onPresence: (participants: Participant[]) => void = () => undefined,
    /**
     * The server refused an update of this document and it was loaded again:
     * editors showing it must rebind to the new copy.
     */
    private readonly onReload: (fileId: string) => void = () => undefined,
  ) {
    // Nothing touches the network before start(), so React may build this during render.
    this.socket = new HocuspocusProviderWebsocket({
      url: collabUrl(window.location),
      autoConnect: false,
    });
    this.socket.on('status', ({ status }: { status: WebSocketStatus }) => {
      this.online = status === WebSocketStatus.Connected;
      for (const fileId of this.entries.keys()) this.report(fileId);
    });
    this.events = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: projectDocumentName(projectId),
      onStateless: ({ payload }) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }
        const result = projectEventMessage.safeParse(parsed);
        if (result.success) this.onEvent.current(result.data);
      },
    });
    this.events.awareness?.on('change', () => {
      const states = this.events.awareness?.getStates() ?? new Map();
      this.onPresence(participantsOf(states, this.user?.id ?? null));
    });
  }

  /**
   * Announces who this tab belongs to, for cursors and the list of people
   * present. collab replaces it with the session's identity anyway.
   */
  setUser(user: PresenceUser): void {
    this.user = user;
    this.events.setAwarenessField('user', user);
    for (const entry of this.entries.values()) {
      entry.document.provider.setAwarenessField('user', user);
    }
  }

  /**
   * Called when collab refuses the project channel, typically after losing
   * access while disconnected, when the event saying so could not arrive.
   * Returns a function that removes the listener.
   */
  onChannelDenied(listener: () => void): () => void {
    this.events.on('authenticationFailed', listener);
    return () => {
      this.events.off('authenticationFailed', listener);
    };
  }

  /** Tells the other participants which file this tab shows. */
  setActiveFile(fileId: string | null): void {
    this.events.setAwarenessField('fileId', fileId);
  }

  /** Connects and joins the project's event channel. Safe to call after {@link stop}. */
  start(): void {
    this.events.attach();
    void this.socket.connect();
  }

  /** Disconnects; open documents keep their content and resync on the next start. */
  stop(): void {
    this.events.detach();
    this.socket.disconnect();
  }

  /** Opens a text file, or returns the already open document. Pair with {@link release}. */
  open(fileId: string): OpenDocument {
    const existing = this.entries.get(fileId);
    if (existing) {
      existing.users += 1;
      return existing.document;
    }
    const entry: Entry = { document: this.connectDocument(fileId), users: 1, loaded: false };
    this.entries.set(fileId, entry);
    this.report(fileId);
    return entry.document;
  }

  /** The open document of a file, if a tab shows it. */
  document(fileId: string): OpenDocument | undefined {
    return this.entries.get(fileId)?.document;
  }

  private connectDocument(fileId: string): OpenDocument {
    const doc = new Y.Doc();
    const provider = new HocuspocusProvider({
      websocketProvider: this.socket,
      name: fileDocumentName(fileId),
      document: doc,
    });
    const document: OpenDocument = {
      fileId,
      doc,
      text: doc.getText(TEXT_KEY),
      ranges: doc.getMap(RANGES_KEY),
      provider,
      readOnly: false,
    };
    if (this.user !== null) provider.setAwarenessField('user', this.user);
    const current = () => this.entries.get(fileId)?.document === document;
    provider.on('authenticated', ({ scope }: { scope: string }) => {
      document.readOnly = scope === 'readonly';
      if (current()) this.report(fileId);
    });
    provider.on('authenticationFailed', () => {
      if (current()) this.onStatus(fileId, 'denied');
    });
    provider.on('synced', () => {
      const entry = this.entries.get(fileId);
      if (entry?.document !== document) return;
      entry.loaded = true;
      this.report(fileId);
    });
    provider.on('unsyncedChanges', () => {
      if (current()) this.report(fileId);
    });
    provider.on('close', ({ event }: { event: { reason?: string } }) => {
      if (event.reason === INVALID_UPDATE_REASON && current()) this.reload(fileId);
    });
    provider.attach();
    return document;
  }

  /**
   * Replaces a document the server refused an update of: the local copy holds
   * a change the server will never accept, so it is dropped, and the content
   * is fetched again.
   */
  private reload(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    const stale = entry.document;
    entry.document = this.connectDocument(fileId);
    entry.loaded = false;
    stale.provider.destroy();
    stale.doc.destroy();
    this.report(fileId);
    this.onReload(fileId);
  }

  /** Drops one use of a document; the last one disconnects it. */
  release(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    entry.users -= 1;
    if (entry.users > 0) return;
    this.entries.delete(fileId);
    entry.document.provider.destroy();
    entry.document.doc.destroy();
  }

  /** Whether the server opened this document read-only. */
  isReadOnly(fileId: string): boolean {
    return this.entries.get(fileId)?.document.readOnly ?? false;
  }

  /** Whether some open document still has changes the server has not acknowledged. */
  hasPendingChanges(): boolean {
    return [...this.entries.values()].some((entry) => entry.document.provider.hasUnsyncedChanges);
  }

  private report(fileId: string): void {
    const entry = this.entries.get(fileId);
    if (!entry) return;
    const { provider } = entry.document;
    let status: SyncStatus;
    if (!entry.loaded) status = 'connecting';
    else if (!this.online) status = 'offline';
    // After a reconnection the content is already here: it is being saved again.
    else if (!provider.isSynced || provider.hasUnsyncedChanges) status = 'saving';
    else status = 'saved';
    this.onStatus(fileId, status);
  }
}
