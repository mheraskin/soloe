import type {
  VaultEntry,
  VaultEntryDraft,
  VaultEntryUpdate,
  VaultSecret
} from '../../shared/types/vault';
import type { DeviceId } from '../../shared/types/devices';
import type { RunMode } from '../../shared/types/sessions';
import {
  worktreeScope,
  worktreeScopeKey,
  type WorktreeScope
} from '../../shared/worktree-identity';
import { backend } from '../lib/ipc';
import type { ScopedVaultEntry } from '../lib/vault-groups';

type CwdKey = string;

interface CwdCache {
  entries: VaultEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

const EMPTY: CwdCache = { entries: [], loaded: false, loading: false, error: null };

function normalizeOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

export class VaultStore {
  private activeCwd = $state<string | null>(null);
  private activeProjectCwd = $state<string | null>(null);
  private activeDeviceId = $state<DeviceId | null>(null);
  private activeRunMode = $state<RunMode | undefined>(undefined);
  private activeWslDistro = $state<string | undefined>(undefined);
  private projectCwds = $state<string[]>([]);
  private byCwd = $state<Record<CwdKey, CwdCache>>({});
  private detachers: Array<() => void> = [];
  private eventVersions = new Map<CwdKey, number>();
  private refreshVersions = new Map<CwdKey, number>();
  private scopeByKey = new Map<CwdKey, WorktreeScope>();

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      backend.vault.onChange((event) => {
        const deviceId =
          'deviceId' in event && typeof event.deviceId === 'string'
            ? event.deviceId
            : null;
        const matchingScopes = [...this.scopeByKey.values()].filter((scope) =>
          scope.cwd === event.cwd && (scope.deviceId ?? null) === deviceId
        );
        const scopes = matchingScopes.length > 0
          ? matchingScopes
          : [this.scopeFor(event.cwd, deviceId)];
        let next = this.byCwd;
        for (const scope of scopes) {
          const key = worktreeScopeKey(scope);
          const current = this.byCwd[key];
          if (
            !current?.loaded
            && !(
              deviceId === this.activeDeviceId
              && this.projectCwds.includes(event.cwd)
            )
          ) continue;
          this.scopeByKey.set(key, scope);
          this.eventVersions.set(key, (this.eventVersions.get(key) ?? 0) + 1);
          next = {
            ...next,
            [key]: {
              entries: event.entries,
              loaded: true,
              loading: false,
              error: null
            }
          };
        }
        this.byCwd = next;
      })
    );
    this.detachers.push(
      backend.connection.onReconnect(() => {
        for (const [key, cache] of Object.entries(this.byCwd)) {
          const scope = this.scopeByKey.get(key);
          if (cache.loaded && scope) void this.refreshCwd(scope);
        }
      })
    );
  }

  detach(): void {
    for (const detach of this.detachers.splice(0)) detach();
  }

  setActiveCwd(cwd: string | null | undefined): void {
    this.setActiveContext({ cwd });
  }

  setActiveContext(context: {
    cwd: string | null | undefined;
    projectCwd?: string | null | undefined;
    projectScopeCwds?: Array<string | null | undefined>;
    deviceId?: DeviceId | null | undefined;
    runMode?: RunMode | undefined;
    wslDistro?: string | null | undefined;
  }): void {
    const {
      cwd,
      projectCwd,
      projectScopeCwds = [],
      deviceId = null,
      runMode,
      wslDistro
    } = context;
    const next = cwd && cwd.trim().length > 0 ? cwd.trim() : null;
    this.activeCwd = next;
    this.activeDeviceId = deviceId;
    this.activeRunMode = runMode;
    this.activeWslDistro = wslDistro?.trim() || undefined;
    this.activeProjectCwd =
      projectCwd && projectCwd.trim().length > 0 ? projectCwd.trim() : next;
    this.projectCwds = uniqueCwds([
      this.activeProjectCwd,
      next,
      ...projectScopeCwds
    ]);
    for (const scopeCwd of this.projectCwds) {
      const scope = this.scopeFor(scopeCwd, deviceId);
      this.scopeByKey.set(worktreeScopeKey(scope), scope);
    }
  }

  get cwd(): string | null {
    return this.activeCwd;
  }

  get projectCwd(): string | null {
    return this.activeProjectCwd;
  }

  private cache(cwd: string, deviceId: DeviceId | null = this.activeDeviceId): CwdCache {
    return this.cacheForScope(this.scopeFor(cwd, deviceId));
  }

  get entries(): VaultEntry[] {
    if (!this.activeCwd) return [];
    return this.cache(this.activeCwd).entries;
  }

  get loaded(): boolean {
    if (!this.activeCwd) return false;
    return this.cache(this.activeCwd).loaded;
  }

  get loading(): boolean {
    if (!this.activeCwd) return false;
    return this.cache(this.activeCwd).loading;
  }

  get error(): string | null {
    if (!this.activeCwd) return null;
    return this.cache(this.activeCwd).error;
  }

  get projectLoading(): boolean {
    return this.projectCwds.some((cwd) => this.cache(cwd).loading);
  }

  get projectError(): string | null {
    for (const cwd of this.projectCwds) {
      const error = this.cache(cwd).error;
      if (error) return error;
    }
    return null;
  }

  get currentScopedEntries(): ScopedVaultEntry[] {
    if (!this.activeCwd) return [];
    return this.cache(this.activeCwd).entries.map((entry) => ({
      entry,
      vaultCwd: this.activeCwd!
    }));
  }

  get projectScopedEntries(): ScopedVaultEntry[] {
    const items: ScopedVaultEntry[] = [];
    for (const cwd of this.projectCwds) {
      for (const entry of this.cache(cwd).entries) {
        items.push({ entry, vaultCwd: cwd });
      }
    }
    return items;
  }

  // All entries that match the given origin, in newest-first order. Returns
  // an empty array if the cwd hasn't been loaded yet (caller should call
  // ensureLoaded() first).
  matchesForOrigin(origin: string): VaultEntry[] {
    if (!this.activeCwd) return [];
    const target = normalizeOrigin(origin);
    if (!target) return [];
    return this.cache(this.activeCwd).entries.filter((e) => e.origin === target);
  }

  projectMatchesForOrigin(origin: string): ScopedVaultEntry[] {
    const target = normalizeOrigin(origin);
    if (!target) return [];
    return this.projectScopedEntries.filter(({ entry }) => entry.origin === target);
  }

  async ensureLoaded(): Promise<void> {
    const cwd = this.activeCwd;
    if (!cwd) return;
    const cur = this.cache(cwd);
    if (cur.loaded || cur.loading) return;
    await this.refresh();
  }

  async ensureProjectLoaded(): Promise<void> {
    const scopes = this.projectCwds.map((cwd) => this.scopeFor(cwd));
    await Promise.all(scopes.map((scope) => this.ensureCwdLoaded(scope)));
  }

  async refresh(): Promise<void> {
    const cwd = this.activeCwd;
    if (!cwd) return;
    await this.refreshCwd(this.scopeFor(cwd));
  }

  async refreshProject(): Promise<void> {
    const scopes = this.projectCwds.map((cwd) => this.scopeFor(cwd));
    await Promise.all(scopes.map((scope) => this.refreshCwd(scope)));
  }

  private async ensureCwdLoaded(scope: WorktreeScope): Promise<void> {
    const cur = this.cacheForScope(scope);
    if (cur.loaded || cur.loading) return;
    await this.refreshCwd(scope);
  }

  private async refreshCwd(scope: WorktreeScope): Promise<void> {
    const key = worktreeScopeKey(scope);
    this.scopeByKey.set(key, scope);
    const eventVersion = this.eventVersions.get(key) ?? 0;
    const refreshVersion = (this.refreshVersions.get(key) ?? 0) + 1;
    this.refreshVersions.set(key, refreshVersion);
    this.byCwd = {
      ...this.byCwd,
      [key]: { ...this.cacheForScope(scope), loading: true, error: null }
    };
    try {
      const entries = await backend.vault.list({
        cwd: scope.cwd,
        ...this.route(scope.deviceId ?? null)
      });
      if (
        this.refreshVersions.get(key) !== refreshVersion
        || (this.eventVersions.get(key) ?? 0) !== eventVersion
      ) return;
      this.byCwd = {
        ...this.byCwd,
        [key]: { entries, loaded: true, loading: false, error: null }
      };
    } catch (err) {
      if (
        this.refreshVersions.get(key) !== refreshVersion
        || (this.eventVersions.get(key) ?? 0) !== eventVersion
      ) return;
      this.byCwd = {
        ...this.byCwd,
        [key]: {
          ...this.cacheForScope(scope),
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        }
      };
    }
  }

  async save(draft: VaultEntryDraft, vaultCwd?: string): Promise<VaultEntry> {
    const cwd = vaultCwd ?? this.requireCwd();
    const scope = this.scopeFor(cwd);
    const entry = await backend.vault.save({
      cwd,
      draft,
      ...this.route(scope.deviceId ?? null)
    });
    this.upsert(scope, entry);
    return entry;
  }

  async update(id: string, patch: VaultEntryUpdate, vaultCwd?: string): Promise<VaultEntry> {
    const cwd = vaultCwd ?? this.requireCwd();
    const scope = this.scopeFor(cwd);
    const entry = await backend.vault.update({
      cwd,
      id,
      patch,
      ...this.route(scope.deviceId ?? null)
    });
    this.upsert(scope, entry);
    return entry;
  }

  async delete(id: string, vaultCwd?: string): Promise<void> {
    const cwd = vaultCwd ?? this.requireCwd();
    const scope = this.scopeFor(cwd);
    await backend.vault.delete({ cwd, id, ...this.route(scope.deviceId ?? null) });
    const cur = this.cacheForScope(scope);
    const key = worktreeScopeKey(scope);
    this.byCwd = {
      ...this.byCwd,
      [key]: { ...cur, entries: cur.entries.filter((e) => e.id !== id) }
    };
  }

  async getSecret(id: string, vaultCwd?: string): Promise<VaultSecret> {
    const cwd = vaultCwd ?? this.requireCwd();
    const scope = this.scopeFor(cwd);
    return backend.vault.getSecret({ cwd, id, ...this.route(scope.deviceId ?? null) });
  }

  saveTarget(scope: 'project' | 'worktree'): string {
    if (scope === 'project' && this.activeProjectCwd) return this.activeProjectCwd;
    return this.requireCwd();
  }

  private upsert(scope: WorktreeScope, entry: VaultEntry): void {
    const cur = this.cacheForScope(scope);
    const key = worktreeScopeKey(scope);
    const without = cur.entries.filter((e) => e.id !== entry.id);
    const next = [...without, entry].sort(
      (a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)
    );
    this.byCwd = {
      ...this.byCwd,
      [key]: { entries: next, loaded: true, loading: false, error: null }
    };
  }

  private requireCwd(): string {
    if (!this.activeCwd) throw new Error('vault: no active worktree');
    return this.activeCwd;
  }

  private cacheForScope(scope: WorktreeScope): CwdCache {
    return this.byCwd[worktreeScopeKey(scope)] ?? EMPTY;
  }

  private scopeFor(
    cwd: string,
    deviceId: DeviceId | null = this.activeDeviceId
  ): WorktreeScope {
    return worktreeScope(cwd, {
      ...(this.activeRunMode ? { runMode: this.activeRunMode } : {}),
      ...(this.activeWslDistro ? { wslDistro: this.activeWslDistro } : {}),
      ...(deviceId ? { deviceId } : {})
    });
  }

  private route(deviceId: DeviceId | null): { deviceId: DeviceId } | Record<string, never> {
    return deviceId ? { deviceId } : {};
  }
}

export const vaultStore = new VaultStore();
export { normalizeOrigin as vaultNormalizeOrigin };

function uniqueCwds(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const cwd = value?.trim();
    if (cwd) seen.add(cwd);
  }
  return [...seen];
}
