import { spawn } from 'node:child_process';
import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  FileOpenRequest,
  FilePasteRequest,
  FileSearchRequest
} from '@shared/types/files.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { FileSearchService } from '../files/FileSearchService.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import { ipcInvoke } from './result.js';

export interface FilesIpcOptions {
  service: FileSearchService;
  pty: PtyManager;
  getBinaries?: () => Promise<SettingsBinaries> | SettingsBinaries;
}

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
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.files.search);
    ipcMain.removeHandler(IpcChannels.files.openInEditor);
    ipcMain.removeHandler(IpcChannels.files.pasteIntoTerminal);
    this.registered = false;
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
