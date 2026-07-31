import type { ModelCatalogEntry, Settings, SettingsUpdate } from '@shared/types/settings.js';
import { DEFAULT_SETTINGS } from '@shared/types/settings.js';
import { ipc } from '../lib/ipc';

export class SettingsStore {
  current = $state<Settings>(structuredClone(DEFAULT_SETTINGS));
  availableModels = $state<ModelCatalogEntry[]>([]);
  loaded = $state(false);
  dialogOpen = $state(false);
  // Tab the dialog should land on the next time it opens. Bumped each
  // time openDialog(tab) is called so PreferencesForm reacts even when
  // the dialog was already open.
  targetTab = $state<{ tab: string; nonce: number } | null>(null);

  private detachers: Array<() => void> = [];
  private targetTabNonce = 0;
  private changeVersion = 0;
  private reconnectRecovery: Promise<void> | null = null;

  async load(): Promise<void> {
    const changeVersion = this.changeVersion;
    const [s, availableModels] = await Promise.all([
      ipc.settings.get(),
      ipc.settings.modelCatalog().catch(() => [] as ModelCatalogEntry[])
    ]);
    if (this.changeVersion === changeVersion) this.current = withSettingsDefaults(s);
    this.availableModels = availableModels;
    this.loaded = true;
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.settings.onChange((s) => {
        this.changeVersion += 1;
        this.current = withSettingsDefaults(s);
      })
    );
    this.detachers.push(
      ipc.connection.onReconnect(() => {
        if (this.reconnectRecovery) return;
        this.reconnectRecovery = this.load()
          .catch(() => undefined)
          .finally(() => {
            this.reconnectRecovery = null;
          });
      })
    );
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers = [];
  }

  async update(patch: SettingsUpdate): Promise<void> {
    const next = await ipc.settings.update(patch);
    this.current = withSettingsDefaults(next);
    if (patch.binaries) await this.refreshModelCatalog();
  }

  async refreshModelCatalog(): Promise<void> {
    this.availableModels = await ipc.settings.modelCatalog().catch(() => this.availableModels);
  }

  openDialog(tab?: string): void {
    void this.refreshModelCatalog();
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

function withSettingsDefaults(settings: Settings): Settings {
  return {
    ...settings,
    shortcuts: {
      ...DEFAULT_SETTINGS.shortcuts,
      ...settings.shortcuts
    }
  };
}

export const settings = new SettingsStore();
