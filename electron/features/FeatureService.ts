import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  joinHostPath as joinPath,
  worktreeHostPath as hostPathFor
} from '../runtime/wsl-paths.js';
import {
  FeatureArtifactObservation,
  type FeatureArtifactIndex,
  type FeatureArtifactScope
} from './FeatureArtifactObservation.js';
import type {
  BranchStatus,
  CoverageBranchEntry,
  CoverageBranchSection,
  CoverageMapSnapshot,
  FeatureIssueEntry,
  FeaturePlanEntry,
  FeatureScanRequest,
  FeatureSetBranchStatusRequest,
  FeatureSetIssueStatusRequest,
  FeatureSetupStatus,
  FeatureSnapshot,
  IssueTrackerConfig,
  IssueTrackerProvider
} from '@shared/types/features.js';

const PLAYWRIGHT_FILE = 'playwright-e2e.md';
const STATUS_MARKERS: Record<BranchStatus, string> = {
  todo: '[ ]',
  in_progress: '[~]',
  resolved: '[x]',
  deferred: '[D]'
};

export interface FeatureArtifactIndexSource {
  observeNow(scope: FeatureArtifactScope): Promise<FeatureArtifactIndex>;
  current(scope: FeatureArtifactScope, revision?: string): FeatureArtifactIndex | null;
}

export class FeatureService {
  private readonly mutationQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly artifacts: FeatureArtifactIndexSource = new FeatureArtifactObservation()
  ) {}

  async scan(request: FeatureScanRequest): Promise<FeatureSnapshot> {
    if (!request.cwd?.trim()) throw new Error('cwd is required');
    const slug = request.slug?.trim() || null;
    if (slug) assertFeatureSlug(slug);
    const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
    const cached = request.observedRevision
      ? this.artifacts.current(request, request.observedRevision)
      : null;
    const [index, setup, tracker] = await Promise.all([
      cached ?? this.artifacts.observeNow(request),
      this.detectSetup(host),
      this.detectTracker(host)
    ]);

    let coverage: CoverageMapSnapshot | null = null;
    let plans: FeaturePlanEntry[] = [];
    let issues: FeatureIssueEntry[] = [];
    if (slug) {
      [coverage, plans, issues] = await Promise.all([
        this.readCoverageMap(host, slug, index),
        Promise.resolve(this.listPlans(index, slug)),
        this.listIssues(host, slug, index)
      ]);
    }

    return {
      cwd: request.cwd,
      features: [...index.features],
      selectedSlug: slug,
      coverage,
      plans,
      issues,
      tracker,
      setup,
      artifactRevision: index.revision,
      scannedAt: Date.now()
    };
  }

  async writeBranchStatus(request: FeatureSetBranchStatusRequest): Promise<CoverageMapSnapshot> {
    if (!request.cwd?.trim()) throw new Error('cwd is required');
    if (!request.slug?.trim()) throw new Error('slug is required');
    assertFeatureSlug(request.slug);
    if (!request.branchId?.trim()) throw new Error('branchId is required');
    const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
    const filePath = joinPath(host, 'docs', 'grill', request.slug, 'coverage-map.md');
    return this.enqueueArtifactMutation(filePath, async () => {
      const original = await fs.readFile(filePath, 'utf8');
      const lines = original.split('\n');
      const before = parseCoverageMap(lines);
      let targetIndex = -1;
      for (const section of before.sections) {
        const hit = section.entries.find((e) => e.id === request.branchId);
        if (hit) {
          targetIndex = hit.lineIndex;
          break;
        }
      }
      if (targetIndex < 0) {
        throw new Error(`Branch ${request.branchId} not found in coverage map`);
      }
      const desiredMarker = STATUS_MARKERS[request.status];
      const rewritten = replaceMarkerOnLine(lines[targetIndex] ?? '', desiredMarker);
      if (!rewritten) {
        throw new Error(`Failed to rewrite status marker on line ${targetIndex + 1}`);
      }
      lines[targetIndex] = rewritten;
      const next = lines.join('\n');
      if (next !== original) await fs.writeFile(filePath, next, 'utf8');
      return this.snapshotCoverage(request.slug, lines);
    });
  }

  async writeIssueStatus(request: FeatureSetIssueStatusRequest): Promise<FeatureIssueEntry> {
    if (!request.cwd?.trim()) throw new Error('cwd is required');
    if (!request.relativePath?.trim()) throw new Error('relativePath is required');
    const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
    const normalized = request.relativePath.replace(/\\/g, '/');
    const issueMatch = /^\.scratch\/([^/]+)\/issues\/([^/]+\.md)$/iu.exec(normalized);
    if (path.isAbsolute(normalized) || normalized.includes('\0') || !issueMatch) {
      throw new Error('Issue path must identify one indexed feature issue');
    }
    const slug = issueMatch[1] ?? '';
    assertFeatureSlug(slug);
    const index = this.artifacts.current(request) ?? await this.artifacts.observeNow(request);
    const isIndexed = index.scratch
      .find((entry) => entry.slug === slug)
      ?.issues.some((entry) => entry.relativePath === normalized) === true;
    if (!isIndexed) throw new Error('Issue path is not part of the current Feature Artifact Index');

    const filePath = joinPath(host, ...normalized.split('/'));
    return this.enqueueArtifactMutation(filePath, async () => {
      const original = await fs.readFile(filePath, 'utf8');
      const lines = original.split('\n');
      const status = request.status.trim() || 'solved';
      const statusIndex = lines.findIndex((line) => /^Status:\s*/i.test(line));
      if (statusIndex >= 0) {
        lines[statusIndex] = `Status: ${status}`;
      } else {
        const titleIndex = lines.findIndex((line) => /^#\s+/.test(line));
        const insertAt = titleIndex >= 0 ? titleIndex + 1 : 0;
        lines.splice(insertAt, 0, `Status: ${status}`);
      }
      const next = lines.join('\n');
      if (next !== original) await fs.writeFile(filePath, next, 'utf8');
      return issueEntryFromFile(normalized, parseIssueHead(next));
    });
  }

  private enqueueArtifactMutation<TResult>(
    artifactPath: string,
    mutation: () => Promise<TResult>
  ): Promise<TResult> {
    const previous = this.mutationQueues.get(artifactPath) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(mutation);
    const settled = result.then(() => undefined, () => undefined);
    this.mutationQueues.set(artifactPath, settled);
    void settled.finally(() => {
      if (this.mutationQueues.get(artifactPath) === settled) {
        this.mutationQueues.delete(artifactPath);
      }
    });
    return result;
  }

  private snapshotCoverage(slug: string, lines: string[]): CoverageMapSnapshot {
    const parsed = parseCoverageMap(lines);
    return {
      relativePath: `docs/grill/${slug}/coverage-map.md`,
      exists: true,
      sections: parsed.sections,
      counts: parsed.counts,
      currentlyGrilling: parsed.currentlyGrilling,
      error: null
    };
  }

  private async readCoverageMap(
    host: string,
    slug: string,
    index: FeatureArtifactIndex
  ): Promise<CoverageMapSnapshot> {
    const relativePath = `docs/grill/${slug}/coverage-map.md`;
    const indexed = index.grill.find((entry) => entry.slug === slug);
    if (!indexed || indexed.coverage.state === 'missing') {
      return {
        relativePath,
        exists: false,
        sections: [],
        counts: { todo: 0, in_progress: 0, resolved: 0, deferred: 0 },
        currentlyGrilling: null,
        error: null
      };
    }
    const filePath = joinPath(host, 'docs', 'grill', slug, 'coverage-map.md');
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = parseCoverageMap(raw.split('\n'));
      return {
        relativePath,
        exists: true,
        sections: parsed.sections,
        counts: parsed.counts,
        currentlyGrilling: parsed.currentlyGrilling,
        error: null
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return {
          relativePath,
          exists: false,
          sections: [],
          counts: { todo: 0, in_progress: 0, resolved: 0, deferred: 0 },
          currentlyGrilling: null,
          error: null
        };
      }
      return {
        relativePath,
        exists: true,
        sections: [],
        counts: { todo: 0, in_progress: 0, resolved: 0, deferred: 0 },
        currentlyGrilling: null,
        error: (err as Error).message
      };
    }
  }

  private listPlans(index: FeatureArtifactIndex, slug: string): FeaturePlanEntry[] {
    return index.plans
      .filter((entry) => entry.slugs.includes(slug))
      .map(({ relativePath, name }) => ({ relativePath, name }));
  }

  private async listIssues(
    host: string,
    slug: string,
    index: FeatureArtifactIndex
  ): Promise<FeatureIssueEntry[]> {
    const indexed = index.scratch.find((entry) => entry.slug === slug);
    if (!indexed) return [];
    const numbered: FeatureIssueEntry[] = [];
    const artifacts: FeatureIssueEntry[] = [];
    const parsedIssues = await mapConcurrent(indexed.issues, 8, async (entry) => ({
      entry,
      parsed: await readIssueHead(joinPath(host, ...entry.relativePath.split('/')))
    }));
    for (const { entry, parsed } of parsedIssues) {
      const relativePath = entry.relativePath;
      const issue = issueEntryFromFile(relativePath, parsed);
      if (issue.kind === 'issue') numbered.push(issue);
      else artifacts.push(issue);
    }
    numbered.sort(issueComparator);
    artifacts.sort((a, b) => a.name.localeCompare(b.name));

    if (indexed.playwright) {
      const playwright = await readIssueHead(
        joinPath(host, ...indexed.playwright.relativePath.split('/'))
      );
      artifacts.push({
        kind: 'artifact',
        relativePath: indexed.playwright.relativePath,
        name: 'playwright-e2e',
        displayName: PLAYWRIGHT_FILE,
        number: null,
        title: playwright.title ?? PLAYWRIGHT_FILE,
        status: null,
        isPlaywright: true
      });
    }
    return [...numbered, ...artifacts];
  }

  private async detectSetup(host: string): Promise<FeatureSetupStatus> {
    const candidates: Array<{ file: 'CLAUDE.md' | 'AGENTS.md' }> = [
      { file: 'CLAUDE.md' },
      { file: 'AGENTS.md' }
    ];
    for (const candidate of candidates) {
      const filePath = joinPath(host, candidate.file);
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        if (/^##\s+Agent skills\b/im.test(raw)) {
          return { hasAgentSkillsBlock: true, inFile: candidate.file };
        }
      } catch {
        // ignore missing files
      }
    }
    return { hasAgentSkillsBlock: false, inFile: null };
  }

  private async detectTracker(host: string): Promise<IssueTrackerConfig> {
    const filePath = joinPath(host, 'docs', 'agents', 'issue-tracker.md');
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const lowered = raw.toLowerCase();
      let provider: IssueTrackerProvider = 'unknown';
      if (/local\s+markdown/i.test(raw) || /\.scratch\//.test(raw)) {
        provider = 'local-markdown';
      } else if (lowered.includes('github')) {
        provider = 'github';
      }
      const lines = raw.split('\n');
      const startIdx = lines.findIndex((l) => l.trim().startsWith('# '));
      const after = startIdx >= 0 ? lines.slice(startIdx + 1) : lines;
      const excerpt = after
        .filter((l) => l.trim().length > 0)
        .slice(0, 6)
        .join('\n');
      return { provider, excerpt: excerpt || null };
    } catch {
      return { provider: 'unknown', excerpt: null };
    }
  }
}

interface ParsedCoverageMap {
  sections: CoverageBranchSection[];
  counts: Record<BranchStatus, number>;
  currentlyGrilling: { sectionId: string; entry: CoverageBranchEntry } | null;
}

const SECTION_RE = /^###\s+(\d+(?:\.\d+)*)\.\s+(.+?)\s*$/u;
const ENTRY_RE = /^[-*]\s+`?\[( |~|x|X|d|D)\]`?\s+([0-9]+[A-Za-z]+|[A-Za-z]+|\d+)?\.?\s*(.*)$/u;

export function parseCoverageMap(lines: string[]): ParsedCoverageMap {
  const sections: CoverageBranchSection[] = [];
  const counts: Record<BranchStatus, number> = {
    todo: 0,
    in_progress: 0,
    resolved: 0,
    deferred: 0
  };
  let current: CoverageBranchSection | null = null;
  let inBranchesArea = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (/^##\s+Branches\b/i.test(line)) {
      inBranchesArea = true;
      continue;
    }
    const sectionMatch = SECTION_RE.exec(line);
    if (sectionMatch) {
      if (!inBranchesArea) continue;
      current = {
        id: sectionMatch[1] ?? String(sections.length + 1),
        title: sectionMatch[2] ?? '',
        entries: []
      };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const entryMatch = ENTRY_RE.exec(line);
    if (!entryMatch) continue;
    const rawMarker = (entryMatch[1] ?? ' ').toLowerCase();
    const status: BranchStatus =
      rawMarker === 'x'
        ? 'resolved'
        : rawMarker === '~'
          ? 'in_progress'
          : rawMarker === 'd'
            ? 'deferred'
            : 'todo';
    const explicitId = (entryMatch[2] ?? '').trim();
    const labelRaw = (entryMatch[3] ?? '').trim();
    const label = stripMarkdownEmphasis(labelRaw);
    const entryId =
      explicitId.length > 0 ? explicitId : `${current.id}.${current.entries.length + 1}`;
    current.entries.push({
      id: entryId,
      label,
      status,
      lineIndex: i
    });
    counts[status] += 1;
  }
  let currentlyGrilling: ParsedCoverageMap['currentlyGrilling'] = null;
  for (const section of sections) {
    const ip = section.entries.find((e) => e.status === 'in_progress');
    if (ip) {
      currentlyGrilling = { sectionId: section.id, entry: ip };
      break;
    }
  }
  if (!currentlyGrilling) {
    for (const section of sections) {
      const todo = section.entries.find((e) => e.status === 'todo');
      if (todo) {
        currentlyGrilling = { sectionId: section.id, entry: todo };
        break;
      }
    }
  }
  return { sections, counts, currentlyGrilling };
}

function stripMarkdownEmphasis(input: string): string {
  return input
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function replaceMarkerOnLine(line: string, marker: string): string | null {
  const re = /(`?)\[( |~|x|X|d|D)\](`?)/u;
  if (!re.test(line)) return null;
  return line.replace(re, (_match, lTick, _ch, rTick) => `${lTick}${marker}${rTick}`);
}

async function readIssueHead(
  filePath: string
): Promise<{ title: string | null; status: string | null }> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseIssueHead(raw);
  } catch {
    return { title: null, status: null };
  }
}

export function parseIssueHead(raw: string): { title: string | null; status: string | null } {
  const lines = raw.split('\n').slice(0, 30);
  let title: string | null = null;
  let status: string | null = null;
  for (const line of lines) {
    if (!title) {
      const m = /^#\s+(.+?)\s*$/.exec(line);
      if (m) title = m[1] ?? null;
    }
    if (!status) {
      const m = /^Status:\s*(.+?)\s*$/i.exec(line);
      if (m) status = (m[1] ?? '').trim().toLowerCase();
    }
    if (title && status) break;
  }
  return { title, status };
}

function issueEntryFromFile(
  relativePath: string,
  parsed: { title: string | null; status: string | null }
): FeatureIssueEntry {
  const filename = relativePath.split('/').pop() ?? relativePath;
  const stem = filename.replace(/\.md$/i, '');
  const numMatch = /^(\d+)/.exec(stem);
  const isIssue = Boolean(numMatch);
  const displayName = isIssue ? stem : filename;
  return {
    kind: isIssue ? 'issue' : 'artifact',
    relativePath,
    name: stem,
    displayName,
    number: numMatch ? Number(numMatch[1]) : null,
    title: parsed.title ?? displayName,
    status: isIssue ? parsed.status : null,
    isPlaywright: false
  };
}

function issueComparator(a: FeatureIssueEntry, b: FeatureIssueEntry): number {
  const an = a.number;
  const bn = b.number;
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return a.name.localeCompare(b.name);
}

function assertFeatureSlug(slug: string): void {
  if (!slug || slug === '.' || slug === '..' || /[\\/\0]/u.test(slug)) {
    throw new Error('Feature slug must be one path segment');
  }
}

async function mapConcurrent<T, TResult>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<TResult>
): Promise<TResult[]> {
  const results = new Array<TResult>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await work(values[index] as T);
      }
    }
  );
  await Promise.all(workers);
  return results;
}
