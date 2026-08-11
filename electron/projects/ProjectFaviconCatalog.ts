import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import type { Project, ProjectFavicon } from '@shared/types/projects.js';
import { worktreeHostPath } from '../runtime/wsl-paths.js';

export interface ProjectFaviconCatalogBudgets {
  maxDepth: number;
  maxDirectories: number;
  maxEntries: number;
  maxCandidates: number;
  maxResults: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export type ProjectFaviconCatalogOptions = Partial<ProjectFaviconCatalogBudgets>;

const DEFAULT_BUDGETS: ProjectFaviconCatalogBudgets = {
  maxDepth: 5,
  maxDirectories: 128,
  maxEntries: 4_096,
  maxCandidates: 72,
  maxResults: 24,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 2 * 1024 * 1024
};

const SEARCH_ROOTS = ['public', 'static', 'src/assets', '', 'src'] as const;
const FAVICON_EXTENSIONS = new Set(['.ico', '.png', '.svg', '.jpg', '.jpeg', '.webp']);
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'out',
  '.next',
  '.svelte-kit',
  'coverage'
]);

interface Candidate {
  absolutePath: string;
  relativePath: string;
  score: number;
}

interface DirectoryWork {
  absolutePath: string;
  relativePath: string;
  depth: number;
}

/**
 * Demand-driven Project icon discovery and asset reads.
 *
 * The Module hides traversal, containment, media, and byte budgets behind two
 * small queries. It owns no Project metadata and never persists or broadcasts
 * asset payloads.
 */
export class ProjectFaviconCatalog {
  private readonly budgets: ProjectFaviconCatalogBudgets;
  private readonly discoveryRequests = new Map<string, Promise<ProjectFavicon[]>>();

  constructor(options: ProjectFaviconCatalogOptions = {}) {
    this.budgets = {
      maxDepth: limit(options.maxDepth, DEFAULT_BUDGETS.maxDepth),
      maxDirectories: limit(options.maxDirectories, DEFAULT_BUDGETS.maxDirectories),
      maxEntries: limit(options.maxEntries, DEFAULT_BUDGETS.maxEntries),
      maxCandidates: limit(options.maxCandidates, DEFAULT_BUDGETS.maxCandidates),
      maxResults: limit(options.maxResults, DEFAULT_BUDGETS.maxResults),
      maxFileBytes: limit(options.maxFileBytes, DEFAULT_BUDGETS.maxFileBytes),
      maxTotalBytes: limit(options.maxTotalBytes, DEFAULT_BUDGETS.maxTotalBytes)
    };
  }

  async discover(project: Project): Promise<ProjectFavicon[]> {
    const key = projectIdentityKey(project);
    const existing = this.discoveryRequests.get(key);
    if (existing) return cloneFavicons(await existing);
    const request = this.discoverUncached(project).finally(() => {
      if (this.discoveryRequests.get(key) === request) this.discoveryRequests.delete(key);
    });
    this.discoveryRequests.set(key, request);
    return cloneFavicons(await request);
  }

  async read(project: Project, relativePath: string): Promise<ProjectFavicon | null> {
    const safePath = safeRelativePath(relativePath);
    if (!safePath) return null;
    const root = projectFsPath(project);
    const absolutePath = path.resolve(root, ...safePath.split('/'));
    if (!isContained(root, absolutePath)) return null;
    try {
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(absolutePath)]);
      if (!isContained(realRoot, realFile)) return null;
      const result = await this.readCandidate(realFile, safePath, this.budgets.maxFileBytes);
      return result?.favicon ?? null;
    } catch {
      return null;
    }
  }

  private async discoverUncached(project: Project): Promise<ProjectFavicon[]> {
    const root = projectFsPath(project);
    const candidates = await this.findCandidates(root);
    const favicons: ProjectFavicon[] = [];
    let retainedBytes = 0;
    for (const candidate of candidates.sort(compareCandidates)) {
      const remaining = this.budgets.maxTotalBytes - retainedBytes;
      if (remaining <= 0) break;
      const result = await this.readCandidate(
        candidate.absolutePath,
        candidate.relativePath,
        Math.min(this.budgets.maxFileBytes, remaining)
      );
      if (!result) continue;
      favicons.push(result.favicon);
      retainedBytes += result.bytes;
      if (favicons.length >= this.budgets.maxResults) break;
    }
    return favicons;
  }

  private async findCandidates(root: string): Promise<Candidate[]> {
    const queue: DirectoryWork[] = SEARCH_ROOTS.map((relativePath) => ({
      absolutePath: relativePath ? path.join(root, relativePath) : root,
      relativePath,
      depth: relativePath ? relativePath.split('/').length : 0
    }));
    const visited = new Set<string>();
    const candidates: Candidate[] = [];
    let directoryCount = 0;
    let entryCount = 0;

    while (
      queue.length > 0
      && directoryCount < this.budgets.maxDirectories
      && entryCount < this.budgets.maxEntries
      && candidates.length < this.budgets.maxCandidates
    ) {
      const current = queue.shift()!;
      const visitKey = path.resolve(current.absolutePath);
      if (visited.has(visitKey) || current.depth > this.budgets.maxDepth) continue;
      visited.add(visitKey);
      directoryCount += 1;

      let entries: Dirent[];
      try {
        entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entryCount >= this.budgets.maxEntries) break;
        entryCount += 1;
        const relativePath = current.relativePath
          ? `${current.relativePath}/${entry.name}`
          : entry.name;
        const absolutePath = path.join(current.absolutePath, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && current.depth < this.budgets.maxDepth) {
            queue.push({
              absolutePath,
              relativePath,
              depth: current.depth + 1
            });
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const score = faviconScore(relativePath);
        if (score === null) continue;
        candidates.push({ absolutePath, relativePath, score });
        if (candidates.length >= this.budgets.maxCandidates) break;
      }
    }
    return candidates;
  }

  private async readCandidate(
    absolutePath: string,
    relativePath: string,
    byteLimit: number
  ): Promise<{ favicon: ProjectFavicon; bytes: number } | null> {
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > byteLimit) return null;
      const mediaType = mediaTypeForExtension(path.extname(relativePath).toLowerCase());
      if (!mediaType) return null;
      const data = await fs.readFile(absolutePath);
      return {
        bytes: data.byteLength,
        favicon: {
          path: relativePath.replace(/\\/g, '/'),
          label: path.basename(relativePath),
          mediaType,
          dataUrl: `data:${mediaType};base64,${data.toString('base64')}`
        }
      };
    } catch {
      return null;
    }
  }
}

function faviconScore(relativePath: string): number | null {
  const normalized = relativePath.replace(/\\/g, '/');
  const lower = normalized.toLowerCase();
  const ext = path.extname(lower);
  if (!FAVICON_EXTENSIONS.has(ext)) return null;
  const base = path.basename(lower, ext);
  const likely =
    base === 'favicon'
    || base.startsWith('favicon-')
    || base.startsWith('apple-touch-icon')
    || base.startsWith('android-chrome-')
    || base.startsWith('mstile-')
    || base === 'safari-pinned-tab'
    || lower.includes('/favicons/');
  if (!likely) return null;
  let score = normalized.split('/').length * 10;
  if (base === 'favicon') score -= 40;
  if (ext === '.ico') score -= 10;
  if (normalized.startsWith('public/')) score -= 8;
  if (normalized.startsWith('static/')) score -= 7;
  if (normalized.startsWith('src/')) score += 5;
  return score;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.score !== b.score) return a.score - b.score;
  return a.relativePath.localeCompare(b.relativePath);
}

function mediaTypeForExtension(ext: string): string | null {
  switch (ext) {
    case '.ico': return 'image/x-icon';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    default: return null;
  }
}

function safeRelativePath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:\//.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function projectFsPath(project: Project): string {
  if (project.defaultRunMode === 'wsl' && project.path.startsWith('/')) {
    return worktreeHostPath(project.path, 'wsl', project.defaultWslDistro ?? 'Ubuntu');
  }
  return project.path;
}

function projectIdentityKey(project: Project): string {
  return JSON.stringify([
    project.path,
    project.defaultRunMode ?? '',
    project.defaultWslDistro?.toLocaleLowerCase('en-US') ?? ''
  ]);
}

function cloneFavicons(favicons: readonly ProjectFavicon[]): ProjectFavicon[] {
  return favicons.map((favicon) => ({ ...favicon }));
}

function limit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}
