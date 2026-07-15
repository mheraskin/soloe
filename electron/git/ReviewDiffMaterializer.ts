import type {
  DiffHunk,
  DiffLine,
  DiffLineKind,
  FileDiff,
  ReviewDiffTarget,
  WorkingChangeKind
} from '@shared/types/git.js';

interface ParsedDiff {
  fromPath: string | null;
  kind: WorkingChangeKind;
  binary: boolean;
  hunks: DiffHunk[];
}

/**
 * Splits one repository-level patch into the per-file shape consumed by the
 * review UI. A target that Git omitted is deliberately absent from the result
 * so the renderer can still fall back to its existing one-file request.
 */
export function materializeReviewDiffs(
  patch: string,
  targets: readonly ReviewDiffTarget[]
): FileDiff[] {
  const blocks = splitDiffBlocks(patch);
  const remaining = new Set(blocks.keys());
  const out: FileDiff[] = [];

  for (const target of targets) {
    const blockIndex = Array.from(remaining).find((index) =>
      blockMatchesTarget(blocks[index] ?? '', target.path)
    );
    if (blockIndex === undefined) continue;
    const parsed = parseUnifiedDiff(blocks[blockIndex] ?? '');
    if (!parsed) continue;
    remaining.delete(blockIndex);
    out.push({
      path: target.path,
      fromPath: target.fromPath ?? parsed.fromPath,
      kind: parsed.kind,
      binary: parsed.binary,
      hunks: parsed.hunks,
      empty: parsed.hunks.length === 0
    });
  }
  return out;
}

function splitDiffBlocks(patch: string): string[] {
  if (!patch.trim()) return [];
  const starts: number[] = [];
  const marker = /^diff --git /gm;
  for (let match = marker.exec(patch); match; match = marker.exec(patch)) {
    starts.push(match.index);
  }
  if (starts.length === 0) return [patch];
  return starts.map((start, index) => patch.slice(start, starts[index + 1] ?? patch.length));
}

function blockMatchesTarget(block: string, targetPath: string): boolean {
  const escaped = targetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|\\n)(?:\\+\\+\\+ b/|--- a/|rename to |copy to )${escaped}(?:\\r?$|\\n)`,
    'm'
  ).test(block)
    || block.includes(` b/${targetPath} differ`)
    || block.split(/\r?\n/, 1)[0]?.endsWith(` b/${targetPath}`) === true;
}

export function parseUnifiedDiff(text: string): ParsedDiff | null {
  if (!text) return null;
  const lines = text.split('\n');
  let fromPath: string | null = null;
  let kind: WorkingChangeKind = 'modified';
  let binary = false;
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;
  let sawHeader = false;

  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      sawHeader = true;
      continue;
    }
    if (!sawHeader && raw.startsWith('--- ')) sawHeader = true;
    if (raw.startsWith('new file mode')) kind = 'added';
    else if (raw.startsWith('deleted file mode')) kind = 'deleted';
    else if (raw.startsWith('rename from ')) {
      fromPath = raw.slice('rename from '.length);
      kind = 'renamed';
    } else if (raw.startsWith('copy from ')) {
      fromPath = raw.slice('copy from '.length);
      kind = 'copied';
    } else if (raw.startsWith('Binary files') || raw.includes('GIT binary patch')) {
      binary = true;
    }

    if (raw.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (!match) continue;
      const oldStart = Number(match[1] ?? 0);
      const oldCount = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3] ?? 0);
      const newCount = match[4] === undefined ? 1 : Number(match[4]);
      current = {
        header: (match[5] ?? '').trim(),
        oldStart,
        oldCount,
        newStart,
        newCount,
        lines: []
      };
      hunks.push(current);
      oldCursor = oldStart;
      newCursor = newStart;
      continue;
    }

    if (!current) continue;
    const head = raw[0];
    if (head === '+' && !raw.startsWith('+++')) {
      current.lines.push(makeLine('add', null, newCursor, raw.slice(1)));
      newCursor += 1;
    } else if (head === '-' && !raw.startsWith('---')) {
      current.lines.push(makeLine('remove', oldCursor, null, raw.slice(1)));
      oldCursor += 1;
    } else if (head === '\\') {
      current.lines.push(makeLine('meta', null, null, raw));
    } else if (head === ' ' || raw === '') {
      const context = head === ' ' ? raw.slice(1) : '';
      current.lines.push(makeLine('context', oldCursor, newCursor, context));
      oldCursor += 1;
      newCursor += 1;
    }
  }

  if (!sawHeader && hunks.length === 0 && !binary) return null;
  return { fromPath, kind, binary, hunks };
}

function makeLine(
  kind: DiffLineKind,
  oldLine: number | null,
  newLine: number | null,
  text: string
): DiffLine {
  return { kind, oldLine, newLine, text };
}
