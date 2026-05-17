import type { RunMode } from '@shared/types/sessions.js';
import { ipc } from '../lib/ipc';

export interface FilesContext {
  runMode: RunMode;
  wslDistro?: string;
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
  size: number;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

const EMPTY_TREE: TreeEntry = {
  paths: [],
  truncated: false,
  isRepo: false,
  loading: false,
  error: null
};

class FilesStore {
  private contextByCwd = $state<Record<string, FilesContext>>({});
  private treeByCwd = $state<Record<string, TreeEntry>>({});
  // Open files are keyed by worktree cwd so a user bouncing between worktrees
  // keeps each one's editor state — including in-progress unsaved edits.
  // Mirrors workingDiff.selectedByCwd's per-cwd memory model.
  private openFilesByCwd = $state<Record<string, OpenFile>>({});

  setContext(cwd: string, context: FilesContext): void {
    const prev = this.contextByCwd[cwd];
    if (prev && prev.runMode === context.runMode && prev.wslDistro === context.wslDistro) return;
    this.contextByCwd = { ...this.contextByCwd, [cwd]: context };
  }

  treeFor(cwd: string): TreeEntry {
    return this.treeByCwd[cwd] ?? EMPTY_TREE;
  }

  openFileFor(cwd: string): OpenFile | null {
    return this.openFilesByCwd[cwd] ?? null;
  }

  dirtyFor(cwd: string): boolean {
    const open = this.openFilesByCwd[cwd];
    return open !== undefined && !open.binary && open.content !== open.baseline;
  }

  async loadTree(cwd: string, opts: { force?: boolean } = {}): Promise<void> {
    const context = this.contextByCwd[cwd];
    if (!context) throw new Error('No file context for cwd; call setContext first');
    const existing = this.treeByCwd[cwd];
    if (existing?.loading) return;
    if (!opts.force && existing && !existing.error) return;
    this.patchTree(cwd, { ...(existing ?? EMPTY_TREE), loading: true, error: null });
    try {
      const result = await ipc.files.listTree({
        cwd,
        runMode: context.runMode,
        ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
      });
      this.patchTree(cwd, {
        paths: result.paths,
        truncated: result.truncated,
        isRepo: result.isRepo,
        loading: false,
        error: null
      });
    } catch (err) {
      this.patchTree(cwd, {
        paths: existing?.paths ?? [],
        truncated: existing?.truncated ?? false,
        isRepo: existing?.isRepo ?? false,
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  async openFileAt(cwd: string, relativePath: string): Promise<void> {
    const context = this.contextByCwd[cwd];
    if (!context) throw new Error('No file context for cwd; call setContext first');
    // If the same file is already open and unmodified, no-op. Picking the same
    // row in the tree shouldn't throw away in-progress unsaved edits either.
    const current = this.openFilesByCwd[cwd];
    if (current && current.relativePath === relativePath) {
      if (this.dirtyFor(cwd) || !current.loading) return;
    }
    this.patchOpen(cwd, {
      cwd,
      relativePath,
      content: '',
      baseline: '',
      binary: false,
      truncated: false,
      size: 0,
      loading: true,
      saving: false,
      error: null
    });
    try {
      const value = await ipc.files.readFile({
        cwd,
        relativePath,
        runMode: context.runMode,
        ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
      });
      // A second openFileAt could land before this one resolves; drop the stale
      // response so we don't overwrite the newer pending state.
      const stillCurrent = this.openFilesByCwd[cwd]?.relativePath === relativePath;
      if (!stillCurrent) return;
      const truncated = value.size > 0 && value.content.length === 0 && !value.binary;
      this.patchOpen(cwd, {
        cwd,
        relativePath: value.relativePath,
        content: value.content,
        baseline: value.content,
        binary: value.binary,
        truncated,
        size: value.size,
        loading: false,
        saving: false,
        error: null
      });
    } catch (err) {
      const stillCurrent = this.openFilesByCwd[cwd]?.relativePath === relativePath;
      if (!stillCurrent) return;
      const existing = this.openFilesByCwd[cwd];
      if (!existing) return;
      this.patchOpen(cwd, {
        ...existing,
        loading: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  setContent(cwd: string, content: string): void {
    const current = this.openFilesByCwd[cwd];
    if (!current) return;
    if (current.content === content) return;
    this.patchOpen(cwd, { ...current, content });
  }

  closeFile(cwd: string): void {
    if (!(cwd in this.openFilesByCwd)) return;
    const next = { ...this.openFilesByCwd };
    delete next[cwd];
    this.openFilesByCwd = next;
  }

  async save(cwd: string): Promise<void> {
    const open = this.openFilesByCwd[cwd];
    if (!open || open.binary || open.saving) return;
    if (open.content === open.baseline) return;
    const context = this.contextByCwd[cwd];
    if (!context) throw new Error('No file context for cwd');
    this.patchOpen(cwd, { ...open, saving: true, error: null });
    try {
      await ipc.files.writeFile({
        cwd,
        relativePath: open.relativePath,
        content: open.content,
        runMode: context.runMode,
        ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
      });
      // Same staleness guard as openFileAt — user may have switched files mid-save.
      const stillCurrent = this.openFilesByCwd[cwd]?.relativePath === open.relativePath;
      if (!stillCurrent) return;
      const current = this.openFilesByCwd[cwd];
      if (!current) return;
      this.patchOpen(cwd, {
        ...current,
        saving: false,
        baseline: current.content,
        error: null
      });
    } catch (err) {
      const stillCurrent = this.openFilesByCwd[cwd]?.relativePath === open.relativePath;
      if (!stillCurrent) return;
      const current = this.openFilesByCwd[cwd];
      if (!current) return;
      this.patchOpen(cwd, {
        ...current,
        saving: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private patchTree(cwd: string, entry: TreeEntry): void {
    this.treeByCwd = { ...this.treeByCwd, [cwd]: entry };
  }

  private patchOpen(cwd: string, entry: OpenFile): void {
    this.openFilesByCwd = { ...this.openFilesByCwd, [cwd]: entry };
  }
}

export const filesStore = new FilesStore();

// Translate a relative path returned by listTree into a string the FileTree
// component will recognize as a directory marker. Pierre Trees infers
// directory entries from trailing slashes; bare paths are always files.
export function toTreePaths(paths: readonly string[]): string[] {
  return paths.slice();
}

export function isPathFile(path: string): boolean {
  return !path.endsWith('/');
}
