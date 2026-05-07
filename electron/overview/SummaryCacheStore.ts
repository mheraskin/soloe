import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  OverviewProvider,
  OverviewSourcesSummary,
  OverviewWatermark
} from '@shared/types/overview.js';

interface StorageShape {
  version: number;
  entries: Record<string, CachedOverviewEntry>;
}

export interface CachedOverviewEntry {
  worktreeCwd: string;
  text: string;
  generatedAt: string;
  generatedBy: { provider: OverviewProvider; model: string };
  watermark: OverviewWatermark;
  sources: OverviewSourcesSummary;
}

const STORAGE_VERSION = 1;

export class SummaryCacheStore {
  private cache: Map<string, CachedOverviewEntry> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.cache) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.cache = await this.loadFromDisk();
  }

  async get(worktreeCwd: string): Promise<CachedOverviewEntry | null> {
    await this.init();
    return this.cache!.get(keyFor(worktreeCwd)) ?? null;
  }

  async set(entry: CachedOverviewEntry): Promise<void> {
    await this.init();
    this.cache!.set(keyFor(entry.worktreeCwd), entry);
    await this.persist();
  }

  async clear(worktreeCwd: string): Promise<void> {
    await this.init();
    this.cache!.delete(keyFor(worktreeCwd));
    await this.persist();
  }

  async list(): Promise<CachedOverviewEntry[]> {
    await this.init();
    return [...this.cache!.values()];
  }

  private async loadFromDisk(): Promise<Map<string, CachedOverviewEntry>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err: unknown) {
      if (isNotFound(err)) return new Map();
      throw err;
    }
    if (!raw.trim()) return new Map();
    let parsed: StorageShape;
    try {
      parsed = JSON.parse(raw) as StorageShape;
    } catch {
      return new Map();
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) return new Map();
    const map = new Map<string, CachedOverviewEntry>();
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
        map.set(key, entry);
      }
    }
    return map;
  }

  private persist(): Promise<void> {
    const next = this.writeQueue.then(() => this.writeNow());
    this.writeQueue = next.catch(() => undefined);
    return next;
  }

  private async writeNow(): Promise<void> {
    if (!this.cache) return;
    const shape: StorageShape = {
      version: STORAGE_VERSION,
      entries: Object.fromEntries(this.cache.entries())
    };
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(shape, null, 2), 'utf8');
    await fs.rename(tmp, this.filePath);
  }
}

export function keyFor(worktreeCwd: string): string {
  return path.resolve(worktreeCwd);
}

export function watermarksMatch(a: OverviewWatermark, b: OverviewWatermark): boolean {
  if (a.headSha !== b.headSha) return false;
  if (a.dirtyHash !== b.dirtyHash) return false;
  if (a.perSession.length !== b.perSession.length) return false;
  const sortedA = [...a.perSession].sort((x, y) => x.sessionFile.localeCompare(y.sessionFile));
  const sortedB = [...b.perSession].sort((x, y) => x.sessionFile.localeCompare(y.sessionFile));
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i]!.sessionFile !== sortedB[i]!.sessionFile) return false;
    if (sortedA[i]!.lastRecordKey !== sortedB[i]!.lastRecordKey) return false;
  }
  return true;
}

export function fingerprintWatermark(w: OverviewWatermark): string {
  const sorted = [...w.perSession].sort((x, y) => x.sessionFile.localeCompare(y.sessionFile));
  const fingerprint = JSON.stringify({
    head: w.headSha,
    dirty: w.dirtyHash,
    sessions: sorted
  });
  return createHash('sha1').update(fingerprint).digest('hex');
}

function isNotFound(err: unknown): boolean {
  return Boolean(err) && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
