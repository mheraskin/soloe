import type {
  TerminalHistoryReplayPlan,
  TerminalHistorySnapshot,
  TerminalId,
  TerminalOutputEvent
} from '@shared/types/terminal.js';
import type { SessionId } from '@shared/types/sessions.js';

export interface TerminalSessionState {
  terminalId: TerminalId;
  sessionId: SessionId;
  buffer: string;
  replay: TerminalHistoryReplayPlan;
  fromSeq: number;
  toSeq: number;
  cols: number;
  rows: number;
  truncated: boolean;
  byteLength: number;
  version: number;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
}

export interface TerminalSessionConnection {
  setVisible(visible: boolean): void;
  resync(): Promise<void>;
  dispose(): void;
}

export interface TerminalSessionSource {
  subscribeOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  historySnapshot(terminalId: TerminalId): Promise<TerminalHistorySnapshot | null>;
  setOutputDemand(terminalId: TerminalId, active: boolean): Promise<void>;
  onReconnect?(listener: () => void): () => void;
}

interface Attachment {
  listener: (state: TerminalSessionState) => void;
  visible: boolean;
}

/**
 * One transport/session state machine shared by every Svelte presentation of
 * a terminal. The state is raw VT history; Ghostty owns all parser/grid state.
 */
export class TerminalHistorySession {
  private readonly attachments = new Set<Attachment>();
  private state: TerminalSessionState;
  private pending: TerminalOutputEvent[] | null = null;
  private unsubscribeOutput: (() => void) | null = null;
  private unsubscribeReconnect: (() => void) | null = null;
  private syncToken = 0;
  private demandActive = false;
  private disposed = false;

  constructor(
    terminalId: TerminalId,
    sessionId: SessionId,
    private readonly source: TerminalSessionSource,
    private readonly onEmpty?: () => void
  ) {
    this.state = emptyState(terminalId, sessionId);
  }

  connect(
    listener: (state: TerminalSessionState) => void,
    initiallyVisible: boolean
  ): TerminalSessionConnection {
    if (this.disposed) throw new Error('Terminal history session is disposed');
    const attachment: Attachment = { listener, visible: initiallyVisible };
    this.attachments.add(attachment);
    this.ensureSubscribed();
    listener(this.state);
    if (initiallyVisible) void this.activate();
    let active = true;
    return {
      setVisible: (visible) => {
        if (!active || attachment.visible === visible) return;
        attachment.visible = visible;
        if (visible) void this.activate();
        else void this.syncDemand();
      },
      resync: () => this.resync(),
      dispose: () => {
        if (!active) return;
        active = false;
        this.attachments.delete(attachment);
        void this.syncDemand();
        if (this.attachments.size === 0) this.dispose();
      }
    };
  }

  private ensureSubscribed(): void {
    if (this.unsubscribeOutput) return;
    this.unsubscribeOutput = this.source.subscribeOutput((event) => this.receive(event));
    this.unsubscribeReconnect = this.source.onReconnect?.(() => {
      if (this.hasVisibleAttachment()) void this.activate(true);
    }) ?? null;
  }

  private async activate(force = false): Promise<void> {
    await this.syncDemand();
    if (this.disposed || !this.hasVisibleAttachment()) return;
    if (force || this.state.status === 'idle' || this.state.status === 'error') {
      await this.resync();
      return;
    }
    // Output demand is intentionally absent while hidden, so every reveal
    // takes a fresh authoritative history even if the transport stayed online.
    await this.resync();
  }

  private async syncDemand(): Promise<void> {
    const active = !this.disposed && this.hasVisibleAttachment();
    if (active === this.demandActive) return;
    this.demandActive = active;
    try {
      await this.source.setOutputDemand(this.state.terminalId, active);
    } catch (error) {
      if (active && !this.disposed) this.fail(error);
    }
  }

  async resync(): Promise<void> {
    if (this.disposed || !this.hasVisibleAttachment()) return;
    const token = ++this.syncToken;
    this.pending = [];
    this.update({ status: 'loading', error: null });
    try {
      const snapshot = await this.source.historySnapshot(this.state.terminalId);
      if (this.disposed || token !== this.syncToken) return;
      const pending = this.pending ?? [];
      this.pending = null;
      if (!snapshot || snapshot.sessionId !== this.state.sessionId) {
        this.update({ ...emptyState(this.state.terminalId, this.state.sessionId), status: 'ready' });
        return;
      }
      this.applySnapshot(snapshot);
      let gap = false;
      for (const event of pending) {
        if (event.sessionId !== this.state.sessionId || event.seq <= this.state.toSeq) continue;
        if (event.seq !== this.state.toSeq + 1) {
          gap = true;
          break;
        }
        this.append(event);
      }
      if (gap) void this.resync();
    } catch (error) {
      if (!this.disposed && token === this.syncToken) {
        this.pending = null;
        this.fail(error);
      }
    }
  }

  private receive(event: TerminalOutputEvent): void {
    if (
      this.disposed
      || event.terminalId !== this.state.terminalId
      || event.sessionId !== this.state.sessionId
    ) return;
    if (this.pending) {
      this.pending.push(event);
      return;
    }
    if (event.seq <= this.state.toSeq) return;
    if (event.seq !== this.state.toSeq + 1) {
      if (this.hasVisibleAttachment()) void this.resync();
      return;
    }
    this.append(event);
  }

  private applySnapshot(snapshot: TerminalHistorySnapshot): void {
    this.state = {
      terminalId: snapshot.terminalId,
      sessionId: snapshot.sessionId,
      buffer: snapshot.data,
      replay: snapshot.replay ?? {
        cols: snapshot.cols,
        rows: snapshot.rows,
        resizes: []
      },
      fromSeq: snapshot.fromSeq,
      toSeq: snapshot.toSeq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      truncated: snapshot.truncated,
      byteLength: snapshot.byteLength,
      version: this.state.version + 1,
      status: 'ready',
      error: null
    };
    this.publish();
  }

  private append(event: TerminalOutputEvent): void {
    this.state = {
      ...this.state,
      buffer: `${this.state.buffer}${event.data}`,
      toSeq: event.seq,
      byteLength: this.state.byteLength + new TextEncoder().encode(event.data).byteLength,
      version: this.state.version + 1,
      status: 'ready',
      error: null
    };
    this.publish();
  }

  private fail(error: unknown): void {
    this.update({
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    });
  }

  private update(patch: Partial<TerminalSessionState>): void {
    this.state = { ...this.state, ...patch };
    this.publish();
  }

  private publish(): void {
    for (const attachment of this.attachments) attachment.listener(this.state);
  }

  private hasVisibleAttachment(): boolean {
    return [...this.attachments].some((attachment) => attachment.visible);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.syncToken += 1;
    this.pending = null;
    this.unsubscribeOutput?.();
    this.unsubscribeReconnect?.();
    this.unsubscribeOutput = null;
    this.unsubscribeReconnect = null;
    if (this.demandActive) {
      this.demandActive = false;
      void this.source.setOutputDemand(this.state.terminalId, false).catch(() => undefined);
    }
    this.onEmpty?.();
  }
}

export class TerminalSessionRegistry {
  private readonly sessions = new Map<TerminalId, TerminalHistorySession>();

  constructor(private readonly source: TerminalSessionSource) {}

  connect(
    terminalId: TerminalId,
    sessionId: SessionId,
    listener: (state: TerminalSessionState) => void,
    initiallyVisible: boolean
  ): TerminalSessionConnection {
    let session = this.sessions.get(terminalId);
    if (!session) {
      session = new TerminalHistorySession(terminalId, sessionId, this.source, () => {
        if (this.sessions.get(terminalId) === session) this.sessions.delete(terminalId);
      });
      this.sessions.set(terminalId, session);
    }
    return session.connect(listener, initiallyVisible);
  }
}

function emptyState(terminalId: TerminalId, sessionId: SessionId): TerminalSessionState {
  return {
    terminalId,
    sessionId,
    buffer: '',
    replay: { cols: 1, rows: 1, resizes: [] },
    fromSeq: 1,
    toSeq: 0,
    cols: 1,
    rows: 1,
    truncated: false,
    byteLength: 0,
    version: 0,
    status: 'idle',
    error: null
  };
}
