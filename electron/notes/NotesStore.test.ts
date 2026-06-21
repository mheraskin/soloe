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

  it('rejects a path that escapes the notes root', async () => {
    const outside = path.join(tmpDir, '..', 'secret.png');
    await expect(store.readImage(outside)).rejects.toThrow(/escapes/i);
  });

  it('rejects an unsupported extension', async () => {
    const evil = path.join(tmpDir, 'proj', 'images', 'note.txt');
    await expect(store.readImage(evil)).rejects.toThrow(/Unsupported/i);
  });
});
