import type {
  VaultEntry,
  VaultEntryDraft,
  VaultEntryUpdate,
  VaultSecret
} from '../../shared/types/vault';
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
  private projectCwds = $state<string[]>([]);
  private byCwd = $state<Record<CwdKey, CwdCache>>({});
  private detachers: Array<() => void> = [];
  private eventVersions = new Map<CwdKey, number>();
  private refreshVersions = new Map<CwdKey, number>();

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      backend.vault.onChange((event) => {
        const current = this.byCwd[event.cwd];
        if (!current?.loaded && !this.projectCwds.includes(event.cwd)) return;
        this.eventVersions.set(event.cwd, (this.eventVersions.get(event.cwd) ?? 0) + 1);
        this.byCwd = {
          ...this.byCwd,
          [event.cwd]: {
            entries: event.entries,
            loaded: true,
            loading: false,
            error: null
          }
        };
      })
    );
    this.detachers.push(
      backend.connection.onReconnect(() => {
        for (const [cwd, cache] of Object.entries(this.byCwd)) {
          if (cache.loaded) void this.refreshCwd(cwd);
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
  }): void {
    const { cwd, projectCwd, projectScopeCwds = [] } = context;
    const next = cwd && cwd.trim().length > 0 ? cwd.trim() : null;
    this.activeCwd = next;
    this.activeProjectCwd =
      projectCwd && projectCwd.trim().length > 0 ? projectCwd.trim() : next;
    this.projectCwds = uniqueCwds([
      this.activeProjectCwd,
      next,
      ...projectScopeCwds
    ]);
  }

  get cwd(): string | null {
    return this.activeCwd;
  }

  get projectCwd(): string | null {
    return this.activeProjectCwd;
  }

  private cache(cwd: string): CwdCache {
    return this.byCwd[cwd] ?? EMPTY;
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
    await Promise.all(this.projectCwds.map((cwd) => this.ensureCwdLoaded(cwd)));
  }

  async refresh(): Promise<void> {
    const cwd = this.activeCwd;
    if (!cwd) return;
    await this.refreshCwd(cwd);
  }

  async refreshProject(): Promise<void> {
    await Promise.all(this.projectCwds.map((cwd) => this.refreshCwd(cwd)));
  }

  private async ensureCwdLoaded(cwd: string): Promise<void> {
    const cur = this.cache(cwd);
    if (cur.loaded || cur.loading) return;
    await this.refreshCwd(cwd);
  }

  private async refreshCwd(cwd: string): Promise<void> {
    const eventVersion = this.eventVersions.get(cwd) ?? 0;
    const refreshVersion = (this.refreshVersions.get(cwd) ?? 0) + 1;
    this.refreshVersions.set(cwd, refreshVersion);
    this.byCwd = { ...this.byCwd, [cwd]: { ...this.cache(cwd), loading: true, error: null } };
    try {
      const entries = await backend.vault.list({ cwd });
      if (
        this.refreshVersions.get(cwd) !== refreshVersion
        || (this.eventVersions.get(cwd) ?? 0) !== eventVersion
      ) return;
      this.byCwd = {
        ...this.byCwd,
        [cwd]: { entries, loaded: true, loading: false, error: null }
      };
    } catch (err) {
      if (
        this.refreshVersions.get(cwd) !== refreshVersion
        || (this.eventVersions.get(cwd) ?? 0) !== eventVersion
      ) return;
      this.byCwd = {
        ...this.byCwd,
        [cwd]: {
          ...this.cache(cwd),
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        }
      };
    }
  }

  async save(draft: VaultEntryDraft, vaultCwd?: string): Promise<VaultEntry> {
    const cwd = vaultCwd ?? this.requireCwd();
    const entry = await backend.vault.save({ cwd, draft });
    this.upsert(cwd, entry);
    return entry;
  }

  async update(id: string, patch: VaultEntryUpdate, vaultCwd?: string): Promise<VaultEntry> {
    const cwd = vaultCwd ?? this.requireCwd();
    const entry = await backend.vault.update({ cwd, id, patch });
    this.upsert(cwd, entry);
    return entry;
  }

  async delete(id: string, vaultCwd?: string): Promise<void> {
    const cwd = vaultCwd ?? this.requireCwd();
    await backend.vault.delete({ cwd, id });
    const cur = this.cache(cwd);
    this.byCwd = {
      ...this.byCwd,
      [cwd]: { ...cur, entries: cur.entries.filter((e) => e.id !== id) }
    };
  }

  async getSecret(id: string, vaultCwd?: string): Promise<VaultSecret> {
    const cwd = vaultCwd ?? this.requireCwd();
    return backend.vault.getSecret({ cwd, id });
  }

  saveTarget(scope: 'project' | 'worktree'): string {
    if (scope === 'project' && this.activeProjectCwd) return this.activeProjectCwd;
    return this.requireCwd();
  }

  private upsert(cwd: string, entry: VaultEntry): void {
    const cur = this.cache(cwd);
    const without = cur.entries.filter((e) => e.id !== entry.id);
    const next = [...without, entry].sort(
      (a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)
    );
    this.byCwd = {
      ...this.byCwd,
      [cwd]: { entries: next, loaded: true, loading: false, error: null }
    };
  }

  private requireCwd(): string {
    if (!this.activeCwd) throw new Error('vault: no active worktree');
    return this.activeCwd;
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
