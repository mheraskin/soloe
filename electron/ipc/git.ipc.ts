import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  CommitsBetweenRequest,
  DiscardFilesRequest,
  FileBlameRequest,
  FileDiffRequest,
  FileLinesRequest,
  GitCheckoutRequest,
  GitCreateWorktreeRequest,
  GitCommitRequest,
  GitObservationDemandRequest,
  GitRefHistoryRequest,
  GitRecentCommitsRequest,
  GitRemoteOpRequest,
  GitRepoRequest,
  GitStatusRequest,
  RangeChangesRequest,
  ReviewDiffsRequest,
  ResolveRefsRequest,
  StageFilesRequest,
  WorkingChangesRequest,
  WorkingTreeSnapshotRequest
} from '@shared/types/git.js';
import { worktreeIdentityKey } from '@shared/worktree-identity.js';
import type { GitService } from '../git/GitService.js';
import { ipcInvoke } from './result.js';

export interface GitIpcOptions {
  service: GitService;
  getWindows: () => BrowserWindow[];
}

interface ObservationDemandState {
  desired: boolean;
  release: (() => void) | null;
  acquiring: Promise<void> | null;
}

export class GitIpc {
  private registered = false;
  private detachListener: (() => void) | null = null;
  private observationDemandByWebContents = new Map<
    number,
    Map<string, ObservationDemandState>
  >();
  private observedDemandOwners = new WeakSet<WebContents>();

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
    ipcMain.handle(IpcChannels.git.refHistory, (_e, request: GitRefHistoryRequest) =>
      ipcInvoke(() =>
        this.opts.service.listRefHistory(
          request.repoPath,
          request.limit,
          request.force,
          {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          }
        )
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
    ipcMain.handle(IpcChannels.git.createWorktree, (_e, request: GitCreateWorktreeRequest) =>
      ipcInvoke(() =>
        this.opts.service.createWorktree(
          request.repoPath,
          request.path,
          request.branch,
          request.baseRef,
          {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          }
        )
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
    ipcMain.handle(
      IpcChannels.git.workingTreeSnapshot,
      (_e, request: WorkingTreeSnapshotRequest) =>
        ipcInvoke(() =>
          this.opts.service.getWorkingTreeSnapshot(request.cwd, request.force, {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          })
        )
    );
    ipcMain.handle(
      IpcChannels.git.observationDemand,
      (event, request: GitObservationDemandRequest) =>
        ipcInvoke(async () => {
          await this.setObservationDemand(event.sender, request);
          return true as const;
        })
    );
    ipcMain.handle(IpcChannels.git.fileDiff, (_e, request: FileDiffRequest) =>
      ipcInvoke(() =>
        this.opts.service.getFileDiff(request.cwd, request.path, {
          fromPath: request.fromPath ?? null,
          contextLines: request.contextLines,
          untracked: request.untracked,
          base: request.base,
          head: request.head,
          context: {
            runMode: request.runMode,
            wslDistro: request.wslDistro
          }
        })
      )
    );
    ipcMain.handle(IpcChannels.git.reviewDiffs, (_e, request: ReviewDiffsRequest) =>
      ipcInvoke(() =>
        this.opts.service.getReviewDiffs(request.cwd, request.files, {
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
            revision: request.revision,
            context: {
              runMode: request.runMode,
              wslDistro: request.wslDistro
            }
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
    ipcMain.handle(IpcChannels.git.commit, (_e, request: GitCommitRequest) =>
      ipcInvoke(() =>
        this.opts.service.commit(request.cwd, request.message, request.stageAll ?? false, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.push, (_e, request: GitRemoteOpRequest) =>
      ipcInvoke(() =>
        this.opts.service.push(
          request.cwd,
          request.remote,
          request.branch,
          request.setUpstream ?? false,
          { runMode: request.runMode, wslDistro: request.wslDistro }
        )
      )
    );
    ipcMain.handle(IpcChannels.git.pull, (_e, request: GitRemoteOpRequest) =>
      ipcInvoke(() =>
        this.opts.service.pull(request.cwd, request.remote, request.branch, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );
    ipcMain.handle(IpcChannels.git.fetch, (_e, request: GitRemoteOpRequest) =>
      ipcInvoke(() =>
        this.opts.service.fetch(request.cwd, request.remote, {
          runMode: request.runMode,
          wslDistro: request.wslDistro
        })
      )
    );

    this.detachListener = this.opts.service.onChange((event) => {
      for (const win of this.opts.getWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IpcChannels.git.change, event);
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
    ipcMain.removeHandler(IpcChannels.git.refHistory);
    ipcMain.removeHandler(IpcChannels.git.commitsBetween);
    ipcMain.removeHandler(IpcChannels.git.rangeChanges);
    ipcMain.removeHandler(IpcChannels.git.resolveRefs);
    ipcMain.removeHandler(IpcChannels.git.checkout);
    ipcMain.removeHandler(IpcChannels.git.createWorktree);
    ipcMain.removeHandler(IpcChannels.git.workingChanges);
    ipcMain.removeHandler(IpcChannels.git.workingTreeSnapshot);
    ipcMain.removeHandler(IpcChannels.git.observationDemand);
    ipcMain.removeHandler(IpcChannels.git.fileDiff);
    ipcMain.removeHandler(IpcChannels.git.reviewDiffs);
    ipcMain.removeHandler(IpcChannels.git.fileBlame);
    ipcMain.removeHandler(IpcChannels.git.fileLines);
    ipcMain.removeHandler(IpcChannels.git.stageFiles);
    ipcMain.removeHandler(IpcChannels.git.unstageFiles);
    ipcMain.removeHandler(IpcChannels.git.discardFiles);
    ipcMain.removeHandler(IpcChannels.git.commit);
    ipcMain.removeHandler(IpcChannels.git.push);
    ipcMain.removeHandler(IpcChannels.git.pull);
    ipcMain.removeHandler(IpcChannels.git.fetch);
    this.detachListener?.();
    this.detachListener = null;
    for (const states of this.observationDemandByWebContents.values()) {
      this.releaseObservationStates(states);
    }
    this.observationDemandByWebContents.clear();
    this.observedDemandOwners = new WeakSet<WebContents>();
    this.registered = false;
  }

  private async setObservationDemand(
    owner: WebContents,
    request: GitObservationDemandRequest
  ): Promise<void> {
    const cwd = request.cwd.trim();
    if (!cwd) return;
    const key = worktreeIdentityKey(cwd, request);
    let states = this.observationDemandByWebContents.get(owner.id);
    if (!states) {
      if (!request.active) return;
      states = new Map();
      this.observationDemandByWebContents.set(owner.id, states);
      this.observeDemandOwner(owner);
    }

    let state = states.get(key);
    if (!request.active) {
      if (!state) return;
      state.desired = false;
      state.release?.();
      state.release = null;
      if (!state.acquiring) states.delete(key);
      if (states.size === 0) this.observationDemandByWebContents.delete(owner.id);
      return;
    }

    if (!state) {
      state = { desired: true, release: null, acquiring: null };
      states.set(key, state);
    } else {
      state.desired = true;
    }
    if (state.release) return;
    if (state.acquiring) return state.acquiring;

    const targetState = state;
    const targetStates = states;
    const acquiring = this.opts.service.acquireObservation(cwd, {
      runMode: request.runMode,
      wslDistro: request.wslDistro
    }).then((release) => {
      targetState.acquiring = null;
      if (targetState.desired && targetStates.get(key) === targetState) {
        targetState.release = release;
        return;
      }
      release();
      if (targetStates.get(key) === targetState) targetStates.delete(key);
      if (targetStates.size === 0) this.observationDemandByWebContents.delete(owner.id);
    }).catch((error) => {
      targetState.acquiring = null;
      if (targetStates.get(key) === targetState) targetStates.delete(key);
      if (targetStates.size === 0) this.observationDemandByWebContents.delete(owner.id);
      throw error;
    });
    targetState.acquiring = acquiring;
    return acquiring;
  }

  private observeDemandOwner(owner: WebContents): void {
    if (this.observedDemandOwners.has(owner)) return;
    this.observedDemandOwners.add(owner);
    owner.once('destroyed', () => {
      const states = this.observationDemandByWebContents.get(owner.id);
      if (!states) return;
      this.releaseObservationStates(states);
      this.observationDemandByWebContents.delete(owner.id);
    });
  }

  private releaseObservationStates(states: Map<string, ObservationDemandState>): void {
    for (const state of states.values()) {
      state.desired = false;
      state.release?.();
      state.release = null;
    }
    states.clear();
  }
}
