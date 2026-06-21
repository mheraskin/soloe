import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProjectId } from '@shared/types/projects.js';
import type {
  NoteContent,
  NoteImage,
  NoteImageData,
  NoteSummary,
  NotesChangeEvent
} from '@shared/types/notes.js';

const FORBIDDEN_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;
const MAX_FILENAME_LENGTH = 120;
const IMAGES_DIR_NAME = 'images';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
};
const MIME_BY_IMAGE_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
};

export class NotesStore {
  private listeners = new Set<(event: NotesChangeEvent) => void>();
  private writeQueues = new Map<ProjectId, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async list(projectId: ProjectId): Promise<NoteSummary[]> {
    const dir = await this.ensureProjectDir(projectId);
    const entries = await safeReaddir(dir);
    const summaries: NoteSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        summaries.push({
          filename: entry.name,
          size: stat.size,
          updatedAt: stat.mtimeMs
        });
      } catch {
        // skip files that vanished mid-list
      }
    }
    summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    return summaries;
  }

  async read(projectId: ProjectId, filename: string): Promise<NoteContent> {
    const filePath = await this.resolveExisting(projectId, filename);
    const [raw, stat] = await Promise.all([
      fs.readFile(filePath, 'utf8'),
      fs.stat(filePath)
    ]);
    return { filename, content: raw, updatedAt: stat.mtimeMs };
  }

  async write(
    projectId: ProjectId,
    filename: string,
    content: string
  ): Promise<NoteContent> {
    const safeName = sanitizeFilename(filename);
    const dir = await this.ensureProjectDir(projectId);
    const filePath = path.join(dir, safeName);
    assertWithin(dir, filePath);
    await this.queueWrite(projectId, async () => {
      await atomicWrite(filePath, content);
    });
    const stat = await fs.stat(filePath);
    const result: NoteContent = {
      filename: safeName,
      content,
      updatedAt: stat.mtimeMs
    };
    await this.broadcast(projectId);
    return result;
  }

  async rename(
    projectId: ProjectId,
    oldName: string,
    newName: string
  ): Promise<NoteSummary> {
    const oldPath = await this.resolveExisting(projectId, oldName);
    const dir = path.dirname(oldPath);
    const finalName = await this.uniqueFilename(dir, sanitizeFilename(newName), oldName);
    const newPath = path.join(dir, finalName);
    assertWithin(dir, newPath);
    await this.queueWrite(projectId, async () => {
      await fs.rename(oldPath, newPath);
    });
    const stat = await fs.stat(newPath);
    await this.broadcast(projectId);
    return { filename: finalName, size: stat.size, updatedAt: stat.mtimeMs };
  }

  async delete(projectId: ProjectId, filename: string): Promise<void> {
    const filePath = await this.resolveExisting(projectId, filename);
    await this.queueWrite(projectId, async () => {
      await fs.unlink(filePath);
    });
    await this.broadcast(projectId);
  }

  async saveImage(
    projectId: ProjectId,
    mimeType: string,
    dataBase64: string
  ): Promise<NoteImage> {
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length === 0) throw new Error('Image is empty');
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB limit');
    const ext = IMAGE_EXTENSIONS_BY_MIME[mimeType.toLowerCase()] ?? 'png';
    const dir = await this.ensureImagesDir(projectId);
    const filename = `soloe-img-${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`;
    const absolutePath = path.join(dir, filename);
    assertWithin(dir, absolutePath);
    await fs.writeFile(absolutePath, buffer);
    return { filename, absolutePath, mimeType };
  }

  // Read a note image back as base64 for inline rendering. Notes store the
  // bare absolute path (so the agent can read the file); the renderer can't
  // load it via file:// under the default webSecurity, so it round-trips the
  // bytes through here. Only paths inside the notes root are served.
  async readImage(absolutePath: string): Promise<NoteImageData> {
    const ext = path.extname(absolutePath).slice(1).toLowerCase();
    const mimeType = MIME_BY_IMAGE_EXTENSION[ext];
    if (!mimeType) throw new Error('Unsupported image type');
    // Resolve symlinks *before* the containment check: a lexical check (which
    // only collapses `..`) would let a symlink planted inside the notes dir
    // redirect readFile to an arbitrary file outside it. realpath follows the
    // link, so the comparison runs against the true target.
    let rootReal: string;
    let resolvedReal: string;
    try {
      rootReal = await fs.realpath(this.rootDir);
      resolvedReal = await fs.realpath(path.resolve(absolutePath));
    } catch {
      throw new Error('Image path not found');
    }
    const rel = path.relative(rootReal, resolvedReal);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error('Image path escapes notes directory');
    }
    const stat = await fs.stat(resolvedReal);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 20 MB limit');
    const buffer = await fs.readFile(resolvedReal);
    return { mimeType, dataBase64: buffer.toString('base64') };
  }

  // Sweep images that are no longer referenced anywhere. Reads every saved
  // note's body plus the renderer-supplied draft text, then unlinks any image
  // whose filename doesn't appear in that combined haystack. Conservative by
  // design — anything referenced anywhere stays.
  async cleanupImages(
    projectId: ProjectId,
    extraReferences: readonly string[]
  ): Promise<{ deleted: number }> {
    const dir = await this.ensureImagesDir(projectId);
    const entries = await safeReaddir(dir);
    if (entries.length === 0) return { deleted: 0 };
    const noteDir = await this.ensureProjectDir(projectId);
    const noteEntries = await safeReaddir(noteDir);
    const haystackParts: string[] = [...extraReferences];
    for (const entry of noteEntries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      try {
        haystackParts.push(await fs.readFile(path.join(noteDir, entry.name), 'utf8'));
      } catch {
        // skip unreadable note; treat as if empty
      }
    }
    const haystack = haystackParts.join('\n');
    let deleted = 0;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (haystack.includes(entry.name)) continue;
      try {
        await fs.unlink(path.join(dir, entry.name));
        deleted += 1;
      } catch {
        // best-effort; ignore
      }
    }
    return { deleted };
  }

  onChange(fn: (event: NotesChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private async resolveExisting(projectId: ProjectId, filename: string): Promise<string> {
    const safeName = sanitizeFilename(filename);
    const dir = await this.ensureProjectDir(projectId);
    const filePath = path.join(dir, safeName);
    assertWithin(dir, filePath);
    await fs.stat(filePath);
    return filePath;
  }

  private async ensureProjectDir(projectId: ProjectId): Promise<string> {
    const safeId = sanitizeProjectId(projectId);
    const dir = path.join(this.rootDir, safeId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async ensureImagesDir(projectId: ProjectId): Promise<string> {
    const projectDir = await this.ensureProjectDir(projectId);
    const dir = path.join(projectDir, IMAGES_DIR_NAME);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  private async uniqueFilename(
    dir: string,
    desired: string,
    allowOverwriteOf?: string
  ): Promise<string> {
    const allow = allowOverwriteOf ? path.basename(allowOverwriteOf) : null;
    if (await fileMissing(path.join(dir, desired)) || desired === allow) {
      return desired;
    }
    const ext = path.extname(desired) || '.md';
    const stem = desired.slice(0, desired.length - ext.length);
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${stem}-${i}${ext}`;
      if (await fileMissing(path.join(dir, candidate))) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  private queueWrite(projectId: ProjectId, op: () => Promise<void>): Promise<void> {
    const prev = this.writeQueues.get(projectId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.writeQueues.set(projectId, next);
    return next;
  }

  private async broadcast(projectId: ProjectId): Promise<void> {
    const notes = await this.list(projectId);
    const event: NotesChangeEvent = { projectId, notes };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // listener errors swallowed
      }
    }
  }
}

function sanitizeFilename(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Note filename is required');
  const stripped = trimmed.replace(FORBIDDEN_CHARS, '').replace(/^\.+/, '');
  if (!stripped || stripped === '.' || stripped === '..') {
    throw new Error('Note filename is invalid');
  }
  const withExt = /\.md$/i.test(stripped) ? stripped : `${stripped}.md`;
  if (withExt.length > MAX_FILENAME_LENGTH) {
    const ext = '.md';
    return withExt.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
  }
  return withExt;
}

function sanitizeProjectId(projectId: ProjectId): string {
  const trimmed = projectId.trim();
  if (!trimmed) throw new Error('projectId is required');
  if (FORBIDDEN_CHARS.test(trimmed) || trimmed.includes('..')) {
    throw new Error('projectId contains invalid characters');
  }
  return trimmed;
}

function assertWithin(dir: string, target: string): void {
  const rel = path.relative(dir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Note path escapes project directory');
  }
}

async function safeReaddir(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function fileMissing(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}
