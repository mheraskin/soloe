import { describe, expect, it } from 'vitest';
import {
  agentIntegrationHostKey,
  platformBackendOptions,
  runModePathPlaceholder,
  platformRunModeOptions,
  platformShellOptions,
  usesMacosNativeWindowControls,
  usesMacosOverlayScrollbars
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

  it('offers only native Linux backend placement on Linux', () => {
    expect(platformBackendOptions('linux')).toEqual([
      { value: 'linux', label: 'Linux' }
    ]);
  });

  it('detects native macOS Electron window controls before backend state loads', () => {
    expect(usesMacosNativeWindowControls(
      'Mozilla/5.0 Electron/41.10.3',
      'MacIntel'
    )).toBe(true);
    expect(usesMacosNativeWindowControls(
      'Mozilla/5.0 Version/18.0 Safari/605.1.15',
      'MacIntel'
    )).toBe(false);
    expect(usesMacosNativeWindowControls(
      'Mozilla/5.0 Electron/41.10.3',
      'Win32'
    )).toBe(false);
  });

  it('detects macOS overlay scrollbars in desktop and web renderers', () => {
    expect(usesMacosOverlayScrollbars('MacIntel')).toBe(true);
    expect(usesMacosOverlayScrollbars('MacArm')).toBe(true);
    expect(usesMacosOverlayScrollbars('Win32')).toBe(false);
    expect(usesMacosOverlayScrollbars('Linux x86_64')).toBe(false);
  });
});
