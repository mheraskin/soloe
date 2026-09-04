import type {
  TerminalHistoryReplayPlan,
  TerminalHistorySnapshot,
  TerminalId,
  TerminalOutputEvent
} from '@shared/types/terminal.js';
import type { SessionId } from '@shared/types/sessions.js';

export const MAX_TERMINAL_PRESENTATION_PENDING_EVENTS = 256;
export const MAX_TERMINAL_PRESENTATION_PENDING_BYTES = 256 * 1024;

export type TerminalPresentationStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; truncated: boolean }
  | { kind: 'recovering' }
  | { kind: 'error'; message: string };

export interface TerminalPresentationReset {
  generation: number;
  data: string;
  replay: TerminalHistoryReplayPlan;
  fromSeq: number;
  toSeq: number;
}

export interface TerminalSessionState {
  terminalId: TerminalId;
  sessionId: SessionId;
  reset: TerminalPresentationReset;
  tail: readonly TerminalOutputEvent[];
  fromSeq: number;
  toSeq: number;
  cols: number;
  rows: number;
  byteLength: number;
  status: TerminalPresentationStatus;
}

export interface TerminalPresentationCursor {
  terminalId: TerminalId | null;
  sessionId: SessionId | null;
  generation: number;
  toSeq: number;
}

export type TerminalPresentationUpdate =
  | { kind: 'reset'; reset: TerminalPresentationReset }
  | { kind: 'append'; event: TerminalOutputEvent }
  | { kind: 'resync' };

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

interface PendingLiveOutput {
  events: TerminalOutputEvent[];
  bytes: number;
  overflowed: boolean;
}

const textEncoder = new TextEncoder();

/** Resolve bounded Session state into work for one independent presentation. */
export function terminalPresentationUpdates(
  state: TerminalSessionState,
  cursor: TerminalPresentationCursor
): TerminalPresentationUpdate[] {
  if (state.status.kind !== 'ready') return [];
  const resetChanged = cursor.terminalId !== state.terminalId
    || cursor.sessionId !== state.sessionId
    || cursor.generation !== state.reset.generation;
  if (!resetChanged && (cursor.toSeq < state.reset.toSeq || cursor.toSeq > state.toSeq)) {
    return [{ kind: 'resync' }];
  }

  let expectedSeq = resetChanged ? state.reset.toSeq : cursor.toSeq;
  const updates: TerminalPresentationUpdate[] = resetChanged
    ? [{ kind: 'reset', reset: state.reset }]
    : [];
  for (const event of state.tail) {
    if (event.seq <= expectedSeq) continue;
    if (event.seq !== expectedSeq + 1) return [{ kind: 'resync' }];
    updates.push({ kind: 'append', event });
    expectedSeq = event.seq;
  }
  if (expectedSeq !== state.toSeq) return [{ kind: 'resync' }];
  return updates;
}

/**
 * Synchronizes Runtime history with every renderer attachment. History is one
 * bounded reset plus a bounded operation tail; Ghostty owns parser/grid state.
 */
export class TerminalHistorySession {
  private readonly attachments = new Set<Attachment>();
  private state: TerminalSessionState;
  private pending: PendingLiveOutput | null = null;
  private resetBytes = 0;
  private tailBytes = 0;
  private unsubscribeOutput: (() => void) | null = null;
  private unsubscribeReconnect: (() => void) | null = null;
  private syncToken = 0;
  private demandActive = false;
  private demandSync: Promise<void> = Promise.resolve();
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
    // Output demand is absent while hidden, so reveal always replaces the
    // presentation reset from Runtime authority before accepting live output.
    if (force || this.state.status.kind !== 'loading') await this.resync();
  }

  private syncDemand(): Promise<void> {
    const active = !this.disposed && this.hasVisibleAttachment();
    if (active === this.demandActive) return this.demandSync;
    this.demandActive = active;
    const applyDemand = async (): Promise<void> => {
      try {
        await this.source.setOutputDemand(this.state.terminalId, active);
      } catch (error) {
        if (active && !this.disposed && this.demandActive === active) this.fail(error);
      }
    };
    this.demandSync = this.demandSync
      .catch(() => undefined)
      .then(applyDemand);
    return this.demandSync;
  }

  async resync(): Promise<void> {
    if (this.disposed || !this.hasVisibleAttachment()) return;
    const token = ++this.syncToken;
    this.pending = { events: [], bytes: 0, overflowed: false };
    this.update({
      status: this.state.status.kind === 'idle' || this.state.status.kind === 'error'
        ? { kind: 'loading' }
        : { kind: 'recovering' }
    });
    try {
      const received = await this.source.historySnapshot(this.state.terminalId);
      if (this.disposed || token !== this.syncToken) return;
      const pending = this.pending ?? { events: [], bytes: 0, overflowed: false };
      this.pending = null;
      if (pending.overflowed) {
        void this.resync();
        return;
      }
      const snapshot = received?.sessionId === this.state.sessionId
        ? received
        : emptySnapshot(this.state.terminalId, this.state.sessionId);
      const unseen = pending.events.filter((event) => (
        event.sessionId === this.state.sessionId && event.seq > snapshot.toSeq
      ));
      let expectedSeq = snapshot.toSeq;
      for (const event of unseen) {
        if (event.seq !== expectedSeq + 1) {
          void this.resync();
          return;
        }
        expectedSeq = event.seq;
      }
      this.applySnapshot(snapshot);
      for (const event of unseen) this.append(event);
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
      this.collectPending(event);
      return;
    }
    if (event.seq <= this.state.toSeq) return;
    if (event.seq !== this.state.toSeq + 1) {
      if (this.hasVisibleAttachment()) void this.resync();
      return;
    }
    this.append(event);
  }

  private collectPending(event: TerminalOutputEvent): void {
    const pending = this.pending;
    if (!pending || pending.overflowed) return;
    const bytes = textEncoder.encode(event.data).byteLength;
    if (
      bytes > MAX_TERMINAL_PRESENTATION_PENDING_BYTES
      || pending.events.length >= MAX_TERMINAL_PRESENTATION_PENDING_EVENTS
      || pending.bytes + bytes > MAX_TERMINAL_PRESENTATION_PENDING_BYTES
    ) {
      pending.events.length = 0;
      pending.bytes = 0;
      pending.overflowed = true;
      return;
    }
    pending.events.push(event);
    pending.bytes += bytes;
  }

  private applySnapshot(snapshot: TerminalHistorySnapshot): void {
    this.resetBytes = snapshot.byteLength;
    this.tailBytes = 0;
    const replay = snapshot.replay ?? {
      cols: snapshot.cols,
      rows: snapshot.rows,
      resizes: []
    };
    this.state = {
      terminalId: snapshot.terminalId,
      sessionId: snapshot.sessionId,
      reset: {
        generation: this.state.reset.generation + 1,
        data: snapshot.data,
        replay,
        fromSeq: snapshot.fromSeq,
        toSeq: snapshot.toSeq
      },
      tail: [],
      fromSeq: snapshot.fromSeq,
      toSeq: snapshot.toSeq,
      cols: snapshot.cols,
      rows: snapshot.rows,
      byteLength: snapshot.byteLength,
      status: { kind: 'ready', truncated: snapshot.truncated }
    };
    this.publish();
  }

  private append(event: TerminalOutputEvent): void {
    const bytes = textEncoder.encode(event.data).byteLength;
    if (bytes > MAX_TERMINAL_PRESENTATION_PENDING_BYTES) {
      if (this.hasVisibleAttachment()) void this.resync();
      return;
    }
    const tail = [...this.state.tail, event];
    let tailBytes = this.tailBytes + bytes;
    let removeCount = 0;
    while (
      tail.length - removeCount > MAX_TERMINAL_PRESENTATION_PENDING_EVENTS
      || tailBytes > MAX_TERMINAL_PRESENTATION_PENDING_BYTES
    ) {
      tailBytes -= textEncoder.encode(tail[removeCount]?.data ?? '').byteLength;
      removeCount += 1;
    }
    this.tailBytes = tailBytes;
    this.state = {
      ...this.state,
      tail: removeCount === 0 ? tail : tail.slice(removeCount),
      toSeq: event.seq,
      byteLength: this.resetBytes + tailBytes
    };
    this.publish();
  }

  private fail(error: unknown): void {
    this.update({
      status: {
        kind: 'error',
        message: error instanceof Error ? error.message : String(error)
      }
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
    void this.syncDemand();
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
    reset: {
      generation: 0,
      data: '',
      replay: { cols: 1, rows: 1, resizes: [] },
      fromSeq: 1,
      toSeq: 0
    },
    tail: [],
    fromSeq: 1,
    toSeq: 0,
    cols: 1,
    rows: 1,
    byteLength: 0,
    status: { kind: 'idle' }
  };
}

function emptySnapshot(
  terminalId: TerminalId,
  sessionId: SessionId
): TerminalHistorySnapshot {
  return {
    kind: 'ghostty-vt-history-v1',
    terminalId,
    sessionId,
    cols: 1,
    rows: 1,
    data: '',
    replay: { cols: 1, rows: 1, resizes: [] },
    fromSeq: 1,
    toSeq: 0,
    truncated: false,
    byteLength: 0
  };
}
