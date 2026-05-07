import { describe, expect, it, vi } from 'vitest';
import * as pty from 'node-pty';
import type { Session } from '@shared/types/sessions.js';
import type {
  SpawnSpec,
  TerminalLocationEvent,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import { AgentObserverManager } from '../agents/AgentObserverManager.js';
import { PtyManager, type PtyManagerOptions } from './PtyManager.js';

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

describe('PtyManager', () => {
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

    onData?.('\x1b]7;file:///home/me/project\x07');

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

    onData?.('\x1b]633;P;Cwd=/home/me/vscode\x07');
    onData?.('\x1b]1337;CurrentDir=file:///home/me/iterm\x1b\\');

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

    await manager.start({ sessionId: codexSession.id });
    observer.setTuiObservedState(codexSession.id, 'working', 'thinking');
    const proc = vi.mocked(pty.spawn).mock.results.at(-1)?.value as {
      onData: { mock: { calls: Array<[(data: string) => void]> } };
    };
    const onData = proc.onData.mock.calls[0]?.[0];

    onData?.('Do you want to allow this command to run?');

    expect(observer.getSnapshot(codexSession.id)?.state).toBe('waiting_for_approval');
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
});
