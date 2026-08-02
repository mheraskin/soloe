import type { GitHistoryCommit } from '@shared/types/git.js';

export type GitHistoryFilter = 'all' | 'branches' | 'commits';

export interface GitGraphEdge {
  from: number;
  to: number;
}

export interface GitHistoryGraphRow {
  commit: GitHistoryCommit;
  nodeLane: number;
  laneCount: number;
  nextLaneCount: number;
  edges: GitGraphEdge[];
}

export function filterGitHistory(
  commits: GitHistoryCommit[],
  query: string,
  filter: GitHistoryFilter
): GitHistoryCommit[] {
  const needle = query.trim().toLocaleLowerCase();
  const candidates = commits.filter((commit) =>
    filter !== 'branches' || commit.refs.some((ref) => ref.kind === 'branch')
  );
  if (!needle) return candidates;
  return candidates
    .map((commit, index) => ({
      commit,
      index,
      score: historyMatchScore(commit, needle)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.commit);
}

export function scopeGitHistory(
  commits: GitHistoryCommit[],
  hashes: ReadonlySet<string> | null
): GitHistoryCommit[] {
  if (!hashes) return commits;
  return commits.filter((commit) => hashes.has(commit.hash));
}

export function buildGitHistoryGraph(commits: GitHistoryCommit[]): GitHistoryGraphRow[] {
  let lanes: string[] = [];
  const rows: GitHistoryGraphRow[] = [];

  for (const commit of commits) {
    let nodeLane = lanes.indexOf(commit.hash);
    if (nodeLane < 0) {
      nodeLane = 0;
      lanes = [commit.hash, ...lanes];
    }
    const before = [...lanes];
    const next = before.filter((hash, index) => index !== nodeLane && hash !== commit.hash);
    const firstParent = commit.parents[0];
    if (firstParent && !next.includes(firstParent)) next.splice(nodeLane, 0, firstParent);
    for (let index = 1; index < commit.parents.length; index += 1) {
      const parent = commit.parents[index]!;
      if (!next.includes(parent)) next.splice(Math.min(nodeLane + index, next.length), 0, parent);
    }

    const edges: GitGraphEdge[] = [];
    for (let index = 0; index < before.length; index += 1) {
      const hash = before[index]!;
      if (index === nodeLane) {
        for (const parent of commit.parents) {
          const target = next.indexOf(parent);
          if (target >= 0) edges.push({ from: index, to: target });
        }
      } else {
        const target = next.indexOf(hash);
        if (target >= 0) edges.push({ from: index, to: target });
      }
    }
    rows.push({
      commit,
      nodeLane,
      laneCount: before.length,
      nextLaneCount: next.length,
      edges
    });
    lanes = next;
  }
  return rows;
}

function historyMatchScore(commit: GitHistoryCommit, needle: string): number {
  let score = 0;
  for (const ref of commit.refs) {
    const name = ref.name.toLocaleLowerCase();
    if (name === needle) score = Math.max(score, 100);
    else if (name.startsWith(needle)) score = Math.max(score, 80);
    else if (name.includes(needle)) score = Math.max(score, 60);
  }
  const subject = commit.subject.toLocaleLowerCase();
  const author = commit.author.toLocaleLowerCase();
  const hash = commit.hash.toLocaleLowerCase();
  const shortHash = commit.shortHash.toLocaleLowerCase();
  if (subject === needle) score = Math.max(score, 50);
  else if (subject.startsWith(needle)) score = Math.max(score, 40);
  else if (subject.includes(needle)) score = Math.max(score, 30);
  if (author.includes(needle)) score = Math.max(score, 20);
  if (hash.startsWith(needle) || shortHash.startsWith(needle)) score = Math.max(score, 45);
  return score;
}
