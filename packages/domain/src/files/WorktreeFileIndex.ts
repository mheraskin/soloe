import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RunMode } from '../../../../shared/types/sessions.js';
import type { FileSearchResult } from '../../../../shared/types/files.js';
import type { SettingsBinaries } from '../../../../shared/types/settings.js';
import {
  worktreeScopeKey,
  type WorktreeScope
} from '../../../../shared/worktree-identity.js';
import {
  runGitCommand,
  type GitCommandOptions,
  type GitCommandResult
} from '../git/GitCommandRunner.js';
import {
  joinHostPath,
  worktreeHostPath,
} from '../runtime/wsl-paths.js';

export type FileIndexScope = WorktreeScope & { runMode: RunMode };

export interface WorktreeFileInventory {
  paths: string[];
  truncated: boolean;
  isRepo: boolean;
}

export type WorktreeFileInventoryLoader = (
  scope: FileIndexScope
) => Promise<WorktreeFileInventory>;

export interface WorktreeFileIndexOptions {
  getBinaries?: () => Promise<SettingsBinaries> | SettingsBinaries;
  loadInventory?: WorktreeFileInventoryLoader;
  runCommand?: (
    binary: string,
    args: string[],
    options?: GitCommandOptions
  ) => Promise<GitCommandResult>;
  ttlMs?: number;
  maxScopes?: number;
  maxPaths?: number;
  now?: () => number;
  useWslHostBridge?: boolean;
}

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_MAX_SCOPES = 6;
const DEFAULT_MAX_PATHS = 20_000;
const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_TREE_DEPTH = 20;
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.svelte-kit',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  '__pycache__'
]);

interface CachedInventory {
  inventory: WorktreeFileInventory;
  expiresAt: number;
}

interface InFlightInventory {
  generation: number;
  request: Promise<WorktreeFileInventory>;
}

/**
 * One bounded path inventory shared by every Files consumer for an exact
 * Worktree Identity. Enumeration, freshness, deduplication, and WSL host-path
 * adaptation stay behind this Interface.
 */
export class WorktreeFileIndex {
  private readonly cache = new Map<string, CachedInventory>();
  private readonly inFlight = new Map<string, InFlightInventory>();
  private readonly generation = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxScopes: number;
  private readonly maxPaths: number;
  private readonly now: () => number;
  private readonly loadInventory: WorktreeFileInventoryLoader;
  private readonly runCommand: NonNullable<WorktreeFileIndexOptions['runCommand']>;
  private readonly useWslHostBridge: boolean;
  private disposed = false;

  constructor(private readonly options: WorktreeFileIndexOptions = {}) {
    this.ttlMs = positiveInteger(options.ttlMs, DEFAULT_TTL_MS);
    this.maxScopes = positiveInteger(options.maxScopes, DEFAULT_MAX_SCOPES);
    this.maxPaths = positiveInteger(options.maxPaths, DEFAULT_MAX_PATHS);
    this.now = options.now ?? Date.now;
    this.runCommand = options.runCommand ?? runGitCommand;
    this.useWslHostBridge = options.useWslHostBridge ?? true;
    this.loadInventory = options.loadInventory ?? ((scope) => this.enumerate(scope));
  }

  async inventory(
    scope: FileIndexScope,
    options: { force?: boolean } = {}
  ): Promise<WorktreeFileInventory> {
    this.assertActive();
    const key = worktreeScopeKey(scope);
    if (options.force) this.invalidate(scope);

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      this.touch(key, cached);
      return cached.inventory;
    }

    const active = this.inFlight.get(key);
    if (active) return active.request;

    const generation = this.generation.get(key) ?? 0;
    let request!: Promise<WorktreeFileInventory>;
    request = (async () => {
      try {
        const loaded = await this.loadInventory(scope);
        if (this.disposed) throw new Error('Worktree File Index is disposed');
        if ((this.generation.get(key) ?? 0) !== generation) {
          this.removeFlight(key, request);
          return this.inventory(scope);
        }
        const inventory = normalizeInventory(loaded, this.maxPaths);
        this.cache.delete(key);
        this.cache.set(key, { inventory, expiresAt: this.now() + this.ttlMs });
        this.trimCache();
        return inventory;
      } catch (error) {
        if (!this.disposed && (this.generation.get(key) ?? 0) !== generation) {
          this.removeFlight(key, request);
          return this.inventory(scope);
        }
        throw error;
      }
    })().finally(() => this.removeFlight(key, request));
    this.inFlight.set(key, { generation, request });
    return request;
  }

  async search(
    scope: FileIndexScope,
    query: string,
    limit = 80
  ): Promise<FileSearchResult[]> {
    const inventory = await this.inventory(scope);
    const q = query.trim();
    const ranked = q
      ? rank(q, inventory.paths)
      : inventory.paths.map((file, index) => ({ file, score: 1000 - index }));
    const hostRoot = worktreeHostPath(scope.cwd, scope.runMode, scope.wslDistro);
    return ranked
      .slice(0, Math.max(1, Math.min(200, Math.trunc(limit))))
      .map(({ file }) => ({
        rootPath: scope.cwd,
        path: file,
        absolutePath: joinHostPath(hostRoot, file)
      }));
  }

  invalidate(scope: FileIndexScope): void {
    const key = worktreeScopeKey(scope);
    this.cache.delete(key);
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    for (const key of this.inFlight.keys()) {
      this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    }
  }

  private async enumerate(scope: FileIndexScope): Promise<WorktreeFileInventory> {
    const hostRoot = worktreeHostPath(scope.cwd, scope.runMode, scope.wslDistro);
    try {
      const stat = await fs.stat(hostRoot);
      if (!stat.isDirectory()) return { paths: [], truncated: false, isRepo: false };
    } catch {
      return { paths: [], truncated: false, isRepo: false };
    }

    const binaries = this.options.getBinaries ? await this.options.getBinaries() : {};
    const result = scope.runMode === 'wsl' && this.useWslHostBridge
      ? await this.runWslGitInventory(scope)
      : await this.runCommand(
          binaries.git ?? 'git',
          ['ls-files', '-co', '-z', '--exclude-standard'],
          { cwd: hostRoot, stdoutLimitBytes: MAX_GIT_OUTPUT_BYTES }
        );
    if (result.code === 0) {
      const paths = result.stdout.split('\0').filter(Boolean);
      return {
        paths,
        truncated: paths.length > this.maxPaths,
        isRepo: true
      };
    }
    return this.walk(hostRoot);
  }

  private runWslGitInventory(scope: FileIndexScope): Promise<GitCommandResult> {
    const distro = scope.wslDistro?.trim();
    if (!distro) {
      return Promise.resolve({ code: null, stdout: '', stderr: 'WSL distro is required' });
    }
    return this.runCommand(
      'wsl.exe',
      [
        '-d', distro, '--cd', scope.cwd, '--',
        'git', 'ls-files', '-co', '-z', '--exclude-standard'
      ],
      { stdoutLimitBytes: MAX_GIT_OUTPUT_BYTES }
    );
  }

  private async walk(hostRoot: string): Promise<WorktreeFileInventory> {
    const paths: string[] = [];
    let truncated = false;
    const recurse = async (dir: string, relative: string, depth: number): Promise<void> => {
      if (truncated || depth > MAX_TREE_DEPTH) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (paths.length >= this.maxPaths) {
          truncated = true;
          return;
        }
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORIES.has(entry.name)) continue;
          const next = relative ? `${relative}/${entry.name}` : entry.name;
          await recurse(joinHostPath(dir, entry.name), next, depth + 1);
        } else if (entry.isFile()) {
          paths.push(relative ? `${relative}/${entry.name}` : entry.name);
        }
      }
    };
    await recurse(hostRoot, '', 0);
    return { paths, truncated, isRepo: false };
  }

  private touch(key: string, entry: CachedInventory): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private trimCache(): void {
    while (this.cache.size > this.maxScopes) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) return;
      this.cache.delete(oldest);
    }
  }

  private removeFlight(key: string, request: Promise<WorktreeFileInventory>): void {
    if (this.inFlight.get(key)?.request === request) this.inFlight.delete(key);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Worktree File Index is disposed');
  }
}

function normalizeInventory(
  inventory: WorktreeFileInventory,
  maxPaths: number
): WorktreeFileInventory {
  const unique = [...new Set(inventory.paths.filter(Boolean))];
  return {
    paths: unique.slice(0, maxPaths),
    truncated: inventory.truncated || unique.length > maxPaths,
    isRepo: inventory.isRepo
  };
}

function rank(query: string, files: string[]): Array<{ file: string; score: number }> {
  return files
    .map((file) => ({ file, score: score(query, file) }))
    .filter((item): item is { file: string; score: number } => item.score !== null)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

function score(query: string, candidate: string): number | null {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let queryIndex = 0;
  let total = 0;
  let last = -1;
  for (let index = 0; index < c.length && queryIndex < q.length; index += 1) {
    if (c[index] !== q[queryIndex]) continue;
    total += index === queryIndex ? 10 : 2;
    if (last >= 0 && index === last + 1) total += 5;
    if (index === 0 || /[/_.-]/.test(candidate[index - 1] ?? '')) total += 4;
    last = index;
    queryIndex += 1;
  }
  if (queryIndex !== q.length) return null;
  return total - candidate.length / 100;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback;
}
