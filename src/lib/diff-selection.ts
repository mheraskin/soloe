import type { FileDiff } from '@shared/types/git.js';
import type { ReviewScope } from '../stores/working-diff.svelte';
import {
  reviewEntryId,
  reviewEntrySection,
  type ReviewEntryLike,
  type ReviewEntrySection,
  type ReviewIdentityContext
} from './review-entry';

export type DiffSelectionSide = 'old' | 'new';

export interface ReviewSelectionTarget {
  scope: ReviewScope;
  filePath: string;
  section: ReviewEntrySection;
  diff: FileDiff;
}

export interface DiffSelectionAnchor {
  entryId: string;
  filePath: string;
  side: DiffSelectionSide;
  startLine: number;
  endLine: number;
  top: number;
  left: number;
}

export interface SelectionViewport {
  width: number;
  height: number;
}

export function resolveReviewSelectionTarget<T extends ReviewEntryLike>(
  scope: ReviewScope,
  entries: readonly T[],
  entryId: string,
  context: ReviewIdentityContext,
  diffForEntry: (entry: T) => FileDiff | null
): ReviewSelectionTarget | null {
  const entry = entries.find((candidate) => reviewEntryId(candidate, context) === entryId);
  if (!entry) return null;
  const diff = diffForEntry(entry);
  if (!diff) return null;
  return {
    scope,
    filePath: diff.path,
    section: reviewEntrySection(entry),
    diff
  };
}

/** Resolves one browser selection to one exact review entry. */
export function computeDiffSelectionAnchor(
  root: HTMLElement,
  selection: Selection | null,
  viewport: SelectionViewport
): DiffSelectionAnchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const startLineElement = climbToLineAnchor(range.startContainer);
  const endLineElement = climbToLineAnchor(range.endContainer);
  if (!startLineElement || !endLineElement) return null;
  if (!root.isConnected || !startLineElement.isConnected || !endLineElement.isConnected) return null;
  const reference = startLineElement;

  const section = reference.closest<HTMLElement>('[data-review-entry]');
  const endSection = endLineElement?.closest<HTMLElement>('[data-review-entry]') ?? section;
  if (!section || !root.contains(section) || endSection !== section) return null;
  const entryId = section.dataset.reviewEntry;
  const filePath = section.dataset.diffFilePath ?? section.dataset.filePath;
  if (!entryId || !filePath) return null;

  const side = reference.dataset.diffSide;
  if (side !== 'old' && side !== 'new') return null;
  if (endLineElement.dataset.diffSide !== side) return null;
  const referenceLine = Number(reference.dataset.diffLine);
  if (!Number.isFinite(referenceLine)) return null;

  let startLine = referenceLine;
  let endLine = referenceLine;
  if (endLineElement && endLineElement !== reference) {
    const endLineNumber = Number(endLineElement.dataset.diffLine);
    if (endLineElement.dataset.diffSide === side && Number.isFinite(endLineNumber)) {
      startLine = Math.min(referenceLine, endLineNumber);
      endLine = Math.max(referenceLine, endLineNumber);
    }
  }

  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  const buttonWidth = 132;
  const buttonHeight = 28;
  const margin = 8;
  let top = rect.bottom + 6;
  let left = rect.right - buttonWidth;
  if (top + buttonHeight + margin > viewport.height) top = rect.top - buttonHeight - 6;
  top = Math.max(margin, Math.min(top, viewport.height - buttonHeight - margin));
  if (left < margin) left = margin;
  if (left + buttonWidth + margin > viewport.width) {
    left = Math.max(margin, viewport.width - buttonWidth - margin);
  }

  return { entryId, filePath, side, startLine, endLine, top, left };
}

function climbToLineAnchor(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current && current.nodeType !== Node.ELEMENT_NODE) current = current.parentNode;
  let element = current as HTMLElement | null;
  while (element && !element.hasAttribute('data-diff-line')) element = element.parentElement;
  return element;
}
