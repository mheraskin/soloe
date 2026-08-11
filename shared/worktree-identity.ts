import type { RunMode } from './types/sessions.js';

export interface WorktreeRuntimeContext {
  runMode?: RunMode;
  wslDistro?: string;
}

/** Immutable address for operations and state owned by one Worktree. */
export interface WorktreeScope extends WorktreeRuntimeContext {
  cwd: string;
}

export interface WorktreeIdentity {
  key: string;
  path: string;
  pathKey: string;
  runMode: RunMode | null;
  wslDistro: string | null;
}

/**
 * Canonical runtime-qualified identity for one Worktree.
 *
 * Windows identity is case/separator insensitive. WSL identity preserves
 * Linux path case and includes the distro, whose name is treated
 * case-insensitively because it is selected by the Windows WSL host.
 */
export function worktreeIdentity(
  path: string,
  context: WorktreeRuntimeContext = {}
): WorktreeIdentity {
  const runMode = context.runMode ?? (isWindowsPath(path) ? 'windows' : null);
  const windows = runMode === 'windows';
  const normalizedPath = normalizeWorktreeDisplayPath(path, windows);
  const pathKey = windows
    ? normalizedPath.toLocaleLowerCase('en-US')
    : normalizedPath;
  const wslDistro = runMode === 'wsl' ? context.wslDistro?.trim() || null : null;
  const distroKey = wslDistro?.toLocaleLowerCase('en-US') ?? '';
  return {
    key: JSON.stringify([runMode ?? '', distroKey, pathKey]),
    path: normalizedPath,
    pathKey,
    runMode,
    wslDistro
  };
}

export function worktreeIdentityKey(
  path: string,
  context: WorktreeRuntimeContext = {}
): string {
  return worktreeIdentity(path, context).key;
}

export function worktreeScope(
  cwd: string,
  context: WorktreeRuntimeContext = {}
): WorktreeScope {
  return {
    cwd: cwd.trim(),
    ...(context.runMode ? { runMode: context.runMode } : {}),
    ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
  };
}

export function worktreeScopeKey(scope: WorktreeScope): string {
  return worktreeIdentityKey(scope.cwd, scope);
}

export function worktreeRuntimeContext(scope: WorktreeScope): WorktreeRuntimeContext {
  return {
    ...(scope.runMode ? { runMode: scope.runMode } : {}),
    ...(scope.wslDistro ? { wslDistro: scope.wslDistro } : {})
  };
}

export function sameWorktreeIdentity(
  aPath: string,
  aContext: WorktreeRuntimeContext,
  bPath: string,
  bContext: WorktreeRuntimeContext
): boolean {
  return worktreeIdentityKey(aPath, aContext) === worktreeIdentityKey(bPath, bContext);
}

export function worktreeRuntimeKey(context: WorktreeRuntimeContext = {}): string {
  const runMode = context.runMode ?? '';
  const distro = runMode === 'wsl'
    ? context.wslDistro?.trim().toLocaleLowerCase('en-US') ?? ''
    : '';
  return JSON.stringify([runMode, distro]);
}

export function normalizeWorktreeDisplayPath(path: string, windows: boolean): string {
  let normalized = path.trim();
  if (!normalized) return '';
  if (windows) normalized = normalized.replace(/\\/g, '/');
  if (normalized === '/') return normalized;
  if (windows && /^[A-Za-z]:\/$/.test(normalized)) return normalized.slice(0, 2);
  return normalized.replace(/\/+$/, '');
}

export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path.trim()) || /^(?:\\\\|\/\/)/.test(path.trim());
}
