import type { BlameLine, FileDiff } from '@shared/types/git.js';

export type ReviewPayloadKind = 'diff' | 'blame';

export interface ReviewPayloadLimits {
  diff: { maxBytes: number; maxEntries: number };
  blame: { maxBytes: number; maxEntries: number };
}

export interface ReviewPayloadRecord {
  kind: ReviewPayloadKind;
  key: string;
  cwd: string;
  pinKey: string;
  bytes: number;
}

export interface ReviewPayloadEviction {
  kind: ReviewPayloadKind;
  key: string;
}

export interface ReviewPayloadStats {
  diff: { bytes: number; entries: number };
  blame: { bytes: number; entries: number };
}

export const DEFAULT_REVIEW_PAYLOAD_LIMITS: ReviewPayloadLimits = {
  diff: { maxBytes: 32 * 1024 * 1024, maxEntries: 64 },
  blame: { maxBytes: 16 * 1024 * 1024, maxEntries: 32 }
};

interface InternalRecord extends ReviewPayloadRecord {
  touchedAt: number;
}

/**
 * Bounded lifetime policy for review payloads.
 *
 * The store owns reactive values; this Module owns the harder invariants:
 * byte/count budgets, LRU ordering, and residency pins. Its Interface returns
 * explicit evictions so the store can update all reactive maps atomically.
 */
export class ReviewPayloadCache {
  private records = new Map<string, InternalRecord>();
  private activeCwd: string | null = null;
  private residentPinKeys = new Set<string>();
  private clock = 0;

  constructor(private readonly limits: ReviewPayloadLimits = DEFAULT_REVIEW_PAYLOAD_LIMITS) {}

  remember(record: ReviewPayloadRecord): ReviewPayloadEviction[] {
    const id = recordId(record.kind, record.key);
    this.records.set(id, {
      ...record,
      bytes: Math.max(0, Math.trunc(record.bytes)),
      touchedAt: ++this.clock
    });
    return this.trim(record.kind);
  }

  touch(kind: ReviewPayloadKind, key: string): void {
    const record = this.records.get(recordId(kind, key));
    if (record) record.touchedAt = ++this.clock;
  }

  setResidents(cwd: string | null, pinKeys: Iterable<string>): ReviewPayloadEviction[] {
    this.activeCwd = cwd?.trim() || null;
    this.residentPinKeys = new Set(pinKeys);
    for (const record of this.records.values()) {
      if (this.isPinned(record)) record.touchedAt = ++this.clock;
    }
    return [...this.trim('diff'), ...this.trim('blame')];
  }

  forget(kind: ReviewPayloadKind, key: string): void {
    this.records.delete(recordId(kind, key));
  }

  forgetCwd(cwd: string, kind?: ReviewPayloadKind): void {
    const trimmed = cwd.trim();
    for (const [id, record] of this.records) {
      if (record.cwd === trimmed && (!kind || record.kind === kind)) this.records.delete(id);
    }
  }

  clear(kind?: ReviewPayloadKind): void {
    if (!kind) {
      this.records.clear();
      return;
    }
    for (const [id, record] of this.records) {
      if (record.kind === kind) this.records.delete(id);
    }
  }

  stats(): ReviewPayloadStats {
    const stats: ReviewPayloadStats = {
      diff: { bytes: 0, entries: 0 },
      blame: { bytes: 0, entries: 0 }
    };
    for (const record of this.records.values()) {
      stats[record.kind].bytes += record.bytes;
      stats[record.kind].entries += 1;
    }
    return stats;
  }

  private trim(kind: ReviewPayloadKind): ReviewPayloadEviction[] {
    const limit = this.limits[kind];
    const evictions: ReviewPayloadEviction[] = [];
    while (true) {
      const records = Array.from(this.records.values()).filter((record) => record.kind === kind);
      const bytes = records.reduce((total, record) => total + record.bytes, 0);
      if (records.length <= limit.maxEntries && bytes <= limit.maxBytes) break;
      let victim: InternalRecord | null = null;
      for (const record of records) {
        if (this.isPinned(record)) continue;
        if (!victim || record.touchedAt < victim.touchedAt) victim = record;
      }
      // A resident payload may individually exceed the budget. Keeping the
      // file currently on screen is more important than pretending the hard
      // limit was met; it becomes evictable as soon as residency moves.
      if (!victim) break;
      this.records.delete(recordId(victim.kind, victim.key));
      evictions.push({ kind: victim.kind, key: victim.key });
    }
    return evictions;
  }

  private isPinned(record: InternalRecord): boolean {
    return record.cwd === this.activeCwd && this.residentPinKeys.has(record.pinKey);
  }
}

export function estimateFileDiffBytes(diff: FileDiff): number {
  let bytes = 128 + 24 + diff.hunks.length * 8 + stringBytes(diff.path);
  if (diff.fromPath) bytes += stringBytes(diff.fromPath);
  for (const hunk of diff.hunks) {
    bytes += 96 + stringBytes(hunk.header) + 24 + hunk.lines.length * 8;
    for (const line of hunk.lines) bytes += 80 + stringBytes(line.text);
  }
  return bytes;
}

export function estimateBlameBytes(lines: ReadonlyArray<BlameLine | undefined>): number {
  let bytes = 24 + lines.length * 8;
  for (const line of lines) {
    if (!line) continue;
    bytes += 80 + stringBytes(line.sha) + stringBytes(line.summary);
  }
  return bytes;
}

function stringBytes(value: string): number {
  // Conservative V8 structural estimate: object/header plus UTF-16 storage.
  // Some strings use one-byte storage internally, but overpricing is safer
  // for a renderer memory budget and avoids allocating a serialized copy.
  return 24 + value.length * 2;
}

function recordId(kind: ReviewPayloadKind, key: string): string {
  return `${kind}\u001f${key}`;
}
