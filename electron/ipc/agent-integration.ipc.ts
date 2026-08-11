import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationStatus
} from '@shared/types/ipc.js';
import { ipcInvoke } from './result.js';
import { HookInstaller } from '../integrations/HookInstaller.js';

export interface AgentIntegrationIpcOptions {
  installer: HookInstaller;
  getWindows: () => BrowserWindow[];
}

export class AgentIntegrationIpc {
  private registered = false;

  constructor(private readonly opts: AgentIntegrationIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;
    const { installer } = this.opts;

    ipcMain.handle(IpcChannels.agentIntegration.status, () =>
      ipcInvoke(() => installer.status())
    );

    ipcMain.handle(
      IpcChannels.agentIntegration.installClaude,
      (_e, request: AgentIntegrationClaudeRequest) =>
        ipcInvoke(async () => {
          await installer.installClaude(request.host);
          return this.broadcastStatus();
        })
    );

    ipcMain.handle(
      IpcChannels.agentIntegration.uninstallClaude,
      (_e, request: AgentIntegrationClaudeRequest) =>
        ipcInvoke(async () => {
          await installer.uninstallClaude(request.host);
          return this.broadcastStatus();
        })
    );

    ipcMain.handle(
      IpcChannels.agentIntegration.installCodex,
      (_e, request: AgentIntegrationCodexRequest) =>
        ipcInvoke(async () => {
          await installer.installCodex(request.host);
          return this.broadcastStatus();
        })
    );

    ipcMain.handle(
      IpcChannels.agentIntegration.uninstallCodex,
      (_e, request: AgentIntegrationCodexRequest) =>
        ipcInvoke(async () => {
          await installer.uninstallCodex(request.host);
          return this.broadcastStatus();
        })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.agentIntegration.status);
    ipcMain.removeHandler(IpcChannels.agentIntegration.installClaude);
    ipcMain.removeHandler(IpcChannels.agentIntegration.uninstallClaude);
    ipcMain.removeHandler(IpcChannels.agentIntegration.installCodex);
    ipcMain.removeHandler(IpcChannels.agentIntegration.uninstallCodex);
    this.registered = false;
  }

  private async broadcastStatus(): Promise<AgentIntegrationStatus> {
    const status = await this.opts.installer.status();
    for (const win of this.opts.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.agentIntegration.changed, status);
      }
    }
    return status;
  }
}
