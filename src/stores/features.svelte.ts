import type {
  BranchStatus,
  FeatureIssueEntry,
  FeatureSnapshot
} from '@shared/types/features.js';
import type { RunMode } from '@shared/types/sessions.js';
import { untrack } from 'svelte';
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
const FEATURE_UI_KEY = 'soloe.featureUi.v1';

interface FeatureUiState {
  hideSolvedIssues?: boolean;
  collapsed?: Record<string, boolean>;
}

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
  private uiByCwdRaw: Record<string, FeatureUiState> = {};
  private uiByCwd = $state<Record<string, FeatureUiState>>({});

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
    try {
      const raw = localStorage.getItem(FEATURE_UI_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, FeatureUiState>;
        this.uiByCwdRaw = parsed && typeof parsed === 'object' ? parsed : {};
        this.uiByCwd = { ...this.uiByCwdRaw };
      }
    } catch {
      // ignore corrupt persisted UI state.
    }
  }

  setContext(cwd: string, context: FeatureContext): void {
    if (!cwd) return;
    untrack(() => {
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
    });
  }

  stateFor(cwd: string | null | undefined): CwdState | null {
    if (!cwd) return null;
    return this.stateByCwd[cwd] ?? null;
  }

  selectedSlugFor(cwd: string | null | undefined): string | null {
    if (!cwd) return null;
    return this.selectedSlugByCwd[cwd] ?? null;
  }

  hideSolvedIssuesFor(cwd: string | null | undefined): boolean {
    if (!cwd) return false;
    return this.uiByCwd[cwd]?.hideSolvedIssues ?? false;
  }

  setHideSolvedIssues(cwd: string, value: boolean): void {
    if (!cwd) return;
    untrack(() => {
      const prev = this.uiByCwdRaw[cwd] ?? {};
      if ((prev.hideSolvedIssues ?? false) === value) return;
      this.uiByCwdRaw[cwd] = { ...prev, hideSolvedIssues: value };
      this.uiByCwd = { ...this.uiByCwd, [cwd]: this.uiByCwdRaw[cwd] };
      this.persistUi();
    });
  }

  sectionOpenFor(cwd: string | null | undefined, section: string, fallback = true): boolean {
    if (!cwd) return fallback;
    const collapsed = this.uiByCwd[cwd]?.collapsed?.[section];
    return collapsed === undefined ? fallback : !collapsed;
  }

  setSectionOpen(cwd: string, section: string, open: boolean, fallback = true): void {
    if (!cwd || !section) return;
    untrack(() => {
      const prev = this.uiByCwdRaw[cwd] ?? {};
      const collapsed = { ...(prev.collapsed ?? {}) };
      const wasOpen = collapsed[section] === undefined ? fallback : !collapsed[section];
      if (wasOpen === open) return;
      if (open === fallback) delete collapsed[section];
      else collapsed[section] = !open;
      this.uiByCwdRaw[cwd] = { ...prev, collapsed };
      this.uiByCwd = { ...this.uiByCwd, [cwd]: this.uiByCwdRaw[cwd] };
      this.persistUi();
    });
  }

  setSelectedSlug(cwd: string, slug: string | null): void {
    if (!cwd) return;
    const trimmed = slug?.trim() || null;
    const changed = untrack(() => {
      if (this.selectedSlugByCwd[cwd] === trimmed) return false;
      this.selectedSlugByCwdRaw[cwd] = trimmed;
      this.selectedSlugByCwd = { ...this.selectedSlugByCwd, [cwd]: trimmed };
      this.persistSelected();
      return true;
    });
    if (!changed) return;
    void this.refresh(cwd).catch(() => undefined);
  }

  async refresh(cwd: string): Promise<void> {
    const request = untrack(() => {
      const state = this.stateByCwd[cwd];
      if (!state) return null;
      const slug = this.selectedSlugByCwd[cwd] ?? null;
      const gen = state.generation + 1;
      this.patch(cwd, { loading: true, error: null, generation: gen });
      return {
        gen,
        slug,
        context: { ...state.context }
      };
    });
    if (!request) return;
    try {
      const snapshot = await ipc.features.scan({
        cwd,
        runMode: request.context.runMode,
        ...(request.context.wslDistro ? { wslDistro: request.context.wslDistro } : {}),
        ...(request.slug ? { slug: request.slug } : {})
      });
      const current = this.stateByCwd[cwd];
      if (!current || current.generation !== request.gen) return;
      // Auto-pick a slug if none chosen yet and the worktree has features —
      // bias toward a feature with both coverage and issues, then any with
      // coverage, then the first slug. Keeps the rail useful on first open
      // without forcing the user to interact with the picker.
      if (!request.slug && snapshot.features.length > 0) {
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
      if (!current || current.generation !== request.gen) return;
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

  async setIssueStatus(
    cwd: string,
    relativePath: string,
    status: string
  ): Promise<FeatureIssueEntry | null> {
    const state = this.stateByCwd[cwd];
    if (!state) return null;
    try {
      const issue = await ipc.features.setIssueStatus({
        cwd,
        runMode: state.context.runMode,
        ...(state.context.wslDistro ? { wslDistro: state.context.wslDistro } : {}),
        relativePath,
        status
      });
      const current = this.stateByCwd[cwd];
      if (current?.snapshot) {
        this.patch(cwd, {
          snapshot: {
            ...current.snapshot,
            issues: current.snapshot.issues.map((item) =>
              item.relativePath === issue.relativePath ? issue : item
            )
          }
        });
      }
      void this.refresh(cwd).catch(() => undefined);
      return issue;
    } catch (err) {
      this.patch(cwd, {
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  async subscribe(cwd: string): Promise<void> {
    const request = untrack(() => {
      const state = this.stateByCwd[cwd];
      if (!state || state.subscribed) return null;
      return { ...state.context };
    });
    if (!request) return;
    try {
      await ipc.features.subscribe({
        cwd,
        runMode: request.runMode,
        ...(request.wslDistro ? { wslDistro: request.wslDistro } : {})
      });
      untrack(() => this.patch(cwd, { subscribed: true }));
    } catch {
      // Subscribe failures are non-fatal — refresh button still works without it.
    }
  }

  async unsubscribe(cwd: string): Promise<void> {
    const request = untrack(() => {
      const state = this.stateByCwd[cwd];
      if (!state || !state.subscribed) return null;
      return { ...state.context };
    });
    if (!request) return;
    try {
      await ipc.features.unsubscribe({
        cwd,
        runMode: request.runMode,
        ...(request.wslDistro ? { wslDistro: request.wslDistro } : {})
      });
      untrack(() => this.patch(cwd, { subscribed: false }));
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

  private persistUi(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(FEATURE_UI_KEY, JSON.stringify(this.uiByCwdRaw));
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
