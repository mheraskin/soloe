import { describe, expect, it } from 'vitest';
import { toIpcPayload } from './ipc';

describe('toIpcPayload', () => {
  it('converts proxied session drafts into structured-cloneable payloads', () => {
    const draft = new Proxy({
      kind: 'standard_terminal',
      name: 'App',
      cwd: '/workspace/app',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      shell: 'custom',
      command: 'bash',
      args: ['-lc', 'npm test']
    }, {});

    expect(() => structuredClone(draft)).toThrow();

    const payload = toIpcPayload(draft);

    expect(payload).toEqual({
      kind: 'standard_terminal',
      name: 'App',
      cwd: '/workspace/app',
      runMode: 'wsl',
      wslDistro: 'Ubuntu',
      shell: 'custom',
      command: 'bash',
      args: ['-lc', 'npm test']
    });
    expect(structuredClone(payload)).toEqual(payload);
  });
});
