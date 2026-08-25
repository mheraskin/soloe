import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
import type { SessionStatus } from '@shared/types/sessions.js';
import { TerminalResidency } from './terminal-residency';

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

export class DeviceTerminalResidency {
  private readonly residency: TerminalResidency;

  constructor(maxResidents = 4) {
    this.residency = new TerminalResidency(maxResidents);
  }

  reconcile(
    projections: readonly MultiDeviceSessionView[],
    selected: MultiDeviceSessionView | null
  ): MultiDeviceSessionView[] {
    const live = projections.filter((projection) => deviceSessionSurface(projection) === 'terminal');
    const byKey = new Map(live.map((projection) => [
      deviceTerminalPresentationKey(projection),
      projection
    ]));
    const selectedKey = selected && deviceSessionSurface(selected) === 'terminal'
      ? deviceTerminalPresentationKey(selected)
      : null;
    return this.residency.reconcile({
      liveSessionIds: [...byKey.keys()],
      visibleSessionIds: selectedKey ? [selectedKey] : []
    }).flatMap((key) => {
      const projection = byKey.get(key);
      return projection ? [projection] : [];
    });
  }
}
