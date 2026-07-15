import type { RunMode } from './sessions.js';

export type BranchStatus = 'todo' | 'in_progress' | 'resolved' | 'deferred';

export interface CoverageBranchEntry {
  // Stable identifier composed from the section + bullet prefix, e.g. "1A" or "3F".
  // Used by the renderer to key list items and by the status-toggle handler to
  // locate the exact line back in the markdown file when writing the new marker.
  id: string;
  // The branch label after the prefix, with markdown punctuation stripped, e.g.
  // "Resolved: DrawerSession is device-scoped..." trimmed to a single-line summary.
  label: string;
  status: BranchStatus;
  // 0-based line index in the original coverage-map.md so the writer can
  // rewrite just that line without re-serializing the whole document.
  lineIndex: number;
}

export interface CoverageBranchSection {
  // Section header text after "### N. ", e.g. "Domain core".
  title: string;
  // Stable id taken from the leading section number, e.g. "1".
  id: string;
  entries: CoverageBranchEntry[];
}

export interface CoverageMapSnapshot {
  // Path relative to the worktree cwd, e.g. "docs/grill/cash-drawer/coverage-map.md".
  relativePath: string;
  exists: boolean;
  sections: CoverageBranchSection[];
  counts: Record<BranchStatus, number>;
  // The first in_progress entry, falling back to the first todo entry. Used to
  // surface a "currently grilling" line at the top of the coverage panel.
  currentlyGrilling: { sectionId: string; entry: CoverageBranchEntry } | null;
  error: string | null;
}

export interface FeaturePlanEntry {
  // Path relative to the worktree cwd, e.g. "docs/plans/cash-drawer-feature.md".
  relativePath: string;
  // Basename without `.md`, used as the row label.
  name: string;
}

export interface FeatureIssueEntry {
  kind: 'issue' | 'artifact';
  relativePath: string;
  // Filename without the `.md` extension, e.g. "01-backend-permissions-and-role-seeds".
  name: string;
  // UI label for non-issue artifacts where the raw filename is the meaningful
  // thing to show, e.g. "playwright.md".
  displayName: string;
  // Numeric prefix parsed from the filename if present, used for ordering.
  number: number | null;
  // First line of the file (typically "# Title") with the leading `#` stripped.
  title: string;
  // The value of the `Status:` line near the top, lowercased. `null` when no
  // status line is present so the UI can render an "unset" pill.
  status: string | null;
  // True when this is the dedicated playwright-e2e.md file; surfaced as the
  // last row in the issues list since it represents the end-to-end test task.
  isPlaywright: boolean;
}

export type IssueTrackerProvider = 'local-markdown' | 'github' | 'unknown';

export interface IssueTrackerConfig {
  provider: IssueTrackerProvider;
  // Free-form excerpt from docs/agents/issue-tracker.md so the UI can surface
  // what the user's chosen provider expects without re-reading the file itself.
  // Renderer truncates as needed.
  excerpt: string | null;
}

export interface FeatureSetupStatus {
  // True when the worktree's CLAUDE.md or AGENTS.md contains a `## Agent skills`
  // section. When false, the rail surfaces a setup CTA to run
  // `/setup-matt-pocock-skills`.
  hasAgentSkillsBlock: boolean;
  // Which file we found the block in (if any) — informational; not displayed.
  inFile: 'CLAUDE.md' | 'AGENTS.md' | null;
}

export interface FeatureSlug {
  slug: string;
  // True when a coverage map exists at docs/grill/<slug>/coverage-map.md.
  hasCoverage: boolean;
  // True when at least one `.scratch/<slug>/issues/*.md` file or
  // `.scratch/<slug>/playwright-e2e.md` exists.
  hasIssues: boolean;
  // True when at least one plan in docs/plans/ starts with the slug.
  hasPlans: boolean;
}

export interface FeatureSnapshot {
  // Worktree cwd this snapshot belongs to. The renderer keys per-cwd caches by
  // this so concurrent worktrees don't clobber each other's data.
  cwd: string;
  // Sorted feature slugs discovered across docs/grill/, docs/plans/, and .scratch/.
  features: FeatureSlug[];
  // The slug the snapshot was scanned for, or null when none was selected.
  selectedSlug: string | null;
  coverage: CoverageMapSnapshot | null;
  plans: FeaturePlanEntry[];
  issues: FeatureIssueEntry[];
  tracker: IssueTrackerConfig;
  setup: FeatureSetupStatus;
  // Exact Feature Artifact Index revision used to materialize this snapshot.
  artifactRevision: string;
  // The wall-clock time the main process completed the scan. Renderer uses
  // this for "last refreshed N seconds ago" UI affordances.
  scannedAt: number;
}

export interface FeatureScanRequest {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  // Limits scanning to a specific feature slug. When omitted, the snapshot
  // includes the slug list but `coverage`, `plans`, and `issues` are empty.
  slug?: string;
  // A watcher-triggered refresh can reuse this exact main-owned Index instead
  // of repeating the metadata traversal that detected the change.
  observedRevision?: string;
}

export interface FeatureSetBranchStatusRequest {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  slug: string;
  // The branch id, e.g. "1A". Matched against the entry id parsed from the file.
  branchId: string;
  status: BranchStatus;
}

export interface FeatureSetIssueStatusRequest {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  relativePath: string;
  status: string;
}

export interface FeatureChangeEvent {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  // Coarse change category so the renderer can decide whether to refetch
  // everything or just the affected slice. The current implementation always
  // emits a full scan, so the renderer treats every event as a snapshot refresh.
  kind: 'features' | 'coverage' | 'plans' | 'issues' | 'setup' | 'tracker';
  // Exact Feature Artifact Index revision already resident in the main process.
  revision: string;
}
