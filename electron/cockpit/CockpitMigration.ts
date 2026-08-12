import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { isDeviceId } from '@shared/types/devices.js';
import type { Project } from '@shared/types/projects.js';
import type { Session } from '@shared/types/sessions.js';
import type {
  CatalogMigrationRecord,
  CatalogMutation,
  CockpitCatalogSnapshot,
  CheckoutRecord,
  SessionSource,
  WorkspaceSource
} from '@shared/types/workspaces.js';
import type { WorkspaceDeviceStore } from '@soloe/domain';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { CockpitCatalogStore } from './CockpitCatalogStore.js';

export interface CockpitMigrationOptions {
  catalog: CockpitCatalogStore;
  deviceStore: WorkspaceDeviceStore;
  sessions: SessionStore;
  resolveWorkspaceSource: (checkout: CheckoutRecord) => Promise<WorkspaceSource | null>;
  idFactory?: () => string;
  now?: () => Date;
}
export interface MigrateLegacyDeviceRequest {
  migrationKey: string;
  projects: Project[];
}

export class CockpitMigration {
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private request: Promise<CockpitCatalogSnapshot> | null = null;

  constructor(private readonly options: CockpitMigrationOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  migrateLegacyDevice(request: MigrateLegacyDeviceRequest): Promise<CockpitCatalogSnapshot> {
    this.request ??= this.migrateLegacyDeviceNow(request).finally(() => {
      this.request = null;
    });
    return this.request;
  }

  private async migrateLegacyDeviceNow(
    request: MigrateLegacyDeviceRequest
  ): Promise<CockpitCatalogSnapshot> {
    const migrationKey = requiredMigrationKey(request.migrationKey);
    const active = await this.options.sessions.list();
    const archived = await this.options.sessions.listArchived();
    const sessions = [...active, ...archived].sort(compareSessions);
    const adopted = await this.options.deviceStore.adoptLegacy({
      migrationKey,
      projects: request.projects,
      sessions
    });

    for (const binding of adopted.sessionSources) {
      const session = await this.options.sessions.get(binding.sessionId);
      if (!session) continue;
      if (session.source) {
        if (!sameSource(session.source, binding.source)) {
          throw new Error(
            `Legacy migration refuses to replace the explicit Source of Session ${session.id}.`
          );
        }
        continue;
      }
      await this.options.sessions.bindSource(
        session.id,
        binding.source,
        session.version ?? 1
      );
    }

    const current = this.options.catalog.snapshot();
    if (current.migrations.some((migration) => migration.key === migrationKey)) {
      return current;
    }

    const mutations: CatalogMutation[] = [];
    const projectMap: Record<string, string> = {};
    const workspaceMap: Record<string, string> = {};
    const sourceByCheckout = new Map<string, WorkspaceSource | null>();
    for (const checkout of adopted.snapshot.checkouts) {
      sourceByCheckout.set(
        checkout.id,
        await this.options.resolveWorkspaceSource(structuredClone(checkout))
      );
    }
    const sourceBySession = new Map(
      adopted.sessionSources.map((binding) => [binding.sessionId, binding.source])
    );

    for (const project of [...request.projects].sort(compareProjects)) {
      const repositoryId = adopted.projectRepositories[project.id];
      if (!repositoryId) continue;
      const logicalProjectId = this.newId('Project');
      projectMap[project.id] = logicalProjectId;
      mutations.push({
        type: 'project.create',
        project: {
          id: logicalProjectId,
          name: project.name,
          canonicalRepository: null,
          order: project.sortIndex
        }
      });
      mutations.push({
        type: 'presence.link',
        projectId: logicalProjectId,
        repository: {
          deviceId: this.options.deviceStore.deviceId,
          repositoryId
        },
        adoptedFromEvidence: null
      });

      const repositoryCheckouts = adopted.snapshot.checkouts
        .filter((checkout) => checkout.repositoryId === repositoryId)
        .sort((left, right) => checkoutOrder(project, left) - checkoutOrder(project, right));
      for (const checkout of repositoryCheckouts) {
        const source = sourceByCheckout.get(checkout.id) ?? null;
        if (!source) continue;
        const workspaceId = this.newId('Workspace');
        const locationId = this.newId('Workspace Location');
        workspaceMap[`${project.id}:${checkout.id}`] = workspaceId;
        mutations.push({
          type: 'workspace.create',
          workspace: {
            id: workspaceId,
            projectId: logicalProjectId,
            name: workspaceName(project, checkout, source),
            source,
            order: checkoutOrder(project, checkout)
          }
        });
        mutations.push({
          type: 'location.link',
          location: {
            id: locationId,
            workspaceId,
            checkout: {
              deviceId: this.options.deviceStore.deviceId,
              checkoutId: checkout.id
            },
            state: checkout.lifecycle === 'ready' ? 'available' : 'unavailable'
          }
        });
        const members = sessions.filter((session) =>
          sourceBySession.get(session.id)?.checkoutId === checkout.id
        );
        members.forEach((session, order) => {
          mutations.push({
            type: 'session.regroup',
            sessionRef: {
              deviceId: this.options.deviceStore.deviceId,
              sessionId: session.id
            },
            workspaceId,
            order
          });
        });
      }
    }

    const migration: CatalogMigrationRecord = {
      key: migrationKey,
      completedAt: this.now().toISOString(),
      projectMap,
      workspaceMap
    };
    mutations.push({ type: 'migration.record', migration });
    const result = await this.options.catalog.execute({
      expectedRevision: current.revision,
      mutations
    });
    return result.snapshot;
  }

  private newId(label: string): string {
    const value = this.idFactory();
    if (!isDeviceId(value)) throw new Error(`${label} identity factory must return a UUID.`);
    return value;
  }
}

function compareProjects(left: Project, right: Project): number {
  return (left.sortIndex ?? Number.MAX_SAFE_INTEGER)
    - (right.sortIndex ?? Number.MAX_SAFE_INTEGER)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function compareSessions(left: Session, right: Session): number {
  return (left.sortIndex ?? Number.MAX_SAFE_INTEGER)
    - (right.sortIndex ?? Number.MAX_SAFE_INTEGER)
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

function checkoutOrder(project: Project, checkout: CheckoutRecord): number {
  const ordered = project.worktreeOrder ?? [];
  const found = ordered.findIndex((candidate) => samePath(candidate, checkout.path));
  if (found >= 0) return found;
  if (samePath(project.path, checkout.path)) return 0;
  return ordered.length + 1;
}

function workspaceName(
  project: Project,
  checkout: CheckoutRecord,
  source: WorkspaceSource
): string {
  if (source.kind === 'branch') return source.localRef.slice('refs/heads/'.length);
  if (source.kind === 'pull_request') return `PR #${source.number}`;
  return source.label?.trim() || path.basename(checkout.path) || project.name;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return normalize(left) === normalize(right);
}

function sameSource(left: SessionSource, right: SessionSource): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requiredMigrationKey(value: string): string {
  const key = value.trim();
  if (!/^[a-zA-Z0-9._:-]{1,256}$/u.test(key)) throw new Error('Migration key is invalid.');
  return key;
}
