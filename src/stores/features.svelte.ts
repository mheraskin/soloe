import type {
  BranchStatus,
  FeatureSnapshot
} from '@shared/types/features.js';
import type { RunMode } from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';

export interface FeatureContext {
  runMode: RunMode;
  wslDistro?: string;
}

interface CwdState {
  context: FeatureContext;
  snapshot: FeatureSnapshot | null;
  loading: boolean;
  error: string | null;
  // Tracks the slug requested for the current snapshot so a UI re-render
  // doesn't re-fire a scan when the same slug is already loaded.
  loadedSlug: string | null;
  // True while subscribed to the main-process watcher for this worktree.
  subscribed: boolean;
  // Generation counter ensures concurrent scans drop stale responses.
  generation: number;
}

const SELECTED_SLUG_KEY = 'soloe.featureSelectedSlug.v1';

function emptyState(context: FeatureContext): CwdState {
  return {
    context,
    snapshot: null,
    loading: false,
    error: null,
    loadedSlug: null,
    subscribed: false,
    generation: 0
  };
}

class FeaturesStore {
  // Per-worktree state. Renderer code reads via the helper getters keyed by
  // cwd so multiple worktrees can keep their selection + snapshot warm.
  private stateByCwd = $state<Record<string, CwdState>>({});
  // Selected slug per-cwd, persisted to localStorage so re-opening the rail
  // restores the same feature. Plain (non-$state) backing map plus a $state
  // mirror so subscribers re-derive after writes.
  private selectedSlugByCwdRaw: Record<string, string | null> = {};
  private selectedSlugByCwd = $state<Record<string, string | null>>({});

  constructor() {
    if (typeof localStorage === 'undefined') return;
    try {
      const raw = localStorage.getItem(SELECTED_SLUG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const next: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && value.length > 0) next[key] = value;
        }
        this.selectedSlugByCwdRaw = next;
        this.selectedSlugByCwd = { ...next };
      }
    } catch {
      // ignore corrupt persisted state — restart with empty selection.
    }
  }

  setContext(cwd: string, context: FeatureContext): void {
    if (!cwd) return;
    const prev = this.stateByCwd[cwd];
    if (
      prev &&
      prev.context.runMode === context.runMode &&
      prev.context.wslDistro === context.wslDistro
    ) {
      return;
    }
    const next = prev ? { ...prev, context } : emptyState(context);
    this.stateByCwd = { ...this.stateByCwd, [cwd]: next };
  }

  stateFor(cwd: string | null | undefined): CwdState | null {
    if (!cwd) return null;
    return this.stateByCwd[cwd] ?? null;
  }

  selectedSlugFor(cwd: string | null | undefined): string | null {
    if (!cwd) return null;
    return this.selectedSlugByCwd[cwd] ?? null;
  }

  setSelectedSlug(cwd: string, slug: string | null): void {
    if (!cwd) return;
    const trimmed = slug?.trim() || null;
    if (this.selectedSlugByCwd[cwd] === trimmed) return;
    this.selectedSlugByCwdRaw[cwd] = trimmed;
    this.selectedSlugByCwd = { ...this.selectedSlugByCwd, [cwd]: trimmed };
    this.persistSelected();
    void this.refresh(cwd).catch(() => undefined);
  }

  async refresh(cwd: string): Promise<void> {
    const state = this.stateByCwd[cwd];
    if (!state) return;
    const slug = this.selectedSlugByCwd[cwd] ?? null;
    const gen = state.generation + 1;
    this.patch(cwd, { loading: true, error: null, generation: gen });
    try {
      const snapshot = await ipc.features.scan({
        cwd,
        runMode: state.context.runMode,
        ...(state.context.wslDistro ? { wslDistro: state.context.wslDistro } : {}),
        ...(slug ? { slug } : {})
      });
      const current = this.stateByCwd[cwd];
      if (!current || current.generation !== gen) return;
      // Auto-pick a slug if none chosen yet and the worktree has features —
      // bias toward a feature with both coverage and issues, then any with
      // coverage, then the first slug. Keeps the rail useful on first open
      // without forcing the user to interact with the picker.
      if (!slug && snapshot.features.length > 0) {
        const best =
          snapshot.features.find((f) => f.hasCoverage && f.hasIssues) ??
          snapshot.features.find((f) => f.hasCoverage) ??
          snapshot.features[0];
        if (best) {
          this.selectedSlugByCwdRaw[cwd] = best.slug;
          this.selectedSlugByCwd = { ...this.selectedSlugByCwd, [cwd]: best.slug };
          this.persistSelected();
          this.patch(cwd, {
            snapshot,
            loading: false,
            loadedSlug: snapshot.selectedSlug,
            error: null
          });
          // Re-scan with the picked slug so the coverage/plans/issues hydrate.
          void this.refresh(cwd).catch(() => undefined);
          return;
        }
      }
      this.patch(cwd, {
        snapshot,
        loading: false,
        loadedSlug: snapshot.selectedSlug,
        error: null
      });
    } catch (err) {
      const current = this.stateByCwd[cwd];
      if (!current || current.generation !== gen) return;
      this.patch(cwd, {
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async setBranchStatus(cwd: string, branchId: string, status: BranchStatus): Promise<void> {
    const state = this.stateByCwd[cwd];
    const slug = this.selectedSlugByCwd[cwd];
    if (!state || !slug) return;
    try {
      const coverage = await ipc.features.setBranchStatus({
        cwd,
        runMode: state.context.runMode,
        ...(state.context.wslDistro ? { wslDistro: state.context.wslDistro } : {}),
        slug,
        branchId,
        status
      });
      // Patch only the coverage slice locally — avoids a full re-scan round
      // trip after a click. The watcher will still send a `features` change
      // event that triggers a refresh and reconciles anything we missed.
      const current = this.stateByCwd[cwd];
      if (!current?.snapshot) return;
      this.patch(cwd, {
        snapshot: { ...current.snapshot, coverage }
      });
    } catch (err) {
      this.patch(cwd, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async subscribe(cwd: string): Promise<void> {
    const state = this.stateByCwd[cwd];
    if (!state || state.subscribed) return;
    try {
      await ipc.features.subscribe({
        cwd,
        runMode: state.context.runMode,
        ...(state.context.wslDistro ? { wslDistro: state.context.wslDistro } : {})
      });
      this.patch(cwd, { subscribed: true });
    } catch {
      // Subscribe failures are non-fatal — refresh button still works without it.
    }
  }

  async unsubscribe(cwd: string): Promise<void> {
    const state = this.stateByCwd[cwd];
    if (!state || !state.subscribed) return;
    try {
      await ipc.features.unsubscribe({
        cwd,
        runMode: state.context.runMode,
        ...(state.context.wslDistro ? { wslDistro: state.context.wslDistro } : {})
      });
      this.patch(cwd, { subscribed: false });
    } catch {
      // ignore — main-process unsubscribe is best-effort.
    }
  }

  // Bound at module load to the global `features:change` channel. The rail tab
  // also subscribes per-cwd before mount so the change event maps back to a
  // scan refresh while it's visible.
  applyChangeEvent(event: { cwd: string }): void {
    const state = this.stateByCwd[event.cwd];
    if (!state) return;
    void this.refresh(event.cwd).catch(() => undefined);
  }

  private patch(cwd: string, partial: Partial<CwdState>): void {
    const prev = this.stateByCwd[cwd];
    if (!prev) return;
    this.stateByCwd = { ...this.stateByCwd, [cwd]: { ...prev, ...partial } };
  }

  private persistSelected(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(SELECTED_SLUG_KEY, JSON.stringify(this.selectedSlugByCwdRaw));
    } catch {
      // Quota — ignore.
    }
  }
}

export const featuresStore = new FeaturesStore();

if (typeof window !== 'undefined' && window.soloe) {
  // Single, app-wide listener that routes change events to the matching cwd.
  ipc.features.onChange((event) => {
    featuresStore.applyChangeEvent(event);
  });
}
