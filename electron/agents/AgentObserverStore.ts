import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ObservedAgentSnapshot, ObserverEvent } from '@shared/types/agents.js';
import type { AgentObserverManager } from './AgentObserverManager.js';

interface ObserverStorageShape {
  version: number;
  snapshots: ObservedAgentSnapshot[];
  events: ObserverEvent[];
}

const STORAGE_VERSION = 1;

export class AgentObserverStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private detach: Array<() => void> = [];

  constructor(private readonly filePath: string) {}

  async load(): Promise<ObserverStorageShape> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyStorage();
      }
      throw err;
    }
    try {
      const parsed = JSON.parse(raw);
      return parseStorage(parsed);
    } catch {
      return emptyStorage();
    }
  }

  attach(observer: AgentObserverManager): void {
    const persist = () => {
      void this.persist(observer).catch(() => {});
    };
    observer.on('snapshot', persist);
    observer.on('event', persist);
    this.detach.push(
      () => observer.off('snapshot', persist),
      () => observer.off('event', persist)
    );
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach = [];
  }

  async persist(observer: AgentObserverManager): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const snapshot: ObserverStorageShape = {
      version: STORAGE_VERSION,
      snapshots: observer.listSnapshots().filter(shouldPersistSnapshot),
      events: observer.listEvents(undefined, 200).filter(shouldPersistEvent)
    };
    const payload = JSON.stringify(snapshot, null, 2);
    this.writeQueue = this.writeQueue.then(() => atomicWrite(this.filePath, payload));
    await this.writeQueue;
  }
}

function parseStorage(raw: unknown): ObserverStorageShape {
  if (!isRecord(raw)) return emptyStorage();
  const snapshots = Array.isArray(raw['snapshots'])
    ? raw['snapshots'].filter(isSnapshot).map(normalizeRestoredSnapshot)
    : [];
  const events = Array.isArray(raw['events']) ? raw['events'].filter(isEvent) : [];
  return { version: STORAGE_VERSION, snapshots, events };
}

function emptyStorage(): ObserverStorageShape {
  return { version: STORAGE_VERSION, snapshots: [], events: [] };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

function isSnapshot(value: unknown): value is ObservedAgentSnapshot {
  if (!isRecord(value)) return false;
  if (typeof value['id'] !== 'string' || typeof value['state'] !== 'string') return false;
  if (value['runtimeMode'] === 'sdk_worker' && value['subjectKind'] === 'worker') return true;
  return value['runtimeMode'] === 'tui'
    && value['subjectKind'] === 'session'
    && value['state'] === 'usage_limited';
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
    || (snapshot.runtimeMode === 'tui' && snapshot.state === 'usage_limited');
}

function shouldPersistEvent(event: ObserverEvent): boolean {
  return event.subjectKind === 'worker' || event.state === 'usage_limited';
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null;
}
