import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type { DiagnosticsService } from '../diagnostics/DiagnosticsService.js';
import { ipcInvoke } from './result.js';

export interface DiagnosticsIpcOptions {
  service: DiagnosticsService;
}

export class DiagnosticsIpc {
  private registered = false;

  constructor(private readonly opts: DiagnosticsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.diagnostics.list, () =>
      ipcInvoke(() => this.opts.service.list())
    );
    ipcMain.handle(IpcChannels.diagnostics.crashLogs, () =>
      ipcInvoke(() => this.opts.service.crashLogs())
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.diagnostics.list);
    ipcMain.removeHandler(IpcChannels.diagnostics.crashLogs);
    this.registered = false;
  }
}
