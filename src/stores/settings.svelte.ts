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
  private modelCatalogLoaded = false;
  private modelCatalogRequest: Promise<void> | null = null;

  async load(): Promise<void> {
    const changeVersion = this.changeVersion;
    const s = await ipc.settings.get();
    if (this.changeVersion === changeVersion) this.current = withSettingsDefaults(s);
    this.loaded = true;
    this.modelCatalogLoaded = false;
  }

  attachListeners(): void {
    this.detach();
    this.detachers.push(
      ipc.settings.onChange((s) => {
        this.changeVersion += 1;
        this.current = withSettingsDefaults(s);
        this.modelCatalogLoaded = false;
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
    if (patch.binaries) {
      this.modelCatalogLoaded = false;
      void this.ensureModelCatalog();
    }
  }

  ensureModelCatalog(): Promise<void> {
    if (this.modelCatalogLoaded) return Promise.resolve();
    if (this.modelCatalogRequest) return this.modelCatalogRequest;

    const request = ipc.settings.modelCatalog()
      .then((availableModels) => {
        this.availableModels = availableModels;
        this.modelCatalogLoaded = true;
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.modelCatalogRequest === request) this.modelCatalogRequest = null;
      });
    this.modelCatalogRequest = request;
    return request;
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

function withSettingsDefaults(settings: Settings): Settings {
  const browser = settings.browser ?? {};
  const shortcuts = settings.shortcuts ?? {};
  return {
    ...settings,
    browser: {
      ...DEFAULT_SETTINGS.browser,
      ...browser
    },
    shortcuts: {
      ...DEFAULT_SETTINGS.shortcuts,
      ...shortcuts,
      elementSourceInspector: shortcuts.elementSourceInspector?.length
        ? shortcuts.elementSourceInspector
        : [...DEFAULT_SETTINGS.shortcuts.elementSourceInspector]
    }
  };
}

export const settings = new SettingsStore();
