// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import type { FileDiff } from '@shared/types/git.js';
import type { ReviewScope } from '../stores/working-diff.svelte';
import { reviewEntryId } from './review-entry';
import { computeDiffSelectionAnchor, resolveReviewSelectionTarget } from './diff-selection';

describe('computeDiffSelectionAnchor', () => {
  it('resolves a selection to one exact review entry and line range', () => {
    const fixture = createFixture();
    const selection = selectionBetween(fixture.firstLine, fixture.secondLine, {
      top: 40,
      right: 220,
      bottom: 60,
      width: 180,
      height: 20
    });

    expect(computeDiffSelectionAnchor(fixture.root, selection, { width: 800, height: 600 }))
      .toEqual({
        entryId: 'unstaged:src/a.ts',
        filePath: 'src/a.ts',
        side: 'new',
        startLine: 7,
        endLine: 9,
        top: 66,
        left: 88
      });
  });

  it('rejects a selection spanning two review entries', () => {
    const fixture = createFixture();
    const otherSection = document.createElement('section');
    otherSection.dataset.reviewEntry = 'unstaged:src/b.ts';
    otherSection.dataset.diffFilePath = 'src/b.ts';
    const otherLine = line('new', 1, 'other');
    otherSection.append(otherLine);
    fixture.root.append(otherSection);

    const selection = selectionBetween(fixture.firstLine, otherLine, {
      top: 10,
      right: 100,
      bottom: 30,
      width: 90,
      height: 20
    }, fixture.root);

    expect(computeDiffSelectionAnchor(fixture.root, selection, { width: 800, height: 600 }))
      .toBeNull();
  });

  it('rejects a selection spanning old and new sides of one entry', () => {
    const fixture = createFixture();
    fixture.secondLine.dataset.diffSide = 'old';
    const selection = selectionBetween(fixture.firstLine, fixture.secondLine, {
      top: 10,
      right: 100,
      bottom: 30,
      width: 90,
      height: 20
    }, fixture.firstLine.parentElement!);

    expect(computeDiffSelectionAnchor(fixture.root, selection, { width: 800, height: 600 }))
      .toBeNull();
  });

  it('rejects selections outside the review surface', () => {
    const fixture = createFixture();
    const outside = line('new', 3, 'outside');
    document.body.append(outside);
    const selection = selectionBetween(outside, outside, {
      top: 10,
      right: 100,
      bottom: 30,
      width: 90,
      height: 20
    });

    expect(computeDiffSelectionAnchor(fixture.root, selection, { width: 800, height: 600 }))
      .toBeNull();
  });
});

describe('resolveReviewSelectionTarget', () => {
  it('distinguishes working-tree and committed copies of the same path', () => {
    const scope = { cwd: '/repo', runMode: 'wsl', wslDistro: 'Ubuntu' } as ReviewScope;
    const entries = [
      { path: 'src/a.ts', section: 'wt' as const },
      { path: 'src/a.ts', section: 'committed' as const }
    ];
    const context = { kind: 'range' as const, base: 'base', head: 'head' };
    const committedId = reviewEntryId(entries[1]!, context);
    const committedDiff = { path: 'src/a.ts' } as FileDiff;

    expect(resolveReviewSelectionTarget(
      scope,
      entries,
      committedId,
      context,
      (entry) => entry.section === 'committed' ? committedDiff : null
    )).toMatchObject({
      scope,
      filePath: 'src/a.ts',
      section: 'committed',
      diff: committedDiff
    });
  });

  it('does not create a target when the exact diff is unavailable', () => {
    const scope = { cwd: '/repo', runMode: 'windows' } as ReviewScope;
    const entries = [{ path: 'src/a.ts', section: 'wt' as const }];
    const context = { kind: 'working-tree' as const };

    expect(resolveReviewSelectionTarget(
      scope,
      entries,
      reviewEntryId(entries[0]!, context),
      context,
      () => null
    )).toBeNull();
  });
});

function createFixture() {
  const root = document.createElement('main');
  const section = document.createElement('section');
  section.dataset.reviewEntry = 'unstaged:src/a.ts';
  section.dataset.diffFilePath = 'src/a.ts';
  const firstLine = line('new', 7, 'first');
  const secondLine = line('new', 9, 'second');
  section.append(firstLine, secondLine);
  root.append(section);
  document.body.append(root);
  return { root, firstLine, secondLine };
}

function line(side: 'old' | 'new', lineNumber: number, text: string): HTMLElement {
  const element = document.createElement('span');
  element.dataset.diffSide = side;
  element.dataset.diffLine = String(lineNumber);
  element.textContent = text;
  return element;
}

function selectionBetween(
  start: HTMLElement,
  end: HTMLElement,
  rect: Pick<DOMRect, 'top' | 'right' | 'bottom' | 'width' | 'height'>,
  commonAncestorContainer: Node = start
): Selection {
  const range = {
    startContainer: start.firstChild ?? start,
    endContainer: end.firstChild ?? end,
    commonAncestorContainer,
    getBoundingClientRect: () => rect
  } as unknown as Range;
  return {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range
  } as unknown as Selection;
}
