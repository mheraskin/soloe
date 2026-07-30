import { EventEmitter } from "node:events";
import type {
  RuntimeExitEvent,
  RuntimeOutputEvent,
  RuntimeTerminalState,
} from "@soloe/protocol";
import { RuntimeClient } from "@soloe/runtime";
import type {
  PtyProcess,
  PtyProcessDisposable,
  PtyProcessExit,
  PtyProcessFactory,
  PtyProcessSpawnOptions,
} from "./PtyProcess.js";

class RemotePtyProcess extends EventEmitter implements PtyProcess {
  private operations: Promise<void> = Promise.resolve();

  constructor(
    readonly pid: number,
    readonly terminalId: string,
    private readonly client: RuntimeClient,
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
    this.enqueue(() => this.client.write(this.terminalId, data));
  }

  resize(cols: number, rows: number): void {
    this.enqueue(() => this.client.resize(this.terminalId, cols, rows));
  }

  kill(): void {
    this.enqueue(() => this.client.stop(this.terminalId));
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
    const process = new RemotePtyProcess(terminal.pid, terminal.terminalId, this.client);
    this.processes.set(terminal.terminalId, process);
    return process;
  }

  listRunning(): Promise<RuntimeTerminalState[]> {
    return this.client.listRunning();
  }

  attach(terminal: RuntimeTerminalState): PtyProcess {
    const existing = this.processes.get(terminal.terminalId);
    if (existing) return existing;
    const process = new RemotePtyProcess(terminal.pid, terminal.terminalId, this.client);
    this.processes.set(terminal.terminalId, process);
    return process;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.processes.values()].map((process) => process.flush()));
  }

  async dispose(): Promise<void> {
    await this.flush();
    this.processes.clear();
    this.client.disconnect();
  }
}
