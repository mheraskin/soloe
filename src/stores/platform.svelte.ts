import type { HostPlatformInfo } from '@shared/types/system.js';
import { ipc } from '../lib/ipc';

const FALLBACK: HostPlatformInfo = {
  platform: 'windows',
  defaultRunMode: 'windows',
  availableRunModes: ['windows', 'wsl'],
  supportsWsl: true
};

class PlatformStore {
  current = $state<HostPlatformInfo>(FALLBACK);
  loaded = $state(false);

  async load(): Promise<void> {
    this.current = await ipc.system.platform();
    this.loaded = true;
  }
}

export const platform = new PlatformStore();
