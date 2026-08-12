import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type {
  CockpitPublishedEvent
} from './CockpitCoordinator.js';
import { CockpitCoordinator } from './CockpitCoordinator.js';
import type {
  CockpitTerminalReplay,
  DeviceReadSnapshot
} from '@shared/types/cockpit.js';
import type {
  DeviceDescriptor,
  DeviceEventEnvelope,
  DeviceId
} from '@shared/types/devices.js';
import type { Session } from '@shared/types/sessions.js';
import type { TerminalInputLease } from '@shared/types/terminal.js';
import type { DevicePort, DevicePortStatus } from './DevicePort.js';
import { CockpitPreferenceStore } from './CockpitPreferenceStore.js';
import { CockpitCatalogStore } from './CockpitCatalogStore.js';
import { CockpitOperationStore } from './CockpitOperationStore.js';

const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';

describe('CockpitCoordinator', () => {
  it('projects catalog Workspaces and regroups without touching the Device Session', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-cockpit-catalog-'));
    try {
      const catalog = new CockpitCatalogStore(path.join(directory, 'catalog.json'));
      await catalog.init();
      const projectId = '33333333-3333-4333-8333-333333333333';
      const workspaceId = '44444444-4444-4444-8444-444444444444';
      await catalog.execute({
        expectedRevision: 0,
        mutations: [
          {
            type: 'project.create',
            project: { id: projectId, name: 'Compiler', canonicalRepository: null }
          },
          {
            type: 'workspace.create',
            workspace: {
              id: workspaceId,
              projectId,
              name: 'main',
              source: { kind: 'branch', localRef: 'refs/heads/main' }
            }
          }
        ]
      });
      const device = fakeDevice(DEVICE_A, 'Build A');
      const cockpit = new CockpitCoordinator({ devices: [device], catalog });
      await cockpit.refreshAll();

      const changed = await cockpit.transactCatalog({
        expectedRevision: 1,
        mutations: [{
          type: 'session.regroup',
          sessionRef: { deviceId: DEVICE_A, sessionId: 'same-session' },
          workspaceId,
          order: 0
        }]
      });

      expect(changed.navigation?.projects[0]?.workspaces[0]?.sessions[0]).toMatchObject({
        projection: { ref: { deviceId: DEVICE_A, sessionId: 'same-session' } }
      });
      expect(device.actions).toEqual([]);
      expect((await device.snapshot()).sessions[0]?.source).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('projects colliding Device-local Session and Terminal IDs without collision', async () => {
    const left = fakeDevice(DEVICE_A, 'Build A');
    const right = fakeDevice(DEVICE_B, 'Build B');
    const cockpit = new CockpitCoordinator({
      devices: [left, right],
      now: () => new Date('2026-08-12T12:00:00.000Z')
    });

    const snapshot = await cockpit.refreshAll();

    expect(snapshot.devices).toEqual([
      expect.objectContaining({ deviceId: DEVICE_A, name: 'Build A', state: 'ready' }),
      expect.objectContaining({ deviceId: DEVICE_B, name: 'Build B', state: 'ready' })
    ]);
    expect(snapshot.sessions).toHaveLength(2);
    expect(new Set(snapshot.sessions.map((session) => session.key)).size).toBe(2);
    expect(snapshot.sessions.map((session) => session.ref)).toEqual([
      { deviceId: DEVICE_A, sessionId: 'same-session' },
      { deviceId: DEVICE_B, sessionId: 'same-session' }
    ]);
    expect(snapshot.sessions.map((session) => session.runtime?.terminalRef)).toEqual([
      { deviceId: DEVICE_A, terminalId: 'same-terminal' },
      { deviceId: DEVICE_B, terminalId: 'same-terminal' }
    ]);
  });

  it('routes terminal control to the explicit owning Device only', async () => {
    const left = fakeDevice(DEVICE_A, 'Build A');
    const right = fakeDevice(DEVICE_B, 'Build B');
    const cockpit = new CockpitCoordinator({ devices: [left, right] });
    await cockpit.refreshAll();
    const rightTerminal = { deviceId: DEVICE_B, terminalId: 'same-terminal' };

    await cockpit.terminalInput(rightTerminal, 'do not duplicate');
    await cockpit.terminalResize(rightTerminal, 120, 40);
    await cockpit.terminalReplay(rightTerminal, 7);
    await cockpit.terminalStop(rightTerminal);

    expect(left.actions).toEqual([]);
    expect(right.actions).toEqual([
      ['input', 'same-terminal', 'do not duplicate'],
      ['resize', 'same-terminal', 120, 40],
      ['replay', 'same-terminal', 7],
      ['stop', 'same-terminal']
    ]);
  });

  it('routes explicit input takeover and publishes Device lease visibility', async () => {
    const left = fakeDevice(DEVICE_A, 'Build A');
    const right = fakeDevice(DEVICE_B, 'Build B');
    const cockpit = new CockpitCoordinator({ devices: [left, right] });
    const published: CockpitPublishedEvent[] = [];
    cockpit.onEvent((event) => published.push(event));
    await cockpit.refreshAll();
    const terminalRef = { deviceId: DEVICE_B, terminalId: 'same-terminal' };

    await expect(cockpit.takeTerminalInputControl(terminalRef)).resolves.toMatchObject({
      terminalId: 'same-terminal',
      ownerId: 'fake-client'
    });
    right.emit('inputLease', {
      type: 'taken-over',
      terminalId: 'same-terminal',
      previousOwnerId: 'other-client',
      lease: {
        terminalId: 'same-terminal',
        leaseId: 'lease-fake',
        ownerId: 'fake-client',
        acquiredAt: '2026-08-12T12:00:00.000Z',
        expiresAt: '2026-08-12T12:00:15.000Z'
      },
      observedAt: '2026-08-12T12:00:00.000Z'
    });

    expect(left.actions).toEqual([]);
    expect(right.actions).toContainEqual(['input-lease', 'same-terminal', true]);
    expect(published.at(-1)?.event).toMatchObject({
      type: 'terminal.input-lease',
      terminalRef,
      event: { type: 'taken-over', previousOwnerId: 'other-client' }
    });
  });

  it('aggregates terminal demand per Device and targets output to interested owners', async () => {
    const left = fakeDevice(DEVICE_A, 'Build A');
    const right = fakeDevice(DEVICE_B, 'Build B');
    const cockpit = new CockpitCoordinator({ devices: [left, right] });
    const published: CockpitPublishedEvent[] = [];
    cockpit.onEvent((event) => published.push(event));
    await cockpit.refreshAll();

    await cockpit.setDemand('window-a', {
      terminalOutput: [{ deviceId: DEVICE_A, terminalId: 'same-terminal' }]
    });
    await cockpit.setDemand('window-b', {
      terminalOutput: [{ deviceId: DEVICE_B, terminalId: 'same-terminal' }]
    });
    expect(left.demand).toEqual(['same-terminal']);
    expect(right.demand).toEqual(['same-terminal']);

    left.emit('output', {
      terminalId: 'same-terminal',
      sessionId: 'same-session',
      data: 'left',
      seq: 1
    });
    right.emit('output', {
      terminalId: 'same-terminal',
      sessionId: 'same-session',
      data: 'right',
      seq: 1
    });
    const outputs = published.filter((item) => item.event.type === 'terminal.output');
    expect(outputs.map((item) => [...(item.audience ?? [])])).toEqual([
      ['window-a'],
      ['window-b']
    ]);
  });

  it('changes filters without disconnecting Devices or stopping terminals', async () => {
    const left = fakeDevice(DEVICE_A, 'Build A');
    const right = fakeDevice(DEVICE_B, 'Build B');
    const cockpit = new CockpitCoordinator({ devices: [left, right] });
    await cockpit.refreshAll();
    const connects = [left.connectCalls, right.connectCalls];

    const snapshot = await cockpit.setFilter([DEVICE_B]);

    expect(snapshot.filterDeviceIds).toEqual([DEVICE_B]);
    expect([left.connectCalls, right.connectCalls]).toEqual(connects);
    expect(left.actions).toEqual([]);
    expect(right.actions).toEqual([]);
  });

  it('commits filter and default placement choices through the preference port', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-cockpit-coordinator-'));
    try {
      const filePath = path.join(directory, 'preferences.json');
      const preferences = new CockpitPreferenceStore(filePath);
      await preferences.init();
      const cockpit = new CockpitCoordinator({
        devices: [fakeDevice(DEVICE_A, 'Build A'), fakeDevice(DEVICE_B, 'Build B')],
        preferenceStore: preferences
      });

      await cockpit.setFilter([DEVICE_B]);
      await cockpit.setDefaultPlacement(DEVICE_B);
      const restarted = new CockpitPreferenceStore(filePath);
      await restarted.init();

      expect(restarted.get()).toMatchObject({
        filterDeviceIds: [DEVICE_B],
        defaultPlacementDeviceId: DEVICE_B
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('surfaces only recoverable durable operations in snapshots and diagnostics', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'soloe-cockpit-recovery-'));
    try {
      const operations = new CockpitOperationStore(path.join(directory, 'operations.json'));
      await operations.init();
      const recoverableId = '55555555-5555-4555-8555-555555555555';
      const succeededId = '66666666-6666-4666-8666-666666666666';
      const planId = '77777777-7777-4777-8777-777777777777';
      await operations.create({ operationId: recoverableId, planId, kind: 'place-session' });
      await operations.update(recoverableId, {
        state: 'needs-attention',
        phase: 'device-prepared',
        progress: 50,
        message: 'Destination prepared; Session creation outcome is unknown.',
        childCommands: [{ deviceId: DEVICE_A, commandId: 'command-1' }]
      });
      await operations.create({ operationId: succeededId, planId, kind: 'align-workspace' });
      await operations.update(succeededId, { state: 'succeeded', phase: 'done', progress: 100 });
      const cockpit = new CockpitCoordinator({
        devices: [fakeDevice(DEVICE_A, 'Build A')],
        operationStore: operations
      });

      const snapshot = await cockpit.refreshAll();

      expect(snapshot.recoverableOperations).toEqual([
        expect.objectContaining({ operationId: recoverableId, state: 'needs-attention' })
      ]);
      expect(cockpit.listRecoverableOperations()).toEqual(snapshot.recoverableOperations);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects terminal commands for unknown and offline Devices', async () => {
    const left = fakeDevice(DEVICE_A, 'Build A');
    const cockpit = new CockpitCoordinator({ devices: [left] });
    await cockpit.refreshAll();

    await expect(cockpit.terminalInput({
      deviceId: DEVICE_B,
      terminalId: 'same-terminal'
    }, 'wrong')).rejects.toThrow('Unknown or disabled Device');

    left.setOffline('connection lost');
    await expect(cockpit.terminalInput({
      deviceId: DEVICE_A,
      terminalId: 'same-terminal'
    }, 'offline')).rejects.toThrow('is not ready');
  });

  it('reconciles the enabled Device set without restarting the cockpit', async () => {
    const left = fakeDevice(DEVICE_A, 'Build A');
    const right = fakeDevice(DEVICE_B, 'Build B');
    const cockpit = new CockpitCoordinator({ devices: [left] });
    await cockpit.refreshAll();

    await cockpit.reconcileDevices([left, right]);
    expect(cockpit.snapshot().sessions.map((session) => session.ref.deviceId)).toEqual([
      DEVICE_A,
      DEVICE_B
    ]);

    await cockpit.reconcileDevices([right]);
    expect(cockpit.snapshot().sessions.map((session) => session.ref.deviceId)).toEqual([
      DEVICE_B
    ]);
    expect(left.disposed).toBe(true);
    expect(left.actions).not.toContainEqual(expect.arrayContaining(['stop']));
  });
});

class FakeDevice implements DevicePort {
  readonly actions: unknown[][] = [];
  readonly deviceId: DeviceId;
  demand: string[] = [];
  connectCalls = 0;
  disposed = false;
  private currentStatus: DevicePortStatus;
  private readonly eventListeners = new Set<(event: DeviceEventEnvelope) => void>();
  private readonly statusListeners = new Set<(status: DevicePortStatus) => void>();
  private sequence = 0;

  constructor(
    readonly descriptor: DeviceDescriptor,
    private readonly deviceSnapshot: DeviceReadSnapshot
  ) {
    this.deviceId = descriptor.deviceId;
    this.currentStatus = { deviceId: this.deviceId, state: 'idle', descriptor };
  }

  get status(): DevicePortStatus {
    return structuredClone(this.currentStatus);
  }

  async connect(): Promise<DevicePortStatus> {
    this.connectCalls += 1;
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'ready',
      descriptor: this.descriptor
    };
    this.publishStatus();
    return this.status;
  }

  async snapshot(): Promise<DeviceReadSnapshot> {
    return structuredClone(this.deviceSnapshot);
  }

  async setTerminalOutputDemand(terminalIds: ReadonlySet<string>): Promise<void> {
    this.demand = [...terminalIds].sort();
  }

  async terminalInput(terminalId: string, data: string): Promise<void> {
    this.actions.push(['input', terminalId, data]);
  }

  async terminalAcquireInputLease(
    terminalId: string,
    takeover = false
  ): Promise<TerminalInputLease> {
    this.actions.push(['input-lease', terminalId, takeover]);
    return {
      terminalId,
      leaseId: 'lease-fake',
      ownerId: 'fake-client',
      acquiredAt: '2026-08-12T12:00:00.000Z',
      expiresAt: '2026-08-12T12:00:15.000Z'
    };
  }

  async terminalResize(terminalId: string, cols: number, rows: number): Promise<void> {
    this.actions.push(['resize', terminalId, cols, rows]);
  }

  async terminalReplay(terminalId: string, afterSeq = 0): Promise<CockpitTerminalReplay> {
    this.actions.push(['replay', terminalId, afterSeq]);
    return {
      terminalRef: { deviceId: this.deviceId, terminalId },
      sessionRef: { deviceId: this.deviceId, sessionId: 'same-session' },
      snapshot: {
        terminalId,
        sessionId: 'same-session',
        data: '',
        fromSeq: afterSeq,
        toSeq: afterSeq,
        truncated: false,
        byteLength: 0
      }
    };
  }

  async terminalStop(terminalId: string): Promise<void> {
    this.actions.push(['stop', terminalId]);
  }

  onEvent(listener: (event: DeviceEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: DevicePortStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  emit(event: string, payload: unknown): void {
    this.sequence += 1;
    const envelope = {
      event,
      deviceId: this.deviceId,
      serverEpoch: this.descriptor.serverEpoch,
      sequence: this.sequence,
      observedAt: '2026-08-12T12:00:00.000Z',
      payload
    };
    for (const listener of this.eventListeners) listener(envelope);
  }

  setOffline(error: string): void {
    this.currentStatus = {
      deviceId: this.deviceId,
      state: 'offline',
      descriptor: this.descriptor,
      error
    };
    this.publishStatus();
  }

  dispose(): void {
    this.disposed = true;
  }

  private publishStatus(): void {
    for (const listener of this.statusListeners) listener(this.status);
  }
}

function fakeDevice(deviceId: DeviceId, name: string): FakeDevice {
  const descriptor: DeviceDescriptor = {
    schemaVersion: 1,
    deviceId,
    name,
    platform: 'linux',
    serverEpoch: deviceId === DEVICE_A
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    service: { name: 'soloe-server', version: '0.1.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: {
      revision: 'revision-1',
      features: ['device.describe.v1', 'events.envelope.v1']
    }
  };
  const session = testSession();
  return new FakeDevice(descriptor, {
    descriptor,
    workspace: null,
    sessions: [session],
    archivedSessions: [],
    runtimes: [{
      sessionId: session.id,
      status: 'running',
      terminalId: 'same-terminal'
    }],
    capturedAt: '2026-08-12T12:00:00.000Z'
  });
}

function testSession(): Session {
  return {
    id: 'same-session',
    launch: { type: 'terminal', shell: 'bash' },
    name: 'Collision-safe Session',
    cwd: '/repo',
    runMode: 'linux',
    createdAt: '2026-08-12T10:00:00.000Z',
    lastUsedAt: '2026-08-12T10:00:00.000Z'
  };
}
