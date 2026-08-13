export interface DesktopServerSelectionInput {
  localServerUrl: string | null;
  activeRemoteEndpoint: string | null;
  legacyExclusiveEnabled: boolean;
}

export interface DesktopServerSelection {
  serverUrl: string | null;
  selectedRemoteWebHost: boolean;
}

export function resolveDesktopServerSelection(
  input: DesktopServerSelectionInput
): DesktopServerSelection {
  if (input.legacyExclusiveEnabled && input.activeRemoteEndpoint) {
    return {
      serverUrl: input.activeRemoteEndpoint,
      selectedRemoteWebHost: true
    };
  }
  return {
    serverUrl: input.localServerUrl,
    selectedRemoteWebHost: false
  };
}

/**
 * The Electron renderer may need a bootstrap token in its page URL, but Device
 * transports only accept a trusted HTTP(S) root. Keep those two concerns
 * separate so browser credentials never become part of a Device endpoint.
 */
export function resolveDeviceServerEndpoint(serverUrl: string | null): string | null {
  if (!serverUrl) return null;
  return new URL(serverUrl).origin;
}

export function legacyExclusiveConnectionEnabled(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  return environment['SOLOE_LEGACY_EXCLUSIVE_CONNECTION'] === '1';
}
