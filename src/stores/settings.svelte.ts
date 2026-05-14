import type { Settings, SettingsUpdate } from '@shared/types/settings.js';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { ipc } from '../lib/ipc';

class SettingsStore {
  current = $state<Settings>(structuredClone(DEFAULT_SETTINGS));
  loaded = $state(false);
  dialogOpen = $state(false);
  // Tab the dialog should land on the next time it opens. Bumped each
  // time openDialog(tab) is called so PreferencesForm reacts even when
  // the dialog was already open.
  targetTab = $state<{ tab: string; nonce: number } | null>(null);

  private detachers: Array<() => void> = [];
  private targetTabNonce = 0;

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

  openDialog(tab?: string): void {
    if (tab) {
      this.targetTabNonce += 1;
      this.targetTab = { tab, nonce: this.targetTabNonce };
    }
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
