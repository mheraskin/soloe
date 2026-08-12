import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { isDeviceId } from '@shared/types/devices.js';
import { sessionRefKey } from '@shared/types/cockpit.js';
import type {
  CockpitCatalogExportBundle,
  CockpitCatalogImportRequest,
  CockpitCatalogImportResult
} from '@shared/types/cockpit.js';
import type {
  CatalogMutation,
  CatalogTransaction,
  CatalogTransactionResult,
  CockpitCatalogSnapshot,
  LogicalProject,
  ProjectPresence,
  RepositoryIdentity,
  SessionMembership,
  Workspace,
  WorkspaceLocation,
  WorkspaceSource
} from '@shared/types/workspaces.js';

const MAX_CATALOG_ENTITIES = 100_000;
const MAX_MUTATIONS_PER_TRANSACTION = 1_000;

export interface CockpitCatalogStoreOptions {
  now?: () => Date;
}

export class CockpitCatalogStore {
  private state: CockpitCatalogSnapshot = emptyCatalog();
  private initialized = false;
  private transactionQueue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: CockpitCatalogSnapshot) => void>();
  private readonly now: () => Date;

  constructor(
    private readonly filePath: string,
    options: CockpitCatalogStoreOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    let source: string;
    try {
      source = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.writeSnapshot(this.state);
      this.initialized = true;
      return;
    }
    try {
      this.state = parseCatalog(JSON.parse(source));
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}.bak`;
      await fs.writeFile(backupPath, source, { encoding: 'utf8', flag: 'wx' }).catch(() => undefined);
      throw new CatalogCorruptError(
        error instanceof Error ? error.message : 'Cockpit catalog is invalid.',
        backupPath
      );
    }
    this.initialized = true;
  }

  snapshot(): CockpitCatalogSnapshot {
    this.assertInitialized();
    return cloneCatalog(this.state);
  }

  exportBundle(cockpitId: string, exportEpoch = randomUUID()): CockpitCatalogExportBundle {
    this.assertInitialized();
    requiredUuid(cockpitId, 'Cockpit');
    requiredUuid(exportEpoch, 'Catalog export epoch');
    const catalog = cloneCatalog(this.state);
    return {
      manifest: {
        schemaVersion: 1,
        cockpitId,
        exportEpoch,
        exportedAt: this.now().toISOString(),
        catalogSchemaVersion: catalog.schemaVersion,
        catalogRevision: catalog.revision,
        checksum: {
          algorithm: 'sha256',
          value: catalogChecksum(catalog)
        }
      },
      catalog
    };
  }

  importBundle(request: CockpitCatalogImportRequest): Promise<CockpitCatalogImportResult> {
    const execute = this.transactionQueue.then(() => this.importBundleNow(request));
    this.transactionQueue = execute.catch(() => undefined);
    return execute;
  }

  execute(transaction: CatalogTransaction): Promise<CatalogTransactionResult> {
    const execute = this.transactionQueue.then(() => this.executeNow(transaction));
    this.transactionQueue = execute.catch(() => undefined);
    return execute;
  }

  onChange(listener: (snapshot: CockpitCatalogSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async executeNow(transaction: CatalogTransaction): Promise<CatalogTransactionResult> {
    this.assertInitialized();
    validateTransaction(transaction);
    if (transaction.expectedRevision !== this.state.revision) {
      throw new CatalogConflictError(transaction.expectedRevision, this.state.revision);
    }
    const next = cloneCatalog(this.state);
    const changed = new Set<string>();
    const timestamp = this.now().toISOString();
    for (const mutation of transaction.mutations) {
      applyMutation(next, mutation, timestamp, changed);
    }
    validateCatalog(next);
    next.revision += 1;
    await this.writeSnapshot(next);
    this.state = next;
    const snapshot = cloneCatalog(next);
    this.publish(snapshot);
    return { snapshot, changedEntityRefs: [...changed] };
  }

  private async importBundleNow(
    request: CockpitCatalogImportRequest
  ): Promise<CockpitCatalogImportResult> {
    this.assertInitialized();
    if (!request || request.replace !== true || !Number.isSafeInteger(request.expectedRevision)) {
      throw new CatalogArchiveError(
        'catalog_archive_invalid',
        'Catalog import must explicitly replace one expected catalog revision.'
      );
    }
    if (request.expectedRevision !== this.state.revision) {
      throw new CatalogConflictError(request.expectedRevision, this.state.revision);
    }
    const bundle = parseExportBundle(request.bundle);
    const next = cloneCatalog(bundle.catalog);
    next.revision = Math.max(this.state.revision, next.revision) + 1;
    validateCatalog(next);

    const backupPath = `${this.filePath}.pre-import-${this.now().getTime()}-${randomUUID()}.bak`;
    await fs.writeFile(backupPath, JSON.stringify(this.state, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    await this.writeSnapshot(next);
    this.state = next;
    const snapshot = cloneCatalog(next);
    this.publish(snapshot);
    return {
      snapshot,
      sourceCockpitId: bundle.manifest.cockpitId,
      exportEpoch: bundle.manifest.exportEpoch,
      backupPath
    };
  }

  private async writeSnapshot(snapshot: CockpitCatalogSnapshot): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), {
      encoding: 'utf8',
      flag: 'wx'
    });
    await fs.rename(temporary, this.filePath);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Initialize the Cockpit Catalog before use.');
  }

  private publish(snapshot: CockpitCatalogSnapshot): void {
    for (const listener of this.listeners) {
      try {
        listener(cloneCatalog(snapshot));
      } catch {
        // Catalog observers do not own transaction durability.
      }
    }
  }
}

export class CatalogConflictError extends Error {
  readonly code = 'catalog_revision_conflict';

  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Cockpit Catalog revision ${expectedRevision} is stale; current revision is ${actualRevision}.`);
    this.name = 'CatalogConflictError';
  }
}

export class CatalogEntityConflictError extends Error {
  readonly code = 'catalog_entity_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'CatalogEntityConflictError';
  }
}

export class CatalogCorruptError extends Error {
  readonly code = 'catalog_corrupt';

  constructor(message: string, readonly backupPath: string) {
    super(`${message} A byte-for-byte backup was written before refusing to continue.`);
    this.name = 'CatalogCorruptError';
  }
}

export class CatalogArchiveError extends Error {
  constructor(
    readonly code:
      | 'catalog_archive_invalid'
      | 'catalog_archive_unsupported'
      | 'catalog_archive_checksum_mismatch',
    message: string
  ) {
    super(message);
    this.name = 'CatalogArchiveError';
  }
}

function emptyCatalog(): CockpitCatalogSnapshot {
  return {
    schemaVersion: 1,
    revision: 0,
    projects: [],
    projectPresences: [],
    workspaces: [],
    workspaceLocations: [],
    sessionMemberships: [],
    migrations: []
  };
}

function applyMutation(
  catalog: CockpitCatalogSnapshot,
  mutation: CatalogMutation,
  timestamp: string,
  changed: Set<string>
): void {
  switch (mutation.type) {
    case 'project.create': {
      requiredUuid(mutation.project.id, 'Project');
      requiredName(mutation.project.name, 'Project');
      if (catalog.projects.some((project) => project.id === mutation.project.id)) {
        throw new CatalogEntityConflictError(`Project already exists: ${mutation.project.id}`);
      }
      const project: LogicalProject = {
        id: mutation.project.id,
        version: 1,
        name: mutation.project.name.trim(),
        canonicalRepository: cloneValue(mutation.project.canonicalRepository),
        repositoryAliases: cloneValue(mutation.project.repositoryAliases ?? []),
        order: finiteOrder(mutation.project.order, nextProjectOrder(catalog)),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      validateRepositoryIdentity(project.canonicalRepository);
      project.repositoryAliases.forEach(validateRepositoryIdentity);
      catalog.projects.push(project);
      changed.add(`project:${project.id}`);
      return;
    }
    case 'project.rename': {
      const project = requireProject(catalog, mutation.projectId);
      requireEntityVersion(project.version, mutation.expectedVersion, `Project ${project.id}`);
      requiredName(mutation.name, 'Project');
      project.name = mutation.name.trim();
      project.version += 1;
      project.updatedAt = timestamp;
      changed.add(`project:${project.id}`);
      return;
    }
    case 'project.archive': {
      const project = requireProject(catalog, mutation.projectId);
      requireEntityVersion(project.version, mutation.expectedVersion, `Project ${project.id}`);
      if (mutation.archived) project.archivedAt = timestamp;
      else delete project.archivedAt;
      project.version += 1;
      project.updatedAt = timestamp;
      changed.add(`project:${project.id}`);
      return;
    }
    case 'project.repository': {
      const project = requireProject(catalog, mutation.projectId);
      requireEntityVersion(project.version, mutation.expectedVersion, `Project ${project.id}`);
      validateRepositoryIdentity(mutation.canonicalRepository);
      mutation.repositoryAliases?.forEach(validateRepositoryIdentity);
      const aliases = [
        ...project.repositoryAliases,
        ...(project.canonicalRepository ? [project.canonicalRepository] : []),
        ...(mutation.repositoryAliases ?? [])
      ];
      project.canonicalRepository = cloneValue(mutation.canonicalRepository);
      project.repositoryAliases = uniqueRepositoryIdentities(aliases)
        .filter((identity) => !sameRepositoryIdentity(identity, project.canonicalRepository));
      project.version += 1;
      project.updatedAt = timestamp;
      changed.add(`project:${project.id}`);
      return;
    }
    case 'presence.link': {
      requireProject(catalog, mutation.projectId);
      validateRepositoryRef(mutation.repository);
      validateRepositoryIdentity(mutation.adoptedFromEvidence);
      const repositoryKey = `${mutation.repository.deviceId}\0${mutation.repository.repositoryId}`;
      const conflicting = catalog.projectPresences.find((presence) =>
        `${presence.repository.deviceId}\0${presence.repository.repositoryId}` === repositoryKey
        && presence.projectId !== mutation.projectId
      );
      if (conflicting) {
        throw new CatalogEntityConflictError('A Device Repository cannot be linked to two Projects.');
      }
      catalog.projectPresences = catalog.projectPresences.filter((presence) =>
        !(presence.projectId === mutation.projectId
          && presence.repository.deviceId === mutation.repository.deviceId)
      );
      const presence: ProjectPresence = {
        projectId: mutation.projectId,
        repository: cloneValue(mutation.repository),
        adoptedFromEvidence: cloneValue(mutation.adoptedFromEvidence),
        linkedAt: timestamp
      };
      catalog.projectPresences.push(presence);
      changed.add(`project:${mutation.projectId}`);
      changed.add(`repository:${repositoryKey}`);
      return;
    }
    case 'workspace.create': {
      requiredUuid(mutation.workspace.id, 'Workspace');
      requiredName(mutation.workspace.name, 'Workspace');
      requireProject(catalog, mutation.workspace.projectId);
      if (catalog.workspaces.some((workspace) => workspace.id === mutation.workspace.id)) {
        throw new CatalogEntityConflictError(`Workspace already exists: ${mutation.workspace.id}`);
      }
      validateWorkspaceSource(mutation.workspace.source);
      const workspace: Workspace = {
        id: mutation.workspace.id,
        projectId: mutation.workspace.projectId,
        version: 1,
        name: mutation.workspace.name.trim(),
        source: cloneValue(mutation.workspace.source),
        order: finiteOrder(
          mutation.workspace.order,
          nextWorkspaceOrder(catalog, mutation.workspace.projectId)
        ),
        createdAt: timestamp,
        updatedAt: timestamp
      };
      catalog.workspaces.push(workspace);
      changed.add(`workspace:${workspace.id}`);
      return;
    }
    case 'workspace.update': {
      const workspace = requireWorkspace(catalog, mutation.workspaceId);
      requireEntityVersion(
        workspace.version,
        mutation.expectedVersion,
        `Workspace ${workspace.id}`
      );
      if (mutation.name !== undefined) {
        requiredName(mutation.name, 'Workspace');
        workspace.name = mutation.name.trim();
      }
      if (mutation.source !== undefined) {
        validateWorkspaceSource(mutation.source);
        workspace.source = cloneValue(mutation.source);
      }
      if (mutation.archived !== undefined) {
        if (mutation.archived) workspace.archivedAt = timestamp;
        else delete workspace.archivedAt;
      }
      workspace.version += 1;
      workspace.updatedAt = timestamp;
      changed.add(`workspace:${workspace.id}`);
      return;
    }
    case 'location.link': {
      requiredUuid(mutation.location.id, 'Workspace Location');
      requireWorkspace(catalog, mutation.location.workspaceId);
      validateCheckoutRef(mutation.location.checkout);
      if (catalog.workspaceLocations.some((location) => location.id === mutation.location.id)) {
        throw new CatalogEntityConflictError(
          `Workspace Location already exists: ${mutation.location.id}`
        );
      }
      if (catalog.workspaceLocations.some((location) =>
        location.workspaceId === mutation.location.workspaceId
        && location.checkout.deviceId === mutation.location.checkout.deviceId
      )) {
        throw new CatalogEntityConflictError(
          'A Workspace can have at most one ordinary Location on a Device.'
        );
      }
      if (catalog.workspaceLocations.some((location) =>
        location.checkout.deviceId === mutation.location.checkout.deviceId
        && location.checkout.checkoutId === mutation.location.checkout.checkoutId
      )) {
        throw new CatalogEntityConflictError(
          'A Checkout can realize at most one ordinary Workspace Location.'
        );
      }
      const location: WorkspaceLocation = {
        id: mutation.location.id,
        workspaceId: mutation.location.workspaceId,
        checkout: cloneValue(mutation.location.checkout),
        desiredRole: 'ordinary',
        state: mutation.location.state ?? 'proposed',
        version: 1,
        linkedAt: timestamp
      };
      catalog.workspaceLocations.push(location);
      changed.add(`location:${location.id}`);
      return;
    }
    case 'location.update': {
      const location = catalog.workspaceLocations.find(
        (candidate) => candidate.id === mutation.locationId
      );
      if (!location) throw new CatalogEntityConflictError(`Unknown Location: ${mutation.locationId}`);
      requireEntityVersion(
        location.version,
        mutation.expectedVersion,
        `Workspace Location ${location.id}`
      );
      location.state = mutation.state;
      location.version += 1;
      changed.add(`location:${location.id}`);
      return;
    }
    case 'session.regroup': {
      validateSessionRef(mutation.sessionRef);
      const destinationWorkspace = requireWorkspace(catalog, mutation.workspaceId);
      const key = sessionRefKey(mutation.sessionRef);
      const previous = catalog.sessionMemberships.find(
        (membership) => sessionRefKey(membership.sessionRef) === key
      );
      const sourceWorkspace = previous
        ? requireWorkspace(catalog, previous.workspaceId)
        : null;
      if (sourceWorkspace && sourceWorkspace.projectId !== destinationWorkspace.projectId) {
        throw new CatalogEntityConflictError(
          'A cross-Project move requires a planned Successor Session; regroup cannot move physical work.'
        );
      }
      catalog.sessionMemberships = catalog.sessionMemberships.filter(
        (membership) => sessionRefKey(membership.sessionRef) !== key
      );
      const membership: SessionMembership = {
        sessionRef: cloneValue(mutation.sessionRef),
        workspaceId: mutation.workspaceId,
        order: finiteOrder(
          mutation.order,
          nextMembershipOrder(catalog, mutation.workspaceId)
        ),
        linkedAt: timestamp
      };
      catalog.sessionMemberships.push(membership);
      normalizeMembershipOrder(catalog, mutation.workspaceId);
      changed.add(`session:${key}`);
      changed.add(`workspace:${mutation.workspaceId}`);
      if (previous && previous.workspaceId !== mutation.workspaceId) {
        changed.add(`workspace:${previous.workspaceId}`);
      }
      return;
    }
    case 'session.unassign': {
      validateSessionRef(mutation.sessionRef);
      const key = sessionRefKey(mutation.sessionRef);
      const previous = catalog.sessionMemberships.find(
        (membership) => sessionRefKey(membership.sessionRef) === key
      );
      catalog.sessionMemberships = catalog.sessionMemberships.filter(
        (membership) => sessionRefKey(membership.sessionRef) !== key
      );
      if (previous) normalizeMembershipOrder(catalog, previous.workspaceId);
      changed.add(`session:${key}`);
      return;
    }
    case 'session.reorder': {
      requireWorkspace(catalog, mutation.workspaceId);
      const requested = new Set<string>();
      for (const ref of mutation.sessionRefs) {
        validateSessionRef(ref);
        const key = sessionRefKey(ref);
        if (requested.has(key)) throw new CatalogEntityConflictError('Session reorder contains a duplicate.');
        requested.add(key);
      }
      const memberships = catalog.sessionMemberships.filter(
        (membership) => membership.workspaceId === mutation.workspaceId
      );
      const known = new Map(memberships.map((membership) => [
        sessionRefKey(membership.sessionRef),
        membership
      ]));
      if ([...requested].some((key) => !known.has(key))) {
        throw new CatalogEntityConflictError('Session reorder contains an unknown membership.');
      }
      const ordered = [
        ...mutation.sessionRefs.map((ref) => known.get(sessionRefKey(ref))!),
        ...memberships
          .filter((membership) => !requested.has(sessionRefKey(membership.sessionRef)))
          .sort((left, right) => left.order - right.order)
      ];
      ordered.forEach((membership, index) => { membership.order = index; });
      changed.add(`workspace:${mutation.workspaceId}`);
      return;
    }
    case 'migration.record': {
      const key = requiredMigrationKey(mutation.migration.key);
      if (catalog.migrations.some((migration) => migration.key === key)) {
        throw new CatalogEntityConflictError(`Catalog migration already exists: ${key}`);
      }
      requiredTimestamp(mutation.migration.completedAt, 'Catalog migration');
      catalog.migrations.push(structuredClone(mutation.migration));
      changed.add(`migration:${key}`);
      return;
    }
  }
}

function parseCatalog(value: unknown): CockpitCatalogSnapshot {
  if (!isRecord(value) || value['schemaVersion'] !== 1) {
    throw new Error('Cockpit Catalog schema is unsupported.');
  }
  const catalog = cloneValue(value) as unknown as CockpitCatalogSnapshot;
  validateCatalog(catalog);
  return catalog;
}

function parseExportBundle(value: unknown): CockpitCatalogExportBundle {
  if (!isRecord(value) || !isRecord(value['manifest'])) {
    throw new CatalogArchiveError('catalog_archive_invalid', 'Catalog export bundle is invalid.');
  }
  const manifest = value['manifest'];
  if (manifest['schemaVersion'] !== 1) {
    throw new CatalogArchiveError(
      'catalog_archive_unsupported',
      'Catalog export bundle schema is unsupported.'
    );
  }
  try {
    requiredUuid(manifest['cockpitId'], 'Source Cockpit');
    requiredUuid(manifest['exportEpoch'], 'Catalog export epoch');
    requiredTimestamp(manifest['exportedAt'], 'Catalog export');
  } catch (error) {
    throw new CatalogArchiveError(
      'catalog_archive_invalid',
      error instanceof Error ? error.message : 'Catalog export manifest is invalid.'
    );
  }
  const catalog = parseCatalog(value['catalog']);
  if (
    manifest['catalogSchemaVersion'] !== catalog.schemaVersion
    || manifest['catalogRevision'] !== catalog.revision
    || !isRecord(manifest['checksum'])
    || manifest['checksum']['algorithm'] !== 'sha256'
    || typeof manifest['checksum']['value'] !== 'string'
    || !/^[0-9a-f]{64}$/u.test(manifest['checksum']['value'])
  ) {
    throw new CatalogArchiveError(
      'catalog_archive_invalid',
      'Catalog export manifest does not match its catalog payload.'
    );
  }
  if (catalogChecksum(catalog) !== manifest['checksum']['value']) {
    throw new CatalogArchiveError(
      'catalog_archive_checksum_mismatch',
      'Catalog export checksum does not match its payload.'
    );
  }
  return cloneValue(value) as unknown as CockpitCatalogExportBundle;
}

function validateCatalog(catalog: CockpitCatalogSnapshot): void {
  if (
    catalog.schemaVersion !== 1
    || !Number.isSafeInteger(catalog.revision)
    || catalog.revision < 0
    || !Array.isArray(catalog.projects)
    || !Array.isArray(catalog.projectPresences)
    || !Array.isArray(catalog.workspaces)
    || !Array.isArray(catalog.workspaceLocations)
    || !Array.isArray(catalog.sessionMemberships)
    || !Array.isArray(catalog.migrations)
  ) throw new Error('Cockpit Catalog shape is invalid.');
  const entityCount = catalog.projects.length
    + catalog.projectPresences.length
    + catalog.workspaces.length
    + catalog.workspaceLocations.length
    + catalog.sessionMemberships.length;
  if (entityCount > MAX_CATALOG_ENTITIES) throw new Error('Cockpit Catalog exceeds its entity limit.');
  const projectIds = new Set<string>();
  for (const project of catalog.projects) {
    requiredUuid(project.id, 'Project');
    if (projectIds.has(project.id)) throw new Error('Cockpit Catalog contains duplicate Projects.');
    projectIds.add(project.id);
    requiredVersion(project.version, 'Project');
    requiredName(project.name, 'Project');
    validateRepositoryIdentity(project.canonicalRepository);
    if (!Array.isArray(project.repositoryAliases)) throw new Error('Project aliases are invalid.');
    project.repositoryAliases.forEach(validateRepositoryIdentity);
    requiredOrder(project.order, 'Project');
    requiredTimestamp(project.createdAt, 'Project');
    requiredTimestamp(project.updatedAt, 'Project');
  }
  const workspaceIds = new Set<string>();
  for (const workspace of catalog.workspaces) {
    requiredUuid(workspace.id, 'Workspace');
    if (workspaceIds.has(workspace.id)) throw new Error('Cockpit Catalog contains duplicate Workspaces.');
    workspaceIds.add(workspace.id);
    if (!projectIds.has(workspace.projectId)) throw new Error('Workspace references an unknown Project.');
    requiredVersion(workspace.version, 'Workspace');
    requiredName(workspace.name, 'Workspace');
    validateWorkspaceSource(workspace.source);
    requiredOrder(workspace.order, 'Workspace');
    requiredTimestamp(workspace.createdAt, 'Workspace');
    requiredTimestamp(workspace.updatedAt, 'Workspace');
  }
  const repositories = new Set<string>();
  const presenceDevices = new Set<string>();
  for (const presence of catalog.projectPresences) {
    if (!projectIds.has(presence.projectId)) throw new Error('Presence references an unknown Project.');
    validateRepositoryRef(presence.repository);
    validateRepositoryIdentity(presence.adoptedFromEvidence);
    requiredTimestamp(presence.linkedAt, 'Presence');
    const repositoryKey = `${presence.repository.deviceId}\0${presence.repository.repositoryId}`;
    const deviceKey = `${presence.projectId}\0${presence.repository.deviceId}`;
    if (repositories.has(repositoryKey) || presenceDevices.has(deviceKey)) {
      throw new Error('Cockpit Catalog contains conflicting Project Presences.');
    }
    repositories.add(repositoryKey);
    presenceDevices.add(deviceKey);
  }
  const locationIds = new Set<string>();
  const locationCheckouts = new Set<string>();
  const workspaceDevices = new Set<string>();
  for (const location of catalog.workspaceLocations) {
    requiredUuid(location.id, 'Workspace Location');
    if (locationIds.has(location.id)) throw new Error('Cockpit Catalog contains duplicate Locations.');
    locationIds.add(location.id);
    if (!workspaceIds.has(location.workspaceId)) throw new Error('Location references an unknown Workspace.');
    validateCheckoutRef(location.checkout);
    requiredVersion(location.version, 'Workspace Location');
    requiredTimestamp(location.linkedAt, 'Workspace Location');
    const checkoutKey = `${location.checkout.deviceId}\0${location.checkout.checkoutId}`;
    const deviceKey = `${location.workspaceId}\0${location.checkout.deviceId}`;
    if (locationCheckouts.has(checkoutKey) || workspaceDevices.has(deviceKey)) {
      throw new Error('Cockpit Catalog contains conflicting Workspace Locations.');
    }
    locationCheckouts.add(checkoutKey);
    workspaceDevices.add(deviceKey);
  }
  const memberships = new Set<string>();
  for (const membership of catalog.sessionMemberships) {
    validateSessionRef(membership.sessionRef);
    if (!workspaceIds.has(membership.workspaceId)) {
      throw new Error('Session Membership references an unknown Workspace.');
    }
    const key = sessionRefKey(membership.sessionRef);
    if (memberships.has(key)) throw new Error('Session belongs to more than one Workspace.');
    memberships.add(key);
    requiredOrder(membership.order, 'Session Membership');
    requiredTimestamp(membership.linkedAt, 'Session Membership');
  }
  if (catalog.migrations.some((migration) =>
    !migration
    || requiredMigrationKeyOrNull(migration.key) === null
    || typeof migration.projectMap !== 'object'
    || migration.projectMap === null
    || typeof migration.workspaceMap !== 'object'
    || migration.workspaceMap === null
    || typeof migration.completedAt !== 'string'
    || !Number.isFinite(Date.parse(migration.completedAt))
  )) throw new Error('Catalog migration record is invalid.');
}

function validateTransaction(transaction: CatalogTransaction): void {
  if (
    !transaction
    || !Number.isSafeInteger(transaction.expectedRevision)
    || transaction.expectedRevision < 0
    || !Array.isArray(transaction.mutations)
    || transaction.mutations.length === 0
    || transaction.mutations.length > MAX_MUTATIONS_PER_TRANSACTION
  ) throw new Error('Cockpit Catalog transaction is invalid.');
}

function validateWorkspaceSource(source: WorkspaceSource): void {
  if (!source || typeof source !== 'object') throw new Error('Workspace Source is invalid.');
  if (source.kind === 'branch') {
    requiredFullRef(source.localRef, 'Branch');
    if (source.upstream) {
      validateRepositoryIdentity(source.upstream.repository);
      requiredFullRef(source.upstream.ref, 'upstream Branch');
    }
    return;
  }
  if (source.kind === 'revision') {
    requiredOid(source.oid);
    if (source.repository) validateRepositoryIdentity(source.repository);
    return;
  }
  if (source.kind === 'pull_request') {
    if (source.provider !== 'github' || !source.providerPullRequestId.trim()) {
      throw new Error('Pull Request Source is invalid.');
    }
    if (!Number.isSafeInteger(source.number) || source.number < 1) {
      throw new Error('Pull Request number is invalid.');
    }
    validateRepositoryIdentity(source.repository);
    validateRepositoryIdentity(source.head.repository);
    validateRepositoryIdentity(source.base.repository);
    requiredFullRef(source.head.ref, 'Pull Request head');
    requiredFullRef(source.base.ref, 'Pull Request base');
    return;
  }
  throw new Error('Workspace Source kind is invalid.');
}

function validateRepositoryIdentity(identity: RepositoryIdentity | null): void {
  if (identity === null) return;
  if (identity.kind === 'unpublished') {
    requiredUuid(identity.localIdentityId, 'unpublished Repository identity');
    return;
  }
  if (identity.kind === 'git') {
    const url = new URL(identity.canonicalUrl);
    if (!['https:', 'ssh:', 'file:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Repository identity URL is invalid.');
    }
    return;
  }
  throw new Error('Repository identity is invalid.');
}

function uniqueRepositoryIdentities(identities: RepositoryIdentity[]): RepositoryIdentity[] {
  const unique = new Map<string, RepositoryIdentity>();
  for (const identity of identities) unique.set(repositoryIdentityKey(identity), cloneValue(identity));
  return [...unique.values()];
}

function sameRepositoryIdentity(
  left: RepositoryIdentity,
  right: RepositoryIdentity | null
): boolean {
  return right !== null && repositoryIdentityKey(left) === repositoryIdentityKey(right);
}

function repositoryIdentityKey(identity: RepositoryIdentity): string {
  return identity.kind === 'unpublished'
    ? `unpublished:${identity.localIdentityId}`
    : `git:${identity.provider ?? ''}:${identity.providerRepositoryId ?? ''}:${identity.canonicalUrl}`;
}

function validateRepositoryRef(ref: { deviceId: string; repositoryId: string }): void {
  requiredUuid(ref.deviceId, 'Device');
  requiredUuid(ref.repositoryId, 'Repository');
}

function validateCheckoutRef(ref: { deviceId: string; checkoutId: string }): void {
  requiredUuid(ref.deviceId, 'Device');
  requiredUuid(ref.checkoutId, 'Checkout');
}

function validateSessionRef(ref: { deviceId: string; sessionId: string }): void {
  requiredUuid(ref.deviceId, 'Device');
  requiredLocalId(ref.sessionId, 'Session');
}

function requireProject(catalog: CockpitCatalogSnapshot, projectId: string): LogicalProject {
  const project = catalog.projects.find((candidate) => candidate.id === projectId);
  if (!project) throw new CatalogEntityConflictError(`Unknown Project: ${projectId}`);
  return project;
}

function requireWorkspace(catalog: CockpitCatalogSnapshot, workspaceId: string): Workspace {
  const workspace = catalog.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) throw new CatalogEntityConflictError(`Unknown Workspace: ${workspaceId}`);
  return workspace;
}

function requireEntityVersion(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new CatalogEntityConflictError(`${label} version ${expected} is stale; current version is ${actual}.`);
  }
}

function nextProjectOrder(catalog: CockpitCatalogSnapshot): number {
  return nextOrder(catalog.projects.map((project) => project.order));
}

function nextWorkspaceOrder(catalog: CockpitCatalogSnapshot, projectId: string): number {
  return nextOrder(catalog.workspaces
    .filter((workspace) => workspace.projectId === projectId)
    .map((workspace) => workspace.order));
}

function nextMembershipOrder(catalog: CockpitCatalogSnapshot, workspaceId: string): number {
  return nextOrder(catalog.sessionMemberships
    .filter((membership) => membership.workspaceId === workspaceId)
    .map((membership) => membership.order));
}

function nextOrder(values: number[]): number {
  return values.reduce((maximum, value) => Math.max(maximum, value), -1) + 1;
}

function normalizeMembershipOrder(catalog: CockpitCatalogSnapshot, workspaceId: string): void {
  catalog.sessionMemberships
    .filter((membership) => membership.workspaceId === workspaceId)
    .sort((left, right) => left.order - right.order || sessionRefKey(left.sessionRef).localeCompare(
      sessionRefKey(right.sessionRef)
    ))
    .forEach((membership, index) => { membership.order = index; });
}

function finiteOrder(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  requiredOrder(value, 'Catalog entity');
  return value;
}

function requiredUuid(value: unknown, label: string): asserts value is string {
  if (!isDeviceId(value)) throw new Error(`${label} ID must be a UUID.`);
}

function requiredName(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 256) {
    throw new Error(`${label} name is invalid.`);
  }
}

function requiredLocalId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error(`${label} ID is invalid.`);
}

function requiredFullRef(value: string, label: string): void {
  if (!value.startsWith('refs/') || value.length > 1_024 || /[\s~^:?*\\[\]]/u.test(value)) {
    throw new Error(`${label} ref must be a full Git ref.`);
  }
}

function requiredOid(value: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(value)) {
    throw new Error('Revision Source must contain a full Git object ID.');
  }
}

function requiredVersion(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} version is invalid.`);
}

function requiredOrder(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} order is invalid.`);
}

function requiredTimestamp(value: unknown, label: string): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} timestamp is invalid.`);
  }
}

function requiredMigrationKey(value: string): string {
  const key = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,256}$/u.test(key)) throw new Error('Catalog migration key is invalid.');
  return key;
}

function requiredMigrationKeyOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return requiredMigrationKey(value);
  } catch {
    return null;
  }
}

function cloneCatalog(value: CockpitCatalogSnapshot): CockpitCatalogSnapshot {
  return structuredClone(value);
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function catalogChecksum(catalog: CockpitCatalogSnapshot): string {
  return createHash('sha256').update(canonicalJson(catalog), 'utf8').digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Catalog export contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  throw new Error('Catalog export contains an unsupported value.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
