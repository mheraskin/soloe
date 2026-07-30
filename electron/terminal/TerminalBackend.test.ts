import { describe, expect, it } from 'vitest';
import { NodePtyProcessFactory } from './NodePtyProcessFactory.js';
import { RustPtyProcessFactory } from './RustPtyProcessFactory.js';
import { defaultRustSidecarPath, selectTerminalBackend } from './TerminalBackend.js';

const baseOptions = {
  appPath: '/workspace/soloe',
  isPackaged: false,
  resourcesPath: '/opt/soloe/resources',
  platform: 'linux' as const
};

describe('terminal backend selection', () => {
  it('keeps node-pty as the default', () => {
    const selected = selectTerminalBackend({ ...baseOptions, env: {} });

    expect(selected.name).toBe('node');
    expect(selected.processFactory).toBeInstanceOf(NodePtyProcessFactory);
  });

  it('selects an explicitly built Rust sidecar', () => {
    const selected = selectTerminalBackend({
      ...baseOptions,
      env: {
        SOLOE_TERMINAL_BACKEND: 'rust',
        SOLOE_TERMINAL_SIDECAR_PATH: '/tmp/soloe-terminal-sidecar'
      },
      pathExists: () => true
    });

    expect(selected.name).toBe('rust');
    expect(selected.sidecarPath).toBe('/tmp/soloe-terminal-sidecar');
    expect(selected.processFactory).toBeInstanceOf(RustPtyProcessFactory);
  });

  it('uses the packaged resources bin directory', () => {
    expect(defaultRustSidecarPath({ ...baseOptions, isPackaged: true }))
      .toBe('/opt/soloe/resources/bin/soloe-terminal-sidecar');
  });

  it('preserves Windows drive and UNC path semantics on every host', () => {
    expect(defaultRustSidecarPath({
      ...baseOptions,
      appPath: 'D:\\projects\\soloe',
      platform: 'win32'
    })).toBe('D:\\projects\\soloe\\target\\release\\soloe-terminal-sidecar.exe');
    expect(defaultRustSidecarPath({
      ...baseOptions,
      isPackaged: true,
      resourcesPath: '\\\\server\\share\\soloe',
      platform: 'win32'
    })).toBe('\\\\server\\share\\soloe\\bin\\soloe-terminal-sidecar.exe');
  });

  it('fails early when the requested sidecar is absent', () => {
    expect(() => selectTerminalBackend({
      ...baseOptions,
      env: { SOLOE_TERMINAL_BACKEND: 'rust' },
      pathExists: () => false
    })).toThrow('Rust terminal sidecar not found');
  });
});
