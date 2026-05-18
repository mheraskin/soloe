import { ipcMain, type BrowserWindow, type IpcMainEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  DiffRpcRequest,
  DiffRpcResponse,
  DiffRpcResult
} from '@shared/types/diff-rpc.js';

export interface DiffBridgeOptions {
  getWindows: () => BrowserWindow[];
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (result: DiffRpcResult) => void;
  timer: NodeJS.Timeout;
}

export interface OpenForCommitsRequest {
  cwd: string;
  base: string;
  head: string;
  commits: string[];
  includeWorkingTree: boolean;
  focusPath?: string;
}

export class DiffBridge {
  private registered = false;
  private readonly pending = new Map<string, PendingCall>();
  private readonly timeoutMs: number;
  private readonly responseHandler = (_e: IpcMainEvent, response: DiffRpcResponse) =>
    this.handleResponse(response);

  constructor(private readonly opts: DiffBridgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  start(): void {
    if (this.registered) return;
    this.registered = true;
    ipcMain.on(IpcChannels.diff.rpcResponse, this.responseHandler);
  }

  stop(): void {
    if (!this.registered) return;
    ipcMain.off(IpcChannels.diff.rpcResponse, this.responseHandler);
    this.registered = false;
    for (const [, call] of this.pending) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, error: 'diff bridge stopped' });
    }
    this.pending.clear();
  }

  async openForCommits(args: OpenForCommitsRequest): Promise<DiffRpcResult> {
    const result = await this.send({ op: 'open_for_commits', args });
    if (result.ok) this.focusFirstWindow();
    return result;
  }

  private focusFirstWindow(): void {
    const win = this.firstLiveWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  private send(payload: {
    op: 'open_for_commits';
    args: OpenForCommitsRequest;
  }): Promise<DiffRpcResult> {
    const target = this.firstLiveWindow();
    if (!target) return Promise.resolve({ ok: false, error: 'no window available' });
    const requestId = randomUUID();
    const request: DiffRpcRequest = {
      requestId,
      ...payload
    };
    return new Promise<DiffRpcResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, error: 'renderer did not respond' });
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, timer });
      target.webContents.send(IpcChannels.diff.rpcRequest, request);
    });
  }

  private handleResponse(response: DiffRpcResponse): void {
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
