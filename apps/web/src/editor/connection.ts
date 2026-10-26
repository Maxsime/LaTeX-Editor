import {
  COLLAB_PATH,
  fileDocumentName,
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
  provider: HocuspocusProvider;
  /** Whether the server granted write access; known after authentication. */
  readOnly: boolean;
}

interface Entry {
  document: OpenDocument;
  users: number;
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

  constructor(
    readonly projectId: string,
    /** Read at each event, so the handler can change without reconnecting. */
    private readonly onEvent: { readonly current: (event: ProjectEventMessage) => void },
    private readonly onStatus: (fileId: string, status: SyncStatus) => void,
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
      provider,
      readOnly: false,
    };
    const entry: Entry = { document, users: 1 };
    this.entries.set(fileId, entry);
    provider.on('authenticated', ({ scope }: { scope: string }) => {
      document.readOnly = scope === 'readonly';
      this.report(fileId);
    });
    provider.on('authenticationFailed', () => {
      this.onStatus(fileId, 'denied');
    });
    provider.on('synced', () => {
      this.report(fileId);
    });
    provider.on('unsyncedChanges', () => {
      this.report(fileId);
    });
    provider.attach();
    this.report(fileId);
    return document;
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
    if (!this.online) status = provider.isSynced ? 'offline' : 'connecting';
    else if (!provider.isSynced) status = 'connecting';
    else status = provider.hasUnsyncedChanges ? 'saving' : 'saved';
    this.onStatus(fileId, status);
  }
}
