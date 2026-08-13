import { describe, expect, it } from 'vitest';

import {
  resolveDesktopServerSelection,
  resolveDeviceServerEndpoint
} from './DesktopServerSelection.js';

describe('resolveDesktopServerSelection', () => {
  it('ignores legacy active Device selection during normal multi-device startup', () => {
    expect(resolveDesktopServerSelection({
      localServerUrl: 'http://127.0.0.1:4317',
      activeRemoteEndpoint: 'https://build.tail.example',
      legacyExclusiveEnabled: false
    })).toEqual({
      serverUrl: 'http://127.0.0.1:4317',
      selectedRemoteWebHost: false
    });
  });

  it('retains exclusive selection only behind its explicit compatibility flag', () => {
    expect(resolveDesktopServerSelection({
      localServerUrl: 'http://127.0.0.1:4317',
      activeRemoteEndpoint: 'https://build.tail.example',
      legacyExclusiveEnabled: true
    })).toEqual({
      serverUrl: 'https://build.tail.example',
      selectedRemoteWebHost: true
    });
  });

  it('starts native local services when no local server exists in normal mode', () => {
    expect(resolveDesktopServerSelection({
      localServerUrl: null,
      activeRemoteEndpoint: 'https://build.tail.example',
      legacyExclusiveEnabled: false
    })).toEqual({ serverUrl: null, selectedRemoteWebHost: false });
  });
});

describe('resolveDeviceServerEndpoint', () => {
  it('separates the trusted Device origin from the browser bootstrap URL', () => {
    expect(resolveDeviceServerEndpoint(
      'http://127.0.0.1:4317/?token=browser-bootstrap-secret'
    )).toBe('http://127.0.0.1:4317');
  });

  it('preserves the absence of a local Application Server', () => {
    expect(resolveDeviceServerEndpoint(null)).toBeNull();
  });
});
