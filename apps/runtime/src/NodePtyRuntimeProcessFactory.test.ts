import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as pty from 'node-pty';
import { NodePtyRuntimeProcessFactory } from './NodePtyRuntimeProcessFactory.js';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    pid: 1234,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  }))
}));

describe('NodePtyRuntimeProcessFactory', () => {
  beforeEach(() => {
    vi.mocked(pty.spawn).mockClear();
    vi.stubEnv('NO_COLOR', '1');
  });

  it('does not inherit NO_COLOR into an interactive terminal', () => {
    const factory = new NodePtyRuntimeProcessFactory();

    factory.spawn({
      terminalId: 'terminal-1',
      sessionId: 'session-1',
      spec: {
        file: 'bash',
        args: ['-l'],
        cwd: '/tmp',
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        description: 'bash -l'
      },
      cols: 120,
      rows: 30
    });

    const options = vi.mocked(pty.spawn).mock.calls[0]?.[2];
    expect(options?.env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    });
    expect(options?.env).not.toHaveProperty('NO_COLOR');
  });
});
