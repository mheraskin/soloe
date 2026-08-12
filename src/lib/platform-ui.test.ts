import { describe, expect, it } from 'vitest';
import {
  agentIntegrationHostKey,
  platformBackendOptions,
  runModePathPlaceholder,
  platformRunModeOptions,
  platformShellOptions
} from './platform-ui';

describe('platform UI', () => {
  it('presents only native macOS runtime and shell choices on macOS', () => {
    expect(platformRunModeOptions({
      platform: 'macos',
      defaultRunMode: 'macos',
      availableRunModes: ['macos'],
      supportsWsl: false
    })).toEqual([{ value: 'macos', label: 'macOS' }]);
    expect(platformShellOptions('macos')).toEqual([
      'auto',
      'bash',
      'zsh',
      'pwsh',
      'custom'
    ]);
  });

  it('targets native macOS agent integrations without falling back to Windows', () => {
    expect(agentIntegrationHostKey({
      kind: 'macos',
      label: 'macOS',
      available: true
    })).toEqual({ kind: 'macos' });
  });

  it('uses a macOS-native example path for macOS sessions', () => {
    expect(runModePathPlaceholder('macos')).toBe('/Users/you/project');
  });

  it('offers only native macOS backend placement on macOS', () => {
    expect(platformBackendOptions('macos')).toEqual([
      { value: 'macos', label: 'macOS' }
    ]);
  });
});
