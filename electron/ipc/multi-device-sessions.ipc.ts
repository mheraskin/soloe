import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type { CreateMultiDeviceSessionRequest } from '@shared/types/multi-device-sessions.js';
import type { MultiDeviceSessions } from '../sessions/MultiDeviceSessions.js';
import type { SessionRef, TerminalRef } from '@shared/types/devices.js';
import { ipcInvoke } from './result.js';

export interface MultiDeviceSessionsIpcOptions {
  sessions: Pick<
    MultiDeviceSessions,
    | 'state'
    | 'refresh'
    | 'create'
    | 'planCreate'
    | 'executeCreate'
    | 'startSession'
    | 'onState'
    | 'onDeviceEvent'
    | 'setTerminalOutputDemand'
    | 'terminalInput'
    | 'terminalAcquireInputLease'
    | 'terminalResize'
    | 'terminalReplay'
    | 'terminalStop'
  >;
  getWindows: () => BrowserWindow[];
}

export class MultiDeviceSessionsIpc {
  private registered = false;
  private detachState: (() => void) | null = null;
  private detachDeviceEvent: (() => void) | null = null;

  constructor(private readonly options: MultiDeviceSessionsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;
    ipcMain.handle(IpcChannels.sessions.deviceState, () =>
      ipcInvoke(() => this.options.sessions.state())
    );
    ipcMain.handle(IpcChannels.sessions.refreshDevices, () =>
      ipcInvoke(() => this.options.sessions.refresh())
    );
    ipcMain.handle(
      IpcChannels.sessions.createOnDevice,
      (_event, request: CreateMultiDeviceSessionRequest) =>
        ipcInvoke(() => this.options.sessions.create(structuredClone(request)))
    );
    ipcMain.handle(
      IpcChannels.sessions.planCreateOnDevice,
      (_event, request: CreateMultiDeviceSessionRequest) =>
        ipcInvoke(() => this.options.sessions.planCreate(structuredClone(request)))
    );
    ipcMain.handle(
      IpcChannels.sessions.executeCreateOnDevice,
      (_event, planId: string) =>
        ipcInvoke(() => this.options.sessions.executeCreate(planId))
    );
    ipcMain.handle(IpcChannels.sessions.startOnDevice, (_event, ref: SessionRef) =>
      ipcInvoke(() => this.options.sessions.startSession(structuredClone(ref)))
    );
    ipcMain.handle(IpcChannels.sessions.deviceTerminalDemand, (_event, refs: TerminalRef[]) =>
      ipcInvoke(async () => {
        await this.options.sessions.setTerminalOutputDemand(structuredClone(refs));
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalInput,
      (_event, request: { ref: TerminalRef; data: string }) => ipcInvoke(async () => {
        if (typeof request?.data !== 'string' || Buffer.byteLength(request.data) > 1024 * 1024) {
          throw new Error('Terminal input is invalid.');
        }
        await this.options.sessions.terminalInput(structuredClone(request.ref), request.data);
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalInputLease,
      (_event, request: { ref: TerminalRef; takeover?: boolean }) =>
        ipcInvoke(() => this.options.sessions.terminalAcquireInputLease(
          structuredClone(request.ref),
          request.takeover ?? false
        ))
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalResize,
      (_event, request: { ref: TerminalRef; cols: number; rows: number }) => ipcInvoke(async () => {
        await this.options.sessions.terminalResize(
          structuredClone(request.ref),
          request.cols,
          request.rows
        );
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalReplay,
      (_event, ref: TerminalRef, afterSeq?: number) =>
        ipcInvoke(() => this.options.sessions.terminalReplay(structuredClone(ref), afterSeq))
    );
    ipcMain.handle(IpcChannels.sessions.deviceTerminalStop, (_event, ref: TerminalRef) =>
      ipcInvoke(async () => {
        await this.options.sessions.terminalStop(structuredClone(ref));
        return true as const;
      })
    );
    this.detachState = this.options.sessions.onState((state) => {
      for (const win of this.options.getWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        win.webContents.send(IpcChannels.sessions.deviceStateChanged, state);
      }
    });
    this.detachDeviceEvent = this.options.sessions.onDeviceEvent((event) => {
      for (const win of this.options.getWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        win.webContents.send(IpcChannels.sessions.deviceEvent, event);
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    this.registered = false;
    this.detachState?.();
    this.detachState = null;
    this.detachDeviceEvent?.();
    this.detachDeviceEvent = null;
    ipcMain.removeHandler(IpcChannels.sessions.deviceState);
    ipcMain.removeHandler(IpcChannels.sessions.refreshDevices);
    ipcMain.removeHandler(IpcChannels.sessions.createOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.planCreateOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.executeCreateOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.startOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalDemand);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalInput);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalInputLease);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalResize);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalReplay);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalStop);
  }
}
