import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
import type { SessionStatus } from '@shared/types/sessions.js';

export function deviceSessionStatus(projection: MultiDeviceSessionView): SessionStatus {
  return projection.lifecycleStatus ?? projection.runtime?.status ?? 'stopped';
}

export function deviceSessionSurface(
  projection: MultiDeviceSessionView,
  lifecyclePending = false
): 'terminal' | 'empty' {
  if (lifecyclePending) return 'empty';
  return projection.runtime?.terminalId
    && (projection.runtime.status === 'running' || projection.runtime.status === 'starting')
    ? 'terminal'
    : 'empty';
}

export function deviceTerminalPresentationKey(
  projection: MultiDeviceSessionView
): string {
  return `${projection.key}:${projection.runtime?.terminalId ?? 'stopped'}`;
}
