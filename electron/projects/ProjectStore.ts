import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type {
  Project,
  ProjectDetectResult,
  ProjectDraft,
  ProjectId,
  ProjectOpenRequest,
  ProjectPathSuggestion,
  ProjectSearchScope,
  ProjectSuggestOptions,
  ProjectSuggestResult,
  ProjectUpdate
} from '@shared/types/projects.js';

interface StorageShape {
  version: number;
  projects: Project[];
}

const STORAGE_VERSION = 1;
const VALID_RUN_MODES = new Set(['windows', 'wsl']);

export interface ProjectStoreOptions {
  gitBinary?: string;
}

export class ProjectStore {
  private cache: Map<ProjectId, Project> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<(projects: Project[]) => void>();
  private wslHomeCache = new Map<string, string>();

  constructor(
    private readonly filePath: string,
    private readonly options: ProjectStoreOptions = {}
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    if (this.cache) return;
    this.cache = await this.loadFromDisk();
  }

  async list(): Promise<Project[]> {
    await this.ensureLoaded();
    return [...this.cache!.values()].sort((a, b) =>
      b.lastOpenedAt.localeCompare(a.lastOpenedAt)
    );
  }

  async get(id: ProjectId): Promise<Project | null> {
    await this.ensureLoaded();
    return this.cache!.get(id) ?? null;
  }

  async create(draft: ProjectDraft): Promise<Project> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const id = this.generateId(draft.name);
    const project: Project = {
      id,
      name: draft.name,
      path: draft.path,
      ...(draft.defaultRunMode ? { defaultRunMode: draft.defaultRunMode } : {}),
      ...(draft.defaultWslDistro ? { defaultWslDistro: draft.defaultWslDistro } : {}),
      ...(draft.accentColor ? { accentColor: draft.accentColor } : {}),
      createdAt: now,
      lastOpenedAt: now
    };
    validateProject(project);
    this.cache!.set(id, project);
    await this.persist();
    this.broadcast();
    return project;
  }

  async open(request: ProjectOpenRequest): Promise<Project> {
    const detected = await this.detectFromPath(request.path);
    if (!detected.path.trim()) throw new Error('Project path is required');
    if (detected.matchedProjectId) {
      const touched = await this.touch(detected.matchedProjectId);
      if (touched) return touched;
    }
    return this.create({
      name: detected.suggestedName || inferNameFromPath(detected.path),
      path: detected.path,
      ...(request.defaultRunMode ? { defaultRunMode: request.defaultRunMode } : {}),
      ...(request.defaultWslDistro ? { defaultWslDistro: request.defaultWslDistro } : {}),
      ...(request.accentColor ? { accentColor: request.accentColor } : {})
    });
  }

  async update(id: ProjectId, patch: ProjectUpdate): Promise<Project> {
    await this.ensureLoaded();
    const existing = this.cache!.get(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const merged: Project = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt
    };
    validateProject(merged);
    this.cache!.set(id, merged);
    await this.persist();
    this.broadcast();
    return merged;
  }

  async delete(id: ProjectId): Promise<void> {
    await this.ensureLoaded();
    if (!this.cache!.delete(id)) {
      throw new Error(`Project not found: ${id}`);
    }
    await this.persist();
    this.broadcast();
  }

  async touch(id: ProjectId): Promise<Project | null> {
    await this.ensureLoaded();
    const existing = this.cache!.get(id);
    if (!existing) return null;
    const updated: Project = { ...existing, lastOpenedAt: new Date().toISOString() };
    this.cache!.set(id, updated);
    await this.persist();
    this.broadcast();
    return updated;
  }

  async detectFromPath(input: string): Promise<ProjectDetectResult> {
    await this.ensureLoaded();
    const trimmed = input.trim();
    if (!trimmed) {
      return { path: '', suggestedName: '', matchedProjectId: null };
    }
    const mainRepo = await runGitMainRepo(this.options.gitBinary ?? 'git', trimmed);
    const resolved = mainRepo ?? trimmed;
    const suggestedName = path.basename(resolved.replace(/[/\\]+$/, '')) || resolved;
    const matchedProjectId = this.findByPath(resolved);
    return { path: resolved, suggestedName, matchedProjectId };
  }

  async suggestPaths(
    query: string,
    options?: ProjectSuggestOptions,
    limit = 10
  ): Promise<ProjectSuggestResult> {
    await this.ensureLoaded();
    const requested: ProjectSuggestOptions = options ?? { scope: 'windows' };
    const parsed = parseProjectQuery(query, requested);
    const scope = parsed.scope;
    const wslDistro = scope === 'wsl' ? parsed.wslDistro ?? 'Ubuntu' : undefined;
    const byPath = new Map<string, ProjectPathSuggestion>();

    const known = [...this.cache!.values()]
      .filter((project) => projectMatchesScope(project, scope, wslDistro))
      .map((project) => {
        const score = Math.max(
          fuzzyScore(parsed.queryForKnown, project.name) ?? -1,
          fuzzyScore(parsed.queryForKnown, project.path) ?? -1
        );
        return { project, score };
      })
      .filter((entry) => !parsed.queryForKnown || entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    for (const { project } of known) {
      byPath.set(normalizePath(project.path), {
        path: project.path,
        name: project.name,
        source: 'known',
        scope: pathScope(project),
        ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {}),
        projectId: project.id
      });
    }

    const dirResults =
      scope === 'wsl'
        ? await this.suggestWslDirectories(wslDistro!, parsed, limit)
        : await suggestWindowsDirectories(parsed, limit);

    for (const suggestion of dirResults) {
      const key = normalizePath(suggestion.path);
      if (!byPath.has(key)) byPath.set(key, suggestion);
    }

    if (dirResults.length === 1 && parsed.fragment) {
      const single = dirResults[0]!;
      const childParsed: ParsedProjectQuery =
        scope === 'wsl'
          ? {
              scope: 'wsl',
              wslDistro: wslDistro!,
              baseDir: single.path,
              fragment: '',
              original: '',
              queryForKnown: ''
            }
          : {
              scope: 'windows',
              baseDir: single.path,
              fragment: '',
              original: '',
              queryForKnown: ''
            };
      const childResults =
        scope === 'wsl'
          ? await this.suggestWslDirectories(wslDistro!, childParsed, limit)
          : await suggestWindowsDirectories(childParsed, limit);
      for (const suggestion of childResults) {
        const key = normalizePath(suggestion.path);
        if (!byPath.has(key)) byPath.set(key, suggestion);
      }
    }

    return {
      scope,
      ...(wslDistro ? { wslDistro } : {}),
      suggestions: [...byPath.values()].slice(0, limit)
    };
  }

  private async suggestWslDirectories(
    distro: string,
    parsed: ParsedProjectQuery,
    limit: number
  ): Promise<ProjectPathSuggestion[]> {
    const home = await this.resolveWslHome(distro);
    const baseDir = parsed.baseDir
      ? expandWslHome(parsed.baseDir, home)
      : home;
    const fragment = parsed.fragment;
    const unc = posixToWslUnc(distro, baseDir);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(unc, { withFileTypes: true });
    } catch {
      return [];
    }
    const fullQuery = parsed.original;
    return entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => fragment.startsWith('.') || !entry.name.startsWith('.'))
      .map((entry) => {
        const fullPath = joinPosix(baseDir, entry.name);
        const score = Math.max(
          fuzzyScore(fragment, entry.name) ?? -1,
          fuzzyScore(fullQuery, fullPath) ?? -1
        );
        return {
          suggestion: {
            path: fullPath,
            name: entry.name,
            source: 'directory' as const,
            scope: 'wsl' as const,
            wslDistro: distro
          },
          score
        };
      })
      .filter((entry) => !fragment || entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.suggestion);
  }

  private async resolveWslHome(distro: string): Promise<string> {
    const cached = this.wslHomeCache.get(distro);
    if (cached) return cached;
    const home = await runWslCommand(distro, 'printf %s "$HOME"');
    const resolved = home.trim() || '/root';
    this.wslHomeCache.set(distro, resolved);
    return resolved;
  }

  onChange(fn: (projects: Project[]) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private findByPath(repoPath: string): ProjectId | null {
    if (!this.cache) return null;
    const norm = normalizePath(repoPath);
    for (const project of this.cache.values()) {
      if (normalizePath(project.path) === norm) return project.id;
    }
    return null;
  }

  private broadcast(): void {
    const snapshot = [...(this.cache?.values() ?? [])];
    for (const l of this.listeners) {
      try {
        l(snapshot);
      } catch {
        // listener errors swallowed
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.cache) await this.init();
  }

  private async loadFromDisk(): Promise<Map<ProjectId, Project>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return new Map();
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.backupCorruptFile(raw);
      return new Map();
    }
    const projects = parseStorage(parsed);
    return new Map(projects.map((p) => [p.id, p]));
  }

  private async backupCorruptFile(content: string): Promise<void> {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      await fs.writeFile(backupPath, content, 'utf8');
    } catch {
      // best-effort backup
    }
  }

  private async persist(): Promise<void> {
    const snapshot: StorageShape = {
      version: STORAGE_VERSION,
      projects: [...this.cache!.values()]
    };
    const payload = JSON.stringify(snapshot, null, 2);
    this.writeQueue = this.writeQueue.then(() => atomicWrite(this.filePath, payload));
    await this.writeQueue;
  }

  private generateId(name: string): ProjectId {
    const slug = slugify(name) || 'project';
    let candidate = slug;
    let attempt = 0;
    while (this.cache!.has(candidate)) {
      attempt += 1;
      candidate = `${slug}-${randomBytes(3).toString('hex')}`;
      if (attempt > 10) {
        candidate = `${slug}-${Date.now()}`;
        break;
      }
    }
    return candidate;
  }
}

async function runGitMainRepo(gitBinary: string, cwd: string): Promise<string | null> {
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const commonDir = await runGitRevParse(gitBinary, cwd, '--git-common-dir');
  if (!commonDir) return null;
  const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
  const normalized = absolute.replace(/[/\\]+$/, '');
  if (path.basename(normalized) === '.git') {
    return path.dirname(normalized);
  }
  // Bare or unusual layout: fall back to --show-toplevel
  return runGitRevParse(gitBinary, cwd, '--show-toplevel');
}

function runGitRevParse(gitBinary: string, cwd: string, flag: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(gitBinary, ['rev-parse', flag], { cwd });
    let stdout = '';
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code === 0) {
        const out = stdout.trim();
        resolve(out.length > 0 ? out : null);
      } else {
        resolve(null);
      }
    });
  });
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizePath(p: string): string {
  return p.replace(/[/\\]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function inferNameFromPath(projectPath: string): string {
  return path.basename(projectPath.replace(/[/\\]+$/, '')) || projectPath;
}

interface ParsedProjectQuery {
  scope: ProjectSearchScope;
  wslDistro?: string;
  baseDir: string;
  fragment: string;
  original: string;
  queryForKnown: string;
}

const WSL_UNC_RE = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\?(.*)$/i;

function parseProjectQuery(
  query: string,
  options: ProjectSuggestOptions
): ParsedProjectQuery {
  const trimmed = query.trim();

  if (trimmed.toLowerCase().startsWith('wsl:')) {
    const remainder = trimmed.slice(4).replace(/^[\s]+/, '');
    return buildWslParsed(remainder, options.wslDistro ?? 'Ubuntu', remainder);
  }
  if (trimmed.toLowerCase().startsWith('win:')) {
    const remainder = trimmed.slice(4).replace(/^[\s]+/, '');
    return buildWindowsParsed(remainder, remainder);
  }
  const uncMatch = trimmed.match(WSL_UNC_RE);
  if (uncMatch) {
    const distro = uncMatch[1] ?? 'Ubuntu';
    const tail = (uncMatch[2] ?? '').replace(/\\/g, '/');
    const posix = tail ? `/${tail.replace(/^\/+/, '')}` : '/';
    return buildWslParsed(posix, distro, trimmed);
  }
  if (options.scope === 'wsl') {
    return buildWslParsed(trimmed, options.wslDistro ?? 'Ubuntu', trimmed);
  }
  return buildWindowsParsed(trimmed, trimmed);
}

function buildWindowsParsed(query: string, original: string): ParsedProjectQuery {
  if (!query) {
    return {
      scope: 'windows',
      baseDir: os.homedir(),
      fragment: '',
      original,
      queryForKnown: original
    };
  }
  const resolved = isWindowsAbsolute(query) ? query : joinWindowsHome(query);
  const expanded = expandWindowsHome(resolved);
  const endsWithSep = resolved.endsWith('/') || resolved.endsWith('\\');
  if (endsWithSep) {
    return {
      scope: 'windows',
      baseDir: expanded,
      fragment: '',
      original,
      queryForKnown: original
    };
  }
  const lastSeparator = Math.max(expanded.lastIndexOf('/'), expanded.lastIndexOf('\\'));
  if (lastSeparator >= 0) {
    return {
      scope: 'windows',
      baseDir: expanded.slice(0, lastSeparator + 1),
      fragment: expanded.slice(lastSeparator + 1),
      original,
      queryForKnown: original
    };
  }
  return {
    scope: 'windows',
    baseDir: os.homedir(),
    fragment: expanded,
    original,
    queryForKnown: original
  };
}

function buildWslParsed(query: string, distro: string, original: string): ParsedProjectQuery {
  if (!query) {
    return {
      scope: 'wsl',
      wslDistro: distro,
      baseDir: '',
      fragment: '',
      original,
      queryForKnown: original
    };
  }
  const resolved = isWslAbsolute(query) ? query : `~/${query}`;
  if (resolved.endsWith('/')) {
    return {
      scope: 'wsl',
      wslDistro: distro,
      baseDir: resolved,
      fragment: '',
      original,
      queryForKnown: original
    };
  }
  const lastSlash = resolved.lastIndexOf('/');
  if (lastSlash >= 0) {
    return {
      scope: 'wsl',
      wslDistro: distro,
      baseDir: resolved.slice(0, lastSlash + 1),
      fragment: resolved.slice(lastSlash + 1),
      original,
      queryForKnown: original
    };
  }
  return {
    scope: 'wsl',
    wslDistro: distro,
    baseDir: '',
    fragment: resolved,
    original,
    queryForKnown: original
  };
}

function isWindowsAbsolute(query: string): boolean {
  if (query.startsWith('/') || query.startsWith('\\')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(query)) return true;
  if (query === '~' || query.startsWith('~/') || query.startsWith('~\\')) return true;
  return false;
}

function isWslAbsolute(query: string): boolean {
  if (query.startsWith('/')) return true;
  if (query === '~' || query.startsWith('~/')) return true;
  return false;
}

function joinWindowsHome(query: string): string {
  return `${os.homedir()}${path.sep}${query}`;
}

function expandWindowsHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function expandWslHome(input: string, home: string): string {
  if (!input) return home;
  if (input === '~') return home;
  if (input.startsWith('~/')) return joinPosix(home, input.slice(2));
  return input;
}

function joinPosix(base: string, child: string): string {
  if (!base) return `/${child.replace(/^\/+/, '')}`;
  return `${base.replace(/\/+$/, '')}/${child.replace(/^\/+/, '')}`;
}

function posixToWslUnc(distro: string, posixPath: string): string {
  const noLead = posixPath.replace(/^\/+/, '');
  const winSubpath = noLead.replace(/\//g, '\\');
  return winSubpath
    ? `\\\\wsl.localhost\\${distro}\\${winSubpath}`
    : `\\\\wsl.localhost\\${distro}\\`;
}

function pathScope(project: Project): ProjectSearchScope {
  if (project.defaultRunMode) return project.defaultRunMode === 'wsl' ? 'wsl' : 'windows';
  if (project.path.startsWith('/')) return 'wsl';
  return 'windows';
}

function projectMatchesScope(
  project: Project,
  scope: ProjectSearchScope,
  wslDistro: string | undefined
): boolean {
  const projectScope = pathScope(project);
  if (projectScope !== scope) return false;
  if (scope !== 'wsl') return true;
  if (!wslDistro) return true;
  if (!project.defaultWslDistro) return true;
  return project.defaultWslDistro === wslDistro;
}

function runWslCommand(distro: string, bashLine: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(
      'wsl.exe',
      ['-d', distro, '--', 'bash', '-lc', bashLine],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    );
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve('');
    }, 2500);
    child.stdout.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(stdout);
    });
  });
}

async function suggestWindowsDirectories(
  parsed: ParsedProjectQuery,
  limit: number
): Promise<ProjectPathSuggestion[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(parsed.baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => parsed.fragment.startsWith('.') || !entry.name.startsWith('.'))
    .map((entry) => {
      const fullPath = path.join(parsed.baseDir, entry.name);
      const score = Math.max(
        fuzzyScore(parsed.fragment, entry.name) ?? -1,
        fuzzyScore(parsed.original, fullPath) ?? -1
      );
      return {
        suggestion: {
          path: fullPath,
          name: entry.name,
          source: 'directory' as const,
          scope: 'windows' as const
        },
        score
      };
    })
    .filter((entry) => !parsed.fragment || entry.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.suggestion);
}

function fuzzyScore(query: string, candidate: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let qi = 0;
  let total = 0;
  let lastIdx = -1;
  let run = 0;
  for (let i = 0; i < c.length && qi < q.length; i += 1) {
    if (c[i] !== q[qi]) {
      run = 0;
      continue;
    }
    let score = 1;
    if (i === 0) score += 5;
    if (i === lastIdx + 1) {
      run += 1;
      score += run * 2;
    } else {
      run = 1;
    }
    const prev = i > 0 ? candidate[i - 1] : '';
    const ch = candidate[i];
    if (prev) {
      const isWordBoundary = /[\s\-_./\\]/.test(prev);
      const isCamelBoundary = ch && prev && prev === prev.toLowerCase() && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
      if (isWordBoundary || isCamelBoundary) score += 3;
    }
    total += score;
    lastIdx = i;
    qi += 1;
  }
  if (qi < q.length) return null;
  return total + Math.max(0, 10 - candidate.length / 8);
}

function parseStorage(raw: unknown): Project[] {
  if (!isObject(raw)) return [];
  const projectsRaw = raw['projects'];
  if (!Array.isArray(projectsRaw)) return [];
  const valid: Project[] = [];
  for (const candidate of projectsRaw) {
    const project = parseProject(candidate);
    if (project) valid.push(project);
  }
  return valid;
}

function parseProject(raw: unknown): Project | null {
  if (!isObject(raw)) return null;
  if (typeof raw['id'] !== 'string') return null;
  if (typeof raw['name'] !== 'string') return null;
  if (typeof raw['path'] !== 'string') return null;
  if (typeof raw['createdAt'] !== 'string') return null;
  if (typeof raw['lastOpenedAt'] !== 'string') return null;
  const project = raw as unknown as Project;
  try {
    validateProject(project);
    return project;
  } catch {
    return null;
  }
}

function validateProject(p: Project): void {
  if (!p.id.trim()) throw new Error('Project id is required');
  if (!p.name.trim()) throw new Error('Project name is required');
  if (!p.path.trim()) throw new Error('Project path is required');
  if (p.defaultRunMode !== undefined && !VALID_RUN_MODES.has(p.defaultRunMode)) {
    throw new Error(`Invalid defaultRunMode: ${p.defaultRunMode}`);
  }
  if (p.defaultWslDistro !== undefined && !p.defaultWslDistro.trim()) {
    throw new Error('defaultWslDistro must be non-empty when set');
  }
  if (p.accentColor !== undefined && !p.accentColor.trim()) {
    throw new Error('accentColor must be non-empty when set');
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
