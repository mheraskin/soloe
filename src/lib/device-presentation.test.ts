import { describe, expect, it } from 'vitest';
import type { CockpitDeviceSummary } from '@shared/types/cockpit.js';
import {
  devicePresentation,
  sessionDevicePresentation
} from './device-presentation.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

describe('devicePresentation', () => {
  it('uses a green dot and only the Device name while it is available', () => {
    expect(devicePresentation(device('ready'))).toEqual({
      label: 'Studio Mac',
      actionable: true,
      tone: 'online',
      dot: true
    });
  });

  it.each([
    ['offline', 'Studio Mac · Offline', 'offline'],
    ['degraded', 'Studio Mac · Unavailable', 'offline'],
    ['provisional', 'Studio Mac · Unavailable', 'offline'],
    ['connecting', 'Studio Mac · Connecting', 'connecting'],
    ['incompatible', 'Studio Mac · Update Soloe', 'update']
  ] as const)('makes %s Devices non-actionable with plain-language status', (state, label, tone) => {
    expect(devicePresentation(device(state))).toEqual({
      label,
      actionable: false,
      tone,
      dot: false
    });
  });

  it('makes a cached Session unavailable when its owning Device is absent', () => {
    expect(sessionDevicePresentation(DEVICE_ID, [])).toEqual({
      label: 'Unknown Device · Offline',
      actionable: false,
      tone: 'offline',
      dot: false
    });
  });

  function device(state: CockpitDeviceSummary['state']): CockpitDeviceSummary {
    return { deviceId: DEVICE_ID, name: 'Studio Mac', state };
  }
});
