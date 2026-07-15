import type { GitWorktree } from '@shared/types/git.js';
import type { RunMode } from '@shared/types/sessions.js';
import { worktreeLabel, worktreePathKey } from './worktree-path';

export interface WorktreeGroup<TItem> {
  key: string;
  cwd: string;
  label: string;
  isMain: boolean;
  worktree: GitWorktree | null;
  items: TItem[];
}

export interface BuildWorktreeGroupsOptions<TItem extends { cwd: string }> {
  projectPath: string;
  runMode?: RunMode;
  worktrees: readonly GitWorktree[];
  items: readonly TItem[];
  orderedPaths?: readonly string[];
}

/**
 * Owns Worktree grouping and ordering for every navigation surface. Callers
 * receive stable display paths while identity stays canonical internally.
 */
export function buildWorktreeGroups<TItem extends { cwd: string }>(
  options: BuildWorktreeGroupsOptions<TItem>
): WorktreeGroup<TItem>[] {
  interface Bucket {
    cwd: string;
    worktree: GitWorktree | null;
    items: TItem[];
  }
  const buckets = new Map<string, Bucket>();
  const naturalOrder: string[] = [];
  const ensure = (path: string): Bucket => {
    const key = worktreePathKey(path, options.runMode);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { cwd: path.trim(), worktree: null, items: [] };
      buckets.set(key, bucket);
      naturalOrder.push(key);
    }
    return bucket;
  };

  for (const worktree of options.worktrees) {
    const bucket = ensure(worktree.path);
    bucket.cwd = worktree.path.trim();
    bucket.worktree = worktree;
  }
  for (const item of options.items) ensure(item.cwd).items.push(item);

  const orderedKeys = (options.orderedPaths ?? [])
    .map((path) => worktreePathKey(path, options.runMode));
  const finalOrder: string[] = [];
  const seen = new Set<string>();
  for (const key of [...orderedKeys, ...naturalOrder]) {
    if (!buckets.has(key) || seen.has(key)) continue;
    seen.add(key);
    finalOrder.push(key);
  }

  return finalOrder.map((key) => {
    const bucket = buckets.get(key)!;
    const worktree = bucket.worktree;
    return {
      key,
      cwd: bucket.cwd,
      label: worktree?.branch
        ?? (worktree?.detached
          ? 'detached'
          : worktreeLabel(options.projectPath, bucket.cwd, options.runMode)),
      isMain: worktree?.isMain
        ?? worktreePathKey(options.projectPath, options.runMode) === key,
      worktree,
      items: bucket.items
    };
  });
}
