import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';

export function deviceTerminalPresentationKey(
  projection: MultiDeviceSessionView
): string {
  return `${projection.key}:${projection.runtime?.terminalId ?? 'stopped'}`;
}
