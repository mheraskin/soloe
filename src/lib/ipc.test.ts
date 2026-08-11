import { describe, expect, it } from 'vitest';
import { toIpcPayload } from './ipc';

describe('toIpcPayload', () => {
  it('converts proxied session drafts into structured-cloneable payloads', () => {
    const draft = new Proxy({
      name: 'App',
      cwd: '/workspace/app',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: {
        type: 'terminal',
        shell: 'custom',
        command: 'bash',
        args: ['-lc', 'npm test']
      }
    }, {});

    expect(() => structuredClone(draft)).toThrow();

    const payload = toIpcPayload(draft);

    expect(payload).toEqual({
      name: 'App',
      cwd: '/workspace/app',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      launch: {
        type: 'terminal',
        shell: 'custom',
        command: 'bash',
        args: ['-lc', 'npm test']
      }
    });
    expect(structuredClone(payload)).toEqual(payload);
  });
});
