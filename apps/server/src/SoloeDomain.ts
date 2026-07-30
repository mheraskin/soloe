import path from "node:path";
import { EventEmitter } from "node:events";
import type {
  RuntimeReplaySnapshot,
  RuntimeTerminalStart,
  RuntimeTerminalState,
} from "@soloe/protocol";
import type {
  CreateWorkerSessionRequest,
  ListObserverEventsRequest,
  SendWorkerPromptRequest,
} from "../../../shared/types/agents.js";
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionUpdate,
} from "../../../shared/types/sessions.js";
import type { SettingsUpdate } from "../../../shared/types/settings.js";
import type {
  ProjectDraft,
  ProjectId,
  ProjectOpenRequest,
  ProjectSuggestOptions,
  ProjectUpdate,
} from "../../../shared/types/projects.js";
import { hostPlatform, platformInfo } from "../../../shared/platform.js";
import { SessionStore } from "../../../electron/sessions/SessionStore.js";
import { SessionCommandBuilder } from "../../../electron/sessions/SessionCommandBuilder.js";
import { ShellDetector } from "../../../electron/terminal/ShellDetector.js";
import { NativeCommandBuilder } from "../../../electron/runtime/WindowsCommandBuilder.js";
import { WslCommandBuilder } from "../../../electron/runtime/WslCommandBuilder.js";
import { SettingsStore } from "../../../electron/settings/SettingsStore.js";
import { ProjectStore } from "../../../electron/projects/ProjectStore.js";
import { AgentObserverManager } from "../../../electron/agents/AgentObserverManager.js";
import { AgentObserverStore } from "../../../electron/agents/AgentObserverStore.js";
import { AgentRuntimeManager } from "../../../electron/agents/AgentRuntimeManager.js";

export interface RuntimeControl {
  start(input: RuntimeTerminalStart): Promise<RuntimeTerminalState>;
  listRunning(): Promise<RuntimeTerminalState[]>;
  replay(terminalId: string, afterSeq?: number): Promise<RuntimeReplaySnapshot | null>;
  write(terminalId: string, data: string): Promise<unknown>;
  resize(terminalId: string, cols: number, rows: number): Promise<unknown>;
  stop(terminalId: string): Promise<unknown>;
}

export interface DomainCall {
  namespace: string;
  method: string;
  args: unknown[];
}

export interface SoloeDomainOptions {
  dataDirectory: string;
  runtime: RuntimeControl;
}

export interface SoloeDomain {
  on(
    event: "event",
    listener: (name: string, payload: unknown) => void,
  ): this;
}

export class SoloeDomain extends EventEmitter {
  private readonly sessions: SessionStore;
  private readonly settings: SettingsStore;
  private readonly projects: ProjectStore;
  private readonly observerStore: AgentObserverStore;
  private observer!: AgentObserverManager;
  private workerRuntime!: AgentRuntimeManager;
  private readonly commandBuilder = new SessionCommandBuilder(
    new ShellDetector(),
    new NativeCommandBuilder(),
    new WslCommandBuilder(),
  );

  constructor(private readonly options: SoloeDomainOptions) {
    super();
    this.sessions = new SessionStore(
      path.join(options.dataDirectory, "sessions.json"),
      hostPlatform(),
    );
    this.settings = new SettingsStore(
      path.join(options.dataDirectory, "settings.json"),
      hostPlatform(),
    );
    this.projects = new ProjectStore(path.join(options.dataDirectory, "projects.json"), {
      platform: hostPlatform(),
    });
    this.observerStore = new AgentObserverStore(
      path.join(options.dataDirectory, "observer.json"),
    );
    this.projects.onChange((projects) => {
      this.emit("event", "projects.change", projects);
    });
    this.settings.onChange((settings) => {
      this.emit("event", "settings.change", settings);
    });
  }

  async init(): Promise<void> {
    const persistedObserver = await this.observerStore.load();
    this.observer = new AgentObserverManager({
      initialSnapshots: persistedObserver.snapshots,
      initialEvents: persistedObserver.events,
    });
    this.workerRuntime = new AgentRuntimeManager({ observer: this.observer });
    this.observerStore.attach(this.observer);
    this.observer.on("snapshot", (snapshot) => {
      this.emit("event", "observer.snapshot", snapshot);
    });
    this.observer.on("event", (event) => {
      this.emit("event", "observer.event", event);
    });
    await Promise.all([
      this.sessions.init(),
      this.settings.init(),
      this.projects.init(),
    ]);
    for (const session of await this.sessions.list()) {
      this.observer.registerTuiSession(session);
    }
  }

  async dispose(): Promise<void> {
    await this.workerRuntime.dispose();
    await this.observerStore.dispose();
  }

  async invoke(call: DomainCall): Promise<unknown> {
    if (call.namespace === "sessions") {
      return this.sessionsCall(call.method, call.args);
    }
    if (call.namespace === "terminal") {
      return this.terminalCall(call.method, call.args);
    }
    if (call.namespace === "projects") {
      return this.projectsCall(call.method, call.args);
    }
    if (call.namespace === "observer") {
      return this.observerCall(call.method, call.args);
    }
    if (call.namespace === "settings") {
      if (call.method === "get") return this.settings.get();
      if (call.method === "update") {
        return this.settings.update(call.args[0] as SettingsUpdate);
      }
    }
    if (call.namespace === "system" && call.method === "platform") {
      return platformInfo();
    }
    if (call.namespace === "system" && call.method === "listWslDistros") {
      return [];
    }
    if (call.namespace === "agentIntegration" && call.method === "status") {
      return { hosts: [] };
    }
    throw new RpcError(
      "rpc_not_supported",
      `RPC ${call.namespace}.${call.method} is not supported by the application server`,
    );
  }

  private async observerCall(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "list":
        return this.observer.listSnapshots();
      case "listEvents": {
        const request = args[0] as ListObserverEventsRequest | undefined;
        return this.observer.listEvents(request?.subjectId, request?.limit);
      }
      case "createWorkerSession":
        return this.workerRuntime.createWorkerSession(
          args[0] as CreateWorkerSessionRequest,
        );
      case "sendWorkerPrompt":
        return this.workerRuntime.sendWorkerPrompt(
          args[0] as SendWorkerPromptRequest,
        );
      case "getWorkerStatus":
        return this.workerRuntime.getWorkerStatus(args[0] as string);
      case "stopWorkerSession":
        return this.workerRuntime.stopWorkerSession(args[0] as string);
      default:
        throw new RpcError(
          "rpc_not_supported",
          `RPC observer.${method} is not supported by the application server`,
        );
    }
  }

  private async projectsCall(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "list":
        return this.projects.list();
      case "get":
        return this.projects.get(args[0] as ProjectId);
      case "create":
        return this.projects.create(args[0] as ProjectDraft);
      case "open":
        return this.projects.open(args[0] as ProjectOpenRequest);
      case "update":
        return this.projects.update(args[0] as ProjectId, args[1] as ProjectUpdate);
      case "delete":
        await this.projects.delete(args[0] as ProjectId);
        return true;
      case "touch":
        return this.projects.touch(args[0] as ProjectId);
      case "reorder":
        return this.projects.reorder(args[0] as ProjectId[]);
      case "refreshFavicons":
        return this.projects.refreshFavicons(args[0] as ProjectId);
      case "readFavicon":
        return this.projects.readFavicon(args[0] as ProjectId, args[1] as string);
      case "detectFromPath":
        return this.projects.detectFromPath(args[0] as string);
      case "suggestPaths":
        return this.projects.suggestPaths(
          args[0] as string,
          args[1] as ProjectSuggestOptions | undefined,
        );
      default:
        throw unsupportedRpc("projects", method);
    }
  }

  private async sessionsCall(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "list":
        return this.sessions.list();
      case "listArchived":
        return this.sessions.listArchived();
      case "get":
        return this.sessions.get(args[0] as SessionId);
      case "create":
        return this.changeSession(
          this.observeSession(
            await this.sessions.create({
              ...(args[0] as SessionDraft),
              runtimeMode: "tui",
            }),
          ),
        );
      case "update":
        return this.changeSession(
          this.observeSession(
            await this.sessions.update(args[0] as SessionId, args[1] as SessionUpdate),
          ),
        );
      case "delete": {
        const id = args[0] as SessionId;
        await this.sessions.delete(args[0] as SessionId);
        this.observer.removeSession(id);
        this.emit("event", "sessions.delete", { id });
        return true;
      }
      case "reorder":
        return this.sessions.reorder(args[0] as SessionId[]);
      case "previewCommand": {
        const session = await this.requireSession(args[0] as SessionId);
        const settings = await this.settings.get();
        return this.commandBuilder.build(session, {
          baseEnv: process.env,
          binaries: settings.binaries,
        });
      }
      default:
        throw unsupportedRpc("sessions", method);
    }
  }

  private async terminalCall(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "start":
        return this.startTerminal(
          args[0] as { sessionId: SessionId; cols?: number; rows?: number },
        );
      case "stop":
        await this.markTerminalStopped(args[0] as string);
        await this.options.runtime.stop(args[0] as string);
        return true;
      case "restart": {
        const sessionId = args[0] as SessionId;
        const current = (await this.options.runtime.listRunning()).find(
          (terminal) => terminal.sessionId === sessionId,
        );
        if (current) await this.options.runtime.stop(current.terminalId);
        return this.startTerminal({
          sessionId,
          ...(args[1] as { cols?: number; rows?: number } | undefined),
        });
      }
      case "input":
        await this.options.runtime.write(args[0] as string, args[1] as string);
        return true;
      case "resize":
        await this.options.runtime.resize(
          args[0] as string,
          args[1] as number,
          args[2] as number,
        );
        return true;
      case "listRunning":
        return (await this.options.runtime.listRunning()).map((terminal) => ({
          sessionId: terminal.sessionId,
          runtimeMode: "tui",
          status: "running",
          terminalId: terminal.terminalId,
          startedAt: terminal.startedAt,
        }));
      case "replay":
        return this.options.runtime.replay(args[0] as string, args[1] as number | undefined);
      case "setOutputDemand":
        return true;
      default:
        throw unsupportedRpc("terminal", method);
    }
  }

  private async startTerminal(options: {
    sessionId: SessionId;
    cols?: number;
    rows?: number;
  }): Promise<unknown> {
    const session = await this.requireSession(options.sessionId);
    const settings = await this.settings.get();
    const spec = this.commandBuilder.build(session, {
      baseEnv: process.env,
      binaries: settings.binaries,
    });
    this.emit("event", "status", {
      sessionId: session.id,
      terminalId: null,
      status: "starting",
    });
    this.observer.updateTuiStatus({
      sessionId: session.id,
      terminalId: null,
      status: "starting",
    });
    const terminal = await this.options.runtime.start({
      sessionId: session.id,
      spec: {
        ...spec,
        env: mergeEnvironment(process.env, spec.env),
      },
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
    });
    this.emit("event", "status", {
      sessionId: session.id,
      terminalId: terminal.terminalId,
      status: "running",
    });
    this.observer.updateTuiStatus({
      sessionId: session.id,
      terminalId: terminal.terminalId,
      status: "running",
    });
    await this.sessions.touch(session.id);
    return {
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      pid: terminal.pid,
      spec,
    };
  }

  private async requireSession(sessionId: SessionId) {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session;
  }

  private changeSession<T>(session: T): T {
    this.emit("event", "sessions.change", session);
    return session;
  }

  private observeSession(session: Session): Session {
    this.observer.registerTuiSession(session);
    return session;
  }

  private async markTerminalStopped(terminalId: string): Promise<void> {
    const terminal = (await this.options.runtime.listRunning()).find(
      (running) => running.terminalId === terminalId,
    );
    if (!terminal) return;
    this.observer.updateTuiStatus({
      sessionId: terminal.sessionId,
      terminalId,
      status: "stopped",
    });
  }
}

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

function unsupportedRpc(namespace: string, method: string): RpcError {
  return new RpcError(
    "rpc_not_supported",
    `RPC ${namespace}.${method} is not supported by the application server`,
  );
}

function mergeEnvironment(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) result[key] = value;
  }
  return { ...result, ...extra };
}
