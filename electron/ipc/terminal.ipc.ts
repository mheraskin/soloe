import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  TerminalInputPayload,
  TerminalResizePayload
} from '@shared/types/ipc.js';
import type { SessionId } from '@shared/types/sessions.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import { ipcInvoke } from './result.js';

export interface TerminalIpcOptions {
  pty: PtyManager;
  getWindows: () => BrowserWindow[];
}

export class TerminalIpc {
  private registered = false;
  private listeners: Array<() => void> = [];

  constructor(private readonly opts: TerminalIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.terminal.start, (_e, options: TerminalStartOptions) =>
      ipcInvoke(() => this.opts.pty.start(options))
    );

    ipcMain.handle(IpcChannels.terminal.stop, (_e, terminalId: TerminalId) =>
      ipcInvoke(async () => {
        await this.opts.pty.stop(terminalId);
        return true as const;
      })
    );

    ipcMain.handle(
      IpcChannels.terminal.restart,
      (_e, sessionId: SessionId, dims?: { cols?: number; rows?: number }) =>
        ipcInvoke(() => this.opts.pty.restart(sessionId, dims))
    );

    ipcMain.handle(IpcChannels.terminal.input, (_e, payload: TerminalInputPayload) =>
      ipcInvoke(() => {
        this.opts.pty.write(payload.terminalId, payload.data);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.terminal.resize, (_e, payload: TerminalResizePayload) =>
      ipcInvoke(() => {
        this.opts.pty.resize(payload.terminalId, payload.dimensions);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.terminal.listRunning, () =>
      ipcInvoke(() => this.opts.pty.listRunning())
    );

    const onOutput = (event: TerminalOutputEvent) => this.broadcast(IpcChannels.terminal.output, event);
    const onExit = (event: TerminalExitEvent) => this.broadcast(IpcChannels.terminal.exit, event);
    const onStatus = (event: TerminalStatusEvent) => this.broadcast(IpcChannels.terminal.status, event);

    this.opts.pty.on('output', onOutput);
    this.opts.pty.on('exit', onExit);
    this.opts.pty.on('status', onStatus);

    this.listeners.push(
      () => this.opts.pty.off('output', onOutput),
      () => this.opts.pty.off('exit', onExit),
      () => this.opts.pty.off('status', onStatus)
    );
  }

  dispose(): void {
    if (!this.registered) return;
    for (const off of this.listeners) off();
    this.listeners = [];
    ipcMain.removeHandler(IpcChannels.terminal.start);
    ipcMain.removeHandler(IpcChannels.terminal.stop);
    ipcMain.removeHandler(IpcChannels.terminal.restart);
    ipcMain.removeHandler(IpcChannels.terminal.input);
    ipcMain.removeHandler(IpcChannels.terminal.resize);
    ipcMain.removeHandler(IpcChannels.terminal.listRunning);
    this.registered = false;
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of this.opts.getWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}
