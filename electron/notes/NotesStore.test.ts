import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotesStore } from './NotesStore.js';

let tmpDir: string;
let store: NotesStore;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-notes-'));
  store = new NotesStore(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// A 1x1 transparent PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('NotesStore.readImage', () => {
  it('round-trips a saved image back to base64 with its mime type', async () => {
    const saved = await store.saveImage('proj', 'image/png', PNG_BASE64);
    const read = await store.readImage(saved.absolutePath);
    expect(read.mimeType).toBe('image/png');
    expect(read.dataBase64).toBe(PNG_BASE64);
  });

  it('rejects a symlink inside the notes root that points outside it', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soloe-outside-'));
    try {
      const secret = path.join(outsideDir, 'secret.png');
      await fs.writeFile(secret, Buffer.from(PNG_BASE64, 'base64'));
      const imagesDir = path.join(tmpDir, 'proj', 'images');
      await fs.mkdir(imagesDir, { recursive: true });
      const link = path.join(imagesDir, 'soloe-img-link.png');
      await fs.symlink(secret, link);
      await expect(store.readImage(link)).rejects.toThrow(/escapes/i);
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects an unsupported extension', async () => {
    const evil = path.join(tmpDir, 'proj', 'images', 'note.txt');
    await expect(store.readImage(evil)).rejects.toThrow(/Unsupported/i);
  });
});

describe('NotesStore concurrent writes', () => {
  it('rejects stale revisions without overwriting the newer content', async () => {
    const created = await store.write('proj', 'shared.md', 'first', null);
    const updated = await store.write(
      'proj',
      'shared.md',
      'second',
      created.revision
    );

    await expect(
      store.write('proj', 'shared.md', 'stale', created.revision)
    ).rejects.toMatchObject({ code: 'notes_conflict' });
    await expect(store.read('proj', 'shared.md')).resolves.toMatchObject({
      content: 'second',
      revision: updated.revision
    });
  });

  it('rejects create-only writes when another client already created the note', async () => {
    await store.write('proj', 'shared.md', 'first', null);
    await expect(
      store.write('proj', 'shared.md', 'second', null)
    ).rejects.toMatchObject({ code: 'notes_conflict' });
  });

  it('rejects filenames that contain path components', async () => {
    await expect(
      store.write('proj', '../outside.md', 'secret')
    ).rejects.toMatchObject({ code: 'invalid_note_filename' });
  });
});
