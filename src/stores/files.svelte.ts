import type { RunMode } from '@shared/types/sessions.js';
import type { DeviceId } from '@shared/types/devices.js';
import type { FileReadResult } from '@shared/types/files.js';
import {
  worktreeScope,
  worktreeScopeKey,
  type WorktreeScope
} from '@shared/worktree-identity.js';
import { ipc } from '../lib/ipc';

export interface FilesContext {
  runMode: RunMode;
  wslDistro?: string;
  deviceId?: DeviceId;
}

export type FilesScope = WorktreeScope & { runMode: RunMode; revision?: string };

export function createFilesScope(
  cwd: string,
  context: FilesContext,
  revision?: string
): FilesScope {
  const scope = worktreeScope(cwd, context) as FilesScope;
  const normalizedRevision = revision?.trim();
  return normalizedRevision ? { ...scope, revision: normalizedRevision } : scope;
}

export function filesScopeKey(scope: FilesScope): string {
  return `${worktreeScopeKey(scope)}::${scope.revision ?? ''}`;
}

export function isFilesScopeReadOnly(scope: FilesScope): boolean {
  return Boolean(scope.revision);
}

interface TreeEntry {
  paths: string[];
  truncated: boolean;
  isRepo: boolean;
  loading: boolean;
  error: string | null;
}

export interface OpenFile {
  cwd: string;
  relativePath: string;
  content: string;
  // Snapshot of disk content for the dirty check. Updated on load + save.
  baseline: string;
  binary: boolean;
  truncated: boolean;
  oversized: boolean;
  unavailable: boolean;
  unavailableReason: string | null;
  size: number;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

export interface SourceFile {
  cwd: string;
  relativePath: string;
  content: string;
  binary: boolean;
  truncated: boolean;
  oversized: boolean;
  unavailable: boolean;
  unavailableReason: string | null;
  size: number;
}

export interface SourceRevealRequest {
  relativePath: string;
  line: number;
  column: number;
  nonce: number;
}

const EMPTY_TREE: TreeEntry = {
  paths: [],
  truncated: false,
  isRepo: false,
  loading: false,
  error: null
};

// A clean file can hold two copies of up to 5 MiB (content + baseline), while
// one tree can retain 20,000 paths. Keep only a very small warm set once no
// Files Rail Surface owns the scope. Dirty/saving buffers are continuity, not
// cache, and are therefore protected independently from this limit.
const MAX_RECENT_CLEAN_SCOPES = 2;

export class FilesStore {
  private treeByCwd = $state<Record<string, TreeEntry>>({});
  // Open files are keyed by worktree cwd so a user bouncing between worktrees
  // keeps each one's editor state — including in-progress unsaved edits.
  // Mirrors workingDiff.selectedByCwd's per-cwd memory model.
  private openFilesByCwd = $state<Record<string, OpenFile>>({});
  private residencyByScope = new Map<string, number>();
  private recentReleasedScopes = new Map<string, true>();
  private sourceCache = new Map<string, SourceFile>();
  private sourceRevealByScope = $state<Record<string, SourceRevealRequest | null>>({});
  private sourceRevealNonce = 0;

  acquirePayloadResidency(scope: FilesScope): () => void {
    const key = filesScopeKey(scope);
    this.residencyByScope.set(key, (this.residencyByScope.get(key) ?? 0) + 1);
    this.recentReleasedScopes.delete(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.residencyByScope.get(key) ?? 1) - 1;
      if (remaining > 0) this.residencyByScope.set(key, remaining);
      else this.residencyByScope.delete(key);
      this.reconcileReleasedPayload(key);
    };
  }

  treeFor(scope: FilesScope): TreeEntry {
    return this.treeByCwd[filesScopeKey(scope)] ?? EMPTY_TREE;
  }

  openFileFor(scope: FilesScope): OpenFile | null {
    return this.openFilesByCwd[filesScopeKey(scope)] ?? null;
  }

  revealFor(scope: FilesScope): SourceRevealRequest | null {
    return this.sourceRevealByScope[filesScopeKey(scope)] ?? null;
  }

  requestReveal(scope: FilesScope, relativePath: string, line: number, column: number): SourceRevealRequest {
    const key = filesScopeKey(scope);
    const request = {
      relativePath,
      line: Math.max(1, Math.floor(line)),
      column: Math.max(1, Math.floor(column)),
      nonce: ++this.sourceRevealNonce
    };
    this.sourceRevealByScope = { ...this.sourceRevealByScope, [key]: request };
    return request;
  }

  clearReveal(scope: FilesScope, nonce?: number): void {
    const key = filesScopeKey(scope);
    const current = this.sourceRevealByScope[key];
    if (!current || (nonce !== undefined && current.nonce !== nonce)) return;
    const next = { ...this.sourceRevealByScope };
    delete next[key];
    this.sourceRevealByScope = next;
  }

  async loadSourceFile(scope: FilesScope, relativePath: string): Promise<SourceFile> {
    const current = this.openFilesByCwd[filesScopeKey(scope)];
    if (current && current.relativePath === relativePath && !current.loading) {
      return sourceFileFromOpen(current);
    }
    const cacheKey = this.sourceCacheKey(scope, relativePath);
    const cached = this.sourceCache.get(cacheKey);
    if (cached) {
      this.sourceCache.delete(cacheKey);
      this.sourceCache.set(cacheKey, cached);
      return cached;
    }
    const value = await ipc.files.readFile({
      cwd: scope.cwd,
      relativePath,
      runMode: scope.runMode,
      ...(scope.wslDistro ? { wslDistro: scope.wslDistro } : {}),
      ...(scope.deviceId ? { deviceId: scope.deviceId } : {}),
      ...(scope.revision ? { revision: scope.revision } : {})
    });
    const source = sourceFileFromRead(scope.cwd, value);
    this.sourceCache.set(cacheKey, source);
    while (this.sourceCache.size > 8) {
      const oldest = this.sourceCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sourceCache.delete(oldest);
    }
    return source;
  }

  dirtyFor(scope: FilesScope): boolean {
    const open = this.openFilesByCwd[filesScopeKey(scope)];
    return open !== undefined && !open.binary && open.content !== open.baseline;
  }

  async loadTree(scope: FilesScope, opts: { force?: boolean } = {}): Promise<void> {
    const key = filesScopeKey(scope);
    const existing = this.treeByCwd[key];
    if (existing?.loading) return;
    if (!opts.force && existing && !existing.error) return;
    this.patchTree(key, { ...(existing ?? EMPTY_TREE), loading: true, error: null });
    try {
      const result = await ipc.files.listTree({
        cwd: scope.cwd,
        runMode: scope.runMode,
        ...(scope.wslDistro ? { wslDistro: scope.wslDistro } : {}),
        ...(scope.deviceId ? { deviceId: scope.deviceId } : {}),
        ...(scope.revision ? { revision: scope.revision } : {}),
        ...(opts.force ? { force: true } : {})
      });
      this.patchTree(key, {
        paths: result.paths,
        truncated: result.truncated,
        isRepo: result.isRepo,
        loading: false,
        error: null
      });
    } catch (err) {
      this.patchTree(key, {
        paths: existing?.paths ?? [],
        truncated: existing?.truncated ?? false,
        isRepo: existing?.isRepo ?? false,
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async openFileAt(
    scope: FilesScope,
    relativePath: string,
    opts: { discardDirty?: boolean; force?: boolean } = {}
  ): Promise<boolean> {
    const key = filesScopeKey(scope);
    // If the same file is already open and unmodified, no-op. Picking the same
    // row in the tree shouldn't throw away in-progress unsaved edits either.
    const current = this.openFilesByCwd[key];
    if (current && current.relativePath === relativePath) {
      if (
        !opts.force &&
        ((!current.binary && current.content !== current.baseline) || !current.loading)
      ) return true;
    }
    if (
      current
      && current.relativePath !== relativePath
      && !current.binary
      && current.content !== current.baseline
      && !opts.discardDirty
    ) {
      return false;
    }
    this.patchOpen(key, {
      cwd: scope.cwd,
      relativePath,
      content: '',
      baseline: '',
      binary: false,
      truncated: false,
      oversized: false,
      unavailable: false,
      unavailableReason: null,
      size: 0,
      loading: true,
      saving: false,
      error: null
    });
    try {
      const value = await ipc.files.readFile({
        cwd: scope.cwd,
        relativePath,
        runMode: scope.runMode,
        ...(scope.wslDistro ? { wslDistro: scope.wslDistro } : {}),
        ...(scope.deviceId ? { deviceId: scope.deviceId } : {}),
        ...(scope.revision ? { revision: scope.revision } : {})
      });
      // A second openFileAt could land before this one resolves; drop the stale
      // response so we don't overwrite the newer pending state.
      const stillCurrent = this.openFilesByCwd[key]?.relativePath === relativePath;
      if (!stillCurrent) return false;
      this.patchOpen(key, {
        cwd: scope.cwd,
        relativePath: value.relativePath,
        content: value.content,
        baseline: value.content,
        binary: value.binary,
        truncated: value.truncated,
        oversized: value.oversized,
        unavailable: value.unavailable,
        unavailableReason: value.unavailableReason ?? null,
        size: value.size,
        loading: false,
        saving: false,
        error: null
      });
      this.cacheSource(scope, {
        cwd: scope.cwd,
        relativePath: value.relativePath,
        content: value.content,
        binary: value.binary,
        truncated: value.truncated,
        oversized: value.oversized,
        unavailable: value.unavailable,
        unavailableReason: value.unavailableReason ?? null,
        size: value.size
      });
      return true;
    } catch (err) {
      const stillCurrent = this.openFilesByCwd[key]?.relativePath === relativePath;
      if (!stillCurrent) return false;
      const existing = this.openFilesByCwd[key];
      if (!existing) return false;
      this.patchOpen(key, {
        ...existing,
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      });
      return true;
    }
  }

  setContent(scope: FilesScope, content: string): void {
    if (isFilesScopeReadOnly(scope)) return;
    const key = filesScopeKey(scope);
    const current = this.openFilesByCwd[key];
    if (!current) return;
    if (current.content === content) return;
    this.patchOpen(key, { ...current, content });
    this.cacheSource(scope, sourceFileFromOpen({ ...current, content }));
  }

  closeFile(scope: FilesScope): void {
    const key = filesScopeKey(scope);
    if (!(key in this.openFilesByCwd)) return;
    const next = { ...this.openFilesByCwd };
    delete next[key];
    this.openFilesByCwd = next;
    this.reconcileReleasedPayload(key);
  }

  async save(scope: FilesScope): Promise<void> {
    if (isFilesScopeReadOnly(scope)) return;
    const key = filesScopeKey(scope);
    const open = this.openFilesByCwd[key];
    if (!open || open.binary || open.truncated || open.unavailable || open.saving) return;
    if (open.content === open.baseline) return;
    this.patchOpen(key, { ...open, saving: true, error: null });
    try {
      await ipc.files.writeFile({
        cwd: scope.cwd,
        relativePath: open.relativePath,
        content: open.content,
        runMode: scope.runMode,
        ...(scope.wslDistro ? { wslDistro: scope.wslDistro } : {}),
        ...(scope.deviceId ? { deviceId: scope.deviceId } : {})
      });
      // Same staleness guard as openFileAt — user may have switched files mid-save.
      const stillCurrent = this.openFilesByCwd[key]?.relativePath === open.relativePath;
      if (!stillCurrent) return;
      const current = this.openFilesByCwd[key];
      if (!current) return;
      this.patchOpen(key, {
        ...current,
        saving: false,
        // The disk now contains the exact snapshot sent above. If the user
        // typed while the write was pending, preserve that newer content and
        // keep the editor dirty against the saved snapshot.
        baseline: open.content,
        error: null
      });
      this.cacheSource(scope, sourceFileFromOpen({ ...current, baseline: open.content }));
    } catch (err) {
      const stillCurrent = this.openFilesByCwd[key]?.relativePath === open.relativePath;
      if (!stillCurrent) return;
      const current = this.openFilesByCwd[key];
      if (!current) return;
      this.patchOpen(key, {
        ...current,
        saving: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private patchTree(key: string, entry: TreeEntry): void {
    this.treeByCwd = { ...this.treeByCwd, [key]: entry };
    this.reconcileReleasedPayload(key);
  }

  private patchOpen(key: string, entry: OpenFile): void {
    this.openFilesByCwd = { ...this.openFilesByCwd, [key]: entry };
    this.reconcileReleasedPayload(key);
  }

  private sourceCacheKey(scope: FilesScope, relativePath: string): string {
    return `${filesScopeKey(scope)}::${relativePath}`;
  }

  private cacheSource(scope: FilesScope, source: SourceFile): void {
    const key = this.sourceCacheKey(scope, source.relativePath);
    this.sourceCache.delete(key);
    this.sourceCache.set(key, source);
    while (this.sourceCache.size > 8) {
      const oldest = this.sourceCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sourceCache.delete(oldest);
    }
  }

  private reconcileReleasedPayload(key: string): void {
    if ((this.residencyByScope.get(key) ?? 0) > 0) {
      this.recentReleasedScopes.delete(key);
      return;
    }
    if (!this.treeByCwd[key] && !this.openFilesByCwd[key]) {
      this.recentReleasedScopes.delete(key);
      return;
    }
    this.recentReleasedScopes.delete(key);
    this.recentReleasedScopes.set(key, true);
    this.trimReleasedPayloads();
  }

  private trimReleasedPayloads(): void {
    while (this.recentReleasedScopes.size > MAX_RECENT_CLEAN_SCOPES) {
      const oldest = this.recentReleasedScopes.keys().next().value as string | undefined;
      if (!oldest) return;
      this.recentReleasedScopes.delete(oldest);
      this.evictCleanPayload(oldest);
    }
  }

  private evictCleanPayload(key: string): void {
    if (key in this.treeByCwd) {
      const nextTrees = { ...this.treeByCwd };
      delete nextTrees[key];
      this.treeByCwd = nextTrees;
    }
    const open = this.openFilesByCwd[key];
    if (!open || open.loading || open.saving || (!open.binary && open.content !== open.baseline)) {
      return;
    }
    const nextOpenFiles = { ...this.openFilesByCwd };
    delete nextOpenFiles[key];
    this.openFilesByCwd = nextOpenFiles;
  }
}

export const filesStore = new FilesStore();

function sourceFileFromRead(cwd: string, value: FileReadResult): SourceFile {
  return {
    cwd,
    relativePath: value.relativePath,
    content: value.content,
    binary: value.binary,
    truncated: value.truncated,
    oversized: value.oversized,
    unavailable: value.unavailable,
    unavailableReason: value.unavailableReason ?? null,
    size: value.size
  };
}

function sourceFileFromOpen(value: OpenFile): SourceFile {
  return {
    cwd: value.cwd,
    relativePath: value.relativePath,
    content: value.content,
    binary: value.binary,
    truncated: value.truncated,
    oversized: value.oversized,
    unavailable: value.unavailable,
    unavailableReason: value.unavailableReason,
    size: value.size
  };
}

// Translate a relative path returned by listTree into a string the FileTree
// component will recognize as a directory marker. Pierre Trees infers
// directory entries from trailing slashes; bare paths are always files.
export function toTreePaths(paths: readonly string[]): string[] {
  return paths.slice();
}

export function isPathFile(path: string): boolean {
  return !path.endsWith('/');
}
