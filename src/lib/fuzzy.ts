/**
 * Lightweight subsequence-fuzzy scorer used by sidebar search, command palette,
 * and file palette. Returns null if the query is not a subsequence of the
 * candidate (case-insensitive). Higher score = better match.
 *
 * Heuristics: prefix match, camel/word-boundary boost, contiguous-run boost,
 * shorter candidate slight boost.
 */
export function score(query: string, candidate: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  let qi = 0;
  let total = 0;
  let lastIdx = -1;
  let run = 0;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] !== q[qi]) {
      run = 0;
      continue;
    }
    let s = 1;
    if (i === 0) s += 5; // prefix
    if (i === lastIdx + 1) {
      run += 1;
      s += run * 2; // contiguous boost
    } else {
      run = 1;
    }
    const prev = i > 0 ? candidate[i - 1] : '';
    const ch = candidate[i];
    if (prev) {
      const isWordBoundary = /[\s\-_./\\]/.test(prev);
      const isCamelBoundary = ch && prev && prev === prev.toLowerCase() && ch === ch.toUpperCase() && ch !== ch.toLowerCase();
      if (isWordBoundary || isCamelBoundary) s += 3;
    }
    total += s;
    lastIdx = i;
    qi += 1;
  }

  if (qi < q.length) return null;
  // slight bias toward shorter candidates
  total += Math.max(0, 10 - candidate.length / 8);
  return total;
}

export interface ScoredItem<T> {
  item: T;
  score: number;
}

export function rank<T>(query: string, items: T[], key: (it: T) => string): ScoredItem<T>[] {
  const out: ScoredItem<T>[] = [];
  for (const item of items) {
    const s = score(query, key(item));
    if (s !== null) out.push({ item, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

export function rankMulti<T>(query: string, items: T[], keys: (it: T) => string[]): ScoredItem<T>[] {
  const out: ScoredItem<T>[] = [];
  for (const item of items) {
    let best: number | null = null;
    for (const k of keys(item)) {
      const s = score(query, k);
      if (s !== null && (best === null || s > best)) best = s;
    }
    if (best !== null) out.push({ item, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
