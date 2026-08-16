import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationCursorRequest,
  AgentIntegrationStatus
} from '@shared/types/ipc.js';
import { ipcInvoke } from './result.js';
import { HookInstaller } from '../integrations/HookInstaller.js';
import { CursorCliDiscovery, enrichCursorCliStatus } from '../agents/CursorCliDiscovery.js';
import type { Settings } from '@shared/types/settings.js';

export interface AgentIntegrationIpcOptions {
  installer: HookInstaller;
  getWindows: () => BrowserWindow[];
  getSettings?: () => Promise<Settings> | Settings;
  cursorDiscovery?: Pick<CursorCliDiscovery, 'detect'>;
}

export class AgentIntegrationIpc {
  private registered = false;
  private readonly cursorDiscovery: Pick<CursorCliDiscovery, 'detect'>;

  constructor(private readonly opts: AgentIntegrationIpcOptions) {
    this.cursorDiscovery = opts.cursorDiscovery ?? new CursorCliDiscovery();
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;
    const { installer } = this.opts;

    ipcMain.handle(IpcChannels.agentIntegration.status, () =>
      ipcInvoke(() => this.status())
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
    ipcMain.handle(
      IpcChannels.agentIntegration.installCursor,
      (_e, request: AgentIntegrationCursorRequest) => ipcInvoke(async () => {
        await installer.installCursor(request.host);
        return this.broadcastStatus();
      })
    );
    ipcMain.handle(
      IpcChannels.agentIntegration.uninstallCursor,
      (_e, request: AgentIntegrationCursorRequest) => ipcInvoke(async () => {
        await installer.uninstallCursor(request.host);
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
    ipcMain.removeHandler(IpcChannels.agentIntegration.installCursor);
    ipcMain.removeHandler(IpcChannels.agentIntegration.uninstallCursor);
    this.registered = false;
  }

  private async broadcastStatus(): Promise<AgentIntegrationStatus> {
    const status = await this.status();
    for (const win of this.opts.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.agentIntegration.changed, status);
      }
    }
    return status;
  }

  private async status(): Promise<AgentIntegrationStatus> {
    const status = await this.opts.installer.status();
    const configuredBinary = (await this.opts.getSettings?.())?.binaries.cursor;
    return enrichCursorCliStatus(status, configuredBinary, this.cursorDiscovery);
  }
}
