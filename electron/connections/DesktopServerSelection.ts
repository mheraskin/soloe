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

export function legacyExclusiveConnectionEnabled(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  return environment['SOLOE_LEGACY_EXCLUSIVE_CONNECTION'] === '1';
}
