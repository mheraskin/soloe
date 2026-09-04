import { Buffer } from 'node:buffer';
import {
  MAX_RUNTIME_HISTORY_BYTES_PER_TERMINAL,
  MAX_RUNTIME_HISTORY_LINE_LIMIT,
  type RuntimeHistorySnapshot
} from '@soloe/protocol';

export interface TerminalHistoryRecoverySource {
  historySnapshot(terminalId: string): Promise<RuntimeHistorySnapshot | null>;
  setHistoryLineLimit?(lineLimit: number): Promise<unknown> | unknown;
}

export interface TerminalHistoryRecoveryOptions {
  terminalId: string;
  lineLimit: number;
  source: TerminalHistoryRecoverySource;
  log?: (message: string, detail: Record<string, unknown>) => void;
}

export async function restoreTerminalHistory(
  options: TerminalHistoryRecoveryOptions
): Promise<RuntimeHistorySnapshot | null> {
  await applyLineLimit(options);
  let snapshot = await options.source.historySnapshot(options.terminalId);
  if (!snapshot || terminalReplayFitsTransport(snapshot)) return snapshot;

  options.log?.('retrying oversized replay after retention repair', replayDetail(snapshot));
  await applyLineLimit(options);
  try {
    const retried = await options.source.historySnapshot(options.terminalId);
    if (!retried || terminalReplayFitsTransport(retried)) return retried;
    snapshot = retried;
  } catch (error) {
    options.log?.('stale Runtime failed the repaired replay request', {
      terminalId: options.terminalId,
      error
    });
  }

  options.log?.('discarded oversized replay while preserving the PTY', replayDetail(snapshot));
  return discardTerminalReplay(snapshot);
}

async function applyLineLimit(options: TerminalHistoryRecoveryOptions): Promise<void> {
  try {
    await options.source.setHistoryLineLimit?.(options.lineLimit);
  } catch (error) {
    options.log?.('stale Runtime rejected replay retention before restore', {
      terminalId: options.terminalId,
      error
    });
  }
}

function terminalReplayFitsTransport(snapshot: RuntimeHistorySnapshot): boolean {
  return Buffer.byteLength(snapshot.data, 'utf8')
    <= MAX_RUNTIME_HISTORY_BYTES_PER_TERMINAL
    && (snapshot.replay?.resizes.length ?? 0) <= MAX_RUNTIME_HISTORY_LINE_LIMIT;
}

function replayDetail(snapshot: RuntimeHistorySnapshot): Record<string, unknown> {
  return {
    terminalId: snapshot.terminalId,
    byteLength: Buffer.byteLength(snapshot.data, 'utf8'),
    resizeCount: snapshot.replay?.resizes.length ?? 0
  };
}

function discardTerminalReplay(snapshot: RuntimeHistorySnapshot): RuntimeHistorySnapshot {
  return {
    kind: snapshot.kind,
    terminalId: snapshot.terminalId,
    sessionId: snapshot.sessionId,
    cols: snapshot.cols,
    rows: snapshot.rows,
    data: '',
    fromSeq: snapshot.toSeq + 1,
    toSeq: snapshot.toSeq,
    truncated: true,
    byteLength: 0,
    replay: {
      cols: snapshot.cols,
      rows: snapshot.rows,
      resizes: []
    }
  };
}
