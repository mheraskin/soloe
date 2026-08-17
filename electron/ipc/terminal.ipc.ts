import { ipcMain, type BrowserWindow, type WebContents } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  TerminalInputPayload,
  TerminalOutputDemandPayload,
  TerminalResizePayload
} from '@shared/types/ipc.js';
import type { SessionId } from '@shared/types/sessions.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStatusEvent
} from '@shared/types/terminal.js';
import type { PtyManager } from '../terminal/PtyManager.js';
import { ipcInvoke } from './result.js';
import { TerminalInputLeaseManager } from '@soloe/runtime';
import type { TerminalControllerIdentity } from '@shared/types/terminal.js';
import type { TerminalControlProof } from '@shared/types/terminal.js';

export interface TerminalIpcOptions {
  pty: PtyManager;
  getWindows: () => BrowserWindow[];
}

export class TerminalIpc {
  private registered = false;
  private listeners: Array<() => void> = [];
  private outputDemandByWebContents = new Map<number, Set<TerminalId>>();
  private observedDemandOwners = new WeakSet<WebContents>();
  private observedControlOwners = new WeakSet<WebContents>();
  private readonly controlLeases: TerminalInputLeaseManager;

  constructor(private readonly opts: TerminalIpcOptions) {
    this.controlLeases = new TerminalInputLeaseManager({
      onChange: (event) => this.broadcast(IpcChannels.terminal.inputLease, event)
    });
  }

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

    ipcMain.handle(
      IpcChannels.terminal.acquireInputLease,
      (event, terminalId: TerminalId, controller: TerminalControllerIdentity, takeover = false) =>
        ipcInvoke(async () => {
          const running = this.opts.pty.listRunning().find(
            (candidate) => candidate.terminalId === terminalId
          );
          if (!running) throw new Error(`Terminal not found: ${terminalId}`);
          this.observeControlOwner(event.sender);
          return this.controlLeases.acquire(terminalId, controlOwnerId(event.sender), {
            takeover,
            sessionId: running.sessionId,
            ownerDeviceId: controller.deviceId,
            controllerDeviceId: controller.deviceId,
            controllerDeviceName: controller.deviceName
          });
        })
    );
    ipcMain.handle(IpcChannels.terminal.currentInputLease, (_event, terminalId: TerminalId) =>
      ipcInvoke(() => this.controlLeases.current(terminalId))
    );
    ipcMain.handle(
      IpcChannels.terminal.releaseInputLease,
      (_event, terminalId: TerminalId, control: TerminalControlProof) => ipcInvoke(() =>
        this.controlLeases.release(terminalId, control)
      )
    );
    ipcMain.handle(
      IpcChannels.terminal.parkInputLease,
      (_event, terminalId: TerminalId, control: TerminalControlProof) => ipcInvoke(() =>
        this.controlLeases.park(terminalId, control)
      )
    );

    ipcMain.handle(IpcChannels.terminal.input, (_event, payload: TerminalInputPayload) =>
      ipcInvoke(() => {
        this.controlLeases.authorizeControl(
          payload.terminalId,
          payload.control,
          'input'
        );
        this.opts.pty.write(payload.terminalId, payload.data);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.terminal.resize, (_event, payload: TerminalResizePayload) =>
      ipcInvoke(() => {
        this.controlLeases.resize(
          payload.terminalId,
          payload.control,
          payload.dimensions.cols,
          payload.dimensions.rows
        );
        this.opts.pty.resize(payload.terminalId, payload.dimensions);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.terminal.listRunning, () =>
      ipcInvoke(() => this.opts.pty.listRunning())
    );

    ipcMain.handle(IpcChannels.terminal.replay, (_e, terminalId: TerminalId, afterSeq?: number) =>
      ipcInvoke(() => this.opts.pty.replay(terminalId, afterSeq))
    );
    ipcMain.handle(IpcChannels.terminal.screenSnapshot, (_e, terminalId: TerminalId) =>
      ipcInvoke(() => this.opts.pty.screenSnapshot(terminalId))
    );

    ipcMain.handle(
      IpcChannels.terminal.outputDemand,
      (event, payload: TerminalOutputDemandPayload) =>
        ipcInvoke(() => {
          this.setOutputDemand(event.sender, payload);
          return true as const;
        })
    );

    const onOutput = (event: TerminalOutputEvent) => this.publishOutput(event);
    const onExit = (event: TerminalExitEvent) => {
      this.controlLeases.clearTerminal(event.terminalId);
      this.broadcast(IpcChannels.terminal.exit, event);
      this.releaseTerminalDemand(event.terminalId);
    };
    const onLocation = (event: TerminalLocationEvent) =>
      this.broadcast(IpcChannels.terminal.location, event);
    const onStatus = (event: TerminalStatusEvent) =>
      this.broadcast(IpcChannels.terminal.status, event);

    this.opts.pty.on('output', onOutput);
    this.opts.pty.on('exit', onExit);
    this.opts.pty.on('location', onLocation);
    this.opts.pty.on('status', onStatus);

    this.listeners.push(
      () => this.opts.pty.off('output', onOutput),
      () => this.opts.pty.off('exit', onExit),
      () => this.opts.pty.off('location', onLocation),
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
    ipcMain.removeHandler(IpcChannels.terminal.acquireInputLease);
    ipcMain.removeHandler(IpcChannels.terminal.currentInputLease);
    ipcMain.removeHandler(IpcChannels.terminal.releaseInputLease);
    ipcMain.removeHandler(IpcChannels.terminal.parkInputLease);
    ipcMain.removeHandler(IpcChannels.terminal.input);
    ipcMain.removeHandler(IpcChannels.terminal.resize);
    ipcMain.removeHandler(IpcChannels.terminal.listRunning);
    ipcMain.removeHandler(IpcChannels.terminal.replay);
    ipcMain.removeHandler(IpcChannels.terminal.screenSnapshot);
    ipcMain.removeHandler(IpcChannels.terminal.outputDemand);
    this.outputDemandByWebContents.clear();
    this.controlLeases.clear();
    this.registered = false;
  }

  private setOutputDemand(sender: WebContents, payload: TerminalOutputDemandPayload): void {
    const terminalId = payload?.terminalId?.trim();
    if (!terminalId || typeof payload.active !== 'boolean') {
      throw new Error('Invalid terminal output demand');
    }
    const ownerId = sender.id;
    if (!this.observedDemandOwners.has(sender)) {
      this.observedDemandOwners.add(sender);
      sender.once('destroyed', () => {
        this.outputDemandByWebContents.delete(ownerId);
      });
    }

    const current = this.outputDemandByWebContents.get(ownerId) ?? new Set<TerminalId>();
    if (payload.active) current.add(terminalId);
    else current.delete(terminalId);
    if (current.size > 0) this.outputDemandByWebContents.set(ownerId, current);
    else this.outputDemandByWebContents.delete(ownerId);
  }

  private observeControlOwner(sender: WebContents): void {
    if (this.observedControlOwners.has(sender)) return;
    this.observedControlOwners.add(sender);
    sender.once('destroyed', () => {
      this.controlLeases.releaseTransportClient(controlOwnerId(sender));
    });
  }

  private publishOutput(event: TerminalOutputEvent): void {
    for (const win of this.opts.getWindows()) {
      if (win.isDestroyed()) continue;
      const webContents = win.webContents;
      if (webContents.isDestroyed()) continue;
      if (!this.outputDemandByWebContents.get(webContents.id)?.has(event.terminalId)) continue;
      webContents.send(IpcChannels.terminal.output, event);
    }
  }

  private releaseTerminalDemand(terminalId: TerminalId): void {
    for (const [ownerId, terminals] of this.outputDemandByWebContents) {
      terminals.delete(terminalId);
      if (terminals.size === 0) this.outputDemandByWebContents.delete(ownerId);
    }
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of this.opts.getWindows()) {
      if (win.isDestroyed()) continue;
      if (win.webContents.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}

function controlOwnerId(sender: WebContents): string {
  return `electron-webcontents-${sender.id}`;
}
