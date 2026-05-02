import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type { SessionDraft, SessionId, SessionUpdate } from '@shared/types/sessions.js';
import type { SettingsBinaries } from '@shared/types/settings.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import type { SessionCommandBuilder } from '../sessions/SessionCommandBuilder.js';
import type { AgentObserverManager } from '../agents/AgentObserverManager.js';
import { ipcInvoke } from './result.js';

export interface SessionsIpcOptions {
  store: SessionStore;
  commandBuilder: SessionCommandBuilder;
  baseEnv?: NodeJS.ProcessEnv;
  observer?: AgentObserverManager;
  bridgeInfo?: () => { url: string; token: string } | null;
  getBinaries?: () => Promise<SettingsBinaries> | SettingsBinaries;
}

export class SessionsIpc {
  private registered = false;

  constructor(private readonly opts: SessionsIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.sessions.list, () =>
      ipcInvoke(async () => {
        const sessions = await this.opts.store.list();
        for (const session of sessions) this.opts.observer?.registerTuiSession(session);
        return sessions;
      })
    );

    ipcMain.handle(IpcChannels.sessions.listArchived, () =>
      ipcInvoke(() => this.opts.store.listArchived())
    );

    ipcMain.handle(IpcChannels.sessions.get, (_e, id: SessionId) =>
      ipcInvoke(() => this.opts.store.get(id))
    );

    ipcMain.handle(IpcChannels.sessions.create, (_e, draft: SessionDraft) =>
      ipcInvoke(async () => {
        const session = await this.opts.store.create({ ...draft, runtimeMode: 'tui' });
        this.opts.observer?.registerTuiSession(session);
        return session;
      })
    );

    ipcMain.handle(IpcChannels.sessions.update, (_e, id: SessionId, patch: SessionUpdate) =>
      ipcInvoke(async () => {
        const session = await this.opts.store.update(id, patch);
        this.opts.observer?.registerTuiSession(session);
        return session;
      })
    );

    ipcMain.handle(IpcChannels.sessions.delete, (_e, id: SessionId) =>
      ipcInvoke(async () => {
        await this.opts.store.delete(id);
        this.opts.observer?.removeSession(id);
        return true as const;
      })
    );

    ipcMain.handle(IpcChannels.sessions.previewCommand, (_e, id: SessionId) =>
      ipcInvoke(async () => {
        const session = await this.opts.store.get(id);
        if (!session) throw new Error(`Session not found: ${id}`);
        const binaries = this.opts.getBinaries ? await this.opts.getBinaries() : undefined;
        return this.opts.commandBuilder.build(session, {
          baseEnv: this.opts.baseEnv ?? process.env,
          bridge: this.opts.bridgeInfo?.() ?? undefined,
          ...(binaries ? { binaries } : {})
        });
      })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.sessions.list);
    ipcMain.removeHandler(IpcChannels.sessions.listArchived);
    ipcMain.removeHandler(IpcChannels.sessions.get);
    ipcMain.removeHandler(IpcChannels.sessions.create);
    ipcMain.removeHandler(IpcChannels.sessions.update);
    ipcMain.removeHandler(IpcChannels.sessions.delete);
    ipcMain.removeHandler(IpcChannels.sessions.previewCommand);
    this.registered = false;
  }
}
