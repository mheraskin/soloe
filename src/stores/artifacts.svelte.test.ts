/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ArtifactCatalogSnapshot,
  ArtifactDocument,
  ArtifactsChangeEvent
} from '@shared/types/artifacts.js';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  prepareFrame: vi.fn(),
  remove: vi.fn(),
  changes: { emit: (_event: ArtifactsChangeEvent): void => {} }
}));

vi.mock('../lib/ipc', () => ({
  ipc: {
    artifacts: {
      list: mocks.list,
      read: mocks.read,
      prepareFrame: mocks.prepareFrame,
      delete: mocks.remove,
      onChange: vi.fn((callback: (event: ArtifactsChangeEvent) => void) => {
        mocks.changes.emit = callback;
        return () => undefined;
      })
    },
    connection: { onReconnect: vi.fn(() => () => undefined) }
  }
}));

import { ArtifactsStore } from './artifacts.svelte';

const project = { id: 'project-one', name: 'Project one' };

function snapshot(revision: string): ArtifactCatalogSnapshot {
  return {
    projectId: project.id,
    projectName: project.name,
    revision,
    homeArtifactId: 'home',
    artifacts: [{
      id: 'home',
      projectId: project.id,
      title: 'Project one artifacts',
      description: 'Overview.',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      revision: `home-${revision}`,
      isHome: true,
      homeOwnership: 'system'
    }]
  };
}

function document(id: string, catalog: ArtifactCatalogSnapshot): ArtifactDocument {
  const artifact = catalog.artifacts.find((candidate) => candidate.id === id);
  if (!artifact) throw new Error(`Unknown test artifact: ${id}`);
  return {
    ...artifact,
    html: `<main>${artifact.title}</main>`,
    catalogRevision: catalog.revision
  };
}

beforeEach(() => {
  localStorage.clear();
  mocks.list.mockReset();
  mocks.read.mockReset();
  mocks.prepareFrame.mockReset();
  mocks.remove.mockReset();
});

describe('ArtifactsStore', () => {
  it('shows unread activity for unseen revisions and only clears it when marked seen', async () => {
    mocks.list.mockResolvedValue(snapshot('revision-one'));
    const store = new ArtifactsStore();
    store.attachListeners();

    await store.ensureCatalog(project);
    expect(store.unread(project.id)).toBe(true);
    store.markSeen(project.id);
    expect(store.unread(project.id)).toBe(false);

    mocks.changes.emit({ projectId: project.id, snapshot: snapshot('revision-two') });
    expect(store.unread(project.id)).toBe(true);
  });

  it('loads metadata without opening a document', async () => {
    mocks.list.mockResolvedValue(snapshot('revision-one'));
    const store = new ArtifactsStore();

    await store.ensureCatalog(project);

    expect(store.documentsByProject[project.id]).toBeUndefined();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('opens home explicitly and keeps the seen revision Project-scoped', async () => {
    const catalog = snapshot('revision-one');
    const document: ArtifactDocument = {
      ...catalog.artifacts[0]!,
      html: '<main>Home</main>',
      catalogRevision: catalog.revision
    };
    mocks.list.mockResolvedValue(catalog);
    mocks.read.mockResolvedValue(document);
    mocks.prepareFrame.mockResolvedValue({ url: 'soloe-artifact://frame/home-ticket' });
    const store = new ArtifactsStore();

    await store.openHome(project);
    store.markSeen(project.id);

    expect(store.documentsByProject[project.id]?.html).toBe('<main>Home</main>');
    expect(store.frameSourcesByProject[project.id]?.url)
      .toBe('soloe-artifact://frame/home-ticket');
    expect(mocks.prepareFrame).toHaveBeenCalledWith('<main>Home</main>');
    expect(store.unread(project.id)).toBe(false);
    expect(store.unread('another-project')).toBe(false);
  });

  it('tracks backward and forward artifact navigation per Project', async () => {
    const catalog = snapshot('revision-one');
    catalog.artifacts.push(
      {
        ...catalog.artifacts[0]!,
        id: 'implementation-handoff',
        title: 'Implementation handoff',
        revision: 'handoff-revision',
        isHome: false,
        homeOwnership: null
      },
      {
        ...catalog.artifacts[0]!,
        id: 'orchestration-status',
        title: 'Orchestration status',
        revision: 'status-revision',
        isHome: false,
        homeOwnership: null
      }
    );
    mocks.list.mockResolvedValue(catalog);
    mocks.read.mockImplementation(async (_project, artifactId: string) =>
      document(artifactId, catalog)
    );
    mocks.prepareFrame.mockImplementation(async (html: string) => ({
      url: `soloe-artifact://frame/${encodeURIComponent(html)}`
    }));
    const store = new ArtifactsStore();

    await store.openHome(project);
    expect(store.canGoBack(project.id)).toBe(false);
    expect(store.canGoForward(project.id)).toBe(false);
    await expect(store.back(project)).resolves.toBeNull();

    await store.openArtifact(project, 'implementation-handoff');
    await store.openArtifact(project, 'orchestration-status');
    expect(store.canGoBack(project.id)).toBe(true);
    expect(store.canGoForward(project.id)).toBe(false);

    await store.back(project);
    expect(store.documentsByProject[project.id]?.id).toBe('implementation-handoff');
    expect(store.canGoBack(project.id)).toBe(true);
    expect(store.canGoForward(project.id)).toBe(true);

    await store.back(project);
    expect(store.documentsByProject[project.id]?.id).toBe('home');
    expect(store.canGoBack(project.id)).toBe(false);
    expect(store.canGoForward(project.id)).toBe(true);

    await store.forward(project);
    expect(store.documentsByProject[project.id]?.id).toBe('implementation-handoff');
    expect(store.canGoBack(project.id)).toBe(true);
    expect(store.canGoForward(project.id)).toBe(true);

    await store.openArtifact(project, 'home');
    expect(store.canGoBack(project.id)).toBe(true);
    expect(store.canGoForward(project.id)).toBe(false);
  });
});
