import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/types/projects.js';
import {
  DEFAULT_SETTINGS,
  type ModelCatalogEntry,
  type Settings
} from '@shared/types/settings.js';

const mocks = vi.hoisted(() => ({
  projectList: vi.fn(),
  settingsGet: vi.fn(),
  settingsUpdate: vi.fn(),
  settingsModelCatalog: vi.fn(async (): Promise<ModelCatalogEntry[]> => []),
  projectChanges: {
    emit: (_projects: Project[]): void => {}
  },
  settingsChanges: {
    emit: (_settings: Settings): void => {}
  },
  reconnects: {
    emit: (): void => {}
  }
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    projects: {
      list: mocks.projectList,
      onChange: vi.fn((callback: (projects: Project[]) => void) => {
        mocks.projectChanges.emit = callback;
        return () => undefined;
      })
    },
    settings: {
      get: mocks.settingsGet,
      update: mocks.settingsUpdate,
      modelCatalog: mocks.settingsModelCatalog,
      onChange: vi.fn((callback: (settings: Settings) => void) => {
        mocks.settingsChanges.emit = callback;
        return () => undefined;
      })
    },
    connection: {
      onReconnect: vi.fn((callback: () => void) => {
        mocks.reconnects.emit = callback;
        return () => undefined;
      })
    }
  }
}));

import { ProjectsStore } from './projects.svelte';
import { SettingsStore } from './settings.svelte';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SettingsStore loading', () => {
  it('does not start model catalog discovery until it is requested', async () => {
    const catalog = deferred<ModelCatalogEntry[]>();
    const discoveredModels: ModelCatalogEntry[] = [
      { provider: 'codex', id: 'gpt-test', label: 'GPT Test' }
    ];
    mocks.settingsGet.mockResolvedValueOnce(settings('light'));
    mocks.settingsModelCatalog.mockReturnValueOnce(catalog.promise);
    const store = new SettingsStore();

    await store.load();

    expect(store.loaded).toBe(true);
    expect(store.current.appearance.theme).toBe('light');
    expect(store.availableModels).toEqual([]);
    expect(mocks.settingsModelCatalog).not.toHaveBeenCalled();

    store.openDialog('appearance');
    expect(store.dialogOpen).toBe(true);
    expect(mocks.settingsModelCatalog).not.toHaveBeenCalled();

    void store.ensureModelCatalog();
    void store.ensureModelCatalog();

    expect(mocks.settingsModelCatalog).toHaveBeenCalledTimes(1);

    catalog.resolve(discoveredModels);
    await vi.waitFor(() => expect(store.availableModels).toEqual(discoveredModels));
  });

  it('does not wait for discovery after a binary setting changes', async () => {
    const catalog = deferred<ModelCatalogEntry[]>();
    mocks.settingsUpdate.mockResolvedValueOnce(settings('dark'));
    mocks.settingsModelCatalog.mockReturnValueOnce(catalog.promise);
    const store = new SettingsStore();

    const updating = store.update({ binaries: { codex: '/opt/codex' } });
    const finishedPromptly = await Promise.race([
      updating.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 50))
    ]);

    expect(finishedPromptly).toBe(true);
    expect(store.current.appearance.theme).toBe('dark');
    expect(mocks.settingsModelCatalog).toHaveBeenCalledTimes(1);

    catalog.resolve([]);
  });
});

describe('shared store reconnect recovery', () => {
  it('fills shortcut defaults when an older backend returns legacy settings', async () => {
    const legacy = structuredClone(DEFAULT_SETTINGS) as Partial<Settings>;
    delete legacy.shortcuts;
    mocks.settingsGet.mockResolvedValueOnce(legacy as Settings);
    const store = new SettingsStore();

    await store.load();

    expect(store.current.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts);
  });

  it('keeps a project change event that arrives during a reconnect refresh', async () => {
    const pending = deferred<Project[]>();
    mocks.projectList.mockReturnValueOnce(pending.promise);
    const store = new ProjectsStore();
    store.attachListeners();

    mocks.reconnects.emit();
    await vi.waitFor(() => expect(mocks.projectList).toHaveBeenCalledTimes(1));
    mocks.projectChanges.emit([project('newer')]);
    pending.resolve([project('stale')]);
    await pending.promise;
    await Promise.resolve();

    expect(store.projects).toEqual([project('newer')]);
    store.detach();
  });

  it('keeps a settings change event that arrives during a reconnect refresh', async () => {
    const pending = deferred<Settings>();
    mocks.settingsGet.mockReturnValueOnce(pending.promise);
    const store = new SettingsStore();
    store.attachListeners();
    const newer = settings('light');

    mocks.reconnects.emit();
    await vi.waitFor(() => expect(mocks.settingsGet).toHaveBeenCalledTimes(1));
    mocks.settingsChanges.emit(newer);
    pending.resolve(settings('dark'));
    await pending.promise;
    await Promise.resolve();

    expect(store.current).toEqual(newer);
    store.detach();
  });
});

function project(id: string): Project {
  return {
    id,
    name: id,
    path: `/repo/${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z'
  };
}

function settings(theme: Settings['appearance']['theme']): Settings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    appearance: { theme }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
