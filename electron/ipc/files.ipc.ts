import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  FileOpenRequest,
  FileReadRequest,
  FileReadResult,
  FileTreeRequest,
  FileTreeResult,
  FileWriteRequest,
  ImagePasteRequest,
  ImagePasteResult,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type { RunMode, Session } from '@shared/types/sessions.js';
import { effectiveAgentProvider } from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { FileSearchService } from '../files/FileSearchService.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import { ipcInvoke } from './result.js';

export interface FilesIpcOptions {
  service: FileSearchService;
  store: SessionStore;
  pty: PtyManager;
  getBinaries?: () => Promise<SettingsBinaries> | SettingsBinaries;
}

const MAX_PASTED_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

// Caps for the in-rail file tree. Trees scales further, but most repos sit
// well under this; a runaway listing should fail loud rather than freeze the
// UI.
const MAX_TREE_PATHS = 20000;
const MAX_TREE_DEPTH = 20;
const MAX_READ_BYTES = 5 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.svelte-kit',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  '__pycache__'
]);

export class FilesIpc {
  private registered = false;

  constructor(private readonly opts: FilesIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.files.search, (_e, request: FileSearchRequest) =>
      ipcInvoke(() => this.opts.service.search(request.rootPath, request.query, request.limit))
    );

    ipcMain.handle(IpcChannels.files.openInEditor, (_e, request: FileOpenRequest) =>
      ipcInvoke(async () => {
        await this.openInEditor(request.absolutePath);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.files.pasteIntoTerminal, (_e, request: FilePasteRequest) =>
      ipcInvoke(() => {
        this.opts.pty.write(request.terminalId, request.path);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.files.pasteImagesIntoTerminal, (_e, request: ImagePasteRequest) =>
      ipcInvoke(() => this.pasteImagesIntoTerminal(request))
    );

    ipcMain.handle(IpcChannels.files.listTree, (_e, request: FileTreeRequest) =>
      ipcInvoke(() => listTree(request))
    );

    ipcMain.handle(IpcChannels.files.readFile, (_e, request: FileReadRequest) =>
      ipcInvoke(() => readFileSafe(request))
    );

    ipcMain.handle(IpcChannels.files.writeFile, (_e, request: FileWriteRequest) =>
      ipcInvoke(async () => {
        await writeFileSafe(request);
        return true as const;
      })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.files.search);
    ipcMain.removeHandler(IpcChannels.files.openInEditor);
    ipcMain.removeHandler(IpcChannels.files.pasteIntoTerminal);
    ipcMain.removeHandler(IpcChannels.files.pasteImagesIntoTerminal);
    ipcMain.removeHandler(IpcChannels.files.listTree);
    ipcMain.removeHandler(IpcChannels.files.readFile);
    ipcMain.removeHandler(IpcChannels.files.writeFile);
    this.registered = false;
  }

  private async pasteImagesIntoTerminal(request: ImagePasteRequest): Promise<ImagePasteResult> {
    const session = await this.opts.store.get(request.sessionId);
    if (!session) throw new Error(`Session not found: ${request.sessionId}`);
    if (!isAgentSession(session)) {
      throw new Error('Image paste is only available for Claude and Codex sessions');
    }

    const images = request.images.slice(0, MAX_PASTED_IMAGES);
    if (images.length === 0) throw new Error('No clipboard images found');

    const target = pasteTargetForSession(session);
    await fs.mkdir(target.writeDir, { recursive: true });

    const paths: string[] = [];
    for (let i = 0; i < images.length; i += 1) {
      const image = images[i]!;
      const buffer = Buffer.from(image.dataBase64, 'base64');
      if (buffer.length === 0) throw new Error('Clipboard image was empty');
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Clipboard image is too large');
      const ext = extensionForMime(image.mimeType);
      const filename = `${Date.now()}-${i + 1}-${randomBytes(3).toString('hex')}.${ext}`;
      await fs.writeFile(path.join(target.writeDir, filename), buffer);
      paths.push(joinProviderPath(target.providerDir, filename, session.runMode));
    }

    // Trailing space so the agent's prompt cursor sits past the path, ready
    // for the user to keep typing without having to space first.
    const insertedText = paths.join(' ') + ' ';
    this.opts.pty.write(request.terminalId, insertedText);
    return { paths, insertedText };
  }

  private async openInEditor(absolutePath: string): Promise<void> {
    const binaries = this.opts.getBinaries ? await this.opts.getBinaries() : {};
    const editor = binaries.editor ?? process.env['EDITOR'] ?? 'code';
    const child = spawn(editor, [absolutePath], {
      detached: true,
      stdio: 'ignore'
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => resolve());
    });
    child.unref();
  }
}

function pasteTargetForSession(session: Session): { writeDir: string; providerDir: string } {
  const safeSessionId = session.id.replace(/[^a-zA-Z0-9_.-]/g, '-');
  if (session.runMode === 'wsl') {
    if (!session.wslDistro) throw new Error('WSL distro is required for image paste');
    const providerDir = `/tmp/soloe-images/${safeSessionId}`;
    return {
      providerDir,
      writeDir: process.platform === 'win32'
        ? wslUncPath(session.wslDistro, providerDir)
        : providerDir
    };
  }
  const providerDir = path.join(os.tmpdir(), 'soloe-images', safeSessionId);
  return { providerDir, writeDir: providerDir };
}

function isAgentSession(session: Session): boolean {
  return effectiveAgentProvider(session) !== null;
}

function wslUncPath(distro: string, linuxPath: string): string {
  const parts = linuxPath.split('/').filter(Boolean);
  return ['\\\\wsl.localhost', distro, ...parts].join('\\');
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/png':
    default:
      return 'png';
  }
}

function joinProviderPath(dir: string, filename: string, runMode: Session['runMode']): string {
  return runMode === 'wsl' ? `${dir.replace(/\/$/u, '')}/${filename}` : path.join(dir, filename);
}

// Resolve a worktree-relative cwd to a path that the host Node process can
// actually open. When Soloe runs on the Windows host and the session is in WSL,
// the session's cwd is a Linux path; the host reads it through the WSL UNC
// share. Native runs (or Linux/macOS hosts) read the path as-is.
function hostPathFor(cwd: string, runMode: RunMode, wslDistro?: string): string {
  if (runMode === 'wsl' && process.platform === 'win32') {
    if (!wslDistro) throw new Error('WSL distro required to access worktree from Windows host');
    return wslUncPath(wslDistro, cwd);
  }
  return cwd;
}

// Ensures a user-supplied relative path stays inside cwd. Rejects '..' escapes,
// absolute paths, and anything that resolves above the worktree root.
function resolveInsideCwd(cwd: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error('Absolute paths are not allowed');
  }
  const normalized = path.normalize(relativePath).replace(/^([./\\])+/u, (m) =>
    m.replace(/\\/g, '/').replace(/^\.+\//, '').replace(/^\/+/, '')
  );
  const absolute = path.resolve(cwd, normalized);
  const rel = path.relative(cwd, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path escapes worktree root');
  }
  return absolute;
}

async function listTree(request: FileTreeRequest): Promise<FileTreeResult> {
  if (!request.cwd?.trim()) throw new Error('cwd is required');
  const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
  const gitResult = await listViaGit(host);
  if (gitResult) {
    return {
      cwd: request.cwd,
      paths: gitResult.paths,
      truncated: gitResult.truncated,
      isRepo: true
    };
  }
  const walkResult = await walkDirectory(host);
  return {
    cwd: request.cwd,
    paths: walkResult.paths,
    truncated: walkResult.truncated,
    isRepo: false
  };
}

// Use `git ls-files` when the cwd is a repo — it already respects .gitignore,
// includes untracked-not-ignored entries, and beats a manual walk on big repos
// by a wide margin. Falls back silently when git isn't available or the dir
// isn't a worktree (caller switches to walkDirectory).
async function listViaGit(host: string): Promise<{ paths: string[]; truncated: boolean } | null> {
  try {
    const stat = await fs.stat(host);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-files', '-co', '--exclude-standard'], {
      cwd: host,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    let buf = '';
    let bytes = 0;
    let aborted = false;
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) {
        aborted = true;
        child.kill();
        return;
      }
      buf += chunk.toString('utf8');
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (aborted) return resolve(null);
      if (code !== 0) return resolve(null);
      const all = buf.split('\n').filter((p) => p.length > 0);
      const truncated = all.length > MAX_TREE_PATHS;
      resolve({
        paths: truncated ? all.slice(0, MAX_TREE_PATHS) : all,
        truncated
      });
    });
  });
}

// Fallback walk for non-git directories. Caps depth + total entries and skips
// known-noisy folders so a stray `node_modules` outside source control doesn't
// freeze the renderer when it tries to feed millions of paths into the tree.
async function walkDirectory(host: string): Promise<{ paths: string[]; truncated: boolean }> {
  const out: string[] = [];
  let truncated = false;
  async function recurse(dir: string, rel: string, depth: number): Promise<void> {
    if (truncated || depth > MAX_TREE_DEPTH) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_TREE_PATHS) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        await recurse(path.join(dir, entry.name), childRel, depth + 1);
      } else if (entry.isFile()) {
        out.push(rel ? `${rel}/${entry.name}` : entry.name);
      }
    }
  }
  await recurse(host, '', 0);
  return { paths: out, truncated };
}

async function readFileSafe(request: FileReadRequest): Promise<FileReadResult> {
  if (!request.cwd?.trim()) throw new Error('cwd is required');
  if (!request.relativePath?.trim()) throw new Error('relativePath is required');
  const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
  const absolute = resolveInsideCwd(host, request.relativePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error('Not a regular file');
  if (stat.size > MAX_READ_BYTES) {
    return { relativePath: request.relativePath, content: '', binary: false, size: stat.size };
  }
  const buf = await fs.readFile(absolute);
  if (looksBinary(buf)) {
    return { relativePath: request.relativePath, content: '', binary: true, size: stat.size };
  }
  return {
    relativePath: request.relativePath,
    content: buf.toString('utf8'),
    binary: false,
    size: stat.size
  };
}

async function writeFileSafe(request: FileWriteRequest): Promise<void> {
  if (!request.cwd?.trim()) throw new Error('cwd is required');
  if (!request.relativePath?.trim()) throw new Error('relativePath is required');
  const host = hostPathFor(request.cwd, request.runMode, request.wslDistro);
  const absolute = resolveInsideCwd(host, request.relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  // Atomic write: stage to a sibling then rename. Crash mid-write leaves the
  // original intact instead of corrupting it with a partial buffer.
  const tmp = `${absolute}.soloe-${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, request.content, 'utf8');
  try {
    await fs.rename(tmp, absolute);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// Sniff for NUL bytes in the first 4KB — Git's own heuristic. Cheap, catches
// images and binaries reliably, and avoids dragging in a full mime sniffer.
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 4096));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}
