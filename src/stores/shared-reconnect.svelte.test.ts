import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/types/projects.js';
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings.js';

const mocks = vi.hoisted(() => ({
  projectList: vi.fn(),
  settingsGet: vi.fn(),
  settingsModelCatalog: vi.fn(async () => []),
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
