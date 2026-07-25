import { Channel, invoke } from '@tauri-apps/api/core';
import type {
  TerminalSidecarEvent,
  TerminalSidecarStartRequest,
  TerminalSidecarStartResponse
} from '@shared/types/terminal-sidecar.js';

export interface TauriSpikeInfo {
  cwd: string;
  shell: string;
  platform: string;
  benchmark: boolean;
  benchmarkStartedAtMs: number | null;
}

export interface TauriUsageSnapshot {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
  sampledAtMs: number;
}

export type TerminalBytesListener = (data: Uint8Array, seq: number) => void;
export type TerminalExitListener = (exitCode: number, signalName: string | null) => void;

export class TauriTerminalClient {
  private readonly outputListeners = new Map<string, Set<TerminalBytesListener>>();
  private readonly exitListeners = new Map<string, Set<TerminalExitListener>>();
  private subscribed = false;

  async info(): Promise<TauriSpikeInfo> {
    return invoke<TauriSpikeInfo>('spike_info');
  }

  async subscribe(): Promise<void> {
    if (this.subscribed) return;
    const channel = new Channel<TerminalSidecarEvent>();
    channel.onmessage = (event) => this.onEvent(event);
    await invoke('terminal_subscribe', { onEvent: channel });
    this.subscribed = true;
  }

  usage(): Promise<TauriUsageSnapshot> {
    return invoke<TauriUsageSnapshot>('spike_usage');
  }

  completeBenchmark(result: unknown): Promise<void> {
    return invoke('benchmark_complete', { result });
  }

  start(request: TerminalSidecarStartRequest): Promise<TerminalSidecarStartResponse> {
    return invoke<TerminalSidecarStartResponse>('terminal_start', { request });
  }

  input(terminalId: string, data: string): Promise<void> {
    return invoke('terminal_input', {
      request: { terminalId, dataBase64: bytesToBase64(new TextEncoder().encode(data)) }
    });
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    return invoke('terminal_resize', { request: { terminalId, cols, rows } });
  }

  stop(terminalId: string): Promise<void> {
    return invoke('terminal_stop', { request: { terminalId } });
  }

  onOutput(terminalId: string, listener: TerminalBytesListener): () => void {
    return addListener(this.outputListeners, terminalId, listener);
  }

  onExit(terminalId: string, listener: TerminalExitListener): () => void {
    return addListener(this.exitListeners, terminalId, listener);
  }

  private onEvent(event: TerminalSidecarEvent): void {
    if (event.event === 'output') {
      const bytes = base64ToBytes(event.payload.dataBase64);
      for (const listener of this.outputListeners.get(event.payload.terminalId) ?? []) {
        listener(bytes, event.payload.seq);
      }
      return;
    }
    for (const listener of this.exitListeners.get(event.payload.terminalId) ?? []) {
      listener(event.payload.exitCode, event.payload.signalName);
    }
    this.outputListeners.delete(event.payload.terminalId);
    this.exitListeners.delete(event.payload.terminalId);
  }
}

function addListener<T>(listeners: Map<string, Set<T>>, terminalId: string, listener: T): () => void {
  let values = listeners.get(terminalId);
  if (!values) {
    values = new Set();
    listeners.set(terminalId, values);
  }
  values.add(listener);
  return () => {
    values?.delete(listener);
    if (values?.size === 0) listeners.delete(terminalId);
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
