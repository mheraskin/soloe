import {
  ipcMain,
  type BrowserWindow,
  type WebContents
} from 'electron';

import type {
  CockpitCatalogImportRequest,
  CockpitDemand,
  CockpitTerminalInputRequest,
  CockpitTerminalInputLeaseRequest,
  CockpitTerminalReplayRequest,
  CockpitTerminalResizeRequest,
  CockpitTerminalStopRequest
} from '@shared/types/cockpit.js';
import type { DeviceId, TerminalRef } from '@shared/types/devices.js';
import type { CatalogTransaction } from '@shared/types/workspaces.js';
import type { DeviceWorkspaceIntent } from '@shared/types/workspaces.js';
import type {
  CockpitAlignWorkspaceIntent,
  CockpitPlaceSessionIntent,
  CockpitSessionSourceLifecycleIntent
} from '@shared/types/workspaces.js';
import type { DeviceCommandEnvelope } from '@shared/types/commands.js';
import type { CockpitPublishProjectIntent } from '@shared/types/providers.js';
import { IpcChannels } from '@shared/types/ipc.js';
import type { CockpitCoordinator } from '../cockpit/CockpitCoordinator.js';
import { ipcInvoke } from './result.js';

const MAX_TERMINAL_INPUT_BYTES = 1024 * 1024;

export interface CockpitIpcOptions {
  coordinator: CockpitCoordinator;
  getWindows: () => BrowserWindow[];
}

export class CockpitIpc {
  private registered = false;
  private detachEvents: (() => void) | null = null;
  private readonly observedOwners = new WeakSet<WebContents>();

  constructor(private readonly options: CockpitIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;
    this.options.coordinator.start();

    ipcMain.handle(IpcChannels.cockpit.snapshot, () =>
      ipcInvoke(() => this.options.coordinator.snapshot())
    );
    ipcMain.handle(IpcChannels.cockpit.refresh, () =>
      ipcInvoke(() => this.options.coordinator.refreshAll())
    );
    ipcMain.handle(IpcChannels.cockpit.demand, (event, demand: CockpitDemand) =>
      ipcInvoke(async () => {
        this.observeOwner(event.sender);
        await this.options.coordinator.setDemand(ownerId(event.sender), demand);
        return true as const;
      })
    );
    ipcMain.handle(IpcChannels.cockpit.filter, (_event, deviceIds: DeviceId[]) =>
      ipcInvoke(() => this.options.coordinator.setFilter(deviceIds))
    );
    ipcMain.handle(IpcChannels.cockpit.defaultPlacement, (_event, deviceId: DeviceId) =>
      ipcInvoke(() => this.options.coordinator.setDefaultPlacement(deviceId))
    );
    ipcMain.handle(
      IpcChannels.cockpit.transactCatalog,
      (_event, transaction: CatalogTransaction) =>
        ipcInvoke(() => this.options.coordinator.transactCatalog(transaction))
    );
    ipcMain.handle(IpcChannels.cockpit.exportCatalog, () =>
      ipcInvoke(() => this.options.coordinator.exportCatalog())
    );
    ipcMain.handle(
      IpcChannels.cockpit.importCatalog,
      (_event, request: CockpitCatalogImportRequest) =>
        ipcInvoke(() => this.options.coordinator.importCatalog(request))
    );
    ipcMain.handle(
      IpcChannels.cockpit.workspacePlan,
      (_event, deviceId: DeviceId, intent: DeviceWorkspaceIntent) =>
        ipcInvoke(() => this.options.coordinator.workspacePlan(deviceId, intent))
    );
    ipcMain.handle(
      IpcChannels.cockpit.workspaceExecute,
      (_event, command: DeviceCommandEnvelope<DeviceWorkspaceIntent>) =>
        ipcInvoke(() => this.options.coordinator.workspaceExecute(command))
    );
    ipcMain.handle(
      IpcChannels.cockpit.workspaceGetCommand,
      (_event, deviceId: DeviceId, cockpitId: string, commandId: string) =>
        ipcInvoke(() => this.options.coordinator.workspaceGetCommand(
          deviceId,
          cockpitId,
          commandId
        ))
    );
    ipcMain.handle(
      IpcChannels.cockpit.placementPlan,
      (_event, intent: CockpitPlaceSessionIntent) =>
        ipcInvoke(() => this.options.coordinator.planSessionPlacement(intent))
    );
    ipcMain.handle(
      IpcChannels.cockpit.placementExecute,
      (_event, planId: string, acknowledgements: string[]) =>
        ipcInvoke(() => this.options.coordinator.executeSessionPlacement(planId, acknowledgements))
    );
    ipcMain.handle(
      IpcChannels.cockpit.alignmentPlan,
      (_event, intent: CockpitAlignWorkspaceIntent) =>
        ipcInvoke(() => this.options.coordinator.planWorkspaceAlignment(intent))
    );
    ipcMain.handle(
      IpcChannels.cockpit.alignmentExecute,
      (_event, planId: string, acknowledgements: string[]) =>
        ipcInvoke(() => this.options.coordinator.executeWorkspaceAlignment(planId, acknowledgements))
    );
    ipcMain.handle(
      IpcChannels.cockpit.publicationPlan,
      (_event, intent: CockpitPublishProjectIntent) =>
        ipcInvoke(() => this.options.coordinator.planProjectPublication(intent))
    );
    ipcMain.handle(
      IpcChannels.cockpit.publicationExecute,
      (_event, planId: string, acknowledgements: string[]) =>
        ipcInvoke(() => this.options.coordinator.executeProjectPublication(planId, acknowledgements))
    );
    ipcMain.handle(
      IpcChannels.cockpit.sourceLifecyclePlan,
      (_event, intent: CockpitSessionSourceLifecycleIntent) =>
        ipcInvoke(() => this.options.coordinator.planSessionSourceLifecycle(intent))
    );
    ipcMain.handle(
      IpcChannels.cockpit.sourceLifecycleExecute,
      (_event, planId: string, acknowledgements: string[]) =>
        ipcInvoke(() => this.options.coordinator.executeSessionSourceLifecycle(planId, acknowledgements))
    );
    ipcMain.handle(
      IpcChannels.cockpit.operationGet,
      (_event, operationId: string) =>
        ipcInvoke(() => this.options.coordinator.getCockpitOperation(operationId))
    );
    ipcMain.handle(IpcChannels.cockpit.operationListRecoverable, () =>
      ipcInvoke(() => this.options.coordinator.listRecoverableOperations())
    );
    ipcMain.handle(
      IpcChannels.cockpit.terminalInputLease,
      (_event, request: CockpitTerminalInputLeaseRequest) => ipcInvoke(async () => {
        const terminalRef = parseTerminalRef(request?.terminalRef);
        const lease = await this.options.coordinator.takeTerminalInputControl(terminalRef);
        return { terminalRef, lease };
      })
    );
    ipcMain.handle(
      IpcChannels.cockpit.terminalInput,
      (_event, request: CockpitTerminalInputRequest) => ipcInvoke(async () => {
        const terminalRef = parseTerminalRef(request?.terminalRef);
        if (typeof request?.data !== 'string') throw new Error('Terminal input is invalid.');
        if (Buffer.byteLength(request.data) > MAX_TERMINAL_INPUT_BYTES) {
          throw new Error('Terminal input exceeds the 1 MiB limit.');
        }
        await this.options.coordinator.terminalInput(terminalRef, request.data);
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.cockpit.terminalResize,
      (_event, request: CockpitTerminalResizeRequest) => ipcInvoke(async () => {
        const terminalRef = parseTerminalRef(request?.terminalRef);
        await this.options.coordinator.terminalResize(
          terminalRef,
          requiredDimension(request?.cols),
          requiredDimension(request?.rows)
        );
        return true as const;
      })
    );
    ipcMain.handle(
      IpcChannels.cockpit.terminalReplay,
      (_event, request: CockpitTerminalReplayRequest) => ipcInvoke(() =>
        this.options.coordinator.terminalReplay(
          parseTerminalRef(request?.terminalRef),
          requiredSequence(request?.afterSeq)
        )
      )
    );
    ipcMain.handle(
      IpcChannels.cockpit.terminalStop,
      (_event, request: CockpitTerminalStopRequest) => ipcInvoke(async () => {
        await this.options.coordinator.terminalStop(parseTerminalRef(request?.terminalRef));
        return true as const;
      })
    );

    this.detachEvents = this.options.coordinator.onEvent(({ event, audience }) => {
      for (const win of this.options.getWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        if (audience && !audience.has(ownerId(win.webContents))) continue;
        win.webContents.send(IpcChannels.cockpit.event, event);
      }
    });
  }

  dispose(): void {
    if (!this.registered) return;
    this.detachEvents?.();
    this.detachEvents = null;
    ipcMain.removeHandler(IpcChannels.cockpit.snapshot);
    ipcMain.removeHandler(IpcChannels.cockpit.refresh);
    ipcMain.removeHandler(IpcChannels.cockpit.demand);
    ipcMain.removeHandler(IpcChannels.cockpit.filter);
    ipcMain.removeHandler(IpcChannels.cockpit.defaultPlacement);
    ipcMain.removeHandler(IpcChannels.cockpit.transactCatalog);
    ipcMain.removeHandler(IpcChannels.cockpit.exportCatalog);
    ipcMain.removeHandler(IpcChannels.cockpit.importCatalog);
    ipcMain.removeHandler(IpcChannels.cockpit.workspacePlan);
    ipcMain.removeHandler(IpcChannels.cockpit.workspaceExecute);
    ipcMain.removeHandler(IpcChannels.cockpit.workspaceGetCommand);
    ipcMain.removeHandler(IpcChannels.cockpit.placementPlan);
    ipcMain.removeHandler(IpcChannels.cockpit.placementExecute);
    ipcMain.removeHandler(IpcChannels.cockpit.alignmentPlan);
    ipcMain.removeHandler(IpcChannels.cockpit.alignmentExecute);
    ipcMain.removeHandler(IpcChannels.cockpit.publicationPlan);
    ipcMain.removeHandler(IpcChannels.cockpit.publicationExecute);
    ipcMain.removeHandler(IpcChannels.cockpit.sourceLifecyclePlan);
    ipcMain.removeHandler(IpcChannels.cockpit.sourceLifecycleExecute);
    ipcMain.removeHandler(IpcChannels.cockpit.operationGet);
    ipcMain.removeHandler(IpcChannels.cockpit.operationListRecoverable);
    ipcMain.removeHandler(IpcChannels.cockpit.terminalInput);
    ipcMain.removeHandler(IpcChannels.cockpit.terminalInputLease);
    ipcMain.removeHandler(IpcChannels.cockpit.terminalResize);
    ipcMain.removeHandler(IpcChannels.cockpit.terminalReplay);
    ipcMain.removeHandler(IpcChannels.cockpit.terminalStop);
    this.registered = false;
  }

  private observeOwner(sender: WebContents): void {
    if (this.observedOwners.has(sender)) return;
    this.observedOwners.add(sender);
    const id = ownerId(sender);
    sender.once('destroyed', () => {
      void this.options.coordinator.releaseDemand(id).catch(() => undefined);
    });
  }
}

function ownerId(sender: WebContents): string {
  return `wc-${sender.id}`;
}

function parseTerminalRef(value: unknown): TerminalRef {
  if (!value || typeof value !== 'object') throw new Error('Terminal reference is invalid.');
  const ref = value as Partial<TerminalRef>;
  if (
    typeof ref.deviceId !== 'string'
    || !ref.deviceId
    || typeof ref.terminalId !== 'string'
    || !ref.terminalId.trim()
  ) {
    throw new Error('Terminal reference is invalid.');
  }
  return { deviceId: ref.deviceId, terminalId: ref.terminalId };
}

function requiredDimension(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new Error('Terminal dimensions are invalid.');
  }
  return value as number;
}

function requiredSequence(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('Terminal replay sequence is invalid.');
  }
  return value as number;
}
