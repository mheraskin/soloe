import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { RunMode } from '@shared/types/sessions.js';
import { worktreeIdentityKey } from '@shared/worktree-identity.js';
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
  runMode: RunMode;
  wslDistro?: string;
  text: string;
  generatedAt: string;
  generatedBy: { provider: OverviewProvider; model: string };
  watermark: OverviewWatermark;
  sources: OverviewSourcesSummary;
}

const STORAGE_VERSION = 2;

export class SummaryCacheStore {
  private cache: Map<string, CachedOverviewEntry> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    if (this.cache) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    this.cache = await this.loadFromDisk();
  }

  async get(
    worktreeCwd: string,
    context: { runMode?: RunMode; wslDistro?: string } = {}
  ): Promise<CachedOverviewEntry | null> {
    await this.init();
    return this.cache!.get(keyFor(worktreeCwd, context)) ?? null;
  }

  async set(entry: CachedOverviewEntry): Promise<void> {
    await this.init();
    this.cache!.set(keyFor(entry.worktreeCwd, entry), entry);
    await this.persist();
  }

  async clear(
    worktreeCwd: string,
    context: { runMode?: RunMode; wslDistro?: string } = {}
  ): Promise<void> {
    await this.init();
    this.cache!.delete(keyFor(worktreeCwd, context));
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
    // Version 1 used path-only keys. A legacy WSL entry cannot be assigned to
    // a distro safely, so invalidate it instead of guessing and leaking text.
    if (
      !parsed
      || typeof parsed !== 'object'
      || parsed.version !== STORAGE_VERSION
      || !parsed.entries
    ) return new Map();
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

export function keyFor(
  worktreeCwd: string,
  context: { runMode?: RunMode; wslDistro?: string } = {}
): string {
  return worktreeIdentityKey(worktreeCwd, context);
}

export function watermarksMatch(a: OverviewWatermark, b: OverviewWatermark): boolean {
  if (!a.scopeKey || a.scopeKey !== b.scopeKey) return false;
  if (!a.evidenceFingerprint || a.evidenceFingerprint !== b.evidenceFingerprint) return false;
  if (a.headSha !== b.headSha) return false;
  if (a.dirtyHash !== b.dirtyHash) return false;
  if (a.perSession.length !== b.perSession.length) return false;
  for (let i = 0; i < a.perSession.length; i++) {
    const x = a.perSession[i]!;
    const y = b.perSession[i]!;
    if (x.sessionFile !== y.sessionFile) return false;
    if (x.displayName !== y.displayName) return false;
    if (x.mtimeMs !== y.mtimeMs) return false;
    if (x.size !== y.size) return false;
    if (x.lastRecordKey !== y.lastRecordKey) return false;
  }
  return true;
}

export function fingerprintWatermark(w: OverviewWatermark): string {
  const fingerprint = JSON.stringify({
    scope: w.scopeKey,
    evidence: w.evidenceFingerprint,
    head: w.headSha,
    dirty: w.dirtyHash,
    sessions: w.perSession
  });
  return createHash('sha1').update(fingerprint).digest('hex');
}

function isNotFound(err: unknown): boolean {
  return Boolean(err) && (err as NodeJS.ErrnoException).code === 'ENOENT';
}
