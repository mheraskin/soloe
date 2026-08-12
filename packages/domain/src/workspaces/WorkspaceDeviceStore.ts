import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isDeviceId, type DeviceId } from '@shared/types/devices.js';
import type { Project } from '@shared/types/projects.js';
import type { RunMode, Session } from '@shared/types/sessions.js';
import type {
  CheckoutRecord,
  DeviceSessionSourceBinding,
  DeviceWorkspaceLegacyMigrationRequest,
  DeviceWorkspaceLegacyReconcileRequest,
  DeviceWorkspaceLegacyMigrationResult,
  DeviceWorkspaceSnapshot,
  DeviceCheckoutRegistrationRequest,
  DeviceCheckoutUpdateRequest,
  DeviceRepositoryRegistrationRequest,
  RepositoryRecord
} from '@shared/types/workspaces.js';

interface PersistedDeviceWorkspaceState extends DeviceWorkspaceSnapshot {
  migrations: Array<{
    key: string;
    completedAt: string;
    projectRepositories: Record<string, string>;
    sessionSources: DeviceSessionSourceBinding[];
  }>;
}

export interface WorkspaceDeviceStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export class WorkspaceDeviceStore {
  private state: PersistedDeviceWorkspaceState;
  private initialized = false;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly filePath: string,
    readonly deviceId: DeviceId,
    options: WorkspaceDeviceStoreOptions = {}
  ) {
    if (!isDeviceId(deviceId)) throw new Error('Workspace Device Store requires a UUID Device ID.');
    this.state = emptyState(deviceId);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const source = await fs.readFile(this.filePath, 'utf8');
      this.state = parseState(JSON.parse(source), this.deviceId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.writeState(this.state);
    }
    this.initialized = true;
  }

  snapshot(): DeviceWorkspaceSnapshot {
    this.assertInitialized();
    return publicSnapshot(this.state);
  }

  adoptLegacy(
    request: DeviceWorkspaceLegacyMigrationRequest
  ): Promise<DeviceWorkspaceLegacyMigrationResult> {
    const operation = this.writeQueue.then(() => this.adoptLegacyNow(request));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  reconcileLegacy(
    request: DeviceWorkspaceLegacyReconcileRequest
  ): Promise<DeviceWorkspaceLegacyMigrationResult> {
    const operation = this.writeQueue.then(() => this.reconcileLegacyNow(request));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  registerCheckout(request: DeviceCheckoutRegistrationRequest): Promise<DeviceWorkspaceSnapshot> {
    const operation = this.writeQueue.then(() => this.registerCheckoutNow(request));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  updateCheckout(request: DeviceCheckoutUpdateRequest): Promise<DeviceWorkspaceSnapshot> {
    const operation = this.writeQueue.then(() => this.updateCheckoutNow(request));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  registerRepository(
    request: DeviceRepositoryRegistrationRequest
  ): Promise<DeviceWorkspaceSnapshot> {
    const operation = this.writeQueue.then(() => this.registerRepositoryNow(request));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  private async adoptLegacyNow(
    request: DeviceWorkspaceLegacyMigrationRequest
  ): Promise<DeviceWorkspaceLegacyMigrationResult> {
    this.assertInitialized();
    const migrationKey = requiredMigrationKey(request.migrationKey);
    const previous = this.state.migrations.find((migration) => migration.key === migrationKey);
    if (previous) return migrationResult(this.state, previous);
    const next = structuredClone(this.state);
    const timestamp = this.now().toISOString();
    const { projectRepositories, sessionSources } = this.reconcileLegacyRecords(
      next,
      request,
      timestamp
    );
    next.revision += 1;
    const migration = {
      key: migrationKey,
      completedAt: timestamp,
      projectRepositories,
      sessionSources
    };
    next.migrations.push(migration);
    validateState(next, this.deviceId);
    await this.writeState(next);
    this.state = next;
    return migrationResult(next, migration);
  }

  private async reconcileLegacyNow(
    request: DeviceWorkspaceLegacyReconcileRequest
  ): Promise<DeviceWorkspaceLegacyMigrationResult> {
    this.assertInitialized();
    const next = structuredClone(this.state);
    const before = JSON.stringify(publicSnapshot(next));
    const timestamp = this.now().toISOString();
    const { projectRepositories, sessionSources } = this.reconcileLegacyRecords(
      next,
      request,
      timestamp
    );
    if (JSON.stringify(publicSnapshot(next)) !== before) {
      next.revision += 1;
      validateState(next, this.deviceId);
      await this.writeState(next);
      this.state = next;
    }
    return {
      snapshot: publicSnapshot(this.state),
      projectRepositories,
      sessionSources
    };
  }

  private reconcileLegacyRecords(
    next: PersistedDeviceWorkspaceState,
    request: DeviceWorkspaceLegacyReconcileRequest,
    timestamp: string
  ): {
    projectRepositories: Record<string, string>;
    sessionSources: DeviceSessionSourceBinding[];
  } {
    if (!Array.isArray(request.projects) || !Array.isArray(request.sessions)) {
      throw new Error('Legacy Workspace migration input is invalid.');
    }
    const projectRepositories: Record<string, string> = {};
    const checkoutByScope = new Map<string, CheckoutRecord>();
    for (const checkout of next.checkouts) checkoutByScope.set(checkoutScopeKey(checkout), checkout);

    for (const project of request.projects) {
      validateLegacyProject(project);
      let repository = next.repositories.find((candidate) => candidate.legacyProjectId === project.id);
      if (!repository) {
        repository = {
          id: this.newId('Repository'),
          version: 1,
          identity: null,
          legacyProjectId: project.id,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        next.repositories.push(repository);
      }
      projectRepositories[project.id] = repository.id;
      const runMode = project.defaultRunMode ?? inferRunMode();
      ensureCheckout({
        state: next,
        checkoutByScope,
        repositoryId: repository.id,
        path: project.path,
        runMode,
        ...(runMode === 'wsl' && project.defaultWslDistro
          ? { wslDistro: project.defaultWslDistro }
          : {}),
        role: 'main',
        timestamp,
        idFactory: () => this.newId('Checkout')
      });
    }

    const sessionSources: DeviceSessionSourceBinding[] = [];
    for (const session of request.sessions) {
      validateLegacySession(session);
      let repositoryId = session.projectId ? projectRepositories[session.projectId] : undefined;
      if (!repositoryId) {
        const standaloneLegacyId = `standalone:${session.id}`;
        let repository = next.repositories.find(
          (candidate) => candidate.legacyProjectId === standaloneLegacyId
        );
        if (!repository) {
          repository = {
            id: this.newId('Repository'),
            version: 1,
            identity: null,
            legacyProjectId: standaloneLegacyId,
            createdAt: timestamp,
            updatedAt: timestamp
          };
          next.repositories.push(repository);
        }
        repositoryId = repository.id;
      }
      const project = session.projectId
        ? request.projects.find((candidate) => candidate.id === session.projectId)
        : undefined;
      const isMain = Boolean(project)
        && checkoutScopeKey({
          path: project!.path,
          runMode: project!.defaultRunMode ?? inferRunMode(),
          ...(project!.defaultWslDistro ? { wslDistro: project!.defaultWslDistro } : {})
        }) === checkoutScopeKey(session);
      const checkout = ensureCheckout({
        state: next,
        checkoutByScope,
        repositoryId,
        path: session.cwd,
        runMode: session.runMode,
        ...(session.wslDistro ? { wslDistro: session.wslDistro } : {}),
        role: isMain ? 'main' : project ? 'workspace' : 'external',
        timestamp,
        idFactory: () => this.newId('Checkout')
      });
      sessionSources.push({
        sessionId: session.id,
        source: {
          kind: 'existing-checkout',
          checkoutId: checkout.id,
          adopted: true
        }
      });
    }
    return { projectRepositories, sessionSources };
  }

  private async registerCheckoutNow(
    request: DeviceCheckoutRegistrationRequest
  ): Promise<DeviceWorkspaceSnapshot> {
    this.assertInitialized();
    requireRevision(request.expectedRevision, this.state.revision);
    const draft = request.checkout;
    if (
      !isDeviceId(draft.id)
      || !isDeviceId(draft.repositoryId)
      || !this.state.repositories.some((repository) => repository.id === draft.repositoryId)
      || !draft.path?.trim()
      || !['main', 'workspace', 'isolated-session', 'external'].includes(draft.role)
      || !['pending', 'ready', 'missing', 'cleanup-planned'].includes(draft.lifecycle)
      || (draft.runMode === 'wsl' && !draft.wslDistro)
      || (draft.role === 'isolated-session' && !draft.ownerSessionId?.trim())
      || (draft.role !== 'isolated-session' && draft.ownerSessionId !== undefined)
    ) throw new Error('Checkout registration is invalid.');
    if (this.state.checkouts.some((checkout) => checkout.id === draft.id)) {
      throw new Error(`Checkout already exists: ${draft.id}`);
    }
    const scope = checkoutScopeKey(draft);
    if (this.state.checkouts.some((checkout) => checkoutScopeKey(checkout) === scope)) {
      throw new Error('A Checkout already owns this physical scope.');
    }
    const timestamp = this.now().toISOString();
    const next = structuredClone(this.state);
    next.checkouts.push({
      ...structuredClone(draft),
      path: draft.path.trim(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    next.revision += 1;
    validateState(next, this.deviceId);
    await this.writeState(next);
    this.state = next;
    return publicSnapshot(next);
  }

  private async updateCheckoutNow(
    request: DeviceCheckoutUpdateRequest
  ): Promise<DeviceWorkspaceSnapshot> {
    this.assertInitialized();
    requireRevision(request.expectedRevision, this.state.revision);
    const next = structuredClone(this.state);
    const checkout = next.checkouts.find((candidate) => candidate.id === request.checkoutId);
    if (!checkout) throw new Error(`Checkout not found: ${request.checkoutId}`);
    if (checkout.version !== request.expectedVersion) {
      throw new Error(
        `Checkout version ${request.expectedVersion} is stale; current version is ${checkout.version}.`
      );
    }
    if (request.lifecycle !== undefined) {
      if (!['pending', 'ready', 'missing', 'cleanup-planned', 'removed'].includes(request.lifecycle)) {
        throw new Error('Checkout lifecycle update is invalid.');
      }
      if (request.lifecycle === 'cleanup-planned' && checkout.lifecycle !== 'ready') {
        throw new Error('Only a ready Checkout can enter cleanup planning.');
      }
      if (request.lifecycle === 'removed' && checkout.lifecycle !== 'cleanup-planned') {
        throw new Error('Only a cleanup-planned Checkout can become removed.');
      }
      checkout.lifecycle = request.lifecycle;
    }
    if (request.role !== undefined) checkout.role = request.role;
    if (request.ownerSessionId === null) delete checkout.ownerSessionId;
    else if (request.ownerSessionId !== undefined) checkout.ownerSessionId = request.ownerSessionId;
    if (checkout.role === 'isolated-session' && !checkout.ownerSessionId?.trim()) {
      throw new Error('An isolated Session Checkout requires an owner Session.');
    }
    if (checkout.role !== 'isolated-session' && checkout.ownerSessionId) {
      throw new Error('Only an isolated Session Checkout can have an owner Session.');
    }
    checkout.version += 1;
    checkout.updatedAt = this.now().toISOString();
    next.revision += 1;
    validateState(next, this.deviceId);
    await this.writeState(next);
    this.state = next;
    return publicSnapshot(next);
  }

  private async registerRepositoryNow(
    request: DeviceRepositoryRegistrationRequest
  ): Promise<DeviceWorkspaceSnapshot> {
    this.assertInitialized();
    requireRevision(request.expectedRevision, this.state.revision);
    const repository = request.repository;
    const checkout = request.mainCheckout;
    if (
      !isDeviceId(repository.id)
      || this.state.repositories.some((candidate) => candidate.id === repository.id)
      || !validRepositoryIdentity(repository.identity)
      || !isDeviceId(checkout.id)
      || checkout.repositoryId !== repository.id
      || this.state.checkouts.some((candidate) => candidate.id === checkout.id)
      || !checkout.path?.trim()
      || checkout.role !== 'main'
      || checkout.lifecycle !== 'pending'
      || (checkout.runMode === 'wsl' && !checkout.wslDistro?.trim())
      || checkout.ownerSessionId !== undefined
      || this.state.checkouts.some((candidate) =>
        checkoutScopeKey(candidate) === checkoutScopeKey(checkout)
      )
    ) throw new Error('Repository registration is invalid.');
    const timestamp = this.now().toISOString();
    const next = structuredClone(this.state);
    next.repositories.push({
      ...structuredClone(repository),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    next.checkouts.push({
      ...structuredClone(checkout),
      path: checkout.path.trim(),
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    next.revision += 1;
    validateState(next, this.deviceId);
    await this.writeState(next);
    this.state = next;
    return publicSnapshot(next);
  }

  private newId(label: string): string {
    const value = this.idFactory();
    if (!isDeviceId(value)) throw new Error(`${label} identity factory must return a UUID.`);
    return value;
  }

  private async writeState(state: PersistedDeviceWorkspaceState): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    await fs.rename(temporary, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Initialize the Workspace Device Store before use.');
  }
}

function ensureCheckout(input: {
  state: PersistedDeviceWorkspaceState;
  checkoutByScope: Map<string, CheckoutRecord>;
  repositoryId: string;
  path: string;
  runMode: RunMode;
  wslDistro?: string;
  role: CheckoutRecord['role'];
  timestamp: string;
  idFactory: () => string;
}): CheckoutRecord {
  const key = checkoutScopeKey(input);
  const existing = input.checkoutByScope.get(key);
  if (existing) {
    if (existing.repositoryId !== input.repositoryId) {
      throw new Error('One physical Checkout cannot belong to two Device Repositories.');
    }
    if (input.role === 'main' && existing.role !== 'main') existing.role = 'main';
    return existing;
  }
  const checkout: CheckoutRecord = {
    id: input.idFactory(),
    repositoryId: input.repositoryId,
    path: input.path,
    runMode: input.runMode,
    ...(input.wslDistro ? { wslDistro: input.wslDistro } : {}),
    role: input.role,
    lifecycle: 'ready',
    version: 1,
    createdAt: input.timestamp,
    updatedAt: input.timestamp
  };
  input.state.checkouts.push(checkout);
  input.checkoutByScope.set(key, checkout);
  return checkout;
}

function checkoutScopeKey(value: {
  path?: string;
  cwd?: string;
  runMode: RunMode;
  wslDistro?: string;
}): string {
  const pathValue = (value.path ?? value.cwd ?? '').trim();
  const windows = value.runMode === 'windows';
  const normalizedPath = pathValue
    .replace(/\\/gu, '/')
    .replace(/\/+$/u, '')
    .normalize('NFC');
  const pathKey = windows ? normalizedPath.toLowerCase() : normalizedPath;
  return `${value.runMode}\0${value.runMode === 'wsl' ? value.wslDistro ?? '' : ''}\0${pathKey}`;
}

function parseState(value: unknown, deviceId: DeviceId): PersistedDeviceWorkspaceState {
  const state = structuredClone(value) as PersistedDeviceWorkspaceState;
  validateState(state, deviceId);
  return state;
}

function validateState(state: PersistedDeviceWorkspaceState, deviceId: DeviceId): void {
  if (
    !state
    || state.schemaVersion !== 1
    || state.deviceId !== deviceId
    || !Number.isSafeInteger(state.revision)
    || state.revision < 0
    || !Array.isArray(state.repositories)
    || !Array.isArray(state.checkouts)
    || !Array.isArray(state.migrations)
  ) throw new Error('Device Workspace registry is invalid.');
  const repositoryIds = new Set<string>();
  for (const repository of state.repositories) {
    if (!isDeviceId(repository.id) || repositoryIds.has(repository.id)) {
      throw new Error('Device Workspace registry contains invalid Repositories.');
    }
    repositoryIds.add(repository.id);
  }
  const checkoutIds = new Set<string>();
  const scopes = new Set<string>();
  for (const checkout of state.checkouts) {
    if (
      !isDeviceId(checkout.id)
      || checkoutIds.has(checkout.id)
      || !repositoryIds.has(checkout.repositoryId)
      || !checkout.path.trim()
      || (checkout.runMode === 'wsl' && !checkout.wslDistro)
      || !['main', 'workspace', 'isolated-session', 'external'].includes(checkout.role)
      || !['pending', 'ready', 'missing', 'cleanup-planned', 'removed'].includes(checkout.lifecycle)
      || (checkout.role === 'isolated-session' && !checkout.ownerSessionId?.trim())
      || (checkout.role !== 'isolated-session' && checkout.ownerSessionId !== undefined)
    ) throw new Error('Device Workspace registry contains invalid Checkouts.');
    const scope = checkoutScopeKey(checkout);
    if (scopes.has(scope)) throw new Error('Device Workspace registry contains duplicate Checkout scopes.');
    scopes.add(scope);
    checkoutIds.add(checkout.id);
  }
}

function publicSnapshot(state: PersistedDeviceWorkspaceState): DeviceWorkspaceSnapshot {
  return {
    schemaVersion: 1,
    revision: state.revision,
    deviceId: state.deviceId,
    repositories: structuredClone(state.repositories),
    checkouts: structuredClone(state.checkouts)
  };
}

function migrationResult(
  state: PersistedDeviceWorkspaceState,
  migration: PersistedDeviceWorkspaceState['migrations'][number]
): DeviceWorkspaceLegacyMigrationResult {
  return {
    snapshot: publicSnapshot(state),
    projectRepositories: structuredClone(migration.projectRepositories),
    sessionSources: structuredClone(migration.sessionSources)
  };
}

function emptyState(deviceId: DeviceId): PersistedDeviceWorkspaceState {
  return {
    schemaVersion: 1,
    revision: 0,
    deviceId,
    repositories: [],
    checkouts: [],
    migrations: []
  };
}

function validateLegacyProject(project: Project): void {
  if (!project?.id?.trim() || !project.name.trim() || !project.path.trim()) {
    throw new Error('Legacy Project is invalid.');
  }
}

function validateLegacySession(session: Session): void {
  if (!session?.id?.trim() || !session.cwd.trim()) throw new Error('Legacy Session is invalid.');
  if (session.runMode === 'wsl' && !session.wslDistro) {
    throw new Error('Legacy WSL Session is missing its distribution.');
  }
}

function requiredMigrationKey(value: string): string {
  const key = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,256}$/u.test(key)) throw new Error('Migration key is invalid.');
  return key;
}

function inferRunMode(): RunMode {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function requireRevision(expected: number, actual: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0) {
    throw new Error('Device Workspace revision is invalid.');
  }
  if (expected !== actual) {
    throw new Error(`Device Workspace revision ${expected} is stale; current revision is ${actual}.`);
  }
}

function validRepositoryIdentity(identity: RepositoryRecord['identity']): boolean {
  if (identity === null) return true;
  if (identity.kind === 'unpublished') return isDeviceId(identity.localIdentityId);
  return Boolean(
    identity.kind === 'git'
    && identity.canonicalUrl.trim()
    && !/[\u0000-\u001f\u007f]/u.test(identity.canonicalUrl)
    && (identity.provider === undefined || identity.provider === 'github')
  );
}
