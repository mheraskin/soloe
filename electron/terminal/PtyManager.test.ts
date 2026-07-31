import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as pty from 'node-pty';
import type { Session } from '@shared/types/sessions.js';
import type {
  SpawnSpec,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import { AgentObserverManager } from '../agents/AgentObserverManager.js';
import { PtyManager, type PtyManagerOptions } from './PtyManager.js';
import { TerminalOutputBatcher } from './TerminalOutputBatcher.js';
import type { PtyProcessFactory } from './PtyProcess.js';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1234,
    onData: vi.fn(),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  }))
}));

const session: Session = {
  id: 's-1',
  name: 'terminal',
  cwd: '~',
  runMode: 'windows',
  launch: { type: 'terminal', shell: 'auto' },
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: '2026-01-01T00:00:00Z'
};

const spec: SpawnSpec = {
  file: 'pwsh.exe',
  args: ['-NoLogo'],
  cwd: 'C:\\Users\\me',
  env: {},
  description: 'pwsh.exe -NoLogo'
};

beforeEach(() => {
  vi.mocked(pty.spawn).mockClear();
});

describe('PtyManager', () => {
  it('makes each output batch replayable before observers receive it', () => {
    const manager = new PtyManager({} as PtyManagerOptions);
    const output: TerminalOutputEvent = {
      terminalId: 't-1',
      sessionId: 's-1',
      seq: 1,
      data: 'ready'
    };
    let replaySeenInsideObserver = null;
    manager.on('output', (event) => {
      replaySeenInsideObserver = manager.replay(event.terminalId, event.seq - 1);
    });

    manager.forwardBatchedOutput([output]);

    expect(replaySeenInsideObserver).toMatchObject({ data: 'ready', fromSeq: 1, toSeq: 1 });
  });

  it('semantically observes final buffered output before publishing terminal exit', async () => {
    const order: string[] = [];
    let manager!: PtyManager;
    const batcher = new TerminalOutputBatcher(10_000, (events) => {
      manager.forwardBatchedOutput(events);
    });
    manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher,
      baseEnv: {}
    });
    manager.on('location', () => order.push('location'));
    manager.on('output', () => order.push('output'));
    manager.on('exit', () => order.push('exit'));

    await manager.start({ sessionId: session.id });
    const proc = vi.mocked(pty.spawn).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
      onExit: { mock: { calls: Array<[(event: { exitCode: number; signal?: number }) => void]> } };
    };
    proc.onData.mock.calls[0]?.[0]('\x1b]7;file:///home/me/final\x07');
    expect(order).toEqual([]);

    proc.onExit.mock.calls[0]?.[0]({ exitCode: 0 });

    expect(order).toEqual(['location', 'output', 'exit']);
    batcher.destroy();
  });

  it('does not pass encoding to node-pty.spawn', async () => {
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });

    await manager.start({ sessionId: session.id });

    expect(pty.spawn).toHaveBeenCalledOnce();
    const options = vi.mocked(pty.spawn).mock.calls[0]?.[2] as Record<string, unknown>;
    expect(options).not.toHaveProperty('encoding');
  });

  it('exposes a terminal id before spawn so the renderer can mount xterm', async () => {
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });
    const statuses: TerminalStatusEvent[] = [];
    manager.on('status', (event) => statuses.push(event));

    await manager.start({ sessionId: session.id });

    expect(statuses[0]).toMatchObject({
      sessionId: session.id,
      status: 'starting',
      terminalId: expect.any(String)
    });
    expect(statuses[1]).toMatchObject({
      sessionId: session.id,
      status: 'running'
    });
    expect(statuses[1]?.terminalId).toEqual(expect.any(String));
  });

  it('reattaches to an already-running session instead of spawning a competing terminal', async () => {
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });

    const first = await manager.start({ sessionId: session.id });
    const resumed = await manager.start({ sessionId: session.id });

    expect(resumed).toEqual(first);
    expect(pty.spawn).toHaveBeenCalledOnce();
  });

  it('emits cwd updates from OSC 7 location sequences', async () => {
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });
    const locations: TerminalLocationEvent[] = [];
    manager.on('location', (event) => locations.push(event));

    const started = await manager.start({ sessionId: session.id });
    const proc = vi.mocked(pty.spawn).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
    };
    const onData = proc.onData.mock.calls[0]?.[0];

    const opener = '\x1b';
    const payload = ']7;file:///home/me/project\x07';
    onData?.(opener);
    onData?.(payload);
    expect(locations).toEqual([]);
    manager.forwardBatchedOutput([
      {
        terminalId: started.terminalId,
        sessionId: session.id,
        data: opener,
        seq: 1
      },
      {
        terminalId: started.terminalId,
        sessionId: session.id,
        data: payload,
        seq: 2
      }
    ]);

    expect(locations).toEqual([
      {
        terminalId: started.terminalId,
        sessionId: session.id,
        cwd: '/home/me/project'
      }
    ]);
  });

  it('emits cwd updates from common shell integration cwd sequences', async () => {
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });
    const locations: TerminalLocationEvent[] = [];
    manager.on('location', (event) => locations.push(event));

    const started = await manager.start({ sessionId: session.id });
    const proc = vi.mocked(pty.spawn).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
    };
    const onData = proc.onData.mock.calls[0]?.[0];

    const data = '\x1b]633;P;Cwd=/home/me/vscode\x07'
      + '\x1b]1337;CurrentDir=file:///home/me/iterm\x1b\\';
    onData?.(data);
    manager.forwardBatchedOutput([{
      terminalId: started.terminalId,
      sessionId: session.id,
      data,
      seq: 1
    }]);

    expect(locations).toEqual([
      {
        terminalId: started.terminalId,
        sessionId: session.id,
        cwd: '/home/me/vscode'
      },
      {
        terminalId: started.terminalId,
        sessionId: session.id,
        cwd: '/home/me/iterm'
      }
    ]);
  });

  it('clears approval state when the user answers a terminal approval prompt', async () => {
    const observer = new AgentObserverManager();
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      observer,
      baseEnv: {}
    });

    const started = await manager.start({ sessionId: session.id });
    observer.setTuiObservedState(session.id, 'waiting_for_approval', 'waiting for approval');

    manager.write(started.terminalId, '\r');

    expect(observer.getSnapshot(session.id)?.state).toBe('working');
    expect(observer.listEvents(session.id).map((e) => e.summary)).toContain('approval answered');
  });

  it('does not infer Claude session ids from transcript files', async () => {
    const claudeSession: Session = {
      ...session,
      id: 'claude-1',
      name: 'Claude',
      launch: {
        type: 'agent',
        provider: 'claude_code',
        resumeMode: 'new',
        fullscreenTui: true
      }
    };
    const update = vi.fn();
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => claudeSession),
        touch: vi.fn(async () => {}),
        update
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });

    await manager.start({ sessionId: claudeSession.id });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(update).not.toHaveBeenCalled();
  });

  it('marks a Claude session resumable when submitted input reaches the PTY', async () => {
    const claudeSession: Session = {
      ...session,
      id: 'claude-input',
      name: 'Claude',
      launch: {
        type: 'agent',
        provider: 'claude_code',
        resumeMode: 'new',
        claudeSessionId: '123e4567-e89b-42d3-a456-426614174000'
      },
      hasUserInput: false
    };
    const update = vi.fn(async () => ({ ...claudeSession, hasUserInput: true }));
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => claudeSession),
        touch: vi.fn(async () => {}),
        update
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });

    const started = await manager.start({ sessionId: claudeSession.id });
    manager.write(started.terminalId, 'hello');
    expect(update).not.toHaveBeenCalled();

    manager.write(started.terminalId, '\r');
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(claudeSession.id, { hasUserInput: true });
    });
  });

  it('marks a Codex session resumable when submitted input reaches the PTY', async () => {
    const codexSession: Session = {
      ...session,
      id: 'codex-input',
      name: 'Codex',
      launch: {
        type: 'agent',
        provider: 'codex',
        resumeMode: 'new',
        codexSessionId: 'codex-empty-123'
      },
      hasUserInput: false
    };
    const update = vi.fn(async () => ({ ...codexSession, hasUserInput: true }));
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => codexSession),
        touch: vi.fn(async () => {}),
        update
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      baseEnv: {}
    });

    const started = await manager.start({ sessionId: codexSession.id });
    manager.write(started.terminalId, '\r');

    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledWith(codexSession.id, { hasUserInput: true });
    });
  });

  it('marks an agent as waiting for approval from terminal output', async () => {
    const codexSession: Session = {
      ...session,
      id: 'codex-1',
      name: 'Codex',
      kind: 'codex',
      resumeMode: 'new'
    };
    const observer = new AgentObserverManager();
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => codexSession),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      observer,
      baseEnv: {}
    });

    const started = await manager.start({ sessionId: codexSession.id });
    observer.setTuiObservedState(codexSession.id, 'working', 'thinking');
    const proc = vi.mocked(pty.spawn).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
    };
    const onData = proc.onData.mock.calls[0]?.[0];

    const data = 'Do you want to allow this command to run?';
    onData?.(data);
    expect(observer.getSnapshot(codexSession.id)?.state).toBe('working');
    manager.forwardBatchedOutput([{
      terminalId: started.terminalId,
      sessionId: codexSession.id,
      data,
      seq: 1
    }]);

    expect(observer.getSnapshot(codexSession.id)?.state).toBe('waiting_for_approval');
    manager.forwardBatchedOutput([{
      terminalId: started.terminalId,
      sessionId: codexSession.id,
      data,
      seq: 2
    }]);
    expect(
      observer.listEvents(codexSession.id).filter((event) => event.summary === 'waiting for approval')
    ).toHaveLength(1);
  });

  it('ignores approval-looking terminal output for auto-approved agents', async () => {
    const codexSession: Session = {
      ...session,
      id: 'codex-auto-approve',
      name: 'Codex',
      launch: {
        type: 'agent',
        provider: 'codex',
        resumeMode: 'new',
        extraArgs: ['--dangerously-bypass-approvals-and-sandbox']
      }
    };
    const observer = new AgentObserverManager();
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => codexSession),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      observer,
      baseEnv: {}
    });

    const started = await manager.start({ sessionId: codexSession.id });
    observer.setTuiObservedState(codexSession.id, 'working', 'thinking');
    manager.forwardBatchedOutput([{
      terminalId: started.terminalId,
      sessionId: codexSession.id,
      data: 'Do you want to allow this command to run?',
      seq: 1
    }]);

    expect(observer.getSnapshot(codexSession.id)?.state).toBe('working');
  });

  it('detects ANSI-decorated agent signals split across output chunks', async () => {
    const codexSession: Session = {
      ...session,
      id: 'codex-signals',
      name: 'Codex',
      kind: 'codex',
      resumeMode: 'new'
    };
    const observer = new AgentObserverManager();
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => codexSession),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      observer,
      baseEnv: {}
    });

    const started = await manager.start({ sessionId: codexSession.id });
    observer.setTuiObservedState(codexSession.id, 'working', 'thinking');
    const proc = vi.mocked(pty.spawn).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
    };
    const onData = proc.onData.mock.calls[0]?.[0];

    const approvalFirst = '\x1b[33mNeeds your per\x1b[1m';
    const approvalSecond = 'mission\x1b[0m before continuing';
    onData?.(approvalFirst);
    onData?.(approvalSecond);
    manager.forwardBatchedOutput([
      {
        terminalId: started.terminalId,
        sessionId: codexSession.id,
        data: approvalFirst,
        seq: 1
      },
      {
        terminalId: started.terminalId,
        sessionId: codexSession.id,
        data: approvalSecond,
        seq: 2
      }
    ]);
    expect(observer.getSnapshot(codexSession.id)?.state).toBe('waiting_for_approval');

    const limitFirst = "\x1b[31mYou've hit your usage li\x1b[0m";
    const limitSecond = 'mit. Try again at 3:45pm.\x1b[0m';
    onData?.(limitFirst);
    onData?.(limitSecond);
    manager.forwardBatchedOutput([
      {
        terminalId: started.terminalId,
        sessionId: codexSession.id,
        data: limitFirst,
        seq: 3
      },
      {
        terminalId: started.terminalId,
        sessionId: codexSession.id,
        data: limitSecond,
        seq: 4
      }
    ]);
    expect(observer.getSnapshot(codexSession.id)).toMatchObject({
      state: 'usage_limited',
      usageLimit: { resetAtLabel: '3:45pm' }
    });

    const approvalAfterLimit = 'Do you want to allow this command to run?';
    manager.forwardBatchedOutput([{
      terminalId: started.terminalId,
      sessionId: codexSession.id,
      data: approvalAfterLimit,
      seq: 5
    }]);
    expect(observer.getSnapshot(codexSession.id)).toMatchObject({
      state: 'usage_limited',
      usageLimit: { resetAtLabel: '3:45pm' }
    });
  });

  it('marks an agent idle when the terminal sends interrupt', async () => {
    const codexSession: Session = {
      ...session,
      id: 'codex-2',
      name: 'Codex',
      kind: 'codex',
      resumeMode: 'new'
    };
    const observer = new AgentObserverManager();
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => codexSession),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      observer,
      baseEnv: {}
    });

    const started = await manager.start({ sessionId: codexSession.id });
    observer.setTuiObservedState(codexSession.id, 'working', 'thinking');

    manager.write(started.terminalId, '\x03');

    expect(observer.getSnapshot(codexSession.id)?.state).toBe('idle');
  });

  it('does not stop externally owned terminal processes when the client is disposed', async () => {
    const kill = vi.fn();
    const processFactory: PtyProcessFactory = {
      preservesProcessesOnDispose: true,
      spawn: () => ({
        pid: 3333,
        onData: () => ({ dispose: vi.fn() }),
        onExit: () => ({ dispose: vi.fn() }),
        write: vi.fn(),
        resize: vi.fn(),
        kill
      }),
      dispose: vi.fn()
    };
    const batcher = {
      push: vi.fn(),
      flushTerminal: vi.fn(),
      removeTerminal: vi.fn(),
      destroy: vi.fn()
    };
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: batcher as unknown as PtyManagerOptions['batcher'],
      processFactory,
      baseEnv: {}
    });

    await manager.start({ sessionId: session.id });
    await manager.dispose();

    expect(kill).not.toHaveBeenCalled();
    expect(processFactory.dispose).toHaveBeenCalledOnce();
    expect(batcher.destroy).toHaveBeenCalledOnce();
  });

  it('rehydrates terminal state after the Electron client restarts', async () => {
    const attachedProcess = {
      pid: 4545,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn()
    };
    const processFactory: PtyProcessFactory = {
      preservesProcessesOnDispose: true,
      spawn: vi.fn(),
      listRunning: vi.fn(async () => [
        {
          terminalId: 'existing-terminal',
          sessionId: session.id,
          pid: 4545,
          status: 'running' as const,
          startedAt: '2026-07-30T10:00:00.000Z',
          spec,
          cols: 110,
          rows: 35
        }
      ]),
      attach: vi.fn(() => attachedProcess)
    };
    const manager = new PtyManager({
      commandBuilder: {
        build: vi.fn(() => spec)
      } as unknown as PtyManagerOptions['commandBuilder'],
      store: {
        get: vi.fn(async () => session),
        touch: vi.fn(async () => {})
      } as unknown as PtyManagerOptions['store'],
      batcher: {
        push: vi.fn(),
        flushTerminal: vi.fn(),
        removeTerminal: vi.fn(),
        destroy: vi.fn()
      } as unknown as PtyManagerOptions['batcher'],
      processFactory,
      baseEnv: {}
    });

    await manager.rehydrate();

    expect(manager.listRunning()).toEqual([
      expect.objectContaining({
        terminalId: 'existing-terminal',
        sessionId: session.id,
        status: 'running',
        startedAt: '2026-07-30T10:00:00.000Z'
      })
    ]);
    expect(processFactory.attach).toHaveBeenCalledOnce();
    expect(attachedProcess.onData).toHaveBeenCalledOnce();
    expect(attachedProcess.onExit).toHaveBeenCalledOnce();
  });
});
