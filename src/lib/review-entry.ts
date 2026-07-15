export type ReviewEntrySection = 'wt' | 'committed';
declare const reviewEntryBrand: unique symbol;
export type ReviewEntryId = string & { readonly [reviewEntryBrand]: true };

export interface ReviewEntryLike {
  path: string;
  section?: ReviewEntrySection;
}

export type ReviewIdentityContext =
  | { kind: 'working-tree' }
  | { kind: 'range'; base: string; head: string };

const SEPARATOR = '\0';

/** Immutable identity for one logical row in a mixed WT/range review. */
export function reviewEntryId(
  entry: ReviewEntryLike,
  context: ReviewIdentityContext = { kind: 'working-tree' }
): ReviewEntryId {
  if (reviewEntrySection(entry) === 'committed' && context.kind === 'range') {
    return ['range', context.base, context.head, entry.path].join(SEPARATOR) as ReviewEntryId;
  }
  return `wt${SEPARATOR}${entry.path}` as ReviewEntryId;
}

export function reviewEntryIdFrom(
  path: string,
  section: ReviewEntrySection = 'wt',
  context: ReviewIdentityContext = { kind: 'working-tree' }
): ReviewEntryId {
  return reviewEntryId({ path, section }, context);
}

export function reviewEntrySection(entry: ReviewEntryLike): ReviewEntrySection {
  return entry.section === 'committed' ? 'committed' : 'wt';
}

export function reviewEntrySectionFromId(id: ReviewEntryId): ReviewEntrySection {
  return id.startsWith(`range${SEPARATOR}`) ? 'committed' : 'wt';
}

export function reviewEntryPath(id: ReviewEntryId): string {
  const separator = id.lastIndexOf(SEPARATOR);
  return separator >= 0 ? id.slice(separator + 1) : id;
}

export function findReviewEntry<T extends ReviewEntryLike>(
  changes: readonly T[],
  id: ReviewEntryId,
  context: ReviewIdentityContext = { kind: 'working-tree' }
): T | undefined {
  return changes.find((change) => reviewEntryId(change, context) === id);
}

export function isReviewEntryId(value: string): value is ReviewEntryId {
  return value.startsWith(`wt${SEPARATOR}`) || value.startsWith(`range${SEPARATOR}`);
}
