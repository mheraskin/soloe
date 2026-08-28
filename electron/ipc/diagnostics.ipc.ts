import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type { DiagnosticLogsRequest } from '@shared/types/diagnostics.js';
import type { ListSessionHookTraceRequest } from '@shared/types/session-debug.js';
import type { SessionHookTraceBuffer } from '../agents/SessionHookTraceBuffer.js';
import type { DiagnosticsService } from '../diagnostics/DiagnosticsService.js';
import { ipcInvoke } from './result.js';

export interface DiagnosticsIpcOptions {
  service: DiagnosticsService;
  sessionHookTrace: SessionHookTraceBuffer;
  getWindows: () => BrowserWindow[];
}

export class DiagnosticsIpc {
  private registered = false;
  private detachTrace: (() => void) | null = null;

  constructor(private readonly opts: DiagnosticsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.diagnostics.list, () =>
      ipcInvoke(() => this.opts.service.list())
    );
    ipcMain.handle(IpcChannels.diagnostics.crashLogs, (_event, request?: DiagnosticLogsRequest) =>
      ipcInvoke(() => this.opts.service.crashLogs(request))
    );
    ipcMain.handle(
      IpcChannels.diagnostics.sessionHookTrace,
      (_event, request?: ListSessionHookTraceRequest) =>
        ipcInvoke(() => this.opts.sessionHookTrace.list(traceLimit(request)))
    );
    ipcMain.handle(IpcChannels.diagnostics.clearSessionHookTrace, () =>
      ipcInvoke(() => {
        this.opts.sessionHookTrace.clear();
        return true;
      })
    );
    this.detachTrace = this.opts.sessionHookTrace.onEvent((event) => {
      for (const win of this.opts.getWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(IpcChannels.diagnostics.sessionHookEvent, event);
        }
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.diagnostics.list);
    ipcMain.removeHandler(IpcChannels.diagnostics.crashLogs);
    ipcMain.removeHandler(IpcChannels.diagnostics.sessionHookTrace);
    ipcMain.removeHandler(IpcChannels.diagnostics.clearSessionHookTrace);
    this.detachTrace?.();
    this.detachTrace = null;
    this.registered = false;
  }
}

function traceLimit(request: ListSessionHookTraceRequest | undefined): number {
  const limit = request?.limit ?? 5_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error('session hook trace limit must be an integer between 1 and 5000');
  }
  return limit;
}
