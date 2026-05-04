import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  FileOpenRequest,
  ImagePasteRequest,
  ImagePasteResult,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type { Session } from '@shared/types/sessions.js';
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
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.files.search);
    ipcMain.removeHandler(IpcChannels.files.openInEditor);
    ipcMain.removeHandler(IpcChannels.files.pasteIntoTerminal);
    ipcMain.removeHandler(IpcChannels.files.pasteImagesIntoTerminal);
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

    const insertedText = paths.join(' ');
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
  return session.kind === 'claude_code'
    || session.kind === 'codex'
    || session.currentAgentRuntime?.provider === 'claude_code'
    || session.currentAgentRuntime?.provider === 'codex';
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
