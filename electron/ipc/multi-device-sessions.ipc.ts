import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  CreateMultiDeviceSessionRequest,
  DeviceWorktreeInvokeRequest
} from '@shared/types/multi-device-sessions.js';
import type { MultiDeviceSessions } from '../sessions/MultiDeviceSessions.js';
import type { ProjectRef, SessionRef, TerminalRef } from '@shared/types/devices.js';
import type { TerminalControlProof } from '@shared/types/terminal.js';
import type { DeviceImagePasteRequest } from '@shared/types/files.js';
import { ipcInvoke } from './result.js';

export interface MultiDeviceSessionsIpcOptions {
  sessions: Pick<
    MultiDeviceSessions,
    | 'state'
    | 'refresh'
    | 'reorderSessions'
    | 'create'
    | 'planCreate'
    | 'executeCreate'
    | 'browseWorkspaceDirectories'
    | 'modelCatalog'
    | 'openProjectOnDevice'
    | 'updateProject'
    | 'deleteProject'
    | 'executePreparation'
    | 'startSession'
    | 'updateSession'
    | 'deleteSession'
    | 'previewSessionCommand'
    | 'ensureTailscalePort'
    | 'listLocalhostBridges'
    | 'openLocalhostBridge'
    | 'closeLocalhostBridge'
    | 'onState'
    | 'onDeviceEvent'
    | 'setTerminalOutputDemand'
    | 'terminalInput'
    | 'terminalPasteImages'
    | 'terminalAcquireInputLease'
    | 'terminalCurrentInputLease'
    | 'terminalReleaseInputLease'
    | 'terminalParkInputLease'
    | 'terminalResize'
    | 'terminalHistory'
    | 'terminalStop'
    | 'invokeWorktree'
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
    ipcMain.handle(IpcChannels.sessions.reorderOnDevices, (_event, refs: SessionRef[]) =>
      ipcInvoke(() => this.options.sessions.reorderSessions(structuredClone(refs)))
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
    ipcMain.handle(
      IpcChannels.sessions.browseDeviceWorkspaceDirectories,
      (_event, request: { deviceId: string; path?: string }) =>
        ipcInvoke(() => this.options.sessions.browseWorkspaceDirectories(
          request.deviceId,
          request.path
        ))
    );
    ipcMain.handle(
      IpcChannels.sessions.modelCatalogOnDevice,
      (_event, request: { deviceId: import('@shared/types/devices.js').DeviceId }) =>
        ipcInvoke(() => this.options.sessions.modelCatalog(request.deviceId))
    );
    ipcMain.handle(
      IpcChannels.sessions.openProjectOnDevice,
      (_event, request: { deviceId: string; project: import('@shared/types/projects.js').ProjectOpenRequest }) =>
        ipcInvoke(() => this.options.sessions.openProjectOnDevice(
          request.deviceId,
          request.project
        ))
    );
    ipcMain.handle(
      IpcChannels.sessions.updateProjectOnDevice,
      (_event, request: { ref: ProjectRef; patch: import('@shared/types/projects.js').ProjectUpdate }) =>
        ipcInvoke(() => this.options.sessions.updateProject(
          structuredClone(request.ref),
          structuredClone(request.patch)
        ))
    );
    ipcMain.handle(IpcChannels.sessions.deleteProjectOnDevice, (_event, ref: ProjectRef) =>
      ipcInvoke(() => this.options.sessions.deleteProject(structuredClone(ref)))
    );
    ipcMain.handle(
      IpcChannels.sessions.executeDevicePreparation,
      (_event, planId: string) => ipcInvoke(() => this.options.sessions.executePreparation(planId))
    );
    ipcMain.handle(IpcChannels.sessions.startOnDevice, (_event, ref: SessionRef) =>
      ipcInvoke(() => this.options.sessions.startSession(structuredClone(ref)))
    );
    ipcMain.handle(
      IpcChannels.sessions.updateOnDevice,
      (_event, request: { ref: SessionRef; patch: import('@shared/types/sessions.js').SessionUpdate }) =>
        ipcInvoke(() => this.options.sessions.updateSession(
          structuredClone(request.ref),
          structuredClone(request.patch)
        ))
    );
    ipcMain.handle(IpcChannels.sessions.deleteOnDevice, (_event, ref: SessionRef) =>
      ipcInvoke(() => this.options.sessions.deleteSession(structuredClone(ref)))
    );
    ipcMain.handle(IpcChannels.sessions.previewCommandOnDevice, (_event, ref: SessionRef) =>
      ipcInvoke(() => this.options.sessions.previewSessionCommand(structuredClone(ref)))
    );
    ipcMain.handle(
      IpcChannels.sessions.ensureDeviceTailscalePort,
      (_event, request: { deviceId: string; port: number; virtualHostname?: string }) =>
        ipcInvoke(() => request.virtualHostname
          ? this.options.sessions.ensureTailscalePort(
              request.deviceId,
              request.port,
              request.virtualHostname
            )
          : this.options.sessions.ensureTailscalePort(request.deviceId, request.port))
    );
    ipcMain.handle(IpcChannels.sessions.listLocalhostBridges, () =>
      ipcInvoke(() => this.options.sessions.listLocalhostBridges())
    );
    ipcMain.handle(
      IpcChannels.sessions.openLocalhostBridge,
      (_event, request: import('@shared/types/connections.js').OpenLocalhostBridgeRequest) =>
        ipcInvoke(() => this.options.sessions.openLocalhostBridge(structuredClone(request)))
    );
    ipcMain.handle(IpcChannels.sessions.closeLocalhostBridge, (_event, port: number) =>
      ipcInvoke(async () => {
        await this.options.sessions.closeLocalhostBridge(port);
        return true as const;
      })
    );
    ipcMain.handle(IpcChannels.sessions.deviceTerminalDemand, (_event, refs: TerminalRef[]) =>
      ipcInvoke(async () => {
        await this.options.sessions.setTerminalOutputDemand(structuredClone(refs));
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalInput,
      (_event, request: { ref: TerminalRef; data: string; control: TerminalControlProof }) => ipcInvoke(async () => {
        if (typeof request?.data !== 'string' || Buffer.byteLength(request.data) > 1024 * 1024) {
          throw new Error('Terminal input is invalid.');
        }
        await this.options.sessions.terminalInput(
          structuredClone(request.ref),
          request.data,
          structuredClone(request.control)
        );
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalPasteImages,
      (_event, request: DeviceImagePasteRequest) =>
        ipcInvoke(() => this.options.sessions.terminalPasteImages(structuredClone(request)))
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
      IpcChannels.sessions.deviceTerminalCurrentInputLease,
      (_event, ref: TerminalRef) =>
        ipcInvoke(() => this.options.sessions.terminalCurrentInputLease(structuredClone(ref)))
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalReleaseInputLease,
      (_event, request: { ref: TerminalRef; control: TerminalControlProof }) =>
        ipcInvoke(() => this.options.sessions.terminalReleaseInputLease(
          structuredClone(request.ref),
          structuredClone(request.control)
        ))
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalParkInputLease,
      (_event, request: { ref: TerminalRef; control: TerminalControlProof }) =>
        ipcInvoke(() => this.options.sessions.terminalParkInputLease(
          structuredClone(request.ref),
          structuredClone(request.control)
        ))
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalResize,
      (_event, request: { ref: TerminalRef; cols: number; rows: number; control: TerminalControlProof }) => ipcInvoke(async () => {
        await this.options.sessions.terminalResize(
          structuredClone(request.ref),
          request.cols,
          request.rows,
          structuredClone(request.control)
        );
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.sessions.deviceTerminalHistory,
      (_event, ref: TerminalRef) =>
        ipcInvoke(() => this.options.sessions.terminalHistory(structuredClone(ref)))
    );
    ipcMain.handle(IpcChannels.sessions.deviceTerminalStop, (_event, ref: TerminalRef) =>
      ipcInvoke(async () => {
        await this.options.sessions.terminalStop(structuredClone(ref));
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.sessions.invokeWorktree,
      (_event, request: DeviceWorktreeInvokeRequest) =>
        ipcInvoke(() => this.options.sessions.invokeWorktree(structuredClone(request)))
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
    ipcMain.removeHandler(IpcChannels.sessions.reorderOnDevices);
    ipcMain.removeHandler(IpcChannels.sessions.createOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.planCreateOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.executeCreateOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.browseDeviceWorkspaceDirectories);
    ipcMain.removeHandler(IpcChannels.sessions.modelCatalogOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.openProjectOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.updateProjectOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.deleteProjectOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.executeDevicePreparation);
    ipcMain.removeHandler(IpcChannels.sessions.startOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.updateOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.deleteOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.previewCommandOnDevice);
    ipcMain.removeHandler(IpcChannels.sessions.ensureDeviceTailscalePort);
    ipcMain.removeHandler(IpcChannels.sessions.listLocalhostBridges);
    ipcMain.removeHandler(IpcChannels.sessions.openLocalhostBridge);
    ipcMain.removeHandler(IpcChannels.sessions.closeLocalhostBridge);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalDemand);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalInput);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalPasteImages);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalInputLease);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalCurrentInputLease);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalReleaseInputLease);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalParkInputLease);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalResize);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalHistory);
    ipcMain.removeHandler(IpcChannels.sessions.deviceTerminalStop);
  }
}
