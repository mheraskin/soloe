import { describe, expect, it } from 'vitest';
import { hostPlatform, nativeRunMode, platformInfo, supportedRunModes } from './platform.js';

describe('host platform', () => {
  it('maps win32 to native Windows plus optional WSL', () => {
    expect(hostPlatform('win32')).toBe('windows');
    expect(nativeRunMode('win32')).toBe('windows');
    expect(supportedRunModes('windows')).toEqual(['windows', 'wsl']);
  });

  it('maps Linux to only the native Linux runtime', () => {
    expect(platformInfo('linux')).toEqual({
      platform: 'linux',
      defaultRunMode: 'linux',
      availableRunModes: ['linux'],
      supportsWsl: false
    });
  });

  it('fails explicitly on unbuilt host platforms', () => {
    expect(() => hostPlatform('darwin')).toThrow(/does not support darwin/);
  });
});
