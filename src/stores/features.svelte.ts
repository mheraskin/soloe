import type {
  BranchStatus,
  FeatureChangeEvent,
  FeatureIssueEntry,
  FeatureSnapshot
} from '@shared/types/features.js';
import type { RunMode } from '@shared/types/sessions.js';
import {
  worktreeScope,
  worktreeScopeKey,
  type WorktreeScope
} from '@shared/worktree-identity.js';
import { untrack } from 'svelte';
import { hasBackendTransport, ipc } from '../lib/ipc';

export interface FeatureContext {
  runMode: RunMode;
  wslDistro?: string;
}

export type FeatureScope = WorktreeScope & { runMode: RunMode };

export function createFeatureScope(cwd: string, context: FeatureContext): FeatureScope {
  return worktreeScope(cwd, context) as FeatureScope;
}

interface CwdState {
  scope: FeatureScope;
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

const SELECTED_SLUG_KEY = 'soloe.featureSelectedSlug.v2';
const FEATURE_UI_KEY = 'soloe.featureUi.v2';

interface FeatureUiState {
  hideSolvedIssues?: boolean;
  collapsed?: Record<string, boolean>;
}

function emptyState(scope: FeatureScope): CwdState {
  return {
    scope,
    snapshot: null,
    loading: false,
    error: null,
    loadedSlug: null,
    subscribed: false,
    generation: 0
  };
}

class FeaturesStore {
  // Runtime-qualified state. Equal Linux paths in separate WSL distributions
  // are distinct Worktrees and must never share snapshots or mutations.
  private stateByIdentity = $state<Record<string, CwdState>>({});
  // Selected slug per Worktree Identity, persisted to localStorage so re-opening the rail
  // restores the same feature. Plain (non-$state) backing map plus a $state
  // mirror so subscribers re-derive after writes.
  private selectedSlugByIdentityRaw: Record<string, string | null> = {};
  private selectedSlugByIdentity = $state<Record<string, string | null>>({});
  private uiByIdentityRaw: Record<string, FeatureUiState> = {};
  private uiByIdentity = $state<Record<string, FeatureUiState>>({});
  private subscriptionRefs = new Map<string, number>();
  private subscriptionQueues = new Map<string, Promise<void>>();
  private subscribedScopes = new Map<string, FeatureScope>();

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
        this.selectedSlugByIdentityRaw = next;
        this.selectedSlugByIdentity = { ...next };
      }
    } catch {
      // ignore corrupt persisted state — restart with empty selection.
    }
    try {
      const raw = localStorage.getItem(FEATURE_UI_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, FeatureUiState>;
        this.uiByIdentityRaw = parsed && typeof parsed === 'object' ? parsed : {};
        this.uiByIdentity = { ...this.uiByIdentityRaw };
      }
    } catch {
      // ignore corrupt persisted UI state.
    }
  }

  register(scope: FeatureScope): void {
    const key = worktreeScopeKey(scope);
    if (!scope.cwd) return;
    untrack(() => {
      if (this.stateByIdentity[key]) return;
      this.stateByIdentity = { ...this.stateByIdentity, [key]: emptyState(scope) };
    });
  }

  stateFor(scope: FeatureScope | null | undefined): CwdState | null {
    if (!scope?.cwd) return null;
    return this.stateByIdentity[worktreeScopeKey(scope)] ?? null;
  }

  selectedSlugFor(scope: FeatureScope | null | undefined): string | null {
    if (!scope?.cwd) return null;
    return this.selectedSlugByIdentity[worktreeScopeKey(scope)] ?? null;
  }

  hideSolvedIssuesFor(scope: FeatureScope | null | undefined): boolean {
    if (!scope?.cwd) return false;
    return this.uiByIdentity[worktreeScopeKey(scope)]?.hideSolvedIssues ?? false;
  }

  setHideSolvedIssues(scope: FeatureScope, value: boolean): void {
    const key = worktreeScopeKey(scope);
    if (!scope.cwd) return;
    untrack(() => {
      const prev = this.uiByIdentityRaw[key] ?? {};
      if ((prev.hideSolvedIssues ?? false) === value) return;
      this.uiByIdentityRaw[key] = { ...prev, hideSolvedIssues: value };
      this.uiByIdentity = { ...this.uiByIdentity, [key]: this.uiByIdentityRaw[key] };
      this.persistUi();
    });
  }

  sectionOpenFor(scope: FeatureScope | null | undefined, section: string, fallback = true): boolean {
    if (!scope?.cwd) return fallback;
    const collapsed = this.uiByIdentity[worktreeScopeKey(scope)]?.collapsed?.[section];
    return collapsed === undefined ? fallback : !collapsed;
  }

  setSectionOpen(scope: FeatureScope, section: string, open: boolean, fallback = true): void {
    const key = worktreeScopeKey(scope);
    if (!scope.cwd || !section) return;
    untrack(() => {
      const prev = this.uiByIdentityRaw[key] ?? {};
      const collapsed = { ...(prev.collapsed ?? {}) };
      const wasOpen = collapsed[section] === undefined ? fallback : !collapsed[section];
      if (wasOpen === open) return;
      if (open === fallback) delete collapsed[section];
      else collapsed[section] = !open;
      this.uiByIdentityRaw[key] = { ...prev, collapsed };
      this.uiByIdentity = { ...this.uiByIdentity, [key]: this.uiByIdentityRaw[key] };
      this.persistUi();
    });
  }

  setSelectedSlug(scope: FeatureScope, slug: string | null): void {
    const key = worktreeScopeKey(scope);
    if (!scope.cwd) return;
    this.register(scope);
    const trimmed = slug?.trim() || null;
    const changed = untrack(() => {
      if (this.selectedSlugByIdentity[key] === trimmed) return false;
      this.selectedSlugByIdentityRaw[key] = trimmed;
      this.selectedSlugByIdentity = { ...this.selectedSlugByIdentity, [key]: trimmed };
      this.persistSelected();
      return true;
    });
    if (!changed) return;
    void this.refresh(scope).catch(() => undefined);
  }

  async refresh(scope: FeatureScope, observedRevision?: string): Promise<void> {
    this.register(scope);
    const key = worktreeScopeKey(scope);
    const request = untrack(() => {
      const state = this.stateByIdentity[key];
      if (!state) return null;
      const slug = this.selectedSlugByIdentity[key] ?? null;
      const gen = state.generation + 1;
      this.patch(key, { loading: true, error: null, generation: gen });
      return {
        gen,
        slug,
        scope: { ...state.scope }
      };
    });
    if (!request) return;
    try {
      const snapshot = await ipc.features.scan({
        cwd: request.scope.cwd,
        runMode: request.scope.runMode,
        ...(request.scope.wslDistro ? { wslDistro: request.scope.wslDistro } : {}),
        ...(request.slug ? { slug: request.slug } : {}),
        ...(observedRevision ? { observedRevision } : {})
      });
      const current = this.stateByIdentity[key];
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
          this.selectedSlugByIdentityRaw[key] = best.slug;
          this.selectedSlugByIdentity = { ...this.selectedSlugByIdentity, [key]: best.slug };
          this.persistSelected();
          this.patch(key, {
            snapshot,
            loading: false,
            loadedSlug: snapshot.selectedSlug,
            error: null
          });
          // Re-scan with the picked slug so the coverage/plans/issues hydrate.
          void this.refresh(scope).catch(() => undefined);
          return;
        }
      }
      this.patch(key, {
        snapshot,
        loading: false,
        loadedSlug: snapshot.selectedSlug,
        error: null
      });
    } catch (err) {
      const current = this.stateByIdentity[key];
      if (!current || current.generation !== request.gen) return;
      this.patch(key, {
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async setBranchStatus(scope: FeatureScope, branchId: string, status: BranchStatus): Promise<void> {
    const key = worktreeScopeKey(scope);
    const state = this.stateByIdentity[key];
    const slug = this.selectedSlugByIdentity[key];
    if (!state || !slug) return;
    this.patch(key, {
      generation: state.generation + 1,
      loading: false
    });
    try {
      const coverage = await ipc.features.setBranchStatus({
        cwd: state.scope.cwd,
        runMode: state.scope.runMode,
        ...(state.scope.wslDistro ? { wslDistro: state.scope.wslDistro } : {}),
        slug,
        branchId,
        status
      });
      // Patch only the coverage slice locally — avoids a full re-scan round
      // trip after a click. The watcher will still send a `features` change
      // event that triggers a refresh and reconciles anything we missed.
      const current = this.stateByIdentity[key];
      if (!current?.snapshot) return;
      this.patch(key, {
        snapshot: { ...current.snapshot, coverage }
      });
    } catch (err) {
      this.patch(key, {
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async setIssueStatus(
    scope: FeatureScope,
    relativePath: string,
    status: string
  ): Promise<FeatureIssueEntry | null> {
    const key = worktreeScopeKey(scope);
    const state = this.stateByIdentity[key];
    if (!state) return null;
    this.patch(key, {
      generation: state.generation + 1,
      loading: false
    });
    try {
      const issue = await ipc.features.setIssueStatus({
        cwd: state.scope.cwd,
        runMode: state.scope.runMode,
        ...(state.scope.wslDistro ? { wslDistro: state.scope.wslDistro } : {}),
        relativePath,
        status
      });
      const current = this.stateByIdentity[key];
      if (current?.snapshot) {
        this.patch(key, {
          snapshot: {
            ...current.snapshot,
            issues: current.snapshot.issues.map((item) =>
              item.relativePath === issue.relativePath ? issue : item
            )
          }
        });
      }
      return issue;
    } catch (err) {
      this.patch(key, {
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  async subscribe(scope: FeatureScope): Promise<void> {
    this.register(scope);
    const key = worktreeScopeKey(scope);
    this.subscriptionRefs.set(key, (this.subscriptionRefs.get(key) ?? 0) + 1);
    await this.queueSubscriptionReconcile(key);
  }

  async unsubscribe(scope: FeatureScope): Promise<void> {
    const key = worktreeScopeKey(scope);
    const refs = this.subscriptionRefs.get(key) ?? 0;
    if (refs <= 1) this.subscriptionRefs.delete(key);
    else this.subscriptionRefs.set(key, refs - 1);
    await this.queueSubscriptionReconcile(key);
  }

  recoverAfterReconnect(): void {
    for (const [key, scope] of this.subscribedScopes) {
      void ipc.features.subscribe(toSubscriptionRequest(scope))
        .then(() => {
          if (!this.subscribedScopes.has(key)) return;
          return this.refresh(scope);
        })
        .catch(() => {
          untrack(() => this.patch(key, { subscribed: false }));
        });
    }
  }

  private queueSubscriptionReconcile(key: string): Promise<void> {
    const previous = this.subscriptionQueues.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.reconcileSubscription(key));
    this.subscriptionQueues.set(key, next);
    void next.finally(() => {
      if (this.subscriptionQueues.get(key) === next) {
        this.subscriptionQueues.delete(key);
      }
    }).catch(() => undefined);
    return next;
  }

  private async reconcileSubscription(key: string): Promise<void> {
    let desired = (this.subscriptionRefs.get(key) ?? 0) > 0
      ? untrack(() => this.stateByIdentity[key]?.scope ?? null)
      : null;
    const active = this.subscribedScopes.get(key) ?? null;

    if (active && !desired) {
      try {
        await ipc.features.unsubscribe(toSubscriptionRequest(active));
        this.subscribedScopes.delete(key);
        untrack(() => this.patch(key, { subscribed: false }));
      } catch {
        // A local IPC failure is transient. Keep the active record so a later
        // reconciliation retries instead of incrementing the main ref-count.
        return;
      }
    }

    desired = (this.subscriptionRefs.get(key) ?? 0) > 0
      ? untrack(() => this.stateByIdentity[key]?.scope ?? null)
      : null;
    if (!desired || this.subscribedScopes.has(key)) return;
    try {
      await ipc.features.subscribe(toSubscriptionRequest(desired));
      this.subscribedScopes.set(key, { ...desired });
      untrack(() => this.patch(key, { subscribed: true }));
    } catch {
      // Subscribe failures are non-fatal — refresh remains available.
      untrack(() => this.patch(key, { subscribed: false }));
    }
  }

  // Bound at module load to the global `features:change` channel. The rail tab
  // also subscribes per-cwd before mount so the change event maps back to a
  // scan refresh while it's visible.
  applyChangeEvent(event: FeatureChangeEvent): void {
    const scope = createFeatureScope(event.cwd, event);
    const state = this.stateByIdentity[worktreeScopeKey(scope)];
    if (!state) return;
    if (state.snapshot?.artifactRevision === event.revision) return;
    void this.refresh(scope, event.revision).catch(() => undefined);
  }

  private patch(key: string, partial: Partial<CwdState>): void {
    const prev = this.stateByIdentity[key];
    if (!prev) return;
    this.stateByIdentity = { ...this.stateByIdentity, [key]: { ...prev, ...partial } };
  }

  private persistSelected(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(SELECTED_SLUG_KEY, JSON.stringify(this.selectedSlugByIdentityRaw));
    } catch {
      // Quota — ignore.
    }
  }

  private persistUi(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(FEATURE_UI_KEY, JSON.stringify(this.uiByIdentityRaw));
    } catch {
      // Quota — ignore.
    }
  }
}

function toSubscriptionRequest(scope: FeatureScope): {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
} {
  return {
    cwd: scope.cwd,
    runMode: scope.runMode,
    ...(scope.wslDistro ? { wslDistro: scope.wslDistro } : {})
  };
}

export const featuresStore = new FeaturesStore();

if (hasBackendTransport()) {
  // Single, app-wide listener that routes change events to the matching cwd.
  ipc.features.onChange((event) => {
    featuresStore.applyChangeEvent(event);
  });
  ipc.connection?.onReconnect(() => {
    featuresStore.recoverAfterReconnect();
  });
}
