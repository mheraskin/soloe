import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  CommitsBetweenRequest,
  DiscardFilesRequest,
  FileBlameRequest,
  FileDiffRequest,
  FileLinesRequest,
  GitCheckoutRequest,
  GitRecentCommitsRequest,
  GitRepoRequest,
  GitStatusRequest,
  RangeChangesRequest,
  ResolveRefsRequest,
  StageFilesRequest,
  WorkingChangesRequest
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
      ipcInvoke(() =>
        this.opts.service.getStatus(request.cwd, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.aheadBehind, (_e, request: GitRepoRequest) =>
      ipcInvoke(() =>
        this.opts.service.getAheadBehind(request.repoPath, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.shortstat, (_e, request: GitRepoRequest) =>
      ipcInvoke(() =>
        this.opts.service.getShortstat(request.repoPath, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.dirty, (_e, request: GitRepoRequest) =>
      ipcInvoke(() =>
        this.opts.service.getDirty(request.repoPath, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
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
      ipcInvoke(() =>
        this.opts.service.listLocalBranches(request.repoPath, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.recentCommits, (_e, request: GitRecentCommitsRequest) =>
      ipcInvoke(() =>
        this.opts.service.listRecentCommits(request.repoPath, request.limit, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.commitsBetween, (_e, request: CommitsBetweenRequest) =>
      ipcInvoke(async () => {
        const { commits, truncated } = await this.opts.service.getCommitsBetween(
          request.cwd,
          request.base,
          request.head,
          {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          }
        );
        return { base: request.base, head: request.head, commits, truncated };
      })
    );
    ipcMain.handle(IpcChannels.git.rangeChanges, (_e, request: RangeChangesRequest) =>
      ipcInvoke(async () => {
        const changes = await this.opts.service.getRangeChanges(
          request.cwd,
          request.base,
          request.head,
          {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          }
        );
        return { base: request.base, head: request.head, changes };
      })
    );
    ipcMain.handle(IpcChannels.git.resolveRefs, (_e, request: ResolveRefsRequest) =>
      ipcInvoke(async () => ({
        resolved: await this.opts.service.resolveCommitRefs(request.cwd, request.refs, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      }))
    );
    ipcMain.handle(IpcChannels.git.checkout, (_e, request: GitCheckoutRequest) =>
      ipcInvoke(() =>
        this.opts.service.checkout(request.repoPath, request.ref, request.force, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.workingChanges, (_e, request: WorkingChangesRequest) =>
      ipcInvoke(() =>
        this.opts.service.listWorkingChanges(request.cwd, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.fileDiff, (_e, request: FileDiffRequest) =>
      ipcInvoke(() =>
        this.opts.service.getFileDiff(request.cwd, request.path, {
          fromPath: request.fromPath ?? null,
          contextLines: request.contextLines,
          base: request.base,
          head: request.head,
          context: {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          }
        })
      )
    );
    ipcMain.handle(IpcChannels.git.fileBlame, (_e, request: FileBlameRequest) =>
      ipcInvoke(() =>
        this.opts.service.getFileBlame(request.cwd, request.path, request.head ?? 'HEAD', {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.fileLines, (_e, request: FileLinesRequest) =>
      ipcInvoke(() =>
        this.opts.service.getFileLines(
          request.cwd,
          request.path,
          request.startLine,
          request.endLine,
          {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          }
        )
      )
    );
    ipcMain.handle(IpcChannels.git.stageFiles, (_e, request: StageFilesRequest) =>
      ipcInvoke(() =>
        this.opts.service.stageFiles(request.cwd, request.paths, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        }).then(() => true as const)
      )
    );
    ipcMain.handle(IpcChannels.git.unstageFiles, (_e, request: StageFilesRequest) =>
      ipcInvoke(() =>
        this.opts.service.unstageFiles(request.cwd, request.paths, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        }).then(() => true as const)
      )
    );
    ipcMain.handle(IpcChannels.git.discardFiles, (_e, request: DiscardFilesRequest) =>
      ipcInvoke(() =>
        this.opts.service.discardFiles(request.cwd, request.files, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        }).then(() => true as const)
      )
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
    ipcMain.removeHandler(IpcChannels.git.commitsBetween);
    ipcMain.removeHandler(IpcChannels.git.rangeChanges);
    ipcMain.removeHandler(IpcChannels.git.resolveRefs);
    ipcMain.removeHandler(IpcChannels.git.checkout);
    ipcMain.removeHandler(IpcChannels.git.workingChanges);
    ipcMain.removeHandler(IpcChannels.git.fileDiff);
    ipcMain.removeHandler(IpcChannels.git.fileBlame);
    ipcMain.removeHandler(IpcChannels.git.fileLines);
    ipcMain.removeHandler(IpcChannels.git.stageFiles);
    ipcMain.removeHandler(IpcChannels.git.unstageFiles);
    ipcMain.removeHandler(IpcChannels.git.discardFiles);
    this.detachListener?.();
    this.detachListener = null;
    this.registered = false;
  }
}
