import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RunMode } from '@shared/types/sessions.js';
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
  FeatureSlug,
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

// Cross-WSL path translation. Mirrors the helper in files.ipc.ts; duplicated
// here rather than re-exported because pulling files.ipc.ts as a dependency
// would create a circular bind through ipc/result.ts.
function hostPathFor(cwd: string, runMode: RunMode, wslDistro?: string): string {
  if (runMode === 'wsl' && process.platform === 'win32') {
    if (!wslDistro) throw new Error('WSL distro required to access worktree from Windows host');
    const parts = cwd.split('/').filter(Boolean);
    return ['\\\\wsl.localhost', wslDistro, ...parts].join('\\');
  }
  return cwd;
}

function joinPath(host: string, ...segments: string[]): string {
  if (host.startsWith('\\\\')) {
    return [host.replace(/\\$/u, ''), ...segments].join('\\');
  }
  return path.join(host, ...segments);
}

export class FeatureService {
  private selfWriteAt = new Map<string, number>();

  async scan(request: FeatureScanRequest): Promise<FeatureSnapshot> {
    if (!request.cwd?.trim()) throw new Error('cwd is required');
    const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);

    const [features, setup, tracker] = await Promise.all([
      this.discoverFeatures(host),
      this.detectSetup(host),
      this.detectTracker(host)
    ]);

    const slug = request.slug?.trim() || null;

    let coverage: CoverageMapSnapshot | null = null;
    let plans: FeaturePlanEntry[] = [];
    let issues: FeatureIssueEntry[] = [];
    if (slug) {
      [coverage, plans, issues] = await Promise.all([
        this.readCoverageMap(host, slug),
        this.listPlans(host, slug),
        this.listIssues(host, slug)
      ]);
    }

    return {
      cwd: request.cwd,
      features,
      selectedSlug: slug,
      coverage,
      plans,
      issues,
      tracker,
      setup,
      scannedAt: Date.now()
    };
  }

  async writeBranchStatus(request: FeatureSetBranchStatusRequest): Promise<CoverageMapSnapshot> {
    if (!request.cwd?.trim()) throw new Error('cwd is required');
    if (!request.slug?.trim()) throw new Error('slug is required');
    if (!request.branchId?.trim()) throw new Error('branchId is required');
    const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
    const filePath = joinPath(host, 'docs', 'grill', request.slug, 'coverage-map.md');
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
    if (next === original) {
      return this.snapshotCoverage(request.slug, lines);
    }
    this.selfWriteAt.set(filePath, Date.now());
    await fs.writeFile(filePath, next, 'utf8');
    return this.snapshotCoverage(request.slug, lines);
  }

  async writeIssueStatus(request: FeatureSetIssueStatusRequest): Promise<FeatureIssueEntry> {
    if (!request.cwd?.trim()) throw new Error('cwd is required');
    if (!request.relativePath?.trim()) throw new Error('relativePath is required');
    const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
    const normalized = request.relativePath.replace(/\\/g, '/');
    if (path.isAbsolute(normalized) || normalized.includes('..')) {
      throw new Error('Issue path must be relative to the worktree');
    }
    const filePath = joinPath(host, ...normalized.split('/'));
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
    return issueEntryFromFile(normalized, await readIssueHead(filePath));
  }

  isSelfWrite(absolutePath: string, mtimeMs: number, graceMs = 1500): boolean {
    const at = this.selfWriteAt.get(absolutePath);
    if (at === undefined) return false;
    return mtimeMs <= at + graceMs;
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

  private async readCoverageMap(host: string, slug: string): Promise<CoverageMapSnapshot> {
    const relativePath = `docs/grill/${slug}/coverage-map.md`;
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

  private async listPlans(host: string, slug: string): Promise<FeaturePlanEntry[]> {
    const dir = joinPath(host, 'docs', 'plans');
    const entries = await safeReaddir(dir);
    const out: FeaturePlanEntry[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (entry.name.startsWith('grill-') && entry.name.includes('-migration.md')) continue;
      const stem = entry.name.replace(/\.md$/i, '');
      if (!planMatchesSlug(stem, slug)) continue;
      out.push({
        relativePath: `docs/plans/${entry.name}`,
        name: stem
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private async listIssues(host: string, slug: string): Promise<FeatureIssueEntry[]> {
    const scratchDir = joinPath(host, '.scratch', slug);
    const issuesDir = joinPath(scratchDir, 'issues');
    const issueEntries = await safeReaddir(issuesDir);
    const numbered: FeatureIssueEntry[] = [];
    const artifacts: FeatureIssueEntry[] = [];
    for (const entry of issueEntries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const filePath = joinPath(issuesDir, entry.name);
      const parsed = await readIssueHead(filePath);
      const relativePath = `.scratch/${slug}/issues/${entry.name}`;
      const issue = issueEntryFromFile(relativePath, parsed);
      if (issue.kind === 'issue') numbered.push(issue);
      else artifacts.push(issue);
    }
    numbered.sort(issueComparator);
    artifacts.sort((a, b) => a.name.localeCompare(b.name));

    const playwrightPath = joinPath(scratchDir, PLAYWRIGHT_FILE);
    const playwright = await readIssueHeadIfExists(playwrightPath);
    if (playwright) {
      artifacts.push({
        kind: 'artifact',
        relativePath: `.scratch/${slug}/${PLAYWRIGHT_FILE}`,
        name: 'playwright-e2e',
        displayName: 'playwright.md',
        number: null,
        title: 'playwright.md',
        status: null,
        isPlaywright: true
      });
    }
    return [...numbered, ...artifacts];
  }

  private async discoverFeatures(host: string): Promise<FeatureSlug[]> {
    const map = new Map<string, FeatureSlug>();
    const ensure = (slug: string): FeatureSlug => {
      let entry = map.get(slug);
      if (!entry) {
        entry = { slug, hasCoverage: false, hasIssues: false, hasPlans: false };
        map.set(slug, entry);
      }
      return entry;
    };

    const grillEntries = await safeReaddir(joinPath(host, 'docs', 'grill'));
    for (const entry of grillEntries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      try {
        const stat = await fs.stat(joinPath(host, 'docs', 'grill', slug, 'coverage-map.md'));
        if (stat.isFile()) ensure(slug).hasCoverage = true;
      } catch {
        ensure(slug);
      }
    }

    const scratchEntries = await safeReaddir(joinPath(host, '.scratch'));
    for (const entry of scratchEntries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const issuesEntries = await safeReaddir(joinPath(host, '.scratch', slug, 'issues'));
      const hasIssueFile = issuesEntries.some(
        (e) => e.isFile() && e.name.toLowerCase().endsWith('.md')
      );
      let hasPlaywright = false;
      try {
        const stat = await fs.stat(joinPath(host, '.scratch', slug, PLAYWRIGHT_FILE));
        hasPlaywright = stat.isFile();
      } catch {
        hasPlaywright = false;
      }
      if (hasIssueFile || hasPlaywright) ensure(slug).hasIssues = true;
    }

    const plansEntries = await safeReaddir(joinPath(host, 'docs', 'plans'));
    for (const entry of plansEntries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      if (entry.name.startsWith('grill-') && entry.name.includes('-migration.md')) continue;
      const stem = entry.name.replace(/\.md$/i, '');
      let matched = false;
      for (const slug of map.keys()) {
        if (planMatchesSlug(stem, slug)) {
          ensure(slug).hasPlans = true;
          matched = true;
        }
      }
      if (!matched) {
        const candidate = guessSlugFromPlan(stem);
        if (candidate) ensure(candidate).hasPlans = true;
      }
    }

    return [...map.values()].sort((a, b) => a.slug.localeCompare(b.slug));
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

async function readIssueHeadIfExists(
  filePath: string
): Promise<{ title: string | null; status: string | null } | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return parseIssueHead(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
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

function planMatchesSlug(planStem: string, slug: string): boolean {
  if (planStem === slug) return true;
  if (planStem.startsWith(`${slug}-`)) return true;
  if (planStem.startsWith(`${slug}_`)) return true;
  return false;
}

function guessSlugFromPlan(stem: string): string | null {
  if (!stem.includes('-')) return null;
  const stripped = stem.replace(/-(feature|ux|spec|design|plan|notes)$/i, '');
  if (stripped.includes(' ')) return null;
  return stripped;
}

function issueComparator(a: FeatureIssueEntry, b: FeatureIssueEntry): number {
  const an = a.number;
  const bn = b.number;
  if (an !== null && bn !== null) return an - bn;
  if (an !== null) return -1;
  if (bn !== null) return 1;
  return a.name.localeCompare(b.name);
}

async function safeReaddir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
