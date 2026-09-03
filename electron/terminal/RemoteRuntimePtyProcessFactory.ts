import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  RuntimeExitEvent,
  RuntimeOutputEvent,
  RuntimeHistorySnapshot,
  RuntimeTerminalState,
} from "@soloe/protocol";
import { RuntimeClient } from "@soloe/runtime";
import type {
  TerminalInputLease,
  TerminalInputLeaseEvent,
} from "../../shared/types/terminal.js";
import { terminalControlProof } from "../../shared/types/terminal.js";
import type {
  PtyProcess,
  PtyProcessDisposable,
  PtyProcessExit,
  PtyProcessFactory,
  PtyProcessSpawnOptions,
} from "./PtyProcess.js";

export interface RuntimeTerminalInputControl {
  acquireInputLease(
    terminalId: string,
    takeover?: boolean,
    controller?: { deviceId: string; deviceName: string; ownerDeviceId: string }
  ): Promise<TerminalInputLease>;
  currentInputLease(terminalId: string): Promise<TerminalInputLease | null>;
  releaseInputLease(terminalId: string, control: import('../../shared/types/terminal.js').TerminalControlProof): Promise<boolean>;
  parkInputLease(terminalId: string, control: import('../../shared/types/terminal.js').TerminalControlProof): Promise<boolean>;
  historySnapshot(terminalId: string): Promise<RuntimeHistorySnapshot | null>;
  onInputLease(listener: (event: TerminalInputLeaseEvent) => void): () => void;
  writeInput(terminalId: string, data: string, lease?: TerminalInputLease): Promise<void>;
  resizeTerminal(
    terminalId: string,
    cols: number,
    rows: number,
    lease?: TerminalInputLease
  ): Promise<void>;
}

export interface RuntimeConnectionOptions {
  /** How long to wait for a supervised Runtime that is still starting. */
  timeoutMs?: number;
  retryDelayMs?: number;
}

class RemotePtyProcess extends EventEmitter implements PtyProcess {
  private operations: Promise<void> = Promise.resolve();

  constructor(
    readonly pid: number,
    readonly terminalId: string,
    private readonly owner: RemoteRuntimePtyProcessFactory,
  ) {
    super();
  }

  onData(listener: (data: string) => void): PtyProcessDisposable {
    this.on("data", listener);
    return { dispose: () => this.off("data", listener) };
  }

  onExit(listener: (event: PtyProcessExit) => void): PtyProcessDisposable {
    this.on("exit", listener);
    return { dispose: () => this.off("exit", listener) };
  }

  write(data: string): void {
    this.enqueue(() => this.owner.writeInput(this.terminalId, data));
  }

  resize(cols: number, rows: number): void {
    this.enqueue(() => this.owner.resize(this.terminalId, cols, rows));
  }

  kill(): void {
    this.enqueue(() => this.owner.stop(this.terminalId));
  }

  flush(): Promise<void> {
    return this.operations;
  }

  private enqueue(operation: () => Promise<unknown>): void {
    this.operations = this.operations
      .then(operation)
      .then(() => undefined)
      .catch((error) => {
        console.warn(`[runtime] terminal operation failed for ${this.terminalId}`, error);
      });
  }
}

export class RemoteRuntimePtyProcessFactory implements PtyProcessFactory {
  readonly preservesProcessesOnDispose = true;
  private readonly processes = new Map<string, RemotePtyProcess>();
  private readonly inputLeaseListeners = new Set<(event: TerminalInputLeaseEvent) => void>();
  private readonly inputOwnerId = `desktop-${randomUUID()}`;

  private constructor(private readonly client: RuntimeClient) {
    client.on("output", (event: RuntimeOutputEvent) => {
      this.processes.get(event.terminalId)?.emit("data", event.data);
    });
    client.on("exit", (event: RuntimeExitEvent) => {
      const process = this.processes.get(event.terminalId);
      if (!process) return;
      this.processes.delete(event.terminalId);
      process.emit("exit", {
        exitCode: event.exitCode ?? 0,
        ...(event.signal === null ? {} : { signal: event.signal }),
      } satisfies PtyProcessExit);
    });
    client.on("inputLease", (event: TerminalInputLeaseEvent) => {
      for (const listener of this.inputLeaseListeners) listener(structuredClone(event));
    });
  }

  static async connect(
    endpoint: string,
    options: RuntimeConnectionOptions = {}
  ): Promise<RemoteRuntimePtyProcessFactory> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
    const retryDelayMs = Math.max(1, options.retryDelayMs ?? 100);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      try {
        return new RemoteRuntimePtyProcessFactory(await RuntimeClient.connect(endpoint));
      } catch (error) {
        const remainingMs = deadline - Date.now();
        if (!isTransientRuntimeConnectionError(error) || remainingMs <= 0) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(retryDelayMs, remainingMs)));
      }
    }
  }

  async spawn(options: PtyProcessSpawnOptions): Promise<PtyProcess> {
    const terminal = await this.client.start({
      terminalId: options.terminalId,
      sessionId: options.sessionId,
      spec: {
        file: options.spec.file,
        args: options.spec.args,
        cwd: options.spec.cwd,
        env: options.env,
        description: options.spec.description,
      },
      cols: options.cols,
      rows: options.rows,
    });
    if (terminal.terminalId !== options.terminalId) {
      throw new Error("Environment Runtime did not preserve the requested terminal id");
    }
    const process = new RemotePtyProcess(terminal.pid, terminal.terminalId, this);
    this.processes.set(terminal.terminalId, process);
    return process;
  }

  listRunning(): Promise<RuntimeTerminalState[]> {
    return this.client.listRunning();
  }

  setHistoryLineLimit(lineLimit: number): Promise<true> {
    return this.client.setHistoryLineLimit(lineLimit);
  }

  acquireInputLease(
    terminalId: string,
    takeover = false,
    controller = {
      deviceId: this.inputOwnerId,
      deviceName: 'Soloe desktop',
      ownerDeviceId: this.inputOwnerId
    }
  ): Promise<TerminalInputLease> {
    return this.client.acquireInputLease(
      terminalId,
      this.inputOwnerId,
      takeover,
      controller
    );
  }

  currentInputLease(terminalId: string): Promise<TerminalInputLease | null> {
    return this.client.currentInputLease(terminalId);
  }

  releaseInputLease(
    terminalId: string,
    control: import('../../shared/types/terminal.js').TerminalControlProof
  ): Promise<boolean> {
    return this.client.releaseInputLease(terminalId, control);
  }

  parkInputLease(
    terminalId: string,
    control: import('../../shared/types/terminal.js').TerminalControlProof
  ): Promise<boolean> {
    return this.client.parkInputLease(terminalId, control);
  }

  historySnapshot(terminalId: string): Promise<RuntimeHistorySnapshot | null> {
    return this.client.historySnapshot(terminalId);
  }

  onInputLease(listener: (event: TerminalInputLeaseEvent) => void): () => void {
    this.inputLeaseListeners.add(listener);
    return () => this.inputLeaseListeners.delete(listener);
  }

  async writeInput(
    terminalId: string,
    data: string,
    existingLease?: TerminalInputLease,
  ): Promise<void> {
    const lease = existingLease ?? await this.acquireInputLease(terminalId);
    await this.client.write(terminalId, data, terminalControlProof(lease));
  }

  async resizeTerminal(
    terminalId: string,
    cols: number,
    rows: number,
    existingLease?: TerminalInputLease
  ): Promise<void> {
    const lease = existingLease ?? await this.acquireInputLease(terminalId);
    await this.client.resize(terminalId, cols, rows, terminalControlProof(lease));
  }

  resize(terminalId: string, cols: number, rows: number): Promise<void> {
    return this.resizeTerminal(terminalId, cols, rows);
  }

  stop(terminalId: string): Promise<true> {
    return this.client.stop(terminalId);
  }

  attach(terminal: RuntimeTerminalState): PtyProcess {
    const existing = this.processes.get(terminal.terminalId);
    if (existing) return existing;
    const process = new RemotePtyProcess(terminal.pid, terminal.terminalId, this);
    this.processes.set(terminal.terminalId, process);
    return process;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.processes.values()].map((process) => process.flush()));
  }

  async dispose(): Promise<void> {
    await this.flush();
    await this.client.releaseInputLeases(this.inputOwnerId).catch(() => undefined);
    this.processes.clear();
    this.inputLeaseListeners.clear();
    this.client.disconnect();
  }
}

function isTransientRuntimeConnectionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}
