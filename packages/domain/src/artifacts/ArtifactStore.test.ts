import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ArtifactStore,
  HOME_ARTIFACT_ID,
  MAX_ARTIFACT_HTML_BYTES
} from './ArtifactStore.js';

const project = { id: 'project-one', name: 'Soloe' };
const otherProject = { id: 'project-two', name: 'Elsewhere' };
let root: string;
let tick: number;
let store: ArtifactStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-artifacts-'));
  tick = 0;
  store = new ArtifactStore(root, {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++))
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('ArtifactStore', () => {
  it('creates the first artifact and a polished generated home', async () => {
    const result = await store.publish({
      project,
      requestedId: 'architecture',
      title: 'Architecture review',
      description: 'How the runtime pieces fit together.',
      html: '<!doctype html><h1>Architecture</h1>'
    });

    expect(result.homeGenerated).toBe(true);
    expect(result.artifact.id).toBe('architecture');
    const snapshot = await store.list(project);
    expect(snapshot.homeArtifactId).toBe(HOME_ARTIFACT_ID);
    expect(snapshot.artifacts).toHaveLength(2);
    expect(snapshot.artifacts[0]).toMatchObject({
      id: HOME_ARTIFACT_ID,
      isHome: true,
      homeOwnership: 'system'
    });
    const home = await store.read(project, HOME_ARTIFACT_ID);
    expect(home.html).toContain('Architecture review');
    expect(home.html).toContain('How the runtime pieces fit together.');
    expect(home.html).toContain('Search titles and descriptions');
  });

  it('refreshes generated home and revisions after later publishes', async () => {
    const first = await store.publish({
      project,
      title: 'First report',
      description: 'The first useful report.',
      html: '<h1>First</h1>'
    });
    const previousHome = await store.read(project, HOME_ARTIFACT_ID);
    const second = await store.publish({
      project,
      title: 'Second report',
      description: 'The follow-up report.',
      html: '<h1>Second</h1>'
    });
    const nextHome = await store.read(project, HOME_ARTIFACT_ID);

    expect(second.revision).not.toBe(first.revision);
    expect(nextHome.revision).not.toBe(previousHome.revision);
    expect(nextHome.html).toContain('First report');
    expect(nextHome.html).toContain('Second report');
  });

  it('edits content and metadata while preserving identity and creation time', async () => {
    const published = await store.publish({
      project,
      requestedId: 'review',
      title: 'Initial review',
      description: 'Initial findings.',
      html: '<p>before</p>'
    });
    const edited = await store.edit({
      project,
      artifactId: 'review',
      title: 'Updated review',
      description: 'Current findings.',
      html: '<p>after</p>'
    });
    const document = await store.read(project, 'review');

    expect(document).toMatchObject({
      id: 'review',
      title: 'Updated review',
      description: 'Current findings.',
      html: '<p>after</p>',
      createdAt: published.artifact.createdAt
    });
    expect(edited.artifact.revision).not.toBe(published.artifact.revision);
  });

  it('deletes a document and removes it from generated home', async () => {
    await store.publish({
      project,
      requestedId: 'temporary',
      title: 'Temporary report',
      description: 'Safe to remove.',
      html: '<p>temporary</p>'
    });
    const result = await store.delete(project, 'temporary');
    const snapshot = await store.list(project);
    const home = await store.read(project, HOME_ARTIFACT_ID);

    expect(result.deleted).toBe(true);
    expect(snapshot.artifacts.map((artifact) => artifact.id)).toEqual([HOME_ARTIFACT_ID]);
    expect(home.html).not.toContain('Temporary report');
    expect(home.html).toContain('No artifacts yet');
    await expect(fs.stat(path.join(root, project.id, 'temporary.html'))).rejects.toMatchObject({
      code: 'ENOENT'
    });
  });

  it('preserves a custom home while the normal catalog changes', async () => {
    const customHtml = '<!doctype html><main data-custom>My exact home</main>';
    await store.publish({
      project,
      title: 'My project home',
      description: 'A hand-authored project landing page.',
      html: customHtml,
      asHome: true
    });
    await store.publish({
      project,
      title: 'New report',
      description: 'Should not replace the custom home.',
      html: '<h1>New report</h1>'
    });

    const home = await store.read(project, HOME_ARTIFACT_ID);
    expect(home.homeOwnership).toBe('user');
    expect(home.html).toBe(customHtml);
  });

  it('editing the generated home makes it user-authored', async () => {
    await store.publish({
      project,
      title: 'Report',
      description: 'Creates the default home.',
      html: '<h1>Report</h1>'
    });
    await store.edit({
      project,
      artifactId: HOME_ARTIFACT_ID,
      title: 'Curated home',
      description: 'A custom knowledge landing page.',
      html: '<main>Curated</main>'
    });

    expect(await store.read(project, HOME_ARTIFACT_ID)).toMatchObject({
      title: 'Curated home',
      homeOwnership: 'user',
      html: '<main>Curated</main>'
    });
  });

  it('restores a generated home after deleting a custom home', async () => {
    await store.publish({
      project,
      requestedId: 'report',
      title: 'Remaining report',
      description: 'Remains after home restoration.',
      html: '<h1>Report</h1>'
    });
    await store.edit({
      project,
      artifactId: HOME_ARTIFACT_ID,
      title: 'Custom home',
      description: 'Temporary custom navigation.',
      html: '<main>Custom</main>'
    });
    const result = await store.delete(project, HOME_ARTIFACT_ID);
    const home = await store.read(project, HOME_ARTIFACT_ID);

    expect(result).toMatchObject({ deleted: true, restoredGeneratedHome: true });
    expect(home.homeOwnership).toBe('system');
    expect(home.html).toContain('Remaining report');
  });

  it('keeps Project catalogs and HTML separated', async () => {
    await store.publish({
      project,
      requestedId: 'shared-name',
      title: 'Project one report',
      description: 'Only belongs to Project one.',
      html: '<p>one</p>'
    });
    await store.publish({
      project: otherProject,
      requestedId: 'shared-name',
      title: 'Project two report',
      description: 'Only belongs to Project two.',
      html: '<p>two</p>'
    });

    expect((await store.read(project, 'shared-name')).html).toBe('<p>one</p>');
    expect((await store.read(otherProject, 'shared-name')).html).toBe('<p>two</p>');
  });

  it('rejects unsafe IDs and Project paths', async () => {
    const input = {
      project,
      title: 'Unsafe report',
      description: 'Must not escape storage.',
      html: '<p>unsafe</p>'
    };
    await expect(store.publish({ ...input, requestedId: '../outside' }))
      .rejects.toMatchObject({ code: 'invalid_artifact_id' });
    await expect(store.list({ id: '../outside', name: 'Unsafe' }))
      .rejects.toMatchObject({ code: 'invalid_project_id' });
  });

  it('enforces the centralized HTML size limit', async () => {
    await expect(store.publish({
      project,
      title: 'Oversized report',
      description: 'Exceeds the safe body limit.',
      html: `<!--${'x'.repeat(MAX_ARTIFACT_HTML_BYTES)}-->`
    })).rejects.toMatchObject({ code: 'artifact_too_large' });
  });

  it('reports conflicting requested IDs without overwriting', async () => {
    await store.publish({
      project,
      requestedId: 'stable',
      title: 'Stable report',
      description: 'The original report.',
      html: '<p>original</p>'
    });
    await expect(store.publish({
      project,
      requestedId: 'stable',
      title: 'Replacement report',
      description: 'Must use edit instead.',
      html: '<p>replacement</p>'
    })).rejects.toMatchObject({ code: 'artifact_id_collision' });
    expect((await store.read(project, 'stable')).html).toBe('<p>original</p>');
  });

  it('returns an idempotent not-found delete result', async () => {
    await expect(store.delete(project, 'missing')).resolves.toMatchObject({
      deleted: false,
      revision: '0'
    });
  });
});
