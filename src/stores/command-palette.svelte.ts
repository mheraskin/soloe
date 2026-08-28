import type { DeviceId } from '@shared/types/devices.js';

export type CommandPaletteMode = 'commands' | 'open-project';

class CommandPaletteStore {
  isOpen = $state(false);
  mode = $state<CommandPaletteMode>('commands');
  projectDeviceId = $state<DeviceId | null>(null);

  open(mode: CommandPaletteMode = 'commands'): void {
    this.mode = mode;
    this.isOpen = true;
  }

  show(): void {
    this.open();
  }

  openProject(deviceId: DeviceId | null = null): void {
    this.projectDeviceId = deviceId;
    this.open('open-project');
  }

  close(): void {
    this.isOpen = false;
    this.mode = 'commands';
    this.projectDeviceId = null;
  }

  toggle(): void {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }
}

export const commandPalette = new CommandPaletteStore();
