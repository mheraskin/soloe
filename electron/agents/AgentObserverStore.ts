import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ObservedAgentSnapshot, ObserverEvent } from '@shared/types/agents.js';
import type { AgentObserverManager } from './AgentObserverManager.js';
import { USAGE_LIMIT_DETECTOR_VERSION } from './UsageLimitDetector.js';

interface ObserverStorageShape {
  version: number;
  snapshots: ObservedAgentSnapshot[];
  events: ObserverEvent[];
}

export interface ObserverPersistenceAdapter {
  read(): Promise<string | null>;
  writeAtomic(content: string): Promise<void>;
}

interface ParsedStorage {
  storage: ObserverStorageShape;
  changedDuringLoad: boolean;
}

const STORAGE_VERSION = 1;

/**
 * Owns the durable projection, latest-state coalescing, byte deduplication,
 * failure recovery, and final-flush ordering for Agent Observation.
 */
export class AgentObserverStore {
  private readonly persistence: ObserverPersistenceAdapter;
  private observer: AgentObserverManager | null = null;
  private detachCommit: (() => void) | null = null;
  private dirty = false;
  private dirtyVersion = 0;
  private failedVersion = -1;
  private scheduled = false;
  private drainPromise: Promise<void> | null = null;
  private lastWrittenPayload: string | null = null;
  private needsRewrite = false;

  constructor(filePath: string, persistence?: ObserverPersistenceAdapter) {
    this.persistence = persistence ?? nodeObserverPersistence(filePath);
  }

  async load(): Promise<ObserverStorageShape> {
    const raw = await this.persistence.read();
    if (raw === null) {
      const empty = emptyStorage();
      this.lastWrittenPayload = serializeStorage(empty);
      this.needsRewrite = false;
      return empty;
    }
    try {
      const parsed = parseStorage(JSON.parse(raw));
      this.lastWrittenPayload = parsed.changedDuringLoad
        ? null
        : serializeStorage(parsed.storage);
      this.needsRewrite = parsed.changedDuringLoad;
      return parsed.storage;
    } catch {
      const empty = emptyStorage();
      this.lastWrittenPayload = null;
      this.needsRewrite = true;
      return empty;
    }
  }

  attach(observer: AgentObserverManager): () => void {
    this.detachObserver();
    this.observer = observer;
    const markDirty = () => this.markDirty();
    observer.on('commit', markDirty);
    const detach = () => {
      observer.off('commit', markDirty);
      if (this.detachCommit === detach) this.detachCommit = null;
    };
    this.detachCommit = detach;
    if (this.needsRewrite) this.markDirty();
    return detach;
  }

  async dispose(): Promise<void> {
    this.detachObserver();
    try {
      try {
        await this.flush();
      } catch {
        // Final shutdown gets one bounded retry. A transient rename/locking
        // failure must not silently discard the latest durable projection,
        // while a persistent failure still surfaces without a hot loop.
        await this.flush();
      }
    } finally {
      this.observer = null;
    }
  }

  /** Compatibility entry point for explicit persistence outside attachment. */
  async persist(observer: AgentObserverManager): Promise<void> {
    this.observer = observer;
    this.markDirty();
    await this.flush();
  }

  /** Waits until the latest durable projection has replaced the prior one. */
  async flush(): Promise<void> {
    while (this.dirty || this.drainPromise) {
      await this.ensureDrain();
    }
  }

  private markDirty(): void {
    this.dirty = true;
    this.dirtyVersion += 1;
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.scheduled || this.drainPromise) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.ensureDrain().catch(() => {
        // Dirty state is retained. A later semantic commit or explicit flush
        // retries from a fresh Promise instead of chaining from the failure.
      });
    });
  }

  private ensureDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise;
    if (!this.dirty) return Promise.resolve();
    const run = this.drainDirty();
    let managed: Promise<void>;
    managed = run.then(
      () => {
        if (this.drainPromise === managed) this.drainPromise = null;
        if (this.dirty) this.scheduleDrain();
      },
      (error: unknown) => {
        if (this.drainPromise === managed) this.drainPromise = null;
        // Retry automatically only when a newer semantic commit arrived while
        // the failed write was running. Otherwise wait for the next commit or
        // an explicit flush, avoiding a hot failure loop.
        if (this.dirty && this.dirtyVersion > this.failedVersion) this.scheduleDrain();
        throw error;
      }
    );
    this.drainPromise = managed;
    return managed;
  }

  private async drainDirty(): Promise<void> {
    while (this.dirty) {
      const observer = this.observer;
      if (!observer) throw new Error('AgentObserverStore is not attached');
      this.dirty = false;
      const projectionVersion = this.dirtyVersion;
      const payload = serializeStorage(durableProjection(observer));
      if (payload === this.lastWrittenPayload) {
        this.needsRewrite = false;
        continue;
      }
      try {
        await this.persistence.writeAtomic(payload);
        this.lastWrittenPayload = payload;
        this.needsRewrite = false;
        this.failedVersion = -1;
      } catch (error) {
        this.dirty = true;
        this.failedVersion = projectionVersion;
        throw error;
      }
    }
  }

  private detachObserver(): void {
    this.detachCommit?.();
    this.detachCommit = null;
  }
}

function durableProjection(observer: AgentObserverManager): ObserverStorageShape {
  return {
    version: STORAGE_VERSION,
    snapshots: observer.listSnapshots().filter(shouldPersistSnapshot),
    events: observer.listEvents(undefined, 200).filter(shouldPersistEvent)
  };
}

function serializeStorage(storage: ObserverStorageShape): string {
  return JSON.stringify(storage, null, 2);
}

function nodeObserverPersistence(filePath: string): ObserverPersistenceAdapter {
  let directoryReady = false;
  return {
    async read() {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async writeAtomic(content) {
      if (!directoryReady) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        directoryReady = true;
      }
      try {
        await atomicWrite(filePath, content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') directoryReady = false;
        throw error;
      }
    }
  };
}

function parseStorage(raw: unknown): ParsedStorage {
  if (!isRecord(raw)) {
    return { storage: emptyStorage(), changedDuringLoad: true };
  }
  const rawSnapshots = Array.isArray(raw['snapshots']) ? raw['snapshots'] : [];
  const validSnapshots = rawSnapshots.filter(isSnapshot);
  const snapshots = validSnapshots.map(normalizeRestoredSnapshot);
  const rawEvents = Array.isArray(raw['events']) ? raw['events'] : [];
  const events = rawEvents.filter(isEvent);
  const normalizedSnapshots = snapshots.some(
    (snapshot, index) => snapshot !== validSnapshots[index]
  );
  const changedDuringLoad = raw['version'] !== STORAGE_VERSION
    || !Array.isArray(raw['snapshots'])
    || !Array.isArray(raw['events'])
    || validSnapshots.length !== rawSnapshots.length
    || events.length !== rawEvents.length
    || normalizedSnapshots;
  return {
    storage: { version: STORAGE_VERSION, snapshots, events },
    changedDuringLoad
  };
}

function emptyStorage(): ObserverStorageShape {
  return { version: STORAGE_VERSION, snapshots: [], events: [] };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  let renamed = false;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

function isSnapshot(value: unknown): value is ObservedAgentSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || typeof value['state'] !== 'string') return false;
  if (value['runtimeMode'] === 'sdk_worker' && value['subjectKind'] === 'worker') return true;
  return value['runtimeMode'] === 'tui'
    && value['subjectKind'] === 'session'
    && value['state'] === 'usage_limited'
    && hasCurrentUsageLimit(value);
}

function normalizeRestoredSnapshot(snapshot: ObservedAgentSnapshot): ObservedAgentSnapshot {
  if (snapshot.state === 'usage_limited') return snapshot;
  if (
    snapshot.state === 'starting'
    || snapshot.state === 'working'
    || snapshot.state === 'running_tool'
    || snapshot.state === 'waiting_for_input'
    || snapshot.state === 'waiting_for_approval'
  ) {
    return {
      ...snapshot,
      state: 'exited',
      resultSummary: snapshot.resultSummary ?? 'worker did not survive app restart'
    };
  }
  return snapshot;
}

function isEvent(value: unknown): value is ObserverEvent {
  return isRecord(value)
    && typeof value['id'] === 'string'
    && typeof value['subjectId'] === 'string'
    && (value['subjectKind'] === 'worker' || value['subjectKind'] === 'session')
    && typeof value['timestamp'] === 'string'
    && typeof value['summary'] === 'string';
}

function shouldPersistSnapshot(snapshot: ObservedAgentSnapshot): boolean {
  return snapshot.runtimeMode === 'sdk_worker'
    || (
      snapshot.runtimeMode === 'tui'
      && snapshot.state === 'usage_limited'
      && hasCurrentUsageLimit(snapshot)
    );
}

function shouldPersistEvent(event: ObserverEvent): boolean {
  return event.subjectKind === 'worker' || event.state === 'usage_limited';
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasCurrentUsageLimit(snapshot: unknown): boolean {
  if (!isRecord(snapshot)) return false;
  const usageLimit = snapshot['usageLimit'];
  if (!isRecord(usageLimit)) return false;
  return usageLimit['detectorVersion'] === USAGE_LIMIT_DETECTOR_VERSION
    && typeof usageLimit['message'] === 'string'
    && typeof usageLimit['detectedAt'] === 'string';
}
