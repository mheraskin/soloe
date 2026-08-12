import { describe, expect, it } from 'vitest';

import { resolveDesktopServerSelection } from './DesktopServerSelection.js';

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
