import { ipcMain, type BrowserWindow } from 'electron';
import { randomBytes } from 'node:crypto';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AskFollowUpChunk,
  AskFollowUpRequest,
  GetOverviewRequest,
  RegenerateOverviewRequest
} from '@shared/types/overview.js';
import { ipcInvoke } from './result.js';
import type { WorktreeOverviewService } from '../overview/WorktreeOverviewService.js';

export interface OverviewIpcOptions {
  service: WorktreeOverviewService;
  getWindows?: () => BrowserWindow[];
}

interface ActiveStream {
  cancel: () => void;
}

export class OverviewIpc {
  private registered = false;
  private readonly streams = new Map<string, ActiveStream>();

  constructor(private readonly opts: OverviewIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.overview.get, (_e, request: GetOverviewRequest) => {
      console.log('[overview.ipc] get →', request);
      return ipcInvoke(async () => {
        const r = await this.opts.service.getOverview(request);
        console.log('[overview.ipc] get ←', { status: r.status, hasText: !!r.text, errorMessage: r.errorMessage });
        return r;
      });
    });

    ipcMain.handle(IpcChannels.overview.regenerate, (_e, request: RegenerateOverviewRequest) => {
      console.log('[overview.ipc] regenerate →', request);
      return ipcInvoke(async () => {
        const r = await this.opts.service.regenerate(request);
        console.log('[overview.ipc] regenerate ←', {
          status: r.status,
          hasText: !!r.text,
          errorMessage: r.errorMessage,
          generatedBy: r.generatedBy
        });
        return r;
      });
    });

    ipcMain.handle(IpcChannels.overview.askStart, (_e, request: AskFollowUpRequest) =>
      ipcInvoke(async () => {
        const requestId = randomBytes(8).toString('hex');
        let cancelled = false;
        this.streams.set(requestId, { cancel: () => { cancelled = true; } });
        void this.runStream(requestId, request, () => cancelled);
        return { requestId };
      })
    );

    ipcMain.handle(IpcChannels.overview.askCancel, (_e, requestId: string) =>
      ipcInvoke(async () => {
        const stream = this.streams.get(requestId);
        if (stream) stream.cancel();
        this.streams.delete(requestId);
        return true as const;
      })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.overview.get);
    ipcMain.removeHandler(IpcChannels.overview.regenerate);
    ipcMain.removeHandler(IpcChannels.overview.askStart);
    ipcMain.removeHandler(IpcChannels.overview.askCancel);
    for (const stream of this.streams.values()) stream.cancel();
    this.streams.clear();
    this.registered = false;
  }

  private async runStream(
    requestId: string,
    request: AskFollowUpRequest,
    isCancelled: () => boolean
  ): Promise<void> {
    try {
      for await (const chunk of this.opts.service.streamFollowUp(request)) {
        if (isCancelled()) {
          this.broadcast({ requestId, type: 'done' });
          return;
        }
        const out: AskFollowUpChunk = {
          requestId,
          type: chunk.type,
          ...(chunk.text !== undefined ? { text: chunk.text } : {}),
          ...(chunk.error !== undefined ? { error: chunk.error } : {})
        };
        this.broadcast(out);
        if (chunk.type === 'done' || chunk.type === 'error') break;
      }
    } catch (err: unknown) {
      this.broadcast({
        requestId,
        type: 'error',
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      this.streams.delete(requestId);
    }
  }

  private broadcast(chunk: AskFollowUpChunk): void {
    const windows = this.opts.getWindows?.() ?? [];
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.overview.askChunk, chunk);
      }
    }
  }
}
