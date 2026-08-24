import { afterEach, describe, expect, it, vi } from 'vitest';

describe('remote Worktree renderer routing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('forwards device-qualified pane requests and streams device events', async () => {
    const invokeWorktree = vi.fn(async () => ({
      ok: true as const,
      value: { branch: 'remote-main' }
    }));
    const listeners: {
      device?: (event: unknown) => void;
      localGit?: (event: unknown) => void;
    } = {};
    const detachDevice = vi.fn();
    const detachLocal = vi.fn();

    vi.stubGlobal('window', {
      soloe: {
        sessions: {
          invokeWorktree,
          onDeviceEvent: (listener: (event: unknown) => void) => {
            listeners.device = listener;
            return detachDevice;
          }
        },
        git: {
          onChange: (listener: (event: unknown) => void) => {
            listeners.localGit = listener;
            return detachLocal;
          }
        }
      }
    });

    const { backend } = await import('./ipc');
    const request = {
      cwd: '/srv/app',
      force: true,
      runMode: 'linux' as const,
      deviceId: 'device-xps'
    };

    await expect(backend.git.status(request)).resolves.toEqual({ branch: 'remote-main' });
    expect(invokeWorktree).toHaveBeenCalledWith({
      deviceId: 'device-xps',
      namespace: 'git',
      method: 'status',
      args: [{ cwd: '/srv/app', force: true, runMode: 'linux' }]
    });

    const listener = vi.fn();
    const detach = backend.git.onChange(listener);
    listeners.localGit?.({ cwd: '/local/app', reason: 'local' });
    listeners.device?.({
      deviceId: 'device-xps',
      event: 'git.change',
      payload: { cwd: '/srv/app', reason: 'remote' }
    });
    expect(listener).toHaveBeenNthCalledWith(1, { cwd: '/local/app', reason: 'local' });
    expect(listener).toHaveBeenNthCalledWith(2, {
      cwd: '/srv/app',
      reason: 'remote',
      deviceId: 'device-xps'
    });

    detach();
    expect(detachLocal).toHaveBeenCalledOnce();
    expect(detachDevice).toHaveBeenCalledOnce();
  });
});
