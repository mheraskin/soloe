import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@shared/types/sessions.js';
import type { SpawnSpec } from '@shared/types/terminal.js';
import { CodexConfigReader, codexApprovalsAreAutomatic } from './CodexConfigReader.js';
import type { PtyProcess, PtyProcessFactory } from '../terminal/PtyProcess.js';

const session: Session = {
  id: 'codex-session',
  name: 'Codex',
  cwd: '/workspace/project',
  runMode: 'linux',
  launch: { type: 'agent', provider: 'codex', resumeMode: 'new' },
  createdAt: '2026-07-31T00:00:00.000Z',
  lastUsedAt: '2026-07-31T00:00:00.000Z'
};

const spec: SpawnSpec = {
  file: 'codex',
  args: ['app-server'],
  cwd: session.cwd,
  env: {},
  description: 'codex app-server'
};

describe('CodexConfigReader', () => {
  it('reads layered effective config through app-server config/read and caches it', async () => {
    const process = fakeProcess((message, emit) => {
      if (message.id !== 2) return;
      queueMicrotask(() => emit(
        `${JSON.stringify(message)}\r\n`
        + 'startup warning\r\n'
        + JSON.stringify({
          id: 2,
          result: {
            config: {
              approval_policy: 'on-request',
              approvals_reviewer: 'auto_review',
              sandbox_mode: 'workspace-write'
            },
            layers: [{ name: { type: 'project' } }],
            origins: { approvals_reviewer: { name: { type: 'user' } } }
          }
        })
        + '\r\n'
      ));
    });
    const factory = {
      spawn: vi.fn(async () => process)
    } satisfies PtyProcessFactory;
    const commandBuilder = {
      buildCodexConfigRead: vi.fn(() => spec)
    };
    const reader = new CodexConfigReader({
      commandBuilder: commandBuilder as never,
      processFactory: factory,
      baseEnv: {},
      timeoutMs: 1000
    });

    const first = await reader.read(session);
    const second = await reader.read(session);

    expect(first).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandboxMode: 'workspace-write',
      layers: [{ name: { type: 'project' } }]
    });
    expect(codexApprovalsAreAutomatic(first)).toBe(true);
    expect(second).toBe(first);
    expect(factory.spawn).toHaveBeenCalledOnce();
    expect(process.writes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'config/read',
        params: { cwd: session.cwd, includeLayers: true }
      })
    ]));
    expect(process.kill).toHaveBeenCalledOnce();
  });
});

function fakeProcess(
  onWrite: (message: Record<string, unknown>, emit: (data: string) => void) => void
): PtyProcess & { writes: Record<string, unknown>[]; kill: ReturnType<typeof vi.fn> } {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | null = null;
  const writes: Record<string, unknown>[] = [];
  const kill = vi.fn(() => {
    exitListener?.({ exitCode: 0 });
  });
  return {
    pid: 123,
    writes,
    kill,
    onData(listener) {
      dataListener = listener;
      return { dispose: () => { dataListener = null; } };
    },
    onExit(listener) {
      exitListener = listener;
      return { dispose: () => { exitListener = null; } };
    },
    write(data) {
      const message = JSON.parse(data) as Record<string, unknown>;
      writes.push(message);
      onWrite(message, (output) => dataListener?.(output));
    },
    resize: vi.fn()
  };
}
