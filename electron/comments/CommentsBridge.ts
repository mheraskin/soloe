import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  CommentsRpcRequest,
  CommentsRpcResponse,
  CommentsRpcResult
} from '@shared/types/comments-rpc.js';

export interface CommentsBridgeOptions {
  getWindows: () => BrowserWindow[];
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (result: CommentsRpcResult) => void;
  timer: NodeJS.Timeout;
}

export class CommentsBridge {
  private registered = false;
  private readonly pending = new Map<string, PendingCall>();
  private readonly timeoutMs: number;
  private readonly responseHandler = (_e: IpcMainEvent, response: CommentsRpcResponse) =>
    this.handleResponse(response);

  constructor(private readonly opts: CommentsBridgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  start(): void {
    if (this.registered) return;
    this.registered = true;
    ipcMain.on(IpcChannels.comments.rpcResponse, this.responseHandler);
  }

  stop(): void {
    if (!this.registered) return;
    ipcMain.off(IpcChannels.comments.rpcResponse, this.responseHandler);
    this.registered = false;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, error: 'comments bridge stopped' });
    }
    this.pending.clear();
  }

  resolveComment(id: string): Promise<CommentsRpcResult> {
    return this.send({ op: 'resolve', args: { id } });
  }

  resolveCommentsBatch(ids: string[]): Promise<CommentsRpcResult> {
    return this.send({ op: 'resolve_batch', args: { ids } });
  }

  private send(
    payload:
      | { op: 'resolve'; args: { id: string } }
      | { op: 'resolve_batch'; args: { ids: string[] } }
  ): Promise<CommentsRpcResult> {
    const target = this.firstLiveWindow();
    if (!target) return Promise.resolve({ ok: false, error: 'no window available' });
    const requestId = randomUUID();
    const request: CommentsRpcRequest = {
      requestId,
      ...payload
    } as CommentsRpcRequest;
    return new Promise<CommentsRpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'renderer did not respond' });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      target.webContents.send(IpcChannels.comments.rpcRequest, request);
    });
  }

  private handleResponse(response: CommentsRpcResponse): void {
    const call = this.pending.get(response.requestId);
    if (!call) return;
    this.pending.delete(response.requestId);
    clearTimeout(call.timer);
    call.resolve(response.result);
  }

  private firstLiveWindow(): BrowserWindow | null {
    for (const win of this.opts.getWindows()) {
      if (!win.isDestroyed()) return win;
    }
    return null;
  }
}
