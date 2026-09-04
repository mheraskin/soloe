import type {
  DeviceDescriptor,
  DeviceEventEnvelope,
  DeviceId,
  DevicePortForwardResult,
  ProjectRef,
  SessionRef,
  TerminalRef
} from '@shared/types/devices.js';
import type { GitWorktree } from '@shared/types/git.js';
import type {
  LocalhostBridge,
  OpenLocalhostBridgeRequest,
  ShortDnsInfo
} from '@shared/types/connections.js';
import type {
  DeviceImagePasteRequest,
  ImagePasteRequest,
  ImagePasteResult
} from '@shared/types/files.js';
import type { Project, ProjectOpenRequest, ProjectUpdate } from '@shared/types/projects.js';
import type {
  Session,
  SessionDraft,
  SessionId,
  SessionRuntimeState,
  SessionUpdate
} from '@shared/types/sessions.js';
import type {
  SpawnSpec,
  TerminalControlProof,
  TerminalInputLease,
  TerminalStartResult
} from '@shared/types/terminal.js';
import type {
  DevicePlacedSessionRequest,
  DeviceWorkspaceIntent,
  DeviceWorkspacePlan,
  WorkspaceDirectoryListing,
  RepositoryIdentity
} from '@shared/types/workspaces.js';
import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalhostBridgeManager } from '@soloe/domain';
import { DEVICE_WORKTREE_RPC_METHODS } from '@shared/api-contract.js';
import type {
  CreateMultiDeviceSessionRequest,
  DeviceProjectInventory,
  DeviceSessionInventory,
  DeviceTerminalHistory,
  DeviceWorktreeInvokeRequest,
  MultiDeviceSessionCreationPlan,
  MultiDeviceSessionState,
  MultiDeviceSessionView,
  ProjectView,
  SessionDeviceView,
  WorkspaceLocationView,
  ProjectPresenceView,
  WorkspaceView
} from '@shared/types/multi-device-sessions.js';
export type {
  CreateMultiDeviceSessionRequest,
  DeviceProjectInventory,
  DeviceSessionInventory,
  DeviceTerminalHistory,
  MultiDeviceSessionState,
  MultiDeviceSessionView,
  ProjectView,
  SessionDeviceView,
  WorkspaceLocationView,
  ProjectPresenceView,
  WorkspaceView
} from '@shared/types/multi-device-sessions.js';

export interface SessionDeviceStatus {
  deviceId: DeviceId;
  state: 'idle' | 'connecting' | 'ready' | 'offline' | 'incompatible' | 'disposed';
  descriptor: DeviceDescriptor | null;
  error?: string;
}

export interface SessionDevice {
  readonly deviceId: DeviceId;
  readonly displayName?: string;
  readonly local: boolean;
  readonly status: SessionDeviceStatus;
  connect(): Promise<SessionDeviceStatus>;
  readInventory(): Promise<DeviceSessionInventory>;
  reorderSessions(orderedIds: SessionId[]): Promise<Session[]>;
  setTerminalOutputDemand(terminalIds: ReadonlySet<string>): Promise<void>;
  terminalInput(terminalId: string, data: string, control: TerminalControlProof): Promise<void>;
  pasteImagesIntoTerminal(request: ImagePasteRequest): Promise<ImagePasteResult>;
  invokeWorktree?(request: DeviceWorktreeInvokeRequest): Promise<unknown>;
  modelCatalog?(): Promise<import('@shared/types/settings.js').ModelCatalogEntry[]>;
  terminalAcquireInputLease?(
    terminalId: string,
    takeover?: boolean,
    controller?: { deviceId: string; deviceName: string }
  ): Promise<TerminalInputLease>;
  terminalCurrentInputLease(terminalId: string): Promise<TerminalInputLease | null>;
  terminalReleaseInputLease(terminalId: string, control: TerminalControlProof): Promise<boolean>;
  terminalParkInputLease(terminalId: string, control: TerminalControlProof): Promise<boolean>;
  terminalResize(
    terminalId: string,
    cols: number,
    rows: number,
    control: TerminalControlProof
  ): Promise<void>;
  terminalHistory(terminalId: string): Promise<DeviceTerminalHistory>;
  terminalStop(terminalId: string): Promise<void>;
  createSession?(request: DevicePlacedSessionRequest): Promise<Session>;
  startSession?(sessionId: string): Promise<TerminalStartResult>;
  updateSession?(sessionId: string, patch: SessionUpdate): Promise<Session>;
  deleteSession?(sessionId: string): Promise<void>;
  previewSessionCommand?(sessionId: string): Promise<SpawnSpec>;
  ensureTailscalePort?(port: number, virtualHostname?: string): Promise<DevicePortForwardResult>;
  setupShortDns?(): Promise<ShortDnsInfo>;
  removeShortDns?(): Promise<ShortDnsInfo>;
  workspacePlan?(intent: DeviceWorkspaceIntent): Promise<DeviceWorkspacePlan>;
  workspaceExecute?(
    command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
  ): Promise<DeviceOperationReceipt>;
  browseWorkspaceDirectories?(path?: string): Promise<WorkspaceDirectoryListing>;
  openProject?(request: ProjectOpenRequest): Promise<Project>;
  updateProject?(projectId: string, patch: ProjectUpdate): Promise<Project>;
  deleteProject?(projectId: string): Promise<void>;
  onEvent(listener: (event: DeviceEventEnvelope) => void): () => void;
  onStatus(listener: (status: SessionDeviceStatus) => void): () => void;
  dispose(): void | Promise<void>;
}

interface StoredSessionCreationPlan {
  public: MultiDeviceSessionCreationPlan;
  request: CreateMultiDeviceSessionRequest;
  devicePlan: DeviceWorkspacePlan | null;
}

export type LocalhostBridgeController = Pick<
  LocalhostBridgeManager,
  'list' | 'open' | 'close' | 'dispose'
>;

export const DEFAULT_DEVICE_POLL_INTERVAL_MS = 60_000;

export interface MultiDeviceSessionsOptions {
  devices: SessionDevice[];
  localhostBridges?: LocalhostBridgeController;
  pollIntervalMs?: number;
}

export class MultiDeviceSessions {
  private devices: SessionDevice[];
  private readonly inventories = new Map<DeviceId, DeviceSessionInventory>();
  private readonly stateListeners = new Set<(state: MultiDeviceSessionState) => void>();
  private readonly eventListeners = new Set<(event: DeviceEventEnvelope) => void>();
  private readonly deviceDetachers = new Map<DeviceId, {
    device: SessionDevice;
    detach: Array<() => void>;
  }>();
  private readonly creationPlans = new Map<string, StoredSessionCreationPlan>();
  private terminalOutputDemand = new Map<DeviceId, Set<string>>();
  private readonly clientId = randomUUID();
  private readonly devicePollTimers = new Map<DeviceId, NodeJS.Timeout>();
  private readonly pollIntervalMs: number;
  private refreshRequest: Promise<MultiDeviceSessionState> | null = null;
  private eventRefreshScheduled = false;
  private refreshAfterCurrent = false;
  private revision = 0;
  private currentState: MultiDeviceSessionState;
  private readonly localhostBridges: LocalhostBridgeController;

  constructor(options: MultiDeviceSessionsOptions) {
    this.devices = [...options.devices];
    this.localhostBridges = options.localhostBridges ?? new LocalhostBridgeManager();
    this.pollIntervalMs = options.pollIntervalMs ?? (process.env.NODE_ENV === 'test' ? 0 : DEFAULT_DEVICE_POLL_INTERVAL_MS);
    this.currentState = projectState([], this.devices, 0);
    this.scheduleDevicePolling();
  }

  state(): MultiDeviceSessionState {
    return structuredClone(this.currentState);
  }

  onState(listener: (state: MultiDeviceSessionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onDeviceEvent(listener: (event: DeviceEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  async refresh(): Promise<MultiDeviceSessionState> {
    if (this.refreshRequest) return this.refreshRequest;
    const request = this.refreshNow().finally(() => {
      if (this.refreshRequest !== request) return;
      this.refreshRequest = null;
      if (this.refreshAfterCurrent) {
        this.refreshAfterCurrent = false;
        this.requestInventoryRefresh();
      }
    });
    this.refreshRequest = request;
    return request;
  }

  private async refreshNow(): Promise<MultiDeviceSessionState> {
    this.attachDevices();
    const inventories = await Promise.all(this.devices.map(async (device) => {
      try {
        const status = await device.connect();
        if (status.state === 'ready') {
          const inventory = await device.readInventory();
          if (inventory.descriptor.deviceId !== device.deviceId) {
            throw new Error('Device inventory identity differs from its connection identity.');
          }
          this.inventories.set(device.deviceId, structuredClone(inventory));
        }
      } catch {
        // A previously read inventory remains useful as disabled presentation
        // while its owning Device is temporarily unavailable.
      }
      const inventory = this.inventories.get(device.deviceId);
      return inventory ? { device, inventory: structuredClone(inventory) } : null;
    }));
    const state = this.updateProjectedState(
      inventories.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    );
    return structuredClone(state);
  }

  async reconcileDevices(nextDevices: SessionDevice[]): Promise<MultiDeviceSessionState> {
    await this.refreshRequest?.catch(() => undefined);
    const seen = new Set<DeviceId>();
    for (const device of nextDevices) {
      if (seen.has(device.deviceId)) throw new Error(`Duplicate Device: ${device.deviceId}`);
      seen.add(device.deviceId);
    }
    const nextById = new Map(nextDevices.map((device) => [device.deviceId, device]));
    const removed: SessionDevice[] = [];
    for (const current of this.devices) {
      if (nextById.get(current.deviceId) === current) continue;
      this.detachDevice(current.deviceId);
      this.inventories.delete(current.deviceId);
      removed.push(current);
    }
    this.devices = [...nextDevices];
    this.scheduleDevicePolling();
    await Promise.allSettled(removed.map((device) => device.dispose()));
    await this.applyTerminalOutputDemand().catch(() => undefined);
    return this.refresh();
  }

  async create(request: CreateMultiDeviceSessionRequest): Promise<MultiDeviceSessionView> {
    const plan = await this.planCreate(request);
    if (plan.action !== 'use-existing-location' && plan.action !== 'use-device-directory') {
      this.creationPlans.delete(plan.planId);
      throw new Error('Review the Project preparation before creating this Session.');
    }
    return this.executeCreate(plan.planId);
  }

  async planCreate(
    request: CreateMultiDeviceSessionRequest
  ): Promise<MultiDeviceSessionCreationPlan> {
    const state = this.currentState.revision > 0 ? this.currentState : await this.refresh();
    const device = this.requireReadyDevice(request.targetDeviceId);
    const deviceName = device.status.descriptor?.name ?? request.targetDeviceId;
    const planId = randomUUID();
    if (request.workspaceKey === null) {
      const targetPath = request.targetPath?.trim() || '~';
      const plan: MultiDeviceSessionCreationPlan = {
        planId,
        workspaceKey: null,
        targetDeviceId: request.targetDeviceId,
        deviceName,
        action: 'use-device-directory',
        targetPath,
        executable: Boolean(device.createSession && device.startSession),
        blockers: device.createSession && device.startSession
          ? []
          : ['Update Soloe on this Device to create Sessions remotely.'],
        warnings: [],
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      };
      this.creationPlans.set(planId, {
        public: plan,
        request: { ...structuredClone(request), targetPath },
        devicePlan: null
      });
      return structuredClone(plan);
    }
    const project = state.projects.find((candidate) =>
      candidate.workspaces.some((workspace) => workspace.key === request.workspaceKey)
    );
    const workspace = project?.workspaces.find((candidate) => candidate.key === request.workspaceKey);
    if (!project || !workspace) throw new Error('Workspace is unavailable.');
    const location = workspace.locations.find((candidate) =>
      candidate.deviceId === request.targetDeviceId && candidate.available
    );
    if (location) {
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const plan: MultiDeviceSessionCreationPlan = {
        planId,
        workspaceKey: request.workspaceKey,
        targetDeviceId: request.targetDeviceId,
        deviceName,
        action: 'use-existing-location',
        targetPath: location.path,
        executable: true,
        blockers: [],
        warnings: [],
        expiresAt
      };
      this.creationPlans.set(planId, {
        public: plan,
        request: structuredClone(request),
        devicePlan: null
      });
      return structuredClone(plan);
    }

    const gitRepository = project.repository?.kind === 'git' ? project.repository : null;
    const action = this.inventories.get(request.targetDeviceId)?.projects.some((candidate) =>
      repositoryKey(candidate.repository) === project.key
    )
      ? 'prepare-workspace-location'
      : 'clone-project';
    const blockers: string[] = [];
    if (
      !device.workspacePlan
      || !device.workspaceExecute
      || (action === 'clone-project' && !device.openProject)
    ) {
      blockers.push('Update Soloe on this device to prepare Projects remotely.');
    }
    if (!gitRepository) {
      blockers.push('This Project has no Git remote to clone on another device.');
    }
    if (action === 'prepare-workspace-location' && !workspace.branch) {
      blockers.push('This revision Workspace cannot be prepared automatically yet.');
    }
    if (blockers.length > 0) {
      const plan: MultiDeviceSessionCreationPlan = {
        planId,
        workspaceKey: request.workspaceKey,
        targetDeviceId: request.targetDeviceId,
        deviceName,
        action,
        targetPath: null,
        executable: false,
        blockers,
        warnings: [],
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      };
      this.creationPlans.set(planId, {
        public: plan,
        request: structuredClone(request),
        devicePlan: null
      });
      return structuredClone(plan);
    }

    const targetInventory = this.inventories.get(request.targetDeviceId)!;
    const targetProject = targetInventory.projects.find((candidate) =>
      repositoryKey(candidate.repository) === project.key
    );
    const runMode = targetProject?.project.defaultRunMode ?? targetInventory.descriptor.platform;
    let intent: DeviceWorkspaceIntent;
    if (action === 'prepare-workspace-location') {
      if (!targetProject?.repositoryId || !workspace.branch) {
        throw new Error('The selected Device has incomplete Project metadata.');
      }
      intent = {
        kind: 'prepare-workspace-location',
        repositoryId: targetProject.repositoryId,
        checkoutId: randomUUID(),
        runMode,
        ...(targetProject.project.defaultWslDistro
          ? { wslDistro: targetProject.project.defaultWslDistro }
          : {}),
        ...(request.targetPath ? { path: request.targetPath } : {}),
        source: {
          kind: 'branch',
          localRef: branchRef(workspace.branch)
        }
      };
    } else {
      intent = {
        kind: 'clone-project-presence',
        repositoryId: randomUUID(),
        checkoutId: randomUUID(),
        sourceUrl: gitRepository!.canonicalUrl,
        runMode,
        ...(workspace.branch ? { branchRef: branchRef(workspace.branch) } : {}),
        identity: structuredClone(gitRepository!),
        ...(request.targetPath ? { path: request.targetPath } : {})
      };
    }
    const devicePlan = await device.workspacePlan!(intent);
    if (devicePlan.targetDeviceId !== request.targetDeviceId) {
      throw new Error('The Device returned a preparation plan for another device.');
    }
    const plan: MultiDeviceSessionCreationPlan = {
      planId,
      workspaceKey: request.workspaceKey,
      targetDeviceId: request.targetDeviceId,
      deviceName,
      action,
      targetPath: devicePlan.preview.targetPath || null,
      executable: devicePlan.executable,
      blockers: [...devicePlan.blockers],
      warnings: [...devicePlan.warnings],
      expiresAt: devicePlan.expiresAt
    };
    this.creationPlans.set(planId, {
      public: plan,
      request: structuredClone(request),
      devicePlan: structuredClone(devicePlan)
    });
    return structuredClone(plan);
  }

  browseWorkspaceDirectories(
    deviceId: DeviceId,
    path?: string
  ): Promise<WorkspaceDirectoryListing> {
    const device = this.requireReadyDevice(deviceId);
    if (!device.browseWorkspaceDirectories) {
      throw new Error('Update Soloe on this Device to browse workspace locations.');
    }
    return device.browseWorkspaceDirectories(path);
  }

  async modelCatalog(deviceId: DeviceId): Promise<import('@shared/types/settings.js').ModelCatalogEntry[]> {
    const device = this.requireReadyDevice(deviceId);
    if (!device.modelCatalog) {
      throw new Error('Update Soloe on this Device to detect installed agent CLIs.');
    }
    return device.modelCatalog();
  }

  async openProjectOnDevice(
    deviceId: DeviceId,
    request: ProjectOpenRequest
  ): Promise<MultiDeviceSessionState> {
    const device = this.requireReadyDevice(deviceId);
    if (!device.openProject) throw new Error('The selected Device cannot open Projects.');
    await device.openProject(structuredClone(request));
    return this.refresh();
  }

  async updateProject(
    ref: ProjectRef,
    patch: ProjectUpdate
  ): Promise<MultiDeviceSessionState> {
    const current = findProjectPresence(this.currentState, ref);
    if (!current) throw new Error('Project is unavailable.');
    if (!current.available) throw new Error(`Device ${current.deviceName} is offline.`);
    const device = this.requireReadyDevice(ref.deviceId);
    if (!device.updateProject) throw new Error('The selected Device cannot update Projects.');
    await device.updateProject(ref.projectId, structuredClone(patch));
    return this.refresh();
  }

  async deleteProject(ref: ProjectRef): Promise<MultiDeviceSessionState> {
    const current = findProjectPresence(this.currentState, ref);
    if (!current) throw new Error('Project is unavailable.');
    if (!current.available) throw new Error(`Device ${current.deviceName} is offline.`);
    const device = this.requireReadyDevice(ref.deviceId);
    if (!device.deleteProject) throw new Error('The selected Device cannot delete Projects.');
    if (!device.deleteSession) throw new Error('The selected Device cannot delete Project Sessions.');

    const inventory = this.inventories.get(ref.deviceId);
    for (const session of inventory?.sessions.filter(
      (candidate) => candidate.projectId === ref.projectId
    ) ?? []) {
      const runtime = inventory?.runtimes.find((candidate) => candidate.sessionId === session.id);
      if (
        runtime?.terminalId
        && (runtime.status === 'running' || runtime.status === 'starting')
      ) {
        try {
          await device.terminalStop(runtime.terminalId);
        } catch {
          // Continue when the Device already stopped the Terminal.
        }
      }
      await device.deleteSession(session.id);
    }
    await device.deleteProject(ref.projectId);
    return this.refresh();
  }

  async executePreparation(planId: string): Promise<MultiDeviceSessionState> {
    const stored = this.takeCreationPlan(planId);
    await this.prepareStoredPlan(stored);
    return this.currentState.revision > 0 ? this.state() : this.refresh();
  }

  async executeCreate(planId: string): Promise<MultiDeviceSessionView> {
    const stored = this.takeCreationPlan(planId);
    await this.prepareStoredPlan(stored);
    return this.createAtLocation(stored.request);
  }

  private takeCreationPlan(planId: string): StoredSessionCreationPlan {
    const stored = this.creationPlans.get(planId);
    if (!stored) throw new Error('Session creation plan is unavailable.');
    this.creationPlans.delete(planId);
    if (!stored.public.executable) {
      throw new Error(stored.public.blockers.join(' ') || 'Session creation is blocked.');
    }
    if (Date.parse(stored.public.expiresAt) <= Date.now()) {
      throw new Error('Session creation plan expired. Review it again.');
    }
    return stored;
  }

  private async prepareStoredPlan(stored: StoredSessionCreationPlan): Promise<void> {
    const device = this.requireReadyDevice(stored.public.targetDeviceId);
    if (stored.devicePlan) {
      if (!device.workspaceExecute) throw new Error('The selected Device cannot prepare Workspaces.');
      const commandId = randomUUID();
      const command: DeviceCommandEnvelope<DeviceWorkspaceIntent> = {
        schemaVersion: 1,
        clientId: this.clientId,
        commandId,
        targetDeviceId: stored.public.targetDeviceId,
        actorClientId: this.clientId,
        expectedEntityVersions: {
          workspace: stored.devicePlan.expectedWorkspaceRevision,
          ...(stored.devicePlan.expectedCheckoutVersion !== undefined
            ? { checkout: stored.devicePlan.expectedCheckoutVersion }
            : {})
        },
        capabilityRevision: stored.devicePlan.capabilityRevision,
        planToken: stored.devicePlan.planToken,
        planExpiresAt: stored.devicePlan.expiresAt,
        intent: structuredClone(stored.devicePlan.intent)
      };
      const receipt = await device.workspaceExecute(command);
      const checkout = successfulCheckout(receipt, command);
      if (stored.public.action === 'clone-project') {
        if (!device.openProject) throw new Error('The selected Device cannot register the cloned Project.');
        await device.openProject({
          path: checkout.path,
          defaultRunMode: checkout.runMode,
          ...(checkout.wslDistro ? { defaultWslDistro: checkout.wslDistro } : {})
        });
      }
      await this.refresh();
    }
  }

  private async createAtLocation(
    request: CreateMultiDeviceSessionRequest
  ): Promise<MultiDeviceSessionView> {
    const state = this.currentState.revision > 0 ? this.currentState : await this.refresh();
    const device = this.requireReadyDevice(request.targetDeviceId);
    if (!device.createSession || !device.startSession) {
      throw new Error('The selected Device cannot create Sessions.');
    }
    const inventory = this.inventories.get(device.deviceId);
    if (request.workspaceKey === null) {
      const runMode = inventory?.descriptor.platform;
      if (!runMode) throw new Error('The selected Device has no runnable environment.');
      const sessionId = randomUUID();
      const draft: SessionDraft = {
        ...structuredClone(request.session),
        cwd: request.targetPath?.trim() || '~',
        runMode,
        runtimeMode: 'tui'
      };
      const created = await device.createSession({ sessionId, draft });
      await device.startSession(created.id);
      const refreshed = await this.refresh();
      const projection = refreshed.unassigned.find((candidate) =>
        candidate.ref.deviceId === device.deviceId
        && candidate.ref.sessionId === created.id
      );
      if (!projection) throw new Error('The created Session was not returned by its Device.');
      return projection;
    }
    const workspace = state.projects
      .flatMap((project) => project.workspaces)
      .find((candidate) => candidate.key === request.workspaceKey);
    const location = workspace?.locations.find((candidate) =>
      candidate.deviceId === request.targetDeviceId && candidate.available
    );
    if (!location) throw new Error('The Workspace Location is unavailable after preparation.');
    const physicalProject = inventory?.projects.find((candidate) =>
      candidate.project.id === location.projectId
    )?.project;
    const runMode = physicalProject?.defaultRunMode ?? inventory?.descriptor.platform;
    if (!runMode) throw new Error('The selected Workspace has no runnable location.');
    const sessionId = randomUUID();
    const draft: SessionDraft = {
      ...structuredClone(request.session),
      cwd: location.path,
      runMode,
      projectId: location.projectId,
      runtimeMode: 'tui'
    };
    const created = await device.createSession({ sessionId, draft });
    await device.startSession(created.id);
    const refreshed = await this.refresh();
    const projection = refreshed.projects
      .flatMap((projectView) => projectView.workspaces)
      .flatMap((workspaceView) => workspaceView.sessions)
      .find((candidate) =>
        candidate.ref.deviceId === device.deviceId
        && candidate.ref.sessionId === created.id
      );
    if (!projection) throw new Error('The created Session was not returned by its Device.');
    return projection;
  }

  async startSession(ref: SessionRef): Promise<MultiDeviceSessionView> {
    const current = findSession(this.currentState, ref);
    if (!current) throw new Error('Session is unavailable.');
    if (!current.available) throw new Error(`Device ${current.deviceName} is offline.`);
    if (current.runtime?.terminalId && current.runtime.status === 'running') {
      return structuredClone(current);
    }
    const device = this.requireReadyDevice(ref.deviceId);
    if (!device.startSession) throw new Error('The selected Device cannot start Sessions.');
    await device.startSession(ref.sessionId);
    const refreshed = await this.refresh();
    const started = findSession(refreshed, ref);
    if (!started?.runtime?.terminalId || started.runtime.status !== 'running') {
      throw new Error('The Session did not start on its Device.');
    }
    return structuredClone(started);
  }

  async ensureTailscalePort(
    deviceId: DeviceId,
    port: number,
    virtualHostname?: string
  ): Promise<DevicePortForwardResult> {
    const device = this.requireReadyDevice(deviceId);
    if (!device.ensureTailscalePort) {
      throw new Error('The selected Device cannot publish Tailscale ports.');
    }
    return structuredClone(virtualHostname
      ? await device.ensureTailscalePort(port, virtualHostname)
      : await device.ensureTailscalePort(port));
  }

  listLocalhostBridges(): LocalhostBridge[] {
    return this.localhostBridges.list();
  }

  async openLocalhostBridge(request: OpenLocalhostBridgeRequest): Promise<LocalhostBridge> {
    const port = validLocalhostBridgePort(request.port);
    const device = this.requireReadyDevice(request.deviceId);
    if (device.local) throw new Error('Choose another Device.');
    if (!device.ensureTailscalePort) {
      throw new Error('The selected Device cannot publish Tailscale ports.');
    }
    const published = await device.ensureTailscalePort(port);
    if (published.state !== 'ready') {
      throw new Error(
        published.message
        ?? `Could not publish localhost:${port} on ${device.displayName ?? request.deviceId}.`
      );
    }
    if (!published.ipAddress) {
      throw new Error('The selected Device did not return a Tailscale IP address.');
    }
    return this.localhostBridges.open({
      deviceId: request.deviceId,
      deviceName: device.status.descriptor?.name ?? device.displayName ?? request.deviceId,
      localPort: port,
      remoteHost: published.ipAddress,
      remotePort: published.port
    });
  }

  closeLocalhostBridge(port: number): Promise<void> {
    return this.localhostBridges.close(validLocalhostBridgePort(port));
  }

  async setupShortDns(deviceId: DeviceId): Promise<ShortDnsInfo> {
    const device = this.requireReadyDevice(deviceId);
    if (!device.setupShortDns) {
      throw new Error('The selected Device cannot install Soloe DNS.');
    }
    return structuredClone(await device.setupShortDns());
  }

  async removeShortDns(deviceId: DeviceId): Promise<ShortDnsInfo> {
    const device = this.requireReadyDevice(deviceId);
    if (!device.removeShortDns) {
      throw new Error('The selected Device cannot uninstall Soloe DNS.');
    }
    return structuredClone(await device.removeShortDns());
  }

  async updateSession(ref: SessionRef, patch: SessionUpdate): Promise<MultiDeviceSessionView> {
    const current = findSession(this.currentState, ref);
    if (!current) throw new Error('Session is unavailable.');
    if (!current.available) throw new Error(`Device ${current.deviceName} is offline.`);
    const device = this.requireReadyDevice(ref.deviceId);
    if (!device.updateSession) throw new Error('The selected Device cannot update Sessions.');
    await device.updateSession(ref.sessionId, structuredClone(patch));
    const refreshed = await this.refresh();
    const updated = findSession(refreshed, ref);
    if (!updated) throw new Error('The updated Session was not returned by its Device.');
    return structuredClone(updated);
  }

  async deleteSession(ref: SessionRef): Promise<MultiDeviceSessionState> {
    const current = findSession(this.currentState, ref);
    if (!current) throw new Error('Session is unavailable.');
    if (!current.available) throw new Error(`Device ${current.deviceName} is offline.`);
    const device = this.requireReadyDevice(ref.deviceId);
    if (!device.deleteSession) throw new Error('The selected Device cannot delete Sessions.');
    if (
      current.runtime?.terminalId
      && (current.runtime.status === 'running' || current.runtime.status === 'starting')
    ) {
      try {
        await device.terminalStop(current.runtime.terminalId);
      } catch {
        // Continue with deletion even if the remote Terminal has already stopped.
      }
    }
    await device.deleteSession(ref.sessionId);
    return this.refresh();
  }

  previewSessionCommand(ref: SessionRef): Promise<SpawnSpec> {
    const current = findSession(this.currentState, ref);
    if (!current) return Promise.reject(new Error('Session is unavailable.'));
    if (!current.available) {
      return Promise.reject(new Error(`Device ${current.deviceName} is offline.`));
    }
    const device = this.requireReadyDevice(ref.deviceId);
    if (!device.previewSessionCommand) {
      return Promise.reject(new Error('The selected Device cannot preview Session commands.'));
    }
    return device.previewSessionCommand(ref.sessionId);
  }

  async reorderSessions(orderedRefs: SessionRef[]): Promise<MultiDeviceSessionState> {
    const refs = orderedRefs.map((ref) => structuredClone(ref));
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = `${ref.deviceId}\u0000${ref.sessionId}`;
      if (seen.has(key)) throw new Error('Session order contains a duplicate Session.');
      seen.add(key);
      if (!findSession(this.currentState, ref)) {
        throw new Error(`Session ${ref.sessionId} is not present on Device ${ref.deviceId}.`);
      }
    }
    const orderedIds = refs.map((ref) => ref.sessionId);
    const devices = [...new Set(refs.map((ref) => ref.deviceId))]
      .map((deviceId) => this.requireReadyDevice(deviceId));
    await Promise.all(devices.map((device) => device.reorderSessions(orderedIds)));
    return this.refresh();
  }

  async terminalInput(ref: TerminalRef, data: string, control: TerminalControlProof): Promise<void> {
    assertControlTargetsDevice(ref, control);
    await this.requireReadyDevice(ref.deviceId).terminalInput(ref.terminalId, data, control);
  }

  async invokeWorktree(request: DeviceWorktreeInvokeRequest): Promise<unknown> {
    const key = `${request.namespace}.${request.method}`;
    if (!DEVICE_WORKTREE_RPC_METHODS.has(key)) {
      throw new Error(`Worktree RPC ${key} is not supported.`);
    }
    const device = this.requireReadyDevice(request.deviceId);
    if (!device.invokeWorktree) {
      throw new Error(`Device ${request.deviceId} cannot serve Worktree data.`);
    }
    return device.invokeWorktree(structuredClone(request));
  }

  async terminalPasteImages(request: DeviceImagePasteRequest): Promise<ImagePasteResult> {
    assertControlTargetsDevice(request.ref, request.control);
    return this.requireReadyDevice(request.ref.deviceId).pasteImagesIntoTerminal({
      terminalId: request.ref.terminalId,
      sessionId: request.sessionId,
      images: structuredClone(request.images),
      control: structuredClone(request.control)
    });
  }

  async terminalAcquireInputLease(
    ref: TerminalRef,
    takeover = false
  ): Promise<TerminalInputLease> {
    const device = this.requireReadyDevice(ref.deviceId);
    if (!device.terminalAcquireInputLease) {
      throw new Error('The selected Device does not support terminal input control.');
    }
    const controller = this.currentState.devices.find((candidate) => candidate.local);
    if (!controller) {
      throw new Error('The controlling Soloe Device identity is unavailable.');
    }
    return device.terminalAcquireInputLease(ref.terminalId, takeover, {
      deviceId: controller.deviceId,
      deviceName: controller.name
    });
  }

  async terminalCurrentInputLease(ref: TerminalRef): Promise<TerminalInputLease | null> {
    return this.requireReadyDevice(ref.deviceId).terminalCurrentInputLease(ref.terminalId);
  }

  async terminalReleaseInputLease(
    ref: TerminalRef,
    control: TerminalControlProof
  ): Promise<boolean> {
    assertControlTargetsDevice(ref, control);
    return this.requireReadyDevice(ref.deviceId).terminalReleaseInputLease(
      ref.terminalId,
      control
    );
  }

  async terminalParkInputLease(
    ref: TerminalRef,
    control: TerminalControlProof
  ): Promise<boolean> {
    assertControlTargetsDevice(ref, control);
    return this.requireReadyDevice(ref.deviceId).terminalParkInputLease(
      ref.terminalId,
      control
    );
  }

  async terminalResize(
    ref: TerminalRef,
    cols: number,
    rows: number,
    control: TerminalControlProof
  ): Promise<void> {
    assertControlTargetsDevice(ref, control);
    await this.requireReadyDevice(ref.deviceId).terminalResize(
      ref.terminalId,
      cols,
      rows,
      control
    );
  }

  terminalHistory(ref: TerminalRef): Promise<DeviceTerminalHistory> {
    return this.requireReadyDevice(ref.deviceId).terminalHistory(ref.terminalId);
  }

  async terminalStop(ref: TerminalRef): Promise<void> {
    await this.requireReadyDevice(ref.deviceId).terminalStop(ref.terminalId);
  }

  async setTerminalOutputDemand(refs: TerminalRef[]): Promise<void> {
    const byDevice = new Map<DeviceId, Set<string>>();
    for (const ref of refs) {
      const terminals = byDevice.get(ref.deviceId) ?? new Set<string>();
      terminals.add(ref.terminalId);
      byDevice.set(ref.deviceId, terminals);
    }
    this.terminalOutputDemand = byDevice;
    await this.applyTerminalOutputDemand();
  }

  private async applyTerminalOutputDemand(): Promise<void> {
    await Promise.all(this.devices.map((device) =>
      device.setTerminalOutputDemand(
        this.terminalOutputDemand.get(device.deviceId) ?? new Set()
      )
    ));
  }

  async dispose(): Promise<void> {
    this.clearDevicePollTimers();
    await this.localhostBridges.dispose();
    for (const deviceId of [...this.deviceDetachers.keys()]) this.detachDevice(deviceId);
    await Promise.allSettled(this.devices.map((device) => device.dispose()));
    this.devices = [];
    this.inventories.clear();
    this.stateListeners.clear();
    this.eventListeners.clear();
    this.creationPlans.clear();
  }

  private scheduleDevicePolling(): void {
    this.clearDevicePollTimers();
    if (this.pollIntervalMs <= 0) return;

    this.devices.forEach((device, index) => {
      // Stagger start times (5s, 10s, 15s...) so devices never poll at the exact same time
      const initialDelay = (index + 1) * 5_000;
      const timer = setTimeout(() => {
        void this.pollDevice(device.deviceId);
        const interval = setInterval(() => {
          void this.pollDevice(device.deviceId);
        }, this.pollIntervalMs);
        interval.unref?.();
        this.devicePollTimers.set(device.deviceId, interval);
      }, initialDelay);
      timer.unref?.();
      this.devicePollTimers.set(device.deviceId, timer);
    });
  }

  private clearDevicePollTimers(): void {
    for (const timer of this.devicePollTimers.values()) clearTimeout(timer);
    this.devicePollTimers.clear();
  }

  private async pollDevice(deviceId: DeviceId): Promise<void> {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device || device.status.state !== 'ready') return;
    try {
      const inventory = await device.readInventory();
      if (inventory.descriptor.deviceId === device.deviceId) {
        this.inventories.set(device.deviceId, structuredClone(inventory));
        this.publishCachedState();
      }
    } catch {
      // Ignore background poll errors
    }
  }

  private attachDevices(): void {
    for (const device of this.devices) {
      const existing = this.deviceDetachers.get(device.deviceId);
      if (existing?.device === device) continue;
      if (existing) this.detachDevice(device.deviceId);
      let previousStatus = device.status.state;
      this.deviceDetachers.set(device.deviceId, {
        device,
        detach: [
          device.onEvent((event) => {
            for (const listener of this.eventListeners) listener(structuredClone(event));
            if (
              event.event === 'sessions.change'
              || event.event === 'sessions.delete'
              || event.event === 'projects.change'
              || event.event === 'git.change'
              || event.event === 'workspaceDevice.change'
              || event.event === 'transport.repair'
            ) {
              this.requestInventoryRefresh();
            }
          }),
          device.onStatus((status) => {
            const reconnected = status.state === 'ready' && previousStatus !== 'ready';
            previousStatus = status.state;
            this.publishCachedState();
            if (reconnected) void this.refresh().catch(() => undefined);
          })
        ]
      });
    }
  }

  private requestInventoryRefresh(): void {
    if (this.eventRefreshScheduled) return;
    this.eventRefreshScheduled = true;
    queueMicrotask(() => {
      this.eventRefreshScheduled = false;
      if (this.refreshRequest) {
        this.refreshAfterCurrent = true;
        return;
      }
      void this.refresh().catch(() => undefined);
    });
  }

  private detachDevice(deviceId: DeviceId): void {
    const record = this.deviceDetachers.get(deviceId);
    if (!record) return;
    this.deviceDetachers.delete(deviceId);
    for (const detach of record.detach) detach();
  }

  private publishCachedState(): void {
    const inventories = this.devices.flatMap((device) => {
      const inventory = this.inventories.get(device.deviceId);
      return inventory ? [{ device, inventory: structuredClone(inventory) }] : [];
    });
    this.updateProjectedState(inventories);
  }

  private updateProjectedState(
    inventories: Array<{ device: SessionDevice; inventory: DeviceSessionInventory }>
  ): MultiDeviceSessionState {
    const candidate = projectState(inventories, this.devices, this.revision);
    if (sameProjectedState(candidate, this.currentState)) return this.currentState;
    candidate.revision = ++this.revision;
    this.currentState = candidate;
    for (const listener of this.stateListeners) listener(structuredClone(candidate));
    return candidate;
  }

  private requireReadyDevice(deviceId: DeviceId): SessionDevice {
    const device = this.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device) throw new Error(`Unknown Device: ${deviceId}`);
    if (device.status.state !== 'ready') {
      throw new Error(`Device ${device.status.descriptor?.name ?? deviceId} is offline.`);
    }
    return device;
  }
}

function validLocalhostBridgePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Port must be between 1 and 65535.');
  }
  return port;
}

function sameProjectedState(
  left: MultiDeviceSessionState,
  right: MultiDeviceSessionState
): boolean {
  const { revision: _leftRevision, capturedAt: _leftCapturedAt, ...leftContent } = left;
  const { revision: _rightRevision, capturedAt: _rightCapturedAt, ...rightContent } = right;
  return isDeepStrictEqual(leftContent, rightContent);
}

function findSession(
  state: MultiDeviceSessionState,
  ref: SessionRef
): MultiDeviceSessionView | null {
  return [
    ...state.projects.flatMap((project) =>
      project.workspaces.flatMap((workspace) => workspace.sessions)
    ),
    ...state.unassigned,
    ...state.archivedSessions
  ].find((session) =>
    session.ref.deviceId === ref.deviceId && session.ref.sessionId === ref.sessionId
  ) ?? null;
}

interface ProjectBuilder {
  key: string;
  name: string;
  repository: RepositoryIdentity | null;
  presences: ProjectPresenceView[];
  workspaces: Map<string, WorkspaceBuilder>;
}

interface WorkspaceBuilder {
  key: string;
  name: string;
  branch: string | null;
  locations: WorkspaceLocationView[];
  sessions: MultiDeviceSessionView[];
}

function projectState(
  inventories: Array<{ device: SessionDevice; inventory: DeviceSessionInventory }>,
  devices: SessionDevice[],
  revision: number
): MultiDeviceSessionState {
  const projects = new Map<string, ProjectBuilder>();
  const workspaceByLocalPath = new Map<string, WorkspaceBuilder>();
  const unassigned: MultiDeviceSessionView[] = [];
  const archivedSessions: MultiDeviceSessionView[] = [];

  for (const { device, inventory } of inventories) {
    const deviceName = inventory.descriptor.name;
    for (const projectInventory of inventory.projects) {
      const projectKey = repositoryKey(projectInventory.repository)
        ?? `device:${device.deviceId}/project:${projectInventory.project.id}`;
      let project = projects.get(projectKey);
      if (!project) {
        project = {
          key: projectKey,
          name: projectInventory.project.name,
          repository: structuredClone(projectInventory.repository),
          presences: [],
          workspaces: new Map()
        };
        projects.set(projectKey, project);
      }
      project.presences.push({
        ref: { deviceId: device.deviceId, projectId: projectInventory.project.id },
        key: `${device.deviceId}/${encodeURIComponent(projectInventory.project.id)}`,
        deviceName,
        available: device.status.state === 'ready',
        project: structuredClone(projectInventory.project)
      });
      for (const worktree of projectInventory.worktrees) {
        const workspaceKey = `${projectKey}/${worktreeSourceKey(worktree, device.deviceId)}`;
        let workspace = project.workspaces.get(workspaceKey);
        if (!workspace) {
          workspace = {
            key: workspaceKey,
            name: workspaceName(worktree),
            branch: worktree.branch,
            locations: [],
            sessions: []
          };
          project.workspaces.set(workspaceKey, workspace);
        }
        workspace.locations.push({
          key: `${device.deviceId}/${encodeURIComponent(worktree.path)}`,
          deviceId: device.deviceId,
          deviceName,
          projectId: projectInventory.project.id,
          path: worktree.path,
          available: device.status.state === 'ready',
          isMain: worktree.isMain
        });
        workspaceByLocalPath.set(
          localPathKey(device.deviceId, projectInventory.project.id, worktree.path),
          workspace
        );
      }
    }

    for (const session of inventory.sessions) {
      const view = sessionView(device, inventory, session);
      const workspace = session.projectId
        ? workspaceByLocalPath.get(localPathKey(device.deviceId, session.projectId, session.cwd))
        : null;
      if (workspace) workspace.sessions.push(view);
      else unassigned.push(view);
    }
    for (const session of inventory.archivedSessions) {
      archivedSessions.push(sessionView(device, inventory, session));
    }
  }

  const projectedProjects = [...projects.values()]
    .map((project): ProjectView => ({
      key: project.key,
      name: project.name,
      repository: structuredClone(project.repository),
      presences: project.presences.sort(compareProjectPresences),
      workspaces: [...project.workspaces.values()]
        .map((workspace): WorkspaceView => ({
          key: workspace.key,
          name: workspace.name,
          branch: workspace.branch,
          locations: workspace.locations.sort(compareLocations),
          sessions: workspace.sessions.sort(compareSessions)
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    revision,
    capturedAt: new Date().toISOString(),
    devices: devices
      .map(deviceView)
      .sort((left, right) => left.name.localeCompare(right.name)),
    projects: projectedProjects,
    unassigned: unassigned.sort(compareSessions),
    archivedSessions: archivedSessions.sort(compareSessions)
  };
}

function compareProjectPresences(left: ProjectPresenceView, right: ProjectPresenceView): number {
  return left.deviceName.localeCompare(right.deviceName)
    || left.project.name.localeCompare(right.project.name);
}

function findProjectPresence(
  state: MultiDeviceSessionState,
  ref: ProjectRef
): ProjectPresenceView | null {
  return state.projects
    .flatMap((project) => project.presences ?? [])
    .find((presence) =>
      presence.ref.deviceId === ref.deviceId && presence.ref.projectId === ref.projectId
    ) ?? null;
}

function deviceView(device: SessionDevice): SessionDeviceView {
  const descriptor = device.status.descriptor;
  return {
    deviceId: device.deviceId,
    name: descriptor?.name ?? device.displayName ?? `Device ${device.deviceId.slice(0, 8)}`,
    state: device.status.state,
    available: device.status.state === 'ready',
    local: device.local,
    ...(descriptor ? { platform: descriptor.platform } : {}),
    ...(device.status.error ? { error: device.status.error } : {})
  };
}

function sessionView(
  device: SessionDevice,
  inventory: DeviceSessionInventory,
  session: Session
): MultiDeviceSessionView {
  const ref = { deviceId: device.deviceId, sessionId: session.id };
  const runtime = inventory.runtimes.find((candidate) => candidate.sessionId === session.id) ?? null;
  return {
    ref,
    key: `${ref.deviceId}/${encodeURIComponent(ref.sessionId)}`,
    deviceName: inventory.descriptor.name,
    available: device.status.state === 'ready',
    session: structuredClone(session),
    lifecycleStatus: runtime?.status ?? 'stopped',
    runtime: structuredClone(runtime),
    observation: structuredClone(
      inventory.observations?.find((snapshot) =>
        snapshot.subjectKind === 'session'
        && (snapshot.sessionId ?? snapshot.id) === session.id
      ) ?? null
    )
  };
}

function repositoryKey(repository: RepositoryIdentity | null): string | null {
  if (!repository || repository.kind !== 'git') return null;
  return `git:${repository.canonicalUrl.trim().replace(/\.git$/iu, '').toLocaleLowerCase()}`;
}

function worktreeSourceKey(worktree: GitWorktree, deviceId: DeviceId): string {
  if (worktree.branch) return `branch:${worktree.branch}`;
  if (worktree.head) return `revision:${worktree.head}`;
  return `location:${deviceId}/${encodeURIComponent(worktree.path)}`;
}

function workspaceName(worktree: GitWorktree): string {
  if (worktree.branch) return worktree.branch;
  if (worktree.head) return worktree.head.slice(0, 12);
  return worktree.path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || 'Workspace';
}

function localPathKey(deviceId: DeviceId, projectId: string, path: string): string {
  const normalized = path.trim().replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase();
  return `${deviceId}\u0000${projectId}\u0000${normalized}`;
}

function compareLocations(left: WorkspaceLocationView, right: WorkspaceLocationView): number {
  return left.deviceName.localeCompare(right.deviceName) || left.path.localeCompare(right.path);
}

function compareSessions(left: MultiDeviceSessionView, right: MultiDeviceSessionView): number {
  return (left.session.sortIndex ?? Number.MAX_SAFE_INTEGER)
    - (right.session.sortIndex ?? Number.MAX_SAFE_INTEGER)
    || left.session.name.localeCompare(right.session.name);
}

function assertControlTargetsDevice(ref: TerminalRef, control: TerminalControlProof): void {
  if (control.ownerDeviceId !== ref.deviceId) {
    throw new Error('Session Control owner Device does not match the terminal Device.');
  }
}

function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

function successfulCheckout(
  receipt: DeviceOperationReceipt,
  command: DeviceCommandEnvelope<DeviceWorkspaceIntent>
): import('@shared/types/workspaces.js').CheckoutRecord {
  if (
    receipt.clientId !== command.clientId
    || receipt.commandId !== command.commandId
    || receipt.targetDeviceId !== command.targetDeviceId
    || receipt.kind !== command.intent.kind
  ) {
    throw new Error('The Device returned a receipt for another preparation command.');
  }
  if (receipt.state !== 'succeeded') {
    throw new Error(receipt.error?.message ?? 'The Device could not prepare the Workspace.');
  }
  const result = receipt.result;
  if (!result || typeof result !== 'object') {
    throw new Error('The Device preparation receipt has no result.');
  }
  const checkout = (result as { checkout?: unknown }).checkout;
  if (!checkout || typeof checkout !== 'object') {
    throw new Error('The Device preparation receipt has no Checkout.');
  }
  const candidate = checkout as Partial<import('@shared/types/workspaces.js').CheckoutRecord>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.repositoryId !== 'string'
    || typeof candidate.path !== 'string'
    || typeof candidate.runMode !== 'string'
    || candidate.lifecycle !== 'ready'
  ) {
    throw new Error('The Device preparation receipt contains an invalid Checkout.');
  }
  return structuredClone(candidate as import('@shared/types/workspaces.js').CheckoutRecord);
}
