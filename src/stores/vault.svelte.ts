import type {
  VaultEntry,
  VaultEntryDraft,
  VaultEntryUpdate,
  VaultSecret
} from '../../shared/types/vault';

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

class VaultStore {
  private activeCwd = $state<string | null>(null);
  private byCwd = $state<Record<CwdKey, CwdCache>>({});

  setActiveCwd(cwd: string | null | undefined): void {
    const next = cwd && cwd.trim().length > 0 ? cwd.trim() : null;
    if (next === this.activeCwd) return;
    this.activeCwd = next;
  }

  get cwd(): string | null {
    return this.activeCwd;
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

  // All entries that match the given origin, in newest-first order. Returns
  // an empty array if the cwd hasn't been loaded yet (caller should call
  // ensureLoaded() first).
  matchesForOrigin(origin: string): VaultEntry[] {
    if (!this.activeCwd) return [];
    const target = normalizeOrigin(origin);
    if (!target) return [];
    return this.cache(this.activeCwd).entries.filter((e) => e.origin === target);
  }

  async ensureLoaded(): Promise<void> {
    const cwd = this.activeCwd;
    if (!cwd) return;
    const cur = this.cache(cwd);
    if (cur.loaded || cur.loading) return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const cwd = this.activeCwd;
    if (!cwd) return;
    this.byCwd = { ...this.byCwd, [cwd]: { ...this.cache(cwd), loading: true, error: null } };
    const res = await window.soloe.vault.list({ cwd });
    if (!res.ok) {
      this.byCwd = {
        ...this.byCwd,
        [cwd]: { ...this.cache(cwd), loading: false, error: res.error }
      };
      return;
    }
    this.byCwd = {
      ...this.byCwd,
      [cwd]: { entries: res.value, loaded: true, loading: false, error: null }
    };
  }

  async save(draft: VaultEntryDraft): Promise<VaultEntry> {
    const cwd = this.requireCwd();
    const res = await window.soloe.vault.save({ cwd, draft });
    if (!res.ok) throw new Error(res.error);
    this.upsert(cwd, res.value);
    return res.value;
  }

  async update(id: string, patch: VaultEntryUpdate): Promise<VaultEntry> {
    const cwd = this.requireCwd();
    const res = await window.soloe.vault.update({ cwd, id, patch });
    if (!res.ok) throw new Error(res.error);
    this.upsert(cwd, res.value);
    return res.value;
  }

  async delete(id: string): Promise<void> {
    const cwd = this.requireCwd();
    const res = await window.soloe.vault.delete({ cwd, id });
    if (!res.ok) throw new Error(res.error);
    const cur = this.cache(cwd);
    this.byCwd = {
      ...this.byCwd,
      [cwd]: { ...cur, entries: cur.entries.filter((e) => e.id !== id) }
    };
  }

  async getSecret(id: string): Promise<VaultSecret> {
    const cwd = this.requireCwd();
    const res = await window.soloe.vault.getSecret({ cwd, id });
    if (!res.ok) throw new Error(res.error);
    return res.value;
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
