import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type {
  RuntimeReplaySnapshot,
  RuntimeTerminalStart,
  RuntimeTerminalState,
  RuntimeUsageSnapshot,
} from "@soloe/protocol";
import type {
  CreateWorkerSessionRequest,
  ListObserverEventsRequest,
  SendWorkerPromptRequest,
} from "../../../shared/types/agents.js";
import type {
  AgentIntegrationHostKey,
  AgentIntegrationStatus,
} from "../../../shared/types/ipc.js";
import type { CommentsRpcResponse } from "../../../shared/types/comments-rpc.js";
import type {
  DiffRpcResponse,
  DiffWorktreeTarget,
} from "../../../shared/types/diff-rpc.js";
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionUpdate,
} from "../../../shared/types/sessions.js";
import type { SettingsUpdate } from "../../../shared/types/settings.js";
import type { SystemUsageRequest } from "../../../shared/types/system.js";
import type { DiagnosticLogsRequest } from "../../../shared/types/diagnostics.js";
import type {
  VaultDeleteRequest,
  VaultGetSecretRequest,
  VaultListRequest,
  VaultSaveRequest,
  VaultUpdateRequest,
} from "../../../shared/types/vault.js";
import type {
  AskFollowUpChunk,
  AskFollowUpRequest,
  GetOverviewRequest,
} from "../../../shared/types/overview.js";
import type {
  ProjectDraft,
  ProjectId,
  ProjectOpenRequest,
  ProjectSuggestOptions,
  ProjectUpdate,
} from "../../../shared/types/projects.js";
import type {
  FileOpenRequest,
  FilePasteRequest,
  FileReadRequest,
  FileSearchRequest,
  FileTreeRequest,
  FileWriteRequest,
  ImagePasteRequest,
} from "../../../shared/types/files.js";
import type {
  CommitsBetweenRequest,
  DiscardFilesRequest,
  FileBlameRequest,
  FileDiffRequest,
  FileLinesRequest,
  GitCheckoutRequest,
  GitCommitRequest,
  GitCreateWorktreeRequest,
  GitObservationDemandRequest,
  GitRecentCommitsRequest,
  GitRefHistoryRequest,
  GitRemoteOpRequest,
  GitRepoRequest,
  GitStatusRequest,
  RangeChangesRequest,
  ReviewDiffsRequest,
  ResolveRefsRequest,
  StageFilesRequest,
  WorkingChangesRequest,
  WorkingTreeSnapshotRequest,
} from "../../../shared/types/git.js";
import type {
  FeatureScanRequest,
  FeatureSetBranchStatusRequest,
  FeatureSetIssueStatusRequest,
} from "../../../shared/types/features.js";
import {
  worktreeIdentityKey,
  type WorktreeScope,
} from "../../../shared/worktree-identity.js";
import { hostPlatform, platformInfo } from "../../../shared/platform.js";
import {
  FileService,
  BackendPathError,
  BackendPathService,
  DiagnosticsService,
  FeatureArtifactObservation,
  FeatureService,
  GitService,
  HookInstaller,
  NotesStore,
  RendererBridgeService,
  SessionTranscriptReader,
  SummaryCacheStore,
  WorktreeFactsCollector,
  WorktreeOverviewService,
  WorktreeFileIndex,
  VaultStore,
  VaultStoreError,
  WslHostDetector,
  type FileIndexScope,
} from "@soloe/domain";
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
import { AgentHookDispatcher } from "../../../electron/agents/AgentHookDispatcher.js";
import {
  SoloeMcpServer,
  type SoloeMcpServerInfo,
} from "../../../electron/agents/SoloeMcpServer.js";
import { BackgroundAgentExecution } from "../../../electron/agents/BackgroundAgentExecution.js";
import { BridgePersistence } from "../../../electron/integrations/BridgePersistence.js";
import { ProcessTreeUsageSampler } from "@soloe/runtime";
import { BackendUsageObservation } from "./BackendUsageObservation.js";

export interface RuntimeControl {
  start(input: RuntimeTerminalStart): Promise<RuntimeTerminalState>;
  listRunning(): Promise<RuntimeTerminalState[]>;
  replay(terminalId: string, afterSeq?: number): Promise<RuntimeReplaySnapshot | null>;
  write(terminalId: string, data: string): Promise<unknown>;
  resize(terminalId: string, cols: number, rows: number): Promise<unknown>;
  stop(terminalId: string): Promise<unknown>;
  usage?(): Promise<RuntimeUsageSnapshot>;
}

export interface DomainCall {
  namespace: string;
  method: string;
  args: unknown[];
  clientId?: string;
}

export interface SoloeDomainOptions {
  dataDirectory: string;
  runtime: RuntimeControl;
  featureArtifacts?: FeatureArtifactObservation;
  usageObservation?: Pick<BackendUsageObservation, "observe" | "reset">;
  overviewService?: Pick<
    WorktreeOverviewService,
    "getOverview" | "regenerate" | "streamFollowUp"
  >;
  integrationInstaller?: Pick<
    HookInstaller,
    | "status"
    | "installClaude"
    | "uninstallClaude"
    | "installCodex"
    | "uninstallCodex"
  >;
  enableAgentBridge?: boolean;
  pathService?: Pick<BackendPathService, "openSessionPath">;
  wslHostDetector?: Pick<WslHostDetector, "detect">;
  fileEditorLauncher?: (editor: string, absolutePath: string) => Promise<void>;
  rendererBridgeTimeouts?: {
    commentsTimeoutMs?: number;
    diffTimeoutMs?: number;
  };
}

export interface SoloeDomain {
  on(
    event: "event",
    listener: (name: string, payload: unknown) => void,
  ): this;
  on(
    event: "targeted-event",
    listener: (clientId: string, name: string, payload: unknown) => void,
  ): this;
}

interface ActiveOverviewStream {
  clientId: string;
  controller: AbortController;
}

export class SoloeDomain extends EventEmitter {
  private readonly sessions: SessionStore;
  private readonly settings: SettingsStore;
  private readonly projects: ProjectStore;
  private readonly files: FileService;
  private readonly diagnostics: DiagnosticsService;
  private readonly git: GitService;
  private readonly pathService: Pick<BackendPathService, "openSessionPath">;
  private readonly wslHostDetector: Pick<WslHostDetector, "detect">;
  private integrationInstaller: NonNullable<
    SoloeDomainOptions["integrationInstaller"]
  >;
  private readonly notes: NotesStore;
  private readonly rendererBridge: RendererBridgeService;
  private readonly vault: VaultStore;
  private readonly featureArtifacts: FeatureArtifactObservation;
  private readonly features: FeatureService;
  private readonly featureSubscriptionReleases = new Map<
    string,
    Map<string, () => void>
  >();
  private readonly gitObservationReleases = new Map<
    string,
    Map<string, () => void>
  >();
  private readonly observerStore: AgentObserverStore;
  private readonly usage: Pick<BackendUsageObservation, "observe" | "reset">;
  private readonly backgroundAgentExecution: BackgroundAgentExecution;
  private readonly overview: Pick<
    WorktreeOverviewService,
    "getOverview" | "regenerate" | "streamFollowUp"
  >;
  private readonly overviewStreams = new Map<string, ActiveOverviewStream>();
  private observer!: AgentObserverManager;
  private workerRuntime!: AgentRuntimeManager;
  private agentBridge: SoloeMcpServer | null = null;
  private agentBridgeInfo: SoloeMcpServerInfo | null = null;
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
    this.files = new FileService({
      fileIndex: new WorktreeFileIndex({
        getBinaries: async () => (await this.settings.get()).binaries,
        useWslHostBridge: process.platform === "win32",
      }),
      runtime: options.runtime,
      getSession: (sessionId) => this.sessions.get(sessionId),
      authorizeScope: (scope) => this.isAuthorizedWorktree(scope),
      getEditor: async () => (await this.settings.get()).binaries.editor,
      ...(options.fileEditorLauncher
        ? { launchEditor: options.fileEditorLauncher }
        : {}),
    });
    this.git = new GitService({
      getGitBinary: async () => (await this.settings.get()).binaries.git,
    });
    this.integrationInstaller =
      options.integrationInstaller ?? new HookInstaller();
    this.pathService =
      options.pathService ??
      new BackendPathService({
        getSession: (sessionId) => this.sessions.get(sessionId),
      });
    this.wslHostDetector = options.wslHostDetector ?? new WslHostDetector();
    this.diagnostics = new DiagnosticsService({
      settings: this.settings,
      projects: this.projects,
      git: this.git,
      crashDir: path.join(options.dataDirectory, "crashes"),
      logDirectory: options.dataDirectory,
    });
    this.notes = new NotesStore(path.join(options.dataDirectory, "notes"));
    this.rendererBridge = new RendererBridgeService({
      publish: (event, payload) => this.emit("event", event, payload),
      ...options.rendererBridgeTimeouts,
    });
    this.vault = new VaultStore(path.join(options.dataDirectory, "vault"));
    this.featureArtifacts =
      options.featureArtifacts ?? new FeatureArtifactObservation();
    this.features = new FeatureService(this.featureArtifacts);
    this.backgroundAgentExecution = new BackgroundAgentExecution();
    const backendPlacement = detectBackendPlacement();
    this.overview = options.overviewService ?? new WorktreeOverviewService({
      reader: new SessionTranscriptReader({
        useWslHostBridge: process.platform === "win32",
      }),
      facts: new WorktreeFactsCollector({
        getGitBinary: async () => (await this.settings.get()).binaries.git,
        useWslHostBridge: process.platform === "win32",
      }),
      cache: new SummaryCacheStore(
        path.join(options.dataDirectory, "overview-cache.json"),
      ),
      getSettings: () => this.settings.get(),
      execution: this.backgroundAgentExecution,
      ...(backendPlacement === "wsl"
        ? {
            resolveExecutionScope: (scope) => ({
              cwd: scope.cwd,
              runMode: "linux" as const,
            }),
          }
        : {}),
    });
    const serverUsage = new ProcessTreeUsageSampler();
    this.usage =
      options.usageObservation ??
      new BackendUsageObservation({
        collectServerUsage: () => serverUsage.sample(),
        ...(options.runtime.usage
          ? { collectRuntimeUsage: () => options.runtime.usage!() }
          : {}),
        backendPlacement,
      });
    this.git.onChange((event) => {
      this.emit("event", "git.change", event);
    });
    this.notes.onChange((event) => {
      this.emit("event", "notes.change", event);
    });
    this.vault.onChange((event) => {
      this.emit("event", "vault.change", event);
    });
    this.featureArtifacts.onChange((event) => {
      this.emit("event", "features.change", event);
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
    if (this.options.enableAgentBridge) {
      await this.startAgentBridge();
    }
  }

  async dispose(): Promise<void> {
    this.usage.reset();
    for (const stream of this.overviewStreams.values()) {
      stream.controller.abort("application server stopping");
    }
    this.overviewStreams.clear();
    for (
      const clientId of new Set([
        ...this.gitObservationReleases.keys(),
        ...this.featureSubscriptionReleases.keys(),
      ])
    ) {
      this.releaseClient(clientId);
    }
    this.featureArtifacts.dispose();
    this.git.dispose();
    this.files.dispose();
    this.rendererBridge.dispose();
    await this.agentBridge?.stop();
    this.agentBridge = null;
    this.agentBridgeInfo = null;
    await this.workerRuntime.dispose();
    await this.backgroundAgentExecution.dispose();
    await this.observerStore.dispose();
  }

  private async startAgentBridge(): Promise<void> {
    const persistence = new BridgePersistence(
      path.join(this.options.dataDirectory, "bridge.json"),
    );
    const initial = await persistence.loadOrCreate();
    const dispatcher = new AgentHookDispatcher({
      observer: this.observer,
      sessionStore: this.sessions,
      onSessionChange: (session) => {
        this.emit("event", "sessions.change", session);
      },
    });
    const start = async (port: number): Promise<{
      bridge: SoloeMcpServer;
      info: SoloeMcpServerInfo;
    }> => {
      const bridge = new SoloeMcpServer({
        observer: this.observer,
        runtime: this.workerRuntime,
        host: "127.0.0.1",
        port,
        token: initial.token,
        onHookEvent: (event) => dispatcher.dispatch(event),
        commentsBridge: this.rendererBridge,
        diffBridge: this.rendererBridge,
        git: this.git,
        resolveDiffTarget: (input) => this.resolveDiffTarget(input),
      });
      const info = await bridge.start();
      return { bridge, info };
    };

    let started: { bridge: SoloeMcpServer; info: SoloeMcpServerInfo };
    try {
      started = await start(initial.port);
    } catch (error) {
      if (initial.port === 0) throw error;
      console.warn("[agent-bridge] persisted port unavailable; selecting a new port");
      started = await start(0);
    }
    const port = portFromBridgeUrl(started.info.url);
    if (port === null) {
      await started.bridge.stop();
      throw new Error("Agent bridge did not report a valid TCP port");
    }
    await persistence.save({ port, token: initial.token });
    this.agentBridge = started.bridge;
    this.agentBridgeInfo = started.info;
    if (!this.options.integrationInstaller) {
      const installer = new HookInstaller({
        bridge: { port, token: initial.token },
      });
      this.integrationInstaller = installer;
      if ((await this.settings.get()).integrations.autoRefreshMcpUrl) {
        const refreshed = await installer.refreshMcpForInstalledHosts();
        if (refreshed.rewritten.length > 0) {
          console.log(
            `[agent-bridge] refreshed ${refreshed.rewritten.length} integration target(s)`,
          );
        }
        for (const item of refreshed.errors) {
          console.warn(
            `[agent-bridge] failed to refresh ${describeIntegrationHost(item.host)}`,
          );
        }
      }
    }
  }

  private async resolveDiffTarget(input: {
    sessionId?: string;
    cwd?: string;
  }): Promise<DiffWorktreeTarget> {
    let session: Session | null = null;
    if (input.sessionId) {
      session = await this.sessions.get(input.sessionId);
    } else if (input.cwd) {
      session =
        (await this.sessions.list()).find(
          (candidate) => sameSessionPath(input.cwd!, candidate),
        ) ?? null;
    }
    if (!session) {
      throw new Error("Diff target must match an existing Soloe session");
    }
    if (input.cwd && !sameSessionPath(input.cwd, session)) {
      throw new Error("Diff target cwd does not match the selected session");
    }
    const scope: FileIndexScope = {
      cwd: session.cwd,
      runMode: session.runMode,
      ...(session.wslDistro ? { wslDistro: session.wslDistro } : {}),
    };
    if (!(await this.isAuthorizedWorktree(scope))) {
      throw new Error("Diff target Worktree is not authorized");
    }
    return { sessionId: session.id, scope };
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
    if (call.namespace === "files") {
      return this.filesCall(call.method, call.args);
    }
    if (call.namespace === "diagnostics") {
      return this.diagnosticsCall(call.method, call.args);
    }
    if (call.namespace === "git") {
      try {
        return await this.gitCall(call.method, call.args, call.clientId);
      } catch (error) {
        if (error instanceof RpcError) throw error;
        throw structuredGitError(error);
      }
    }
    if (call.namespace === "notes") {
      return this.notesCall(call.method, call.args);
    }
    if (call.namespace === "vault") {
      return this.vaultCall(call.method, call.args);
    }
    if (call.namespace === "features") {
      try {
        return await this.featuresCall(call.method, call.args, call.clientId);
      } catch (error) {
        if (error instanceof RpcError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new RpcError(
          /path|slug|indexed feature issue/iu.test(message)
            ? "invalid_feature_path"
            : "feature_failed",
          message,
        );
      }
    }
    if (call.namespace === "overview") {
      return this.overviewCall(
        call.method,
        call.args,
        call.clientId,
      );
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
    if (call.namespace === "system") {
      return this.systemCall(call.method, call.args);
    }
    if (call.namespace === "agentIntegration") {
      return this.agentIntegrationCall(call.method, call.args);
    }
    if (call.namespace === "comments" && call.method === "sendRpcResponse") {
      requireArgumentCount("comments.sendRpcResponse", call.args, 1);
      return this.rendererBridge.handleCommentsResponse(
        validateCommentsResponse(call.args[0]),
      );
    }
    if (call.namespace === "diff" && call.method === "sendRpcResponse") {
      requireArgumentCount("diff.sendRpcResponse", call.args, 1);
      return this.rendererBridge.handleDiffResponse(
        validateDiffResponse(call.args[0]),
      );
    }
    throw new RpcError(
      "rpc_not_supported",
      `RPC ${call.namespace}.${call.method} is not supported by the application server`,
    );
  }

  private async systemCall(method: string, args: unknown[]): Promise<unknown> {
    if (method === "platform") {
      requireArgumentCount("system.platform", args, 0);
      return platformInfo();
    }
    if (method === "openPath") {
      requireArgumentCount("system.openPath", args, 1);
      try {
        return await this.pathService.openSessionPath(
          validateSystemSessionId(args[0]),
        );
      } catch (error) {
        if (error instanceof RpcError) throw error;
        if (error instanceof BackendPathError) {
          throw new RpcError(error.code, error.message);
        }
        throw new RpcError(
          "path_open_failed",
          "The backend could not open the selected session directory",
        );
      }
    }
    if (method === "listWslDistros") {
      requireArgumentCount("system.listWslDistros", args, 0);
      const distro = process.env.WSL_DISTRO_NAME?.trim();
      if (distro) return [distro];
      const hosts = await this.wslHostDetector.detect();
      return hosts
        .filter((host) => host.available)
        .map((host) => host.distro);
    }
    if (method === "usage") {
      if (args.length > 1) {
        throw new RpcError(
          "invalid_system_usage_request",
          "system.usage accepts at most one request object",
        );
      }
      return this.usage.observe(validateSystemUsageRequest(args[0]));
    }
    throw unsupportedRpc("system", method);
  }

  private async agentIntegrationCall(
    method: string,
    args: unknown[],
  ): Promise<AgentIntegrationStatus> {
    if (method === "status") {
      requireIntegrationArgumentCount(method, args, 0);
      return this.integrationInstaller.status();
    }
    if (
      method !== "installClaude" &&
      method !== "uninstallClaude" &&
      method !== "installCodex" &&
      method !== "uninstallCodex"
    ) {
      throw unsupportedRpc("agentIntegration", method);
    }

    requireIntegrationArgumentCount(method, args, 1);
    const host = validateIntegrationRequest(args[0]);
    try {
      await this.integrationInstaller[method](host);
      const status = await this.integrationInstaller.status();
      this.emit("event", "agentIntegration.change", status);
      return status;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw structuredIntegrationError(error);
    }
  }

  private async diagnosticsCall(
    method: string,
    args: unknown[],
  ): Promise<unknown> {
    if (method === "list") {
      requireArgumentCount("diagnostics.list", args, 0);
      return this.diagnostics.list();
    }
    if (method === "crashLogs") {
      if (args.length > 1) {
        throw new RpcError(
          "invalid_diagnostics_request",
          "diagnostics.crashLogs accepts at most one request object",
        );
      }
      const request = validateDiagnosticLogsRequest(args[0]);
      try {
        return await this.diagnostics.crashLogs(request);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith("tailBytes must")
        ) {
          throw new RpcError("invalid_diagnostics_request", error.message);
        }
        throw error;
      }
    }
    throw unsupportedRpc("diagnostics", method);
  }

  private async vaultCall(method: string, args: unknown[]): Promise<unknown> {
    if (!VAULT_RPC_METHODS.has(method)) throw unsupportedRpc("vault", method);
    requireArgumentCount(`vault.${method}`, args, 1);
    const request = validateVaultRequest(method, args[0]);
    if (!(await this.isAuthorizedVaultScope(request.cwd))) {
      throw new RpcError(
        "vault_scope_not_authorized",
        "Vault access is limited to an authorized Project or Worktree",
      );
    }
    try {
      if (method === "list") {
        return this.vault.list(request.cwd);
      }
      if (method === "save") {
        const save = request as VaultSaveRequest;
        return this.vault.save(save.cwd, save.draft);
      }
      if (method === "update") {
        const update = request as VaultUpdateRequest;
        return this.vault.update(update.cwd, update.id, update.patch);
      }
      if (method === "delete") {
        const target = request as VaultDeleteRequest;
        await this.vault.delete(target.cwd, target.id);
        return true;
      }
      if (method === "getSecret") {
        const target = request as VaultGetSecretRequest;
        return this.vault.getSecret(target.cwd, target.id);
      }
    } catch (error) {
      if (error instanceof VaultStoreError) {
        throw new RpcError(error.code, error.message);
      }
      throw error;
    }
    throw unsupportedRpc("vault", method);
  }

  private async overviewCall(
    method: string,
    args: unknown[],
    clientId?: string,
  ): Promise<unknown> {
    if (method === "get" || method === "regenerate") {
      requireArgumentCount(`overview.${method}`, args, 1);
      const request = validateOverviewRequest(args[0], false);
      await this.authorizeOverviewRequest(request);
      return method === "get"
        ? this.overview.getOverview(request)
        : this.overview.regenerate(request);
    }
    if (method === "askStart") {
      requireArgumentCount("overview.askStart", args, 1);
      if (!clientId) {
        throw new RpcError(
          "client_identity_required",
          "Overview streaming requires a client identity",
        );
      }
      const request = validateOverviewRequest(args[0], true);
      await this.authorizeOverviewRequest(request);
      const requestId = randomUUID();
      const controller = new AbortController();
      this.overviewStreams.set(requestId, { clientId, controller });
      void this.runOverviewStream(requestId, clientId, request, controller);
      return { requestId };
    }
    if (method === "askCancel") {
      requireArgumentCount("overview.askCancel", args, 1);
      if (!clientId) {
        throw new RpcError(
          "client_identity_required",
          "Overview cancellation requires a client identity",
        );
      }
      const requestId = requireRpcString(
        args[0],
        "requestId",
        128,
        "invalid_overview_request",
      );
      const stream = this.overviewStreams.get(requestId);
      if (stream?.clientId === clientId) {
        stream.controller.abort("request cancelled");
        this.overviewStreams.delete(requestId);
      }
      return true;
    }
    throw unsupportedRpc("overview", method);
  }

  private async authorizeOverviewRequest(
    request: GetOverviewRequest,
  ): Promise<void> {
    const authorized = await this.isAuthorizedWorktree({
      cwd: request.worktreeCwd,
      runMode: request.runMode ?? hostPlatform(),
      wslDistro: request.wslDistro,
    });
    if (!authorized) {
      throw new RpcError(
        "worktree_not_authorized",
        "Overview access is limited to registered projects and Sessions",
      );
    }
    if (
      request.runMode === "wsl" &&
      process.env.WSL_DISTRO_NAME &&
      request.wslDistro?.toLowerCase() !==
        process.env.WSL_DISTRO_NAME.toLowerCase()
    ) {
      throw new RpcError(
        "invalid_wsl_distribution",
        "The requested WSL distribution does not match the application server",
      );
    }
  }

  private async runOverviewStream(
    requestId: string,
    clientId: string,
    request: AskFollowUpRequest,
    controller: AbortController,
  ): Promise<void> {
    try {
      for await (
        const chunk of this.overview.streamFollowUp(
          request,
          controller.signal,
        )
      ) {
        if (controller.signal.aborted) return;
        this.emitOverviewChunk(clientId, { requestId, ...chunk });
        if (chunk.type === "done" || chunk.type === "error") return;
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      this.emitOverviewChunk(clientId, {
        requestId,
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      const active = this.overviewStreams.get(requestId);
      if (active?.controller === controller) {
        this.overviewStreams.delete(requestId);
      }
    }
  }

  private cancelOverviewStreams(
    clientId: string,
    reason: string,
    notify = false,
  ): void {
    for (const [requestId, stream] of this.overviewStreams) {
      if (stream.clientId !== clientId) continue;
      if (notify) {
        this.emitOverviewChunk(clientId, {
          requestId,
          type: "error",
          error: reason,
        });
      }
      stream.controller.abort(reason);
      this.overviewStreams.delete(requestId);
    }
  }

  private emitOverviewChunk(
    clientId: string,
    chunk: AskFollowUpChunk,
  ): void {
    this.emit("targeted-event", clientId, "overview.chunk", chunk);
  }

  releaseClient(clientId: string): void {
    const gitReleases = this.gitObservationReleases.get(clientId);
    if (gitReleases) {
      this.gitObservationReleases.delete(clientId);
      for (const release of gitReleases.values()) release();
    }
    const featureReleases = this.featureSubscriptionReleases.get(clientId);
    if (featureReleases) {
      this.featureSubscriptionReleases.delete(clientId);
      for (const release of featureReleases.values()) release();
    }
    this.cancelOverviewStreams(clientId, "client disconnected");
  }

  recoverClient(clientId: string): void {
    this.cancelOverviewStreams(
      clientId,
      "Overview stream interrupted by reconnect; ask the question again",
      true,
    );
  }

  private async gitCall(
    method: string,
    args: unknown[],
    clientId?: string,
  ): Promise<unknown> {
    try {
      validateGitRpcRequest(method, args[0]);
      switch (method) {
        case "status": {
          const request = args[0] as GitStatusRequest;
          await this.authorizeGitPath(request.cwd, request);
          return this.git.getStatus(request.cwd, request.force, request);
        }
        case "aheadBehind": {
          const request = args[0] as GitRepoRequest;
          await this.authorizeGitPath(request.repoPath, request);
          return this.git.getAheadBehind(request.repoPath, request.force, request);
        }
        case "shortstat": {
          const request = args[0] as GitRepoRequest;
          await this.authorizeGitPath(request.repoPath, request);
          return this.git.getShortstat(request.repoPath, request.force, request);
        }
        case "dirty": {
          const request = args[0] as GitRepoRequest;
          await this.authorizeGitPath(request.repoPath, request);
          return this.git.getDirty(request.repoPath, request.force, request);
        }
        case "worktrees": {
          const request = args[0] as GitRepoRequest;
          await this.authorizeGitPath(request.repoPath, request);
          return this.git.listWorktrees(request.repoPath, request.force, request);
        }
        case "branches": {
          const request = args[0] as GitRepoRequest;
          await this.authorizeGitPath(request.repoPath, request);
          return this.git.listLocalBranches(request.repoPath, request.force, request);
        }
        case "recentCommits": {
          const request = args[0] as GitRecentCommitsRequest;
          await this.authorizeGitPath(request.repoPath, request);
          return this.git.listRecentCommits(
            request.repoPath,
            request.limit,
            request.force,
            request,
          );
        }
        case "refHistory": {
          const request = args[0] as GitRefHistoryRequest;
          await this.authorizeGitPath(request.repoPath, request);
          return this.git.listRefHistory(
            request.repoPath,
            request.limit,
            request.force,
            request,
          );
        }
        case "commitsBetween": {
          const request = args[0] as CommitsBetweenRequest;
          await this.authorizeGitPath(request.cwd, request);
          await this.requireGitRefs(request.cwd, [request.base, request.head], request);
          const { commits, truncated } = await this.git.getCommitsBetween(
            request.cwd,
            request.base,
            request.head,
            request,
          );
          return {
            base: request.base,
            head: request.head,
            commits,
            truncated,
          };
        }
        case "rangeChanges": {
          const request = args[0] as RangeChangesRequest;
          await this.authorizeGitPath(request.cwd, request);
          await this.requireGitRefs(request.cwd, [request.base, request.head], request);
          return {
            base: request.base,
            head: request.head,
            changes: await this.git.getRangeChanges(
              request.cwd,
              request.base,
              request.head,
              request,
            ),
          };
        }
        case "resolveRefs": {
          const request = args[0] as ResolveRefsRequest;
          await this.authorizeGitPath(request.cwd, request);
          return {
            resolved: await this.git.resolveCommitRefs(
              request.cwd,
              request.refs,
              request,
            ),
          };
        }
        case "checkout": {
          const request = args[0] as GitCheckoutRequest;
          await this.authorizeGitPath(request.repoPath, request);
          await this.requireGitRefs(request.repoPath, [request.ref], request);
          return this.git.checkout(
            request.repoPath,
            request.ref,
            request.force,
            request,
          );
        }
        case "createWorktree": {
          const request = args[0] as GitCreateWorktreeRequest;
          await this.authorizeGitPath(request.repoPath, request);
          validateWorktreeTarget(request.repoPath, request.path);
          await this.requireGitRefs(request.repoPath, [request.baseRef], request);
          return this.git.createWorktree(
            request.repoPath,
            request.path,
            request.branch,
            request.baseRef,
            request,
          );
        }
        case "workingChanges": {
          const request = args[0] as WorkingChangesRequest;
          await this.authorizeGitPath(request.cwd, request);
          return this.git.listWorkingChanges(request.cwd, request);
        }
        case "workingTreeSnapshot": {
          const request = args[0] as WorkingTreeSnapshotRequest;
          await this.authorizeGitPath(request.cwd, request);
          return this.git.getWorkingTreeSnapshot(
            request.cwd,
            request.force,
            request,
          );
        }
        case "setObservationDemand":
          return this.setGitObservationDemand(
            clientId,
            args[0] as GitObservationDemandRequest,
          );
        case "fileDiff": {
          const request = args[0] as FileDiffRequest;
          await this.authorizeGitPath(request.cwd, request);
          validateGitRelativePaths([request.path, request.fromPath]);
          if (request.base && request.head) {
            await this.requireGitRefs(
              request.cwd,
              [request.base, request.head],
              request,
            );
          }
          return this.git.getFileDiff(request.cwd, request.path, {
            fromPath: request.fromPath ?? null,
            contextLines: request.contextLines,
            untracked: request.untracked,
            base: request.base,
            head: request.head,
            context: request,
          });
        }
        case "reviewDiffs": {
          const request = args[0] as ReviewDiffsRequest;
          await this.authorizeGitPath(request.cwd, request);
          validateGitRelativePaths(
            request.files.flatMap((file) => [file.path, file.fromPath]),
          );
          if (request.base && request.head) {
            await this.requireGitRefs(
              request.cwd,
              [request.base, request.head],
              request,
            );
          }
          return this.git.getReviewDiffs(request.cwd, request.files, {
            contextLines: request.contextLines,
            base: request.base,
            head: request.head,
            context: request,
          });
        }
        case "fileBlame": {
          const request = args[0] as FileBlameRequest;
          await this.authorizeGitPath(request.cwd, request);
          validateGitRelativePaths([request.path]);
          await this.requireGitRefs(
            request.cwd,
            [request.head ?? "HEAD"],
            request,
          );
          return this.git.getFileBlame(
            request.cwd,
            request.path,
            request.head ?? "HEAD",
            request,
          );
        }
        case "fileLines": {
          const request = args[0] as FileLinesRequest;
          await this.authorizeGitPath(request.cwd, request);
          validateGitRelativePaths([request.path]);
          if (request.revision.kind === "commit") {
            await this.requireGitRefs(
              request.cwd,
              [request.revision.sha],
              request,
            );
          }
          return this.git.getFileLines(
            request.cwd,
            request.path,
            request.startLine,
            request.endLine,
            { revision: request.revision, context: request },
          );
        }
        case "stageFiles":
        case "unstageFiles": {
          const request = args[0] as StageFilesRequest;
          await this.authorizeGitPath(request.cwd, request);
          validateGitRelativePaths(request.paths);
          if (method === "stageFiles") {
            await this.git.stageFiles(request.cwd, request.paths, request);
          } else {
            await this.git.unstageFiles(request.cwd, request.paths, request);
          }
          return true;
        }
        case "discardFiles": {
          const request = args[0] as DiscardFilesRequest;
          await this.authorizeGitPath(request.cwd, request);
          validateGitRelativePaths(
            request.files.flatMap((file) => [file.path, file.fromPath]),
          );
          await this.git.discardFiles(request.cwd, request.files, request);
          return true;
        }
        case "commit": {
          const request = args[0] as GitCommitRequest;
          await this.authorizeGitPath(request.cwd, request);
          return this.git.commit(
            request.cwd,
            request.message,
            request.stageAll ?? false,
            request,
          );
        }
        case "push":
        case "pull":
        case "fetch": {
          const request = args[0] as GitRemoteOpRequest;
          await this.authorizeGitPath(request.cwd, request);
          if (method === "push") {
            return this.git.push(
              request.cwd,
              request.remote,
              request.branch,
              request.setUpstream ?? false,
              request,
            );
          }
          if (method === "pull") {
            return this.git.pull(
              request.cwd,
              request.remote,
              request.branch,
              request,
            );
          }
          return this.git.fetch(request.cwd, request.remote, request);
        }
        default:
          throw unsupportedRpc("git", method);
      }
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw structuredGitError(error);
    }
  }

  private async authorizeGitPath(
    cwd: string,
    context: Pick<WorktreeScope, "runMode" | "wslDistro">,
  ): Promise<void> {
    const runMode = context.runMode ?? hostPlatform();
    const authorized = await this.isAuthorizedWorktree({
      cwd,
      runMode,
      ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
    });
    if (!authorized) {
      throw new RpcError(
        "worktree_not_authorized",
        "The requested Git Worktree is not registered with this Soloe backend",
      );
    }
  }

  private async requireGitRefs(
    cwd: string,
    refs: string[],
    context: Pick<WorktreeScope, "runMode" | "wslDistro">,
  ): Promise<void> {
    const resolved = await this.git.resolveCommitRefs(cwd, refs, context);
    const missing = refs.find((_ref, index) => resolved[index] === null);
    if (missing) {
      throw new RpcError(
        "invalid_revision",
        `Git revision could not be resolved: ${missing}`,
      );
    }
  }

  private async setGitObservationDemand(
    clientId: string | undefined,
    request: GitObservationDemandRequest,
  ): Promise<true> {
    if (!clientId) {
      throw new RpcError(
        "client_identity_required",
        "Git observation demand requires a client identity",
      );
    }
    await this.authorizeGitPath(request.cwd, request);
    const key = worktreeIdentityKey(request.cwd, request);
    let releases = this.gitObservationReleases.get(clientId);
    if (!releases) {
      if (!request.active) return true;
      releases = new Map();
      this.gitObservationReleases.set(clientId, releases);
    }
    const existing = releases.get(key);
    if (request.active) {
      if (!existing) {
        releases.set(
          key,
          await this.git.acquireObservation(request.cwd, request),
        );
      }
    } else if (existing) {
      existing();
      releases.delete(key);
      if (releases.size === 0) {
        this.gitObservationReleases.delete(clientId);
      }
    }
    return true;
  }

  private async filesCall(method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "search":
        return this.files.search(args[0] as FileSearchRequest);
      case "openInEditor":
        requireArgumentCount("files.openInEditor", args, 1);
        return this.files.openInEditor(validateFileOpenRequest(args[0]));
      case "pasteIntoTerminal":
        return this.files.pasteIntoTerminal(args[0] as FilePasteRequest);
      case "pasteImagesIntoTerminal":
        return this.files.pasteImagesIntoTerminal(args[0] as ImagePasteRequest);
      case "listTree":
        return this.files.listTree(args[0] as FileTreeRequest);
      case "readFile":
        return this.files.readFile(args[0] as FileReadRequest);
      case "writeFile":
        return this.files.writeFile(args[0] as FileWriteRequest);
      default:
        throw unsupportedRpc("files", method);
    }
  }

  private async notesCall(method: string, args: unknown[]): Promise<unknown> {
    if (!NOTES_RPC_METHODS.has(method)) {
      throw unsupportedRpc("notes", method);
    }
    if (method === "readImage") {
      return this.notes.readImage(
        requireNotesString(args[0], "absolutePath", 16_384),
      );
    }
    const projectId = requireNotesString(args[0], "projectId", 256) as ProjectId;
    if (!(await this.projects.get(projectId))) {
      throw new RpcError(
        "project_not_found",
        "The requested Notes project is not registered with this Soloe backend",
      );
    }
    switch (method) {
      case "list":
        return this.notes.list(projectId);
      case "read":
        return this.notes.read(
          projectId,
          requireNotesString(args[1], "filename", 256),
        );
      case "write":
        return this.notes.write(
          projectId,
          requireNotesString(args[1], "filename", 256),
          requireNotesString(args[2], "content", 1024 * 1024, true),
          args[3] as string | null | undefined,
        );
      case "rename":
        return this.notes.rename(
          projectId,
          requireNotesString(args[1], "oldName", 256),
          requireNotesString(args[2], "newName", 256),
        );
      case "delete":
        await this.notes.delete(
          projectId,
          requireNotesString(args[1], "filename", 256),
        );
        return true;
      case "saveImage":
        return this.notes.saveImage(
          projectId,
          requireNotesString(args[1], "mimeType", 128),
          requireNotesString(args[2], "dataBase64", 30 * 1024 * 1024),
        );
      case "cleanupImages": {
        if (!Array.isArray(args[1]) || args[1].length > 1_000) {
          throw new RpcError(
            "invalid_notes_request",
            "extraReferences must be a bounded string array",
          );
        }
        return this.notes.cleanupImages(
          projectId,
          args[1].map((value) =>
            requireNotesString(value, "extraReferences", 1024 * 1024, true),
          ),
        );
      }
    }
  }

  private async featuresCall(
    method: string,
    args: unknown[],
    clientId?: string,
  ): Promise<unknown> {
    if (!FEATURE_RPC_METHODS.has(method)) {
      throw unsupportedRpc("features", method);
    }
    const request = validateFeatureRequest(args[0]);
    await this.authorizeGitPath(request.cwd, request);
    switch (method) {
      case "scan":
        return this.features.scan(request as FeatureScanRequest);
      case "setBranchStatus":
        return this.features.writeBranchStatus(
          request as unknown as FeatureSetBranchStatusRequest,
        );
      case "setIssueStatus":
        return this.features.writeIssueStatus(
          request as unknown as FeatureSetIssueStatusRequest,
        );
      case "subscribe":
        return this.setFeatureSubscription(clientId, request, true);
      case "unsubscribe":
        return this.setFeatureSubscription(clientId, request, false);
    }
  }

  private setFeatureSubscription(
    clientId: string | undefined,
    request: {
      cwd: string;
      runMode: NonNullable<WorktreeScope["runMode"]>;
      wslDistro?: string;
    },
    active: boolean,
  ): true {
    if (!clientId) {
      throw new RpcError(
        "client_identity_required",
        "Feature subscriptions require a client identity",
      );
    }
    const key = worktreeIdentityKey(request.cwd, request);
    let releases = this.featureSubscriptionReleases.get(clientId);
    if (!releases) {
      if (!active) return true;
      releases = new Map();
      this.featureSubscriptionReleases.set(clientId, releases);
    }
    const existing = releases.get(key);
    if (active) {
      existing?.();
      releases.set(key, this.featureArtifacts.acquire(request));
    } else if (existing) {
      existing();
      releases.delete(key);
      if (releases.size === 0) {
        this.featureSubscriptionReleases.delete(clientId);
      }
    }
    return true;
  }

  private async isAuthorizedWorktree(scope: FileIndexScope): Promise<boolean> {
    const [projects, sessions] = await Promise.all([
      this.projects.list(),
      this.sessions.list(),
    ]);
    if (projects.some((project) => sameLogicalPath(project.path, scope.cwd))) {
      return true;
    }
    return sessions.some(
      (session) =>
        sameLogicalPath(session.cwd, scope.cwd) &&
        sameWorktreePlacement(session, scope),
    );
  }

  private async isAuthorizedVaultScope(cwd: string): Promise<boolean> {
    const [projects, sessions] = await Promise.all([
      this.projects.list(),
      this.sessions.list(),
    ]);
    return (
      projects.some((project) => sameLogicalPath(project.path, cwd)) ||
      sessions.some((session) => sameLogicalPath(session.cwd, cwd))
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
      ...(this.agentBridgeInfo ? { bridge: this.agentBridgeInfo } : {}),
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
    const publicSpec = {
      ...spec,
      env: { ...spec.env },
    };
    delete publicSpec.env.SOLOE_BRIDGE_TOKEN;
    return {
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      pid: terminal.pid,
      spec: publicSpec,
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

function validateCommentsResponse(value: unknown): CommentsRpcResponse {
  const response = requireBridgeRecord(value, "comments response");
  requireBridgeKeys(response, ["requestId", "result"], "comments response");
  const requestId = requireBridgeRequestId(response.requestId);
  const result = requireBridgeRecord(response.result, "comments result");
  if (result.ok === true) {
    requireBridgeKeys(result, ["ok"], "successful comments result");
    return { requestId, result: { ok: true } };
  }
  if (result.ok === false) {
    requireBridgeKeys(result, ["ok", "error"], "failed comments result");
    return {
      requestId,
      result: {
        ok: false,
        error: requireBridgeString(result.error, "comments error", 2_048),
      },
    };
  }
  throw invalidBridgeResponse("Comments result must contain a boolean ok field");
}

function validateDiffResponse(value: unknown): DiffRpcResponse {
  const response = requireBridgeRecord(value, "diff response");
  requireBridgeKeys(response, ["requestId", "result"], "diff response");
  const requestId = requireBridgeRequestId(response.requestId);
  const result = requireBridgeRecord(response.result, "diff result");
  if (result.ok === false) {
    requireBridgeKeys(result, ["ok", "error"], "failed diff result");
    return {
      requestId,
      result: {
        ok: false,
        error: requireBridgeString(result.error, "diff error", 2_048),
      },
    };
  }
  if (result.ok !== true) {
    throw invalidBridgeResponse("Diff result must contain a boolean ok field");
  }
  requireBridgeKeys(
    result,
    ["ok", "sessionId", "cwd", "base", "head", "commitCount"],
    "successful diff result",
  );
  if (
    typeof result.commitCount !== "number" ||
    !Number.isInteger(result.commitCount) ||
    result.commitCount < 0 ||
    result.commitCount > 10_000
  ) {
    throw invalidBridgeResponse(
      "Diff commitCount must be an integer from 0 to 10000",
    );
  }
  return {
    requestId,
    result: {
      ok: true,
      sessionId: requireBridgeString(result.sessionId, "diff sessionId", 256),
      cwd: requireBridgeString(result.cwd, "diff cwd", 16_384),
      base: requireBridgeString(result.base, "diff base", 1_024),
      head: requireBridgeString(result.head, "diff head", 1_024),
      commitCount: result.commitCount,
    },
  };
}

function requireBridgeRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBridgeResponse(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBridgeKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expected.includes(key))
  ) {
    throw invalidBridgeResponse(`${name} contains unexpected fields`);
  }
}

function requireBridgeRequestId(value: unknown): string {
  const requestId = requireBridgeString(value, "bridge requestId", 128);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      requestId,
    )
  ) {
    throw invalidBridgeResponse("Bridge requestId must be a UUID");
  }
  return requestId;
}

function requireBridgeString(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw invalidBridgeResponse(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function invalidBridgeResponse(message: string): RpcError {
  return new RpcError("invalid_bridge_response", message);
}

function sameSessionPath(value: string, session: Session): boolean {
  const normalize = (candidate: string): string => {
    const trimmed = candidate.trim().replace(/\\/gu, "/").replace(/\/+$/gu, "");
    return session.runMode === "windows"
      ? trimmed.toLocaleLowerCase("en-US")
      : trimmed;
  };
  return normalize(value) === normalize(session.cwd);
}

function requireIntegrationArgumentCount(
  method: string,
  args: unknown[],
  expected: number,
): void {
  if (args.length !== expected) {
    throw new RpcError(
      "invalid_integration_request",
      `agentIntegration.${method} expects ${expected} argument${expected === 1 ? "" : "s"}`,
    );
  }
}

function validateIntegrationRequest(value: unknown): AgentIntegrationHostKey {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidIntegrationRequest("Agent integration request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).some((key) => key !== "host") ||
    !request.host ||
    typeof request.host !== "object" ||
    Array.isArray(request.host)
  ) {
    throw invalidIntegrationRequest(
      "Agent integration request must contain only a host object",
    );
  }
  const host = request.host as Record<string, unknown>;
  if (
    Object.keys(host).some((key) => key !== "kind" && key !== "distro") ||
    (host.kind !== "windows" && host.kind !== "linux" && host.kind !== "wsl")
  ) {
    throw invalidIntegrationRequest("Agent integration host is invalid");
  }
  if (host.kind !== "wsl") {
    if (host.distro !== undefined) {
      throw invalidIntegrationRequest(
        "Only a WSL integration host may specify a distro",
      );
    }
    return { kind: host.kind };
  }
  if (
    typeof host.distro !== "string" ||
    !host.distro.trim() ||
    host.distro.length > 256 ||
    host.distro.includes("\0") ||
    /[\\/]/u.test(host.distro)
  ) {
    throw invalidIntegrationRequest(
      "WSL integration host distro must be a bounded distro name",
    );
  }
  return { kind: "wsl", distro: host.distro };
}

function invalidIntegrationRequest(message: string): RpcError {
  return new RpcError("invalid_integration_request", message);
}

function structuredIntegrationError(error: unknown): RpcError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("Unknown host:")) {
    return new RpcError(
      "integration_host_not_found",
      "The selected integration host is not available on this backend",
    );
  }
  if (message.startsWith("Host is unavailable:")) {
    return new RpcError(
      "integration_host_unavailable",
      "The selected integration host is currently unavailable",
    );
  }
  return new RpcError(
    "integration_failed",
    "The backend could not update the selected agent integration",
  );
}

function portFromBridgeUrl(value: string): number | null {
  try {
    const port = Number(new URL(value).port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
  } catch {
    return null;
  }
}

function describeIntegrationHost(host: AgentIntegrationHostKey): string {
  return host.kind === "wsl" ? `wsl:${host.distro}` : host.kind;
}

function validateSystemSessionId(value: unknown): SessionId {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 256 ||
    value.includes("\0") ||
    /[\\/]/u.test(value)
  ) {
    throw new RpcError(
      "invalid_system_path_request",
      "system.openPath sessionId must be a bounded string",
    );
  }
  return value;
}

function validateFileOpenRequest(value: unknown): FileOpenRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(
      "invalid_file_request",
      "files.openInEditor request must be an object",
    );
  }
  const request = value as Record<string, unknown>;
  const allowed = new Set(["absolutePath", "cwd", "runMode", "wslDistro"]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw new RpcError(
      "invalid_file_request",
      "files.openInEditor request contains an unknown field",
    );
  }
  if (
    typeof request.absolutePath !== "string" ||
    typeof request.cwd !== "string" ||
    (request.runMode !== "linux" &&
      request.runMode !== "windows" &&
      request.runMode !== "wsl") ||
    (request.wslDistro !== undefined &&
      typeof request.wslDistro !== "string")
  ) {
    throw new RpcError(
      "invalid_file_request",
      "files.openInEditor request fields are invalid",
    );
  }
  return request as unknown as FileOpenRequest;
}

function validateSystemUsageRequest(value: unknown): SystemUsageRequest {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(
      "invalid_system_usage_request",
      "system.usage request must be an object",
    );
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.some((key) => key !== "detail")) {
    throw new RpcError(
      "invalid_system_usage_request",
      "system.usage request contains an unknown field",
    );
  }
  if (
    request.detail !== undefined &&
    request.detail !== "summary" &&
    request.detail !== "wsl"
  ) {
    throw new RpcError(
      "invalid_system_usage_request",
      "system.usage detail must be summary or wsl",
    );
  }
  return request as SystemUsageRequest;
}

function validateDiagnosticLogsRequest(
  value: unknown,
): DiagnosticLogsRequest {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(
      "invalid_diagnostics_request",
      "diagnostics.crashLogs request must be an object",
    );
  }
  const request = value as Record<string, unknown>;
  if (Object.keys(request).some((key) => key !== "tailBytes")) {
    throw new RpcError(
      "invalid_diagnostics_request",
      "diagnostics.crashLogs request contains an unknown field",
    );
  }
  if (
    request.tailBytes !== undefined &&
    (
      typeof request.tailBytes !== "number" ||
      !Number.isInteger(request.tailBytes) ||
      request.tailBytes < 0 ||
      request.tailBytes > 65_536
    )
  ) {
    throw new RpcError(
      "invalid_diagnostics_request",
      "tailBytes must be an integer from 0 to 65536",
    );
  }
  return request as DiagnosticLogsRequest;
}

const VAULT_RPC_METHODS = new Set([
  "list",
  "save",
  "update",
  "delete",
  "getSecret",
]);

function validateVaultRequest(
  method: string,
  value: unknown,
):
  | VaultListRequest
  | VaultSaveRequest
  | VaultUpdateRequest
  | VaultDeleteRequest
  | VaultGetSecretRequest {
  const request = requireVaultObject(
    value,
    "Vault request",
    method === "list"
      ? ["cwd"]
      : method === "save"
        ? ["cwd", "draft"]
        : method === "update"
          ? ["cwd", "id", "patch"]
          : ["cwd", "id"],
  );
  const cwd = requireVaultString(request.cwd, "cwd", 16_384);
  if (!path.posix.isAbsolute(cwd) && !path.win32.isAbsolute(cwd)) {
    throw invalidVaultRequest("cwd must be an absolute path");
  }
  if (method === "list") return { cwd };
  if (method === "save") {
    const draft = requireVaultObject(
      request.draft,
      "Vault draft",
      ["origin", "username", "password", "label"],
      ["label"],
    );
    return {
      cwd,
      draft: {
        origin: requireVaultString(draft.origin, "origin", 4_096),
        username: requireVaultString(draft.username, "username", 1_024),
        password: requireVaultString(draft.password, "password", 65_536),
        ...(draft.label === undefined
          ? {}
          : {
              label: requireVaultString(
                draft.label,
                "label",
                2_048,
                true,
              ),
            }),
      },
    };
  }
  const id = requireVaultString(request.id, "id", 16);
  if (!/^[0-9a-f]{16}$/u.test(id)) {
    throw invalidVaultRequest("Vault entry id is invalid");
  }
  if (method === "update") {
    const patch = requireVaultObject(
      request.patch,
      "Vault patch",
      ["username", "password", "label"],
      ["username", "password", "label"],
    );
    if (Object.keys(patch).length === 0) {
      throw invalidVaultRequest("Vault patch must contain a change");
    }
    return {
      cwd,
      id,
      patch: {
        ...(patch.username === undefined
          ? {}
          : {
              username: requireVaultString(
                patch.username,
                "username",
                1_024,
              ),
            }),
        ...(patch.password === undefined
          ? {}
          : {
              password: requireVaultString(
                patch.password,
                "password",
                65_536,
              ),
            }),
        ...(patch.label === undefined
          ? {}
          : {
              label: requireVaultString(
                patch.label,
                "label",
                2_048,
                true,
              ),
            }),
      },
    };
  }
  return { cwd, id };
}

function requireVaultObject(
  value: unknown,
  name: string,
  allowedKeys: string[],
  optionalKeys: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidVaultRequest(`${name} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const optional = new Set(optionalKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw invalidVaultRequest(`${name} contains an unknown field`);
  }
  if (
    allowedKeys.some(
      (key) => !optional.has(key) && record[key] === undefined,
    )
  ) {
    throw invalidVaultRequest(`${name} is missing a required field`);
  }
  return record;
}

function requireVaultString(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw invalidVaultRequest(`${name} must be a bounded string`);
  }
  return value;
}

function invalidVaultRequest(message: string): RpcError {
  return new RpcError("invalid_vault_request", message);
}

function validateOverviewRequest(
  value: unknown,
  followUp: false,
): GetOverviewRequest;
function validateOverviewRequest(
  value: unknown,
  followUp: true,
): AskFollowUpRequest;
function validateOverviewRequest(
  value: unknown,
  followUp: boolean,
): GetOverviewRequest | AskFollowUpRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(
      "invalid_overview_request",
      "Overview request must be an object",
    );
  }
  const request = value as Record<string, unknown>;
  const allowed = new Set([
    "worktreeCwd",
    "runMode",
    "wslDistro",
    "baseBranch",
    "sessions",
    ...(followUp ? ["message", "history"] : []),
  ]);
  if (Object.keys(request).some((key) => !allowed.has(key))) {
    throw new RpcError(
      "invalid_overview_request",
      "Overview request contains an unknown field",
    );
  }
  const worktreeCwd = requireRpcString(
    request.worktreeCwd,
    "worktreeCwd",
    4_096,
    "invalid_overview_request",
  );
  if (!path.posix.isAbsolute(worktreeCwd) && !path.win32.isAbsolute(worktreeCwd)) {
    throw new RpcError(
      "invalid_overview_request",
      "worktreeCwd must be an absolute path",
    );
  }
  const runMode = request.runMode;
  if (
    runMode !== undefined &&
    runMode !== "windows" &&
    runMode !== "linux" &&
    runMode !== "wsl"
  ) {
    throw new RpcError(
      "invalid_overview_request",
      "runMode must be windows, linux, or wsl",
    );
  }
  const wslDistro =
    request.wslDistro === undefined
      ? undefined
      : requireRpcString(
          request.wslDistro,
          "wslDistro",
          128,
          "invalid_overview_request",
        );
  if (runMode === "wsl" && !wslDistro) {
    throw new RpcError(
      "invalid_wsl_distribution",
      "wslDistro is required for a WSL Overview",
    );
  }
  if (runMode !== "wsl" && wslDistro !== undefined) {
    throw new RpcError(
      "invalid_overview_request",
      "wslDistro is only valid when runMode is wsl",
    );
  }
  const baseBranch =
    request.baseBranch === undefined
      ? undefined
      : requireRpcString(
          request.baseBranch,
          "baseBranch",
          4_096,
          "invalid_overview_request",
        );
  if (baseBranch && (baseBranch.startsWith("-") || /[\0\r\n]/u.test(baseBranch))) {
    throw new RpcError(
      "invalid_overview_request",
      "baseBranch is not a safe Git revision",
    );
  }
  let sessions: GetOverviewRequest["sessions"];
  if (request.sessions !== undefined) {
    if (!Array.isArray(request.sessions) || request.sessions.length > 64) {
      throw new RpcError(
        "invalid_overview_request",
        "sessions must contain at most 64 entries",
      );
    }
    sessions = request.sessions.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new RpcError(
          "invalid_overview_request",
          "each Overview session must be an object",
        );
      }
      const session = entry as Record<string, unknown>;
      if (
        Object.keys(session).some(
          (key) => key !== "transcriptPath" && key !== "name",
        )
      ) {
        throw new RpcError(
          "invalid_overview_request",
          "Overview session contains an unknown field",
        );
      }
      const transcriptPath = requireRpcString(
        session.transcriptPath,
        "transcriptPath",
        4_096,
        "invalid_overview_request",
      );
      if (
        !path.posix.isAbsolute(transcriptPath) &&
        !path.win32.isAbsolute(transcriptPath)
      ) {
        throw new RpcError(
          "invalid_overview_request",
          "transcriptPath must be absolute",
        );
      }
      return {
        transcriptPath,
        name: requireRpcString(
          session.name,
          "session name",
          256,
          "invalid_overview_request",
        ),
      };
    });
  }
  const common: GetOverviewRequest = {
    worktreeCwd,
    ...(runMode ? { runMode } : {}),
    ...(wslDistro ? { wslDistro } : {}),
    ...(baseBranch ? { baseBranch } : {}),
    ...(sessions ? { sessions } : {}),
  };
  if (!followUp) return common;

  const message = requireRpcString(
    request.message,
    "message",
    32_768,
    "invalid_overview_request",
  );
  if (!Array.isArray(request.history) || request.history.length > 50) {
    throw new RpcError(
      "invalid_overview_request",
      "history must contain at most 50 messages",
    );
  }
  const history = request.history.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RpcError(
        "invalid_overview_request",
        "each history entry must be an object",
      );
    }
    const messageEntry = entry as Record<string, unknown>;
    if (
      Object.keys(messageEntry).some(
        (key) => key !== "role" && key !== "content",
      ) ||
      (messageEntry.role !== "user" && messageEntry.role !== "assistant")
    ) {
      throw new RpcError(
        "invalid_overview_request",
        "history roles must be user or assistant",
      );
    }
    return {
      role: messageEntry.role as "user" | "assistant",
      content: requireRpcString(
        messageEntry.content,
        "history content",
        32_768,
        "invalid_overview_request",
      ),
    };
  });
  return { ...common, message, history };
}

function requireRpcString(
  value: unknown,
  name: string,
  maximum: number,
  code: string,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new RpcError(code, `${name} must be a non-empty bounded string`);
  }
  return value;
}

function requireArgumentCount(
  method: string,
  args: unknown[],
  expected: number,
): void {
  if (args.length !== expected) {
    throw new RpcError(
      "invalid_rpc_arguments",
      `${method} expects ${expected} arguments`,
    );
  }
}

function detectBackendPlacement(): "native" | "wsl" {
  return process.platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) || Boolean(process.env.WSL_INTEROP))
    ? "wsl"
    : "native";
}

function sameLogicalPath(left: string, right: string): boolean {
  const windowsPath =
    /^[a-zA-Z]:[\\/]/u.test(left) ||
    /^[a-zA-Z]:[\\/]/u.test(right) ||
    left.startsWith("\\\\") ||
    right.startsWith("\\\\");
  const pathApi = windowsPath ? path.win32 : path.posix;
  const normalizedLeft = pathApi.normalize(left).replace(/[\\/]+$/u, "");
  const normalizedRight = pathApi.normalize(right).replace(/[\\/]+$/u, "");
  return windowsPath
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameWorktreePlacement(
  session: Pick<Session, "runMode" | "wslDistro">,
  scope: WorktreeScope,
): boolean {
  if (session.runMode !== scope.runMode) return false;
  if (session.runMode !== "wsl") return true;
  return session.wslDistro?.trim() === scope.wslDistro?.trim();
}

const NOTES_RPC_METHODS = new Set([
  "list",
  "read",
  "write",
  "rename",
  "delete",
  "saveImage",
  "readImage",
  "cleanupImages",
]);
const FEATURE_RPC_METHODS = new Set([
  "scan",
  "setBranchStatus",
  "setIssueStatus",
  "subscribe",
  "unsubscribe",
]);

function validateFeatureRequest(value: unknown): Record<string, unknown> & {
  cwd: string;
  runMode: NonNullable<WorktreeScope["runMode"]>;
  wslDistro?: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RpcError(
      "invalid_feature_request",
      "Feature RPC calls require a request object",
    );
  }
  const request = value as Record<string, unknown>;
  const cwd = requireNotesString(request.cwd, "cwd", 16_384);
  if (
    request.runMode !== "windows" &&
    request.runMode !== "linux" &&
    request.runMode !== "wsl"
  ) {
    throw new RpcError("invalid_feature_request", "runMode is invalid");
  }
  const wslDistro =
    request.wslDistro === undefined
      ? undefined
      : requireNotesString(request.wslDistro, "wslDistro", 128);
  if (request.runMode === "wsl" && !wslDistro) {
    throw new RpcError(
      "invalid_feature_request",
      "wslDistro is required for WSL Feature requests",
    );
  }
  for (const [name, maximum] of [
    ["slug", 128],
    ["observedRevision", 256],
    ["branchId", 128],
    ["relativePath", 16_384],
    ["status", 256],
  ] as const) {
    if (request[name] !== undefined) {
      requireNotesString(request[name], name, maximum);
    }
  }
  return {
    ...request,
    cwd,
    runMode: request.runMode,
    ...(wslDistro ? { wslDistro } : {}),
  };
}

function requireNotesString(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new RpcError(
      "invalid_notes_request",
      `${name} must be a bounded string`,
    );
  }
  return value;
}

function validateGitRelativePaths(
  values: Array<string | null | undefined>,
): void {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (
      !value.trim() ||
      value.includes("\0") ||
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      value.split(/[\\/]/u).includes("..")
    ) {
      throw new RpcError(
        "invalid_git_path",
        "Git file paths must be non-empty Worktree-relative paths",
      );
    }
  }
}

const GIT_REPO_PATH_METHODS = new Set([
  "aheadBehind",
  "shortstat",
  "dirty",
  "worktrees",
  "branches",
  "recentCommits",
  "refHistory",
  "checkout",
  "createWorktree",
]);
const GIT_CWD_METHODS = new Set([
  "status",
  "commitsBetween",
  "rangeChanges",
  "resolveRefs",
  "workingChanges",
  "workingTreeSnapshot",
  "setObservationDemand",
  "fileDiff",
  "reviewDiffs",
  "fileBlame",
  "fileLines",
  "stageFiles",
  "unstageFiles",
  "discardFiles",
  "commit",
  "push",
  "pull",
  "fetch",
]);

function validateGitRpcRequest(method: string, value: unknown): void {
  if (!GIT_REPO_PATH_METHODS.has(method) && !GIT_CWD_METHODS.has(method)) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidGitRequest("Git RPC calls require a request object");
  }
  const request = value as Record<string, unknown>;
  const rootKey = GIT_REPO_PATH_METHODS.has(method) ? "repoPath" : "cwd";
  requireBoundedString(request[rootKey], rootKey, 16_384);
  validateGitContext(request);

  switch (method) {
    case "recentCommits":
    case "refHistory":
      optionalBoundedInteger(request.limit, "limit", 1, 1_000);
      break;
    case "checkout":
      validateGitOperand(request.ref, "ref");
      optionalBoolean(request.force, "force");
      break;
    case "createWorktree":
      requireBoundedString(request.path, "path", 16_384);
      validateGitOperand(request.branch, "branch");
      validateGitOperand(request.baseRef, "baseRef");
      break;
    case "commitsBetween":
    case "rangeChanges":
      validateGitOperand(request.base, "base");
      validateGitOperand(request.head, "head");
      break;
    case "resolveRefs":
      validateGitOperands(request.refs, "refs", 500);
      break;
    case "setObservationDemand":
      if (typeof request.active !== "boolean") {
        throw invalidGitRequest("active must be a boolean");
      }
      break;
    case "fileDiff":
      validateGitRelativePaths([
        requireBoundedString(request.path, "path", 16_384),
        optionalBoundedString(request.fromPath, "fromPath", 16_384),
      ]);
      validateOptionalRange(request);
      optionalBoundedInteger(request.contextLines, "contextLines", 0, 10_000);
      break;
    case "reviewDiffs": {
      const files = requireBoundedArray(request.files, "files", 500);
      for (const file of files) {
        if (!file || typeof file !== "object" || Array.isArray(file)) {
          throw invalidGitRequest("files entries must be objects");
        }
        const target = file as Record<string, unknown>;
        validateGitRelativePaths([
          requireBoundedString(target.path, "files.path", 16_384),
          optionalBoundedString(target.fromPath, "files.fromPath", 16_384),
        ]);
      }
      validateOptionalRange(request);
      optionalBoundedInteger(request.contextLines, "contextLines", 0, 10_000);
      break;
    }
    case "fileBlame":
      validateGitRelativePaths([
        requireBoundedString(request.path, "path", 16_384),
      ]);
      if (request.head !== undefined) validateGitOperand(request.head, "head");
      break;
    case "fileLines": {
      validateGitRelativePaths([
        requireBoundedString(request.path, "path", 16_384),
      ]);
      const start = requireBoundedInteger(request.startLine, "startLine", 1, 10_000_000);
      const end = requireBoundedInteger(request.endLine, "endLine", start, 10_000_000);
      if (end - start > 10_000) {
        throw invalidGitRequest("fileLines ranges may contain at most 10001 lines");
      }
      const revision = request.revision;
      if (!revision || typeof revision !== "object" || Array.isArray(revision)) {
        throw invalidGitRequest("revision must identify head or a canonical commit");
      }
      const revisionValue = revision as Record<string, unknown>;
      if (revisionValue.kind === "head") break;
      if (
        revisionValue.kind !== "commit" ||
        typeof revisionValue.sha !== "string" ||
        !/^[0-9a-f]{40}$/iu.test(revisionValue.sha)
      ) {
        throw invalidGitRequest("commit revisions must use a canonical 40-character SHA");
      }
      break;
    }
    case "stageFiles":
    case "unstageFiles":
      validateGitRelativePaths(
        validateStringArray(request.paths, "paths", 1_000),
      );
      break;
    case "discardFiles": {
      const files = requireBoundedArray(request.files, "files", 1_000);
      for (const file of files) {
        if (!file || typeof file !== "object" || Array.isArray(file)) {
          throw invalidGitRequest("files entries must be objects");
        }
        const target = file as Record<string, unknown>;
        validateGitRelativePaths([
          requireBoundedString(target.path, "files.path", 16_384),
          optionalBoundedString(target.fromPath, "files.fromPath", 16_384),
        ]);
        if (
          !["added", "modified", "deleted", "renamed", "copied", "untracked"].includes(
            String(target.kind),
          )
        ) {
          throw invalidGitRequest("files.kind is invalid");
        }
      }
      break;
    }
    case "commit":
      requireBoundedString(request.message, "message", 100_000);
      optionalBoolean(request.stageAll, "stageAll");
      break;
    case "push":
    case "pull":
    case "fetch":
      if (request.remote !== undefined) validateGitOperand(request.remote, "remote");
      if (request.branch !== undefined) validateGitOperand(request.branch, "branch");
      optionalBoolean(request.setUpstream, "setUpstream");
      break;
  }
}

function validateGitContext(request: Record<string, unknown>): void {
  if (
    request.runMode !== undefined &&
    request.runMode !== "windows" &&
    request.runMode !== "linux" &&
    request.runMode !== "wsl"
  ) {
    throw invalidGitRequest("runMode is invalid");
  }
  if (request.wslDistro !== undefined) {
    requireBoundedString(request.wslDistro, "wslDistro", 128);
  }
  if (request.runMode === "wsl" && request.wslDistro === undefined) {
    throw invalidGitRequest("wslDistro is required for WSL Git requests");
  }
}

function validateOptionalRange(request: Record<string, unknown>): void {
  const hasBase = request.base !== undefined;
  const hasHead = request.head !== undefined;
  if (hasBase !== hasHead) {
    throw invalidGitRequest("base and head must be provided together");
  }
  if (hasBase) {
    validateGitOperand(request.base, "base");
    validateGitOperand(request.head, "head");
  }
}

function validateGitOperand(value: unknown, name: string): string {
  const operand = requireBoundedString(value, name, 4_096);
  if (operand.startsWith("-") || /[\0\r\n]/u.test(operand)) {
    throw invalidGitRequest(`${name} is not a safe Git argument`);
  }
  return operand;
}

function validateGitOperands(
  value: unknown,
  name: string,
  maximum: number,
): string[] {
  const operands = validateStringArray(value, name, maximum);
  for (const operand of operands) validateGitOperand(operand, name);
  return operands;
}

function validateStringArray(
  value: unknown,
  name: string,
  maximum: number,
): string[] {
  const values = requireBoundedArray(value, name, maximum);
  return values.map((entry) => requireBoundedString(entry, name, 16_384));
}

function requireBoundedArray(
  value: unknown,
  name: string,
  maximum: number,
): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidGitRequest(`${name} must be an array with at most ${maximum} entries`);
  }
  return value;
}

function optionalBoundedString(
  value: unknown,
  name: string,
  maximum: number,
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : requireBoundedString(value, name, maximum);
}

function requireBoundedString(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw invalidGitRequest(`${name} must be a non-empty bounded string`);
  }
  return value;
}

function optionalBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (value !== undefined) {
    requireBoundedInteger(value, name, minimum, maximum);
  }
}

function requireBoundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidGitRequest(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function optionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw invalidGitRequest(`${name} must be a boolean`);
  }
}

function invalidGitRequest(message: string): RpcError {
  return new RpcError("invalid_git_request", message);
}

function validateWorktreeTarget(repoPath: string, targetPath: string): void {
  const windowsPath =
    /^[a-zA-Z]:[\\/]/u.test(repoPath) || repoPath.startsWith("\\\\");
  const pathApi = windowsPath ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(targetPath)) {
    throw new RpcError(
      "invalid_worktree_path",
      "A new Worktree path must be absolute",
    );
  }
  const repoParent = pathApi.dirname(pathApi.resolve(repoPath));
  const targetParent = pathApi.dirname(pathApi.resolve(targetPath));
  if (
    (windowsPath
      ? repoParent.toLowerCase() !== targetParent.toLowerCase()
      : repoParent !== targetParent) ||
    pathApi.basename(targetPath) === ""
  ) {
    throw new RpcError(
      "worktree_path_not_authorized",
      "A new Worktree must be created as a sibling of the authorized repository",
    );
  }
}

function structuredGitError(error: unknown): RpcError {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (lower.includes("not a git repository")) {
    return new RpcError("repository_not_found", message);
  }
  if (
    lower.includes("unknown revision") ||
    lower.includes("bad revision") ||
    lower.includes("invalid object") ||
    lower.includes("not a valid object") ||
    lower.includes("ambiguous argument")
  ) {
    return new RpcError("invalid_revision", message);
  }
  if (
    lower.includes("would be overwritten") ||
    lower.includes("uncommitted changes")
  ) {
    return new RpcError("dirty_checkout", message);
  }
  if (
    lower.includes("conflict") ||
    lower.includes("automatic merge failed") ||
    lower.includes("not possible to fast-forward")
  ) {
    return new RpcError("git_conflict", message);
  }
  if (
    lower.includes("authentication failed") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("could not read username")
  ) {
    return new RpcError("authentication_failed", message);
  }
  if (
    lower.includes("could not resolve host") ||
    lower.includes("failed to connect") ||
    lower.includes("does not appear to be a git repository") ||
    lower.includes("could not read from remote repository") ||
    lower.includes("remote:")
  ) {
    return new RpcError("remote_failure", message);
  }
  return new RpcError("git_failed", message);
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
