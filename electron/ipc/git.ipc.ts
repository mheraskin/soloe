import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  GitCheckoutRequest,
  GitRecentCommitsRequest,
  GitRepoRequest,
  GitStatusRequest
} from '@shared/types/git.js';
import type { GitService } from '../git/GitService.js';
import { ipcInvoke } from './result.js';

export interface GitIpcOptions {
  service: GitService;
  getWindows: () => BrowserWindow[];
}

export class GitIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;

  constructor(private readonly opts: GitIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.git.status, (_e, request: GitStatusRequest) =>
      ipcInvoke(() => this.opts.service.getStatus(request.cwd, request.force))
    );
    ipcMain.handle(IpcChannels.git.aheadBehind, (_e, request: GitRepoRequest) =>
      ipcInvoke(() => this.opts.service.getAheadBehind(request.repoPath))
    );
    ipcMain.handle(IpcChannels.git.shortstat, (_e, request: GitRepoRequest) =>
      ipcInvoke(() => this.opts.service.getShortstat(request.repoPath))
    );
    ipcMain.handle(IpcChannels.git.dirty, (_e, request: GitRepoRequest) =>
      ipcInvoke(() => this.opts.service.getDirty(request.repoPath))
    );
    ipcMain.handle(IpcChannels.git.worktrees, (_e, request: GitRepoRequest) =>
      ipcInvoke(() =>
        this.opts.service.listWorktrees(request.repoPath, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.branches, (_e, request: GitRepoRequest) =>
      ipcInvoke(() => this.opts.service.listLocalBranches(request.repoPath))
    );
    ipcMain.handle(IpcChannels.git.recentCommits, (_e, request: GitRecentCommitsRequest) =>
      ipcInvoke(() => this.opts.service.listRecentCommits(request.repoPath, request.limit))
    );
    ipcMain.handle(IpcChannels.git.checkout, (_e, request: GitCheckoutRequest) =>
      ipcInvoke(() => this.opts.service.checkout(request.repoPath, request.ref, request.force))
    );

    this.detachListener = this.opts.service.onChange((repoPath) => {
      for (const win of this.opts.getWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannels.git.change, { repoPath });
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.git.status);
    ipcMain.removeHandler(IpcChannels.git.aheadBehind);
    ipcMain.removeHandler(IpcChannels.git.shortstat);
    ipcMain.removeHandler(IpcChannels.git.dirty);
    ipcMain.removeHandler(IpcChannels.git.worktrees);
    ipcMain.removeHandler(IpcChannels.git.branches);
    ipcMain.removeHandler(IpcChannels.git.recentCommits);
    ipcMain.removeHandler(IpcChannels.git.checkout);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }
}
