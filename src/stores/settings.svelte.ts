import type { Settings, SettingsUpdate } from '@shared/types/settings.js';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { ipc } from '../lib/ipc';

class SettingsStore {
  current = $state<Settings>(structuredClone(DEFAULT_SETTINGS));
  loaded = $state(false);
  dialogOpen = $state(false);

  private detachers: Array<() => void> = [];

  async load(): Promise<void> {
    const s = await ipc.settings.get();
    this.current = s;
    this.loaded = true;
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.settings.onChange((s) => {
        this.current = s;
      })
    );
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }

  async update(patch: SettingsUpdate): Promise<void> {
    const next = await ipc.settings.update(patch);
    this.current = next;
  }

  openDialog(): void {
    this.dialogOpen = true;
  }

  closeDialog(): void {
    this.dialogOpen = false;
  }

  toggleDialog(): void {
    this.dialogOpen = !this.dialogOpen;
  }
}

export const settings = new SettingsStore();
