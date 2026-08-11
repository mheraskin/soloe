import type { RunMode } from '@shared/types/sessions.js';
import {
  isWindowsPath,
  normalizeWorktreeDisplayPath,
  worktreeIdentity
} from '@shared/worktree-identity.js';

/**
 * Canonical identity for a Worktree path. Windows identity is separator- and
 * case-insensitive; WSL identity preserves Linux filename semantics.
 */
export function worktreePathKey(path: string, runMode?: RunMode): string {
  return worktreeIdentity(path, { ...(runMode ? { runMode } : {}) }).pathKey;
}

export function sameWorktreePath(a: string, b: string, runMode?: RunMode): boolean {
  return worktreePathKey(a, runMode) === worktreePathKey(b, runMode);
}

export function worktreeBasename(path: string): string {
  const normalized = normalizeWorktreeDisplayPath(path, isWindowsPath(path));
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function worktreeLabel(projectPath: string, cwd: string, runMode?: RunMode): string {
  const windows = runMode === 'windows'
    || (runMode === undefined && (isWindowsPath(projectPath) || isWindowsPath(cwd)));
  const projectDisplay = normalizeWorktreeDisplayPath(projectPath, windows);
  const worktreeDisplay = normalizeWorktreeDisplayPath(cwd, windows);
  const projectKey = windows ? projectDisplay.toLocaleLowerCase('en-US') : projectDisplay;
  const worktreeKey = windows ? worktreeDisplay.toLocaleLowerCase('en-US') : worktreeDisplay;
  if (worktreeKey === projectKey) return 'main';
  if (worktreeKey.startsWith(`${projectKey}/`)) {
    return worktreeDisplay.slice(projectDisplay.length + 1);
  }
  return worktreeBasename(worktreeDisplay);
}
