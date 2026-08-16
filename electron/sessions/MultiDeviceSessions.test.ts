import { describe, expect, it } from 'vitest';
import { terminalControlProof } from '@shared/types/terminal.js';
import type { DeviceDescriptor, DeviceEventEnvelope } from '@shared/types/devices.js';
import type { GitWorktree } from '@shared/types/git.js';
import type { Project } from '@shared/types/projects.js';
import type { Session } from '@shared/types/sessions.js';
import type { RepositoryIdentity } from '@shared/types/workspaces.js';
import type { DevicePlacedSessionRequest } from '@shared/types/workspaces.js';
import {
  MultiDeviceSessions,
  type DeviceSessionInventory,
  type SessionDevice,
  type SessionDeviceStatus
} from './MultiDeviceSessions.js';

const MAC_ID = '11111111-1111-4111-8111-111111111111';
const LAPTOP_ID = '22222222-2222-4222-8222-222222222222';

describe('MultiDeviceSessions', () => {
  it('merges the same Git Project and branch while preserving device-local locations', async () => {
    const mac = fakeDevice({
      deviceId: MAC_ID,
      name: 'MacBook',
      projectId: 'mac-soloe',
      projectPath: '/Users/me/soloe',
      workspacePath: '/Users/me/soloe-feature',
      branch: 'feature/multi-device',
      sessions: [],
      local: true
    });
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe-feature',
      branch: 'feature/multi-device',
      sessions: [session({
        id: 'remote-session',
        projectId: 'windows-soloe',
        cwd: 'C:\\src\\soloe-feature'
      })]
    });

    const sessions = new MultiDeviceSessions({ devices: [mac, laptop] });
    const state = await sessions.refresh();

    expect(state.devices).toEqual([
      expect.objectContaining({
        deviceId: LAPTOP_ID,
        name: 'LAPTOPLORES',
        state: 'ready',
        local: false
      }),
      expect.objectContaining({
        deviceId: MAC_ID,
        name: 'MacBook',
        state: 'ready',
        local: true
      })
    ]);
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0]).toMatchObject({
      name: 'Soloe',
      workspaces: [{
        name: 'feature/multi-device',
        locations: [
          { deviceId: LAPTOP_ID, path: 'C:\\src\\soloe-feature' },
          { deviceId: MAC_ID, path: '/Users/me/soloe-feature' }
        ],
        sessions: [{
          ref: { deviceId: LAPTOP_ID, sessionId: 'remote-session' },
          deviceName: 'LAPTOPLORES',
          available: true
        }]
      }]
    });
  });

  it('keeps the last known hierarchy when a Device goes offline and disables its Sessions', async () => {
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe-feature',
      branch: 'feature/multi-device',
      sessions: [session({
        id: 'remote-session',
        projectId: 'windows-soloe',
        cwd: 'C:\\src\\soloe-feature'
      })]
    });
    const sessions = new MultiDeviceSessions({ devices: [laptop] });

    await sessions.refresh();
    laptop.setState('offline');
    const offline = await sessions.refresh();

    expect(offline.projects[0]?.workspaces[0]?.locations[0]).toMatchObject({
      deviceId: LAPTOP_ID,
      available: false
    });
    expect(offline.projects[0]?.workspaces[0]?.sessions[0]).toMatchObject({
      ref: { deviceId: LAPTOP_ID, sessionId: 'remote-session' },
      available: false
    });
  });

  it('creates a Session on the Device that owns the selected Workspace Location', async () => {
    const createdRequests: DevicePlacedSessionRequest[] = [];
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe-feature',
      branch: 'feature/multi-device',
      sessions: [],
      onCreate: (request) => {
        createdRequests.push(structuredClone(request));
      }
    });
    const sessions = new MultiDeviceSessions({ devices: [laptop] });
    const initial = await sessions.refresh();
    const workspaceKey = initial.projects[0]!.workspaces[0]!.key;

    const created = await sessions.create({
      workspaceKey,
      targetDeviceId: LAPTOP_ID,
      session: {
        name: 'Codex',
        launch: { type: 'agent', provider: 'codex', resumeMode: 'new' }
      }
    });

    expect(created).toMatchObject({
      ref: { deviceId: LAPTOP_ID },
      deviceName: 'LAPTOPLORES',
      available: true,
      session: {
        name: 'Codex',
        projectId: 'windows-soloe',
        cwd: 'C:\\src\\soloe-feature',
        runMode: 'windows'
      }
    });
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0]?.draft).toMatchObject({
      projectId: 'windows-soloe',
      cwd: 'C:\\src\\soloe-feature',
      runMode: 'windows'
    });
    expect(laptop.startedSessionIds).toEqual([created.ref.sessionId]);
  });

  it('plans, reviews, and clones a missing Project before creating on another Device', async () => {
    const mac = fakeDevice({
      deviceId: MAC_ID,
      name: 'MacBook',
      projectId: 'mac-soloe',
      projectPath: '/Users/me/soloe',
      workspacePath: '/Users/me/soloe-feature',
      branch: 'feature/multi-device',
      sessions: [],
      local: true
    });
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\managed\\soloe-feature',
      branch: 'feature/multi-device',
      sessions: [],
      hasProject: false
    });
    const sessions = new MultiDeviceSessions({ devices: [mac, laptop] });
    const state = await sessions.refresh();
    const request = {
      workspaceKey: state.projects[0]!.workspaces[0]!.key,
      targetDeviceId: LAPTOP_ID,
      targetPath: 'C:\\managed\\custom-soloe',
      session: {
        name: 'Codex',
        launch: { type: 'agent' as const, provider: 'codex' as const, resumeMode: 'new' as const }
      }
    };

    const plan = await sessions.planCreate(request);

    expect(plan).toMatchObject({
      action: 'clone-project',
      deviceName: 'LAPTOPLORES',
      targetPath: 'C:\\managed\\custom-soloe',
      executable: true
    });
    expect(laptop.plannedIntents).toEqual([
      expect.objectContaining({
        kind: 'clone-project-presence',
        sourceUrl: 'https://github.com/example/soloe.git',
        branchRef: 'refs/heads/feature/multi-device'
      })
    ]);

    const created = await sessions.executeCreate(plan.planId);

    expect(laptop.openedProjectPaths).toEqual(['C:\\managed\\custom-soloe']);
    expect(created).toMatchObject({
      ref: { deviceId: LAPTOP_ID },
      session: {
        cwd: 'C:\\managed\\custom-soloe',
        projectId: 'windows-soloe'
      }
    });
  });

  it('prepares a missing Project on another Device without creating a Session', async () => {
    const mac = fakeDevice({
      deviceId: MAC_ID,
      name: 'MacBook',
      projectId: 'mac-soloe',
      projectPath: '/Users/me/soloe',
      workspacePath: '/Users/me/soloe',
      branch: 'main',
      sessions: [],
      local: true
    });
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\managed\\soloe',
      branch: 'main',
      sessions: [],
      hasProject: false
    });
    const sessions = new MultiDeviceSessions({ devices: [mac, laptop] });
    const state = await sessions.refresh();
    const plan = await sessions.planCreate({
      workspaceKey: state.projects[0]!.workspaces[0]!.key,
      targetDeviceId: LAPTOP_ID,
      targetPath: 'C:\\managed\\prepared-soloe',
      session: {
        name: 'Placement preview',
        launch: { type: 'terminal', shell: 'auto' }
      }
    });

    const prepared = await sessions.executePreparation(plan.planId);

    expect(laptop.openedProjectPaths).toEqual(['C:\\managed\\prepared-soloe']);
    expect(laptop.startedSessionIds).toEqual([]);
    expect(prepared.projects.flatMap((project) =>
      project.workspaces.flatMap((workspace) => workspace.sessions)
    )).toHaveLength(0);
  });

  it('routes terminal control to the Device that owns the Session', async () => {
    const mac = fakeDevice({
      deviceId: MAC_ID,
      name: 'MacBook',
      projectId: 'mac-soloe',
      projectPath: '/Users/me/soloe',
      workspacePath: '/Users/me/soloe',
      branch: 'main',
      sessions: [],
      local: true
    });
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe',
      branch: 'main',
      sessions: []
    });
    const sessions = new MultiDeviceSessions({ devices: [mac, laptop] });
    await sessions.refresh();

    await sessions.terminalInput(
      { deviceId: LAPTOP_ID, terminalId: 'terminal-remote-session' },
      'git status\r',
      {
        sessionId: 'remote-session',
        ownerDeviceId: LAPTOP_ID,
        controllerDeviceId: MAC_ID,
        leaseId: 'lease-remote-session'
      }
    );

    expect(mac.terminalInputs).toEqual([]);
    expect(laptop.terminalInputs).toEqual([
      { terminalId: 'terminal-remote-session', data: 'git status\r' }
    ]);

    const ref = { deviceId: LAPTOP_ID, terminalId: 'terminal-remote-session' };
    const lease = await sessions.terminalAcquireInputLease(ref);
    expect(lease).toMatchObject({
      ownerDeviceId: LAPTOP_ID,
      controllerDeviceId: MAC_ID,
      controllerDeviceName: 'MacBook'
    });
    await expect(sessions.terminalCurrentInputLease(ref)).resolves.toEqual(lease);
    await expect(
      sessions.terminalReleaseInputLease(ref, terminalControlProof(lease))
    ).resolves.toBe(true);
    await expect(sessions.terminalCurrentInputLease(ref)).resolves.toBeNull();
  });

  it('starts a stopped Session on its owning Device before opening it', async () => {
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe',
      branch: 'main',
      sessions: [session({
        id: 'remote-session',
        projectId: 'windows-soloe',
        cwd: 'C:\\src\\soloe'
      })]
    });
    const sessions = new MultiDeviceSessions({ devices: [laptop] });
    await sessions.refresh();

    const opened = await sessions.startSession({
      deviceId: LAPTOP_ID,
      sessionId: 'remote-session'
    });

    expect(laptop.startedSessionIds).toEqual(['remote-session']);
    expect(opened).toMatchObject({
      ref: { deviceId: LAPTOP_ID, sessionId: 'remote-session' },
      runtime: {
        status: 'running',
        terminalId: 'terminal-remote-session'
      }
    });
  });

  it('reconciles the connected Device set without restarting the Sessions interface', async () => {
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe',
      branch: 'main',
      sessions: []
    });
    const mac = fakeDevice({
      deviceId: MAC_ID,
      name: 'MacBook',
      projectId: 'mac-soloe',
      projectPath: '/Users/me/soloe',
      workspacePath: '/Users/me/soloe',
      branch: 'main',
      sessions: [],
      local: true
    });
    const sessions = new MultiDeviceSessions({ devices: [laptop] });
    await sessions.refresh();

    const state = await sessions.reconcileDevices([mac]);

    expect(state.devices).toEqual([
      expect.objectContaining({ deviceId: MAC_ID, local: true })
    ]);
    expect(laptop.disposed).toBe(true);
  });

  it('coalesces concurrent refresh requests into one Device inventory read', async () => {
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe',
      branch: 'main',
      sessions: []
    });
    const sessions = new MultiDeviceSessions({ devices: [laptop] });

    const [first, second] = await Promise.all([sessions.refresh(), sessions.refresh()]);

    expect(first).toEqual(second);
    expect(laptop.readInventoryCalls).toBe(1);
  });

  it('does not publish or revise identical periodic inventory refreshes', async () => {
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe',
      branch: 'main',
      sessions: []
    });
    const sessions = new MultiDeviceSessions({ devices: [laptop] });
    const published: number[] = [];
    sessions.onState((state) => published.push(state.revision));

    const first = await sessions.refresh();
    const unchanged = await sessions.refresh();

    expect(unchanged).toEqual(first);
    expect(published).toEqual([first.revision]);
    expect(laptop.readInventoryCalls).toBe(2);
  });

  it('propagates one merged Session order to every owning Device', async () => {
    const mac = fakeDevice({
      deviceId: MAC_ID,
      name: 'MacBook',
      projectId: 'mac-soloe',
      projectPath: '/Users/me/soloe',
      workspacePath: '/Users/me/soloe-feature',
      branch: 'feature/multi-device',
      sessions: [{
        ...session({ id: 'mac-session', projectId: 'mac-soloe', cwd: '/Users/me/soloe-feature' }),
        sortIndex: 1
      }],
      local: true
    });
    const laptop = fakeDevice({
      deviceId: LAPTOP_ID,
      name: 'LAPTOPLORES',
      projectId: 'windows-soloe',
      projectPath: 'C:\\src\\soloe',
      workspacePath: 'C:\\src\\soloe-feature',
      branch: 'feature/multi-device',
      sessions: [{
        ...session({
          id: 'remote-session',
          projectId: 'windows-soloe',
          cwd: 'C:\\src\\soloe-feature'
        }),
        sortIndex: 0
      }]
    });
    const multiDevice = new MultiDeviceSessions({ devices: [mac, laptop] });
    await multiDevice.refresh();

    const state = await multiDevice.reorderSessions([
      { deviceId: MAC_ID, sessionId: 'mac-session' },
      { deviceId: LAPTOP_ID, sessionId: 'remote-session' }
    ]);

    expect(mac.reorderRequests).toEqual([['mac-session', 'remote-session']]);
    expect(laptop.reorderRequests).toEqual([['mac-session', 'remote-session']]);
    expect(state.projects[0]?.workspaces[0]?.sessions.map((item) => item.ref)).toEqual([
      { deviceId: MAC_ID, sessionId: 'mac-session' },
      { deviceId: LAPTOP_ID, sessionId: 'remote-session' }
    ]);
  });
});

function fakeDevice(input: {
  deviceId: string;
  name: string;
  projectId: string;
  projectPath: string;
  workspacePath: string;
  branch: string;
  sessions: Session[];
  onCreate?: (request: DevicePlacedSessionRequest) => void;
  local?: boolean;
  hasProject?: boolean;
}): SessionDevice & {
  setState(state: SessionDeviceStatus['state']): void;
  startedSessionIds: string[];
  terminalInputs: Array<{ terminalId: string; data: string }>;
  readonly disposed: boolean;
  plannedIntents: import('@shared/types/workspaces.js').DeviceWorkspaceIntent[];
  openedProjectPaths: string[];
  readonly readInventoryCalls: number;
  reorderRequests: string[][];
} {
  const descriptor = deviceDescriptor(input.deviceId, input.name);
  const status: SessionDeviceStatus = {
    deviceId: input.deviceId,
    state: 'ready',
    descriptor
  };
  const project: Project = {
    id: input.projectId,
    name: 'Soloe',
    path: input.projectPath,
    createdAt: '2026-08-13T08:00:00.000Z',
    lastOpenedAt: '2026-08-13T09:00:00.000Z'
  };
  const worktree: GitWorktree = {
    path: input.workspacePath,
    branch: input.branch,
    head: '0123456789abcdef0123456789abcdef01234567',
    detached: false,
    bare: false,
    isMain: false
  };
  const repository: RepositoryIdentity = {
    kind: 'git',
    canonicalUrl: 'https://github.com/example/soloe.git'
  };
  const inventory: DeviceSessionInventory = {
    descriptor,
    projects: input.hasProject === false
      ? []
      : [{ project, repository, repositoryId: `repository-${input.deviceId}`, worktrees: [worktree] }],
    sessions: input.sessions,
    archivedSessions: [],
    runtimes: [],
    capturedAt: '2026-08-13T10:00:00.000Z'
  };
  const startedSessionIds: string[] = [];
  const terminalInputs: Array<{ terminalId: string; data: string }> = [];
  const terminalLeases = new Map<string, import('@shared/types/terminal.js').TerminalInputLease>();
  const plannedIntents: import('@shared/types/workspaces.js').DeviceWorkspaceIntent[] = [];
  const openedProjectPaths: string[] = [];
  const reorderRequests: string[][] = [];
  let pendingClone: import('@shared/types/workspaces.js').CloneProjectPresenceIntent | null = null;
  let disposed = false;
  let readInventoryCalls = 0;
  return {
    deviceId: input.deviceId,
    local: input.local ?? false,
    status,
    connect: async () => status,
    readInventory: async () => {
      readInventoryCalls += 1;
      return structuredClone(inventory);
    },
    reorderSessions: async (orderedIds) => {
      reorderRequests.push([...orderedIds]);
      const positions = new Map(orderedIds.map((id, index) => [id, index]));
      inventory.sessions = inventory.sessions.map((item) => {
        const sortIndex = positions.get(item.id);
        return sortIndex === undefined ? item : { ...item, sortIndex };
      });
      return structuredClone(inventory.sessions);
    },
    setTerminalOutputDemand: async () => undefined,
    terminalInput: async (terminalId, data) => {
      terminalInputs.push({ terminalId, data });
    },
    terminalAcquireInputLease: async (
      terminalId,
      _takeover,
      controller = { deviceId: input.deviceId, deviceName: input.name }
    ) => {
      const lease = {
        terminalId,
        sessionId: `session-${terminalId}`,
        ownerDeviceId: input.deviceId,
        leaseId: `lease-${terminalId}`,
        controllerDeviceId: controller.deviceId,
        controllerDeviceName: controller.deviceName,
        generation: 1,
        cols: 120,
        rows: 30,
        acquiredAt: '2026-08-13T10:00:00.000Z',
        expiresAt: '2026-08-13T10:00:15.000Z'
      };
      terminalLeases.set(terminalId, lease);
      return lease;
    },
    terminalCurrentInputLease: async (terminalId) => terminalLeases.get(terminalId) ?? null,
    terminalReleaseInputLease: async (terminalId, control) => {
      if (terminalLeases.get(terminalId)?.leaseId !== control.leaseId) return false;
      terminalLeases.delete(terminalId);
      return true;
    },
    terminalResize: async () => undefined,
    terminalReplay: async () => ({ terminalRef: null, sessionRef: null, snapshot: null }),
    terminalStop: async () => undefined,
    workspacePlan: async (intent) => {
      plannedIntents.push(structuredClone(intent));
      return {
        schemaVersion: 1,
        planId: `plan-${input.deviceId}`,
        planToken: `token-${input.deviceId}`,
        targetDeviceId: input.deviceId,
        capabilityRevision: 'test',
        expectedWorkspaceRevision: 1,
        intent: structuredClone(intent),
        executable: true,
        blockers: [],
        warnings: ['This Project will be cloned on LAPTOPLORES.'],
        preview: {
          repositoryPath: null,
          targetPath: 'path' in intent && intent.path ? intent.path : input.workspacePath,
          sourceLabel: input.branch
        },
        createdAt: '2026-08-13T10:00:00.000Z',
        expiresAt: '2099-08-13T10:05:00.000Z'
      };
    },
    workspaceExecute: async (command) => {
      if (command.intent.kind === 'clone-project-presence') pendingClone = structuredClone(command.intent);
      return {
        schemaVersion: 1,
        clientId: command.clientId,
        commandId: command.commandId,
        targetDeviceId: input.deviceId,
        kind: command.intent.kind,
        intentDigest: 'test',
        state: 'succeeded',
        createdAt: '2026-08-13T10:00:00.000Z',
        updatedAt: '2026-08-13T10:00:01.000Z',
        result: {
          repository: {
            id: command.intent.kind === 'clone-project-presence' ? command.intent.repositoryId : '',
            version: 1,
            identity: command.intent.kind === 'clone-project-presence' ? command.intent.identity : null,
            createdAt: '2026-08-13T10:00:00.000Z',
            updatedAt: '2026-08-13T10:00:00.000Z'
          },
          checkout: {
            id: command.intent.kind === 'clone-project-presence' ? command.intent.checkoutId : '',
            repositoryId: command.intent.kind === 'clone-project-presence' ? command.intent.repositoryId : '',
            path: 'path' in command.intent && command.intent.path
              ? command.intent.path
              : input.workspacePath,
            runMode: descriptor.platform,
            role: 'main',
            lifecycle: 'ready',
            version: 1,
            createdAt: '2026-08-13T10:00:00.000Z',
            updatedAt: '2026-08-13T10:00:00.000Z'
          },
          workspaceRevision: 2
        }
      };
    },
    openProject: async (request) => {
      openedProjectPaths.push(request.path);
      const cloned = pendingClone;
      if (!cloned) throw new Error('No clone was executed.');
      project.path = request.path;
      inventory.projects.push({
        project,
        repository: cloned.identity,
        repositoryId: cloned.repositoryId,
        worktrees: [{ ...worktree, path: request.path }]
      });
      return structuredClone(project);
    },
    createSession: async (request) => {
      input.onCreate?.(request);
      const created = session({
        id: request.sessionId,
        projectId: request.draft.projectId!,
        cwd: request.draft.cwd
      });
      Object.assign(created, structuredClone(request.draft));
      inventory.sessions.push(created);
      return structuredClone(created);
    },
    startSession: async (sessionId) => {
      startedSessionIds.push(sessionId);
      inventory.runtimes = inventory.runtimes.filter((runtime) => runtime.sessionId !== sessionId);
      inventory.runtimes.push({
        sessionId,
        status: 'running',
        terminalId: `terminal-${sessionId}`
      });
      return {
        terminalId: `terminal-${sessionId}`,
        sessionId,
        pid: 1234,
        spec: {
          file: 'test-shell',
          args: [],
          cwd: inventory.sessions.find((item) => item.id === sessionId)?.cwd ?? '.',
          env: {},
          description: 'test terminal'
        }
      };
    },
    onEvent: (_listener: (event: DeviceEventEnvelope) => void) => () => undefined,
    onStatus: (_listener: (next: SessionDeviceStatus) => void) => () => undefined,
    dispose: () => {
      disposed = true;
    },
    setState: (state) => {
      status.state = state;
    },
    startedSessionIds,
    plannedIntents,
    openedProjectPaths,
    terminalInputs,
    reorderRequests,
    get disposed() {
      return disposed;
    },
    get readInventoryCalls() {
      return readInventoryCalls;
    }
  };
}

function deviceDescriptor(deviceId: string, name: string): DeviceDescriptor {
  return {
    schemaVersion: 1,
    deviceId,
    name,
    platform: name === 'MacBook' ? 'macos' : 'windows',
    serverEpoch: deviceId,
    service: { name: 'soloe-server', version: '1.0.0' },
    protocol: { current: 1, minimum: 1, maximum: 1 },
    capabilities: { revision: 'test', features: [] }
  };
}

function session(input: { id: string; projectId: string; cwd: string }): Session {
  return {
    id: input.id,
    name: 'Remote agent',
    projectId: input.projectId,
    cwd: input.cwd,
    runMode: 'windows',
    launch: { type: 'terminal', shell: 'pwsh' },
    createdAt: '2026-08-13T08:00:00.000Z',
    lastUsedAt: '2026-08-13T09:00:00.000Z'
  };
}
