import type { SessionId } from '@shared/types/sessions.js';
import type {
  TerminalId,
  TerminalOutputEvent,
  TerminalReplaySnapshot
} from '@shared/types/terminal.js';

type OutputSource = (listener: (event: TerminalOutputEvent) => void) => () => void;
type ReplaySource = (
  terminalId: TerminalId,
  afterSeq: number
) => Promise<TerminalReplaySnapshot | null>;
type DemandSource = (terminalId: TerminalId, active: boolean) => Promise<void>;
type ReconnectSource = (listener: () => void) => () => void;

const TRUNCATED_REPLAY_PREFIX =
  '\r\n\x1b[33m[Earlier terminal output omitted to bound memory]\r\n'
  + '[Output omitted before complete history was enabled cannot be restored.]\x1b[0m\r\n';

interface PendingBatch {
  data: string;
  fromSeq: number;
  toSeq: number;
}

export interface TerminalPresentationSink {
  write(data: string): void | Promise<void>;
  replace(data: string): void | Promise<void>;
}

export interface TerminalPresentation {
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface PresentationState {
  terminalId: TerminalId;
  sessionId: SessionId;
  sink: TerminalPresentationSink;
  visible: boolean;
  active: boolean;
  appliedSeq: number;
  coveredSeq: number;
  pending: PendingBatch[];
  writing: boolean;
  writeRevision: number;
  writeToSeq: number;
  writeWasRecovery: boolean;
  recovering: boolean;
  replayRequired: boolean;
  replaying: boolean;
  replayRevision: number;
  highestObservedSeq: number;
}

interface OutputDemandState {
  owners: number;
  acknowledged: boolean;
  syncing: Promise<void> | null;
}

/**
 * Owns the output lifecycle of resident Terminal Presentations.
 *
 * Hidden presentations are dormant: no xterm parsing and no retained output
 * strings. Reveal resumes from the last sequence whose xterm callback
 * completed. During replay only a sequence watermark is retained; live bytes
 * are recovered from the bounded Terminal Replay Tail, keeping overlap memory
 * bounded even if IPC or xterm is slow.
 */
export class TerminalOutputRouter {
  private readonly presentations = new Map<TerminalId, Set<PresentationState>>();
  private readonly demandByTerminal = new Map<TerminalId, OutputDemandState>();
  private sourceDetach: (() => void) | null = null;
  private reconnectDetach: (() => void) | null = null;
  private visibleCount = 0;

  constructor(
    private readonly source: OutputSource,
    private readonly replaySource?: ReplaySource,
    private readonly demandSource?: DemandSource,
    private readonly reconnectSource?: ReconnectSource
  ) {}

  attach(
    terminalId: TerminalId,
    sessionId: SessionId,
    sink: TerminalPresentationSink,
    initiallyVisible: boolean
  ): TerminalPresentation {
    const state: PresentationState = {
      terminalId,
      sessionId,
      sink,
      visible: initiallyVisible,
      active: true,
      appliedSeq: 0,
      coveredSeq: 0,
      pending: [],
      writing: false,
      writeRevision: 0,
      writeToSeq: 0,
      writeWasRecovery: false,
      recovering: false,
      replayRequired: false,
      replaying: false,
      replayRevision: 0,
      highestObservedSeq: 0
    };
    const group = this.presentations.get(terminalId) ?? new Set<PresentationState>();
    group.add(state);
    this.presentations.set(terminalId, group);

    if (initiallyVisible) {
      this.visibleCount += 1;
      this.beginRecovery(state);
    }

    return {
      setVisible: (visible) => this.setVisible(state, visible),
      dispose: () => this.dispose(state)
    };
  }

  private setVisible(state: PresentationState, visible: boolean): void {
    if (!state.active || state.visible === visible) return;
    state.visible = visible;
    if (!visible) {
      this.visibleCount = Math.max(0, this.visibleCount - 1);
      state.pending.length = 0;
      state.coveredSeq = state.writing ? state.writeToSeq : state.appliedSeq;
      state.recovering = false;
      state.replayRequired = false;
      state.replaying = false;
      state.replayRevision += 1;
      state.highestObservedSeq = state.appliedSeq;
      this.releaseDemand(state.terminalId);
      if (this.visibleCount === 0) this.detachSource();
      return;
    }

    this.visibleCount += 1;
    this.beginRecovery(state);
  }

  private dispose(state: PresentationState): void {
    if (!state.active) return;
    state.active = false;
    if (state.visible) {
      this.visibleCount = Math.max(0, this.visibleCount - 1);
      this.releaseDemand(state.terminalId);
    }
    state.pending.length = 0;
    state.replaying = false;
    state.replayRevision += 1;
    state.writeRevision += 1;
    const group = this.presentations.get(state.terminalId);
    group?.delete(state);
    if (group?.size === 0) this.presentations.delete(state.terminalId);
    if (this.visibleCount === 0) this.detachSource();
  }

  private ensureSource(): void {
    this.sourceDetach ??= this.source((event) => this.route(event));
    this.reconnectDetach ??= this.reconnectSource?.(() => this.recoverAfterReconnect()) ?? null;
  }

  private detachSource(): void {
    this.sourceDetach?.();
    this.sourceDetach = null;
    this.reconnectDetach?.();
    this.reconnectDetach = null;
  }

  private recoverAfterReconnect(): void {
    for (const group of this.presentations.values()) {
      for (const state of group) {
        if (!state.active || !state.visible) continue;
        state.pending.length = 0;
        state.coveredSeq = state.writing ? state.writeToSeq : state.appliedSeq;
        state.recovering = true;
        state.replayRequired = true;
        state.highestObservedSeq = state.appliedSeq;
        if (!state.writing) this.requestReplay(state);
      }
    }
  }

  private route(event: TerminalOutputEvent): void {
    const group = this.presentations.get(event.terminalId);
    if (!group) return;
    for (const state of group) {
      if (!state.active || !state.visible || event.sessionId !== state.sessionId) continue;
      if (state.recovering) {
        state.highestObservedSeq = Math.max(state.highestObservedSeq, event.seq);
        continue;
      }
      if (event.seq <= state.coveredSeq) continue;
      if (event.seq !== state.coveredSeq + 1) {
        console.warn('terminal output sequence gap; recovering from replay', {
          terminalId: event.terminalId,
          expected: state.coveredSeq + 1,
          got: event.seq
        });
        state.pending.length = 0;
        state.coveredSeq = state.writing ? state.writeToSeq : state.appliedSeq;
        state.recovering = true;
        state.replayRequired = true;
        state.highestObservedSeq = event.seq;
        if (!state.writing) this.requestReplay(state);
        continue;
      }
      state.pending.push({ data: event.data, fromSeq: event.seq, toSeq: event.seq });
      state.coveredSeq = event.seq;
      this.startPendingWrite(state);
    }
  }

  private beginRecovery(state: PresentationState): void {
    if (!state.active || !state.visible) return;
    state.recovering = true;
    state.replayRequired = true;
    state.highestObservedSeq = state.appliedSeq;
    this.ensureSource();
    const visibilityRevision = state.replayRevision;
    const demandReady = this.acquireDemand(state.terminalId);
    if (!this.demandSource) {
      if (!state.writing) this.requestReplay(state);
      return;
    }
    void demandReady.then(() => {
      if (
        !state.active ||
        !state.visible ||
        state.replayRevision !== visibilityRevision
      ) return;
      if (!state.writing) this.requestReplay(state);
    });
  }

  /**
   * Converts visible Presentation ownership into one main-process transport
   * lease per terminal. The acknowledgement precedes replay so output emitted
   * during recovery is either observed live or covered by the replay watermark.
   */
  private acquireDemand(terminalId: TerminalId): Promise<void> {
    const demand = this.demandByTerminal.get(terminalId) ?? {
      owners: 0,
      acknowledged: false,
      syncing: null
    };
    demand.owners += 1;
    this.demandByTerminal.set(terminalId, demand);
    return this.reconcileDemand(terminalId, demand);
  }

  private releaseDemand(terminalId: TerminalId): void {
    const demand = this.demandByTerminal.get(terminalId);
    if (!demand) return;
    demand.owners = Math.max(0, demand.owners - 1);
    void this.reconcileDemand(terminalId, demand);
  }

  private reconcileDemand(
    terminalId: TerminalId,
    demand: OutputDemandState
  ): Promise<void> {
    if (!this.demandSource) {
      demand.acknowledged = demand.owners > 0;
      if (demand.owners === 0) this.demandByTerminal.delete(terminalId);
      return Promise.resolve();
    }
    if (demand.syncing) return demand.syncing;

    const sync = async () => {
      while (demand.acknowledged !== (demand.owners > 0)) {
        const desired = demand.owners > 0;
        try {
          await this.demandSource!(terminalId, desired);
        } catch {
          // Replay still provides a bounded best-effort presentation if the
          // transport Adapter is unavailable. A later visibility transition
          // retries the authoritative demand state.
        }
        demand.acknowledged = desired;
      }
    };
    demand.syncing = sync().finally(() => {
      demand.syncing = null;
      if (demand.acknowledged !== (demand.owners > 0)) {
        void this.reconcileDemand(terminalId, demand);
      } else if (demand.owners === 0 && !demand.acknowledged) {
        this.demandByTerminal.delete(terminalId);
      }
    });
    return demand.syncing;
  }

  private requestReplay(state: PresentationState): void {
    if (
      !state.active ||
      !state.visible ||
      !state.recovering ||
      !state.replayRequired ||
      state.writing ||
      state.replaying
    ) return;
    const load = this.replaySource;
    if (!load) {
      this.finishRecovery(state);
      return;
    }

    state.replaying = true;
    state.replayRequired = false;
    const revision = ++state.replayRevision;
    let request: Promise<TerminalReplaySnapshot | null>;
    try {
      request = load(state.terminalId, state.appliedSeq);
    } catch {
      this.completeReplay(state, revision, null);
      return;
    }
    void request.then(
      (snapshot) => this.completeReplay(state, revision, snapshot),
      () => this.completeReplay(state, revision, null)
    );
  }

  private completeReplay(
    state: PresentationState,
    revision: number,
    candidate: TerminalReplaySnapshot | null
  ): void {
    if (
      !state.active ||
      !state.visible ||
      !state.recovering ||
      !state.replaying ||
      state.replayRevision !== revision
    ) return;
    state.replaying = false;
    const snapshot =
      candidate?.terminalId === state.terminalId &&
      candidate.sessionId === state.sessionId &&
      candidate.toSeq >= state.appliedSeq &&
      (candidate.truncated || candidate.fromSeq <= state.appliedSeq + 1)
        ? candidate
        : null;
    if (!snapshot) {
      this.finishRecovery(state);
      return;
    }

    if (!snapshot.data && !snapshot.truncated) {
      state.appliedSeq = snapshot.toSeq;
      state.coveredSeq = snapshot.toSeq;
      this.continueRecovery(state);
      return;
    }

    this.startWrite(
      state,
      {
        data: `${snapshot.truncated ? TRUNCATED_REPLAY_PREFIX : ''}${snapshot.data}`,
        fromSeq: snapshot.fromSeq,
        toSeq: snapshot.toSeq
      },
      true,
      snapshot.truncated
    );
  }

  private continueRecovery(state: PresentationState): void {
    if (!state.active || !state.visible) {
      state.recovering = false;
      state.replayRequired = false;
      return;
    }
    if (state.highestObservedSeq > state.appliedSeq) state.replayRequired = true;
    if (state.replayRequired) {
      this.requestReplay(state);
      return;
    }
    this.finishRecovery(state);
  }

  private finishRecovery(state: PresentationState): void {
    state.recovering = false;
    state.replayRequired = false;
    state.highestObservedSeq = state.appliedSeq;
    state.coveredSeq = state.appliedSeq;
    this.startPendingWrite(state);
  }

  private startPendingWrite(state: PresentationState): void {
    if (
      !state.active ||
      !state.visible ||
      state.recovering ||
      state.writing ||
      state.pending.length === 0
    ) return;
    const batches = state.pending;
    state.pending = [];
    this.startWrite(
      state,
      {
        data: batches.map((batch) => batch.data).join(''),
        fromSeq: batches[0]?.fromSeq ?? state.appliedSeq + 1,
        toSeq: batches[batches.length - 1]?.toSeq ?? state.appliedSeq
      },
      false,
      false
    );
  }

  private startWrite(
    state: PresentationState,
    batch: PendingBatch,
    recovery: boolean,
    replace: boolean
  ): void {
    state.writing = true;
    state.writeToSeq = batch.toSeq;
    state.writeWasRecovery = recovery;
    const revision = ++state.writeRevision;
    let completion: void | Promise<void>;
    try {
      completion = replace ? state.sink.replace(batch.data) : state.sink.write(batch.data);
    } catch {
      this.finishWrite(state, revision, false);
      return;
    }
    if (completion) {
      void completion.then(
        () => this.finishWrite(state, revision, true),
        () => this.finishWrite(state, revision, false)
      );
    } else {
      this.finishWrite(state, revision, true);
    }
  }

  private finishWrite(state: PresentationState, revision: number, succeeded: boolean): void {
    if (!state.active || state.writeRevision !== revision) return;
    const wasRecovery = state.writeWasRecovery;
    state.writing = false;
    if (succeeded) {
      state.appliedSeq = Math.max(state.appliedSeq, state.writeToSeq);
    } else {
      state.pending.length = 0;
      state.coveredSeq = state.appliedSeq;
      if (state.visible) {
        state.recovering = true;
        state.replayRequired = true;
      }
    }

    if (!state.visible) return;
    if (state.recovering || wasRecovery) {
      this.continueRecovery(state);
      return;
    }
    this.startPendingWrite(state);
  }
}
