import { ipcMain } from 'electron';
import { FileService, type FileIndexScope } from '@soloe/domain';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  FileOpenRequest,
  ImagePasteRequest,
  FilePasteRequest,
  FileSearchRequest,
  FileTreeRequest,
  FileReadRequest,
  FileWriteRequest
} from '@shared/types/files.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { WorktreeFileIndex } from '../files/WorktreeFileIndex.js';
import type { GitService } from '../git/GitService.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import { ipcInvoke } from './result.js';

export interface FilesIpcOptions {
  fileIndex: WorktreeFileIndex;
  store: SessionStore;
  pty: PtyManager;
  git?: GitService;
  getBinaries?: () => Promise<SettingsBinaries> | SettingsBinaries;
  authorizeScope?: (scope: FileIndexScope) => Promise<boolean>;
}

export class FilesIpc {
  private registered = false;
  private readonly service: FileService;

  constructor(private readonly opts: FilesIpcOptions) {
    this.service = new FileService({
      fileIndex: opts.fileIndex,
      runtime: {
        listRunning: async () => opts.pty.listRunning().flatMap((terminal) =>
          terminal.terminalId
            ? [{ terminalId: terminal.terminalId, sessionId: terminal.sessionId }]
            : []
        ),
        write: async (terminalId, data) => opts.pty.write(terminalId, data)
      },
      getSession: (sessionId) => opts.store.get(sessionId),
      ...(opts.git
        ? {
            revisionReader: {
              listFiles: (scope: FileIndexScope, revision: string) =>
                opts.git!.listFilesAtRevision(scope.cwd, revision, scope),
              readFile: (
                scope: FileIndexScope,
                revision: string,
                relativePath: string,
                maxBytes: number
              ) => opts.git!.readFileAtRevision(
                scope.cwd,
                revision,
                relativePath,
                maxBytes,
                scope
              )
            }
          }
        : {}),
      getEditor: async () => {
        const binaries = opts.getBinaries ? await opts.getBinaries() : {};
        return binaries.editor;
      },
      authorizeScope: opts.authorizeScope ?? (async (scope) => {
        const sessions = await opts.store.list();
        return sessions.some((session) =>
          session.cwd === scope.cwd
          && session.runMode === scope.runMode
          && (scope.runMode !== 'wsl' || session.wslDistro === scope.wslDistro)
        );
      })
    });
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.files.search, (_e, request: FileSearchRequest) =>
      ipcInvoke(() => this.service.search(request))
    );

    ipcMain.handle(IpcChannels.files.openInEditor, (_e, request: FileOpenRequest) =>
      ipcInvoke(() => this.service.openInEditor(request))
    );

    ipcMain.handle(IpcChannels.files.pasteIntoTerminal, (_e, request: FilePasteRequest) =>
      ipcInvoke(() => this.service.pasteIntoTerminal(request))
    );

    ipcMain.handle(IpcChannels.files.pasteImagesIntoTerminal, (_e, request: ImagePasteRequest) =>
      ipcInvoke(() => this.service.pasteImagesIntoTerminal(request))
    );

    ipcMain.handle(IpcChannels.files.listTree, (_e, request: FileTreeRequest) =>
      ipcInvoke(() => this.service.listTree(request))
    );

    ipcMain.handle(IpcChannels.files.readFile, (_e, request: FileReadRequest) =>
      ipcInvoke(() => this.service.readFile(request))
    );

    ipcMain.handle(IpcChannels.files.writeFile, (_e, request: FileWriteRequest) =>
      ipcInvoke(() => this.service.writeFile(request))
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
    this.service.dispose();
    this.registered = false;
  }
}
