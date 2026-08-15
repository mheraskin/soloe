import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  RuntimeExitEvent,
  RuntimeOutputEvent,
  RuntimeTerminalState,
} from "@soloe/protocol";
import { RuntimeClient } from "@soloe/runtime";
import type {
  TerminalInputLease,
  TerminalInputLeaseEvent,
} from "../../shared/types/terminal.js";
import type {
  PtyProcess,
  PtyProcessDisposable,
  PtyProcessExit,
  PtyProcessFactory,
  PtyProcessSpawnOptions,
} from "./PtyProcess.js";

export interface RuntimeTerminalInputControl {
  acquireInputLease(terminalId: string, takeover?: boolean): Promise<TerminalInputLease>;
  currentInputLease(terminalId: string): Promise<TerminalInputLease | null>;
  releaseInputLease(terminalId: string, leaseId: string): Promise<boolean>;
  onInputLease(listener: (event: TerminalInputLeaseEvent) => void): () => void;
  writeInput(terminalId: string, data: string, lease?: TerminalInputLease): Promise<void>;
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

  static async connect(endpoint: string): Promise<RemoteRuntimePtyProcessFactory> {
    return new RemoteRuntimePtyProcessFactory(await RuntimeClient.connect(endpoint));
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

  setReplayUnbounded(unbounded: boolean): Promise<true> {
    return this.client.setReplayUnbounded(unbounded);
  }

  acquireInputLease(terminalId: string, takeover = false): Promise<TerminalInputLease> {
    return this.client.acquireInputLease(terminalId, this.inputOwnerId, takeover);
  }

  currentInputLease(terminalId: string): Promise<TerminalInputLease | null> {
    return this.client.currentInputLease(terminalId);
  }

  releaseInputLease(terminalId: string, leaseId: string): Promise<boolean> {
    return this.client.releaseInputLease(terminalId, this.inputOwnerId, leaseId);
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
    await this.client.write(terminalId, data, {
      ownerId: lease.ownerId,
      leaseId: lease.leaseId,
    });
  }

  resize(terminalId: string, cols: number, rows: number): Promise<true> {
    return this.client.resize(terminalId, cols, rows);
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
