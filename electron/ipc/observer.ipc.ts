import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  CreateWorkerSessionRequest,
  ListObserverEventsRequest,
  ObservedAgentSnapshot,
  ObserverEvent,
  SendWorkerPromptRequest
} from '@shared/types/agents.js';
import type { AgentObserverManager } from '../agents/AgentObserverManager.js';
import type { AgentRuntimeManager } from '../agents/AgentRuntimeManager.js';
import { ipcInvoke } from './result.js';

export interface ObserverIpcOptions {
  observer: AgentObserverManager;
  runtime: AgentRuntimeManager;
  getWindows: () => BrowserWindow[];
}

export class ObserverIpc {
  private registered = false;
  private listeners: Array<() => void> = [];

  constructor(private readonly opts: ObserverIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.observer.list, () =>
      ipcInvoke(() => this.opts.observer.listSnapshots())
    );

    ipcMain.handle(IpcChannels.observer.listEvents, (_e, request?: ListObserverEventsRequest) =>
      ipcInvoke(() => this.opts.observer.listEvents(request?.subjectId, request?.limit))
    );

    ipcMain.handle(IpcChannels.observer.createWorkerSession, (_e, request: CreateWorkerSessionRequest) =>
      ipcInvoke(() => this.opts.runtime.createWorkerSession(request))
    );

    ipcMain.handle(IpcChannels.observer.sendWorkerPrompt, (_e, request: SendWorkerPromptRequest) =>
      ipcInvoke(() => this.opts.runtime.sendWorkerPrompt(request))
    );

    ipcMain.handle(IpcChannels.observer.getWorkerStatus, (_e, workerId: string) =>
      ipcInvoke(() => this.opts.runtime.getWorkerStatus(workerId))
    );

    ipcMain.handle(IpcChannels.observer.stopWorkerSession, (_e, workerId: string) =>
      ipcInvoke(() => this.opts.runtime.stopWorkerSession(workerId))
    );

    const onSnapshot = (snapshot: ObservedAgentSnapshot) =>
      this.broadcast(IpcChannels.observer.snapshot, snapshot);
    const onEvent = (event: ObserverEvent) => this.broadcast(IpcChannels.observer.event, event);

    this.opts.observer.on('snapshot', onSnapshot);
    this.opts.observer.on('event', onEvent);
    this.listeners.push(
      () => this.opts.observer.off('snapshot', onSnapshot),
      () => this.opts.observer.off('event', onEvent)
    );
  }

  dispose(): void {
    if (!this.registered) return;
    for (const off of this.listeners) off();
    this.listeners = [];
    ipcMain.removeHandler(IpcChannels.observer.list);
    ipcMain.removeHandler(IpcChannels.observer.listEvents);
    ipcMain.removeHandler(IpcChannels.observer.createWorkerSession);
    ipcMain.removeHandler(IpcChannels.observer.sendWorkerPrompt);
    ipcMain.removeHandler(IpcChannels.observer.getWorkerStatus);
    ipcMain.removeHandler(IpcChannels.observer.stopWorkerSession);
    this.registered = false;
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of this.opts.getWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  }
}
