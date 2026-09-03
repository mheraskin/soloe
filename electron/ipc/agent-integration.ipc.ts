import { ipcMain, type BrowserWindow } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AgentIntegrationClaudeRequest,
  AgentIntegrationCodexRequest,
  AgentIntegrationCursorRequest,
  AgentIntegrationGrokRequest,
  AgentIntegrationOpenCodeRequest,
  AgentIntegrationStatus
} from '@shared/types/ipc.js';
import { ipcInvoke } from './result.js';
import { HookInstaller } from '../integrations/HookInstaller.js';
import {
  AgentCliDiscovery,
  enrichAgentCliStatus
} from '../agents/AgentCliDiscovery.js';
import type { Settings } from '@shared/types/settings.js';

export interface AgentIntegrationIpcOptions {
  installer: HookInstaller;
  getWindows: () => BrowserWindow[];
  getSettings?: () => Promise<Settings> | Settings;
  cursorDiscovery?: Pick<import('../agents/CursorCliDiscovery.js').CursorCliDiscovery, 'detect'>;
  agentCliDiscovery?: Pick<AgentCliDiscovery, 'detect'>;
}

export class AgentIntegrationIpc {
  private registered = false;
  private readonly agentCliDiscovery: Pick<AgentCliDiscovery, 'detect'>;

  constructor(private readonly opts: AgentIntegrationIpcOptions) {
    const defaultAgentCliDiscovery = new AgentCliDiscovery();
    this.agentCliDiscovery = opts.agentCliDiscovery ?? (opts.cursorDiscovery
      ? {
          detect: (provider, host, configured) => {
            if (provider === 'cursor' && opts.cursorDiscovery) {
              return opts.cursorDiscovery.detect(host, configured);
            }
            return defaultAgentCliDiscovery.detect(provider, host, configured);
          }
        }
      : defaultAgentCliDiscovery);
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
    ipcMain.handle(
      IpcChannels.agentIntegration.installOpenCode,
      (_e, request: AgentIntegrationOpenCodeRequest) => ipcInvoke(async () => {
        await installer.installOpenCode(request.host);
        return this.broadcastStatus();
      })
    );
    ipcMain.handle(
      IpcChannels.agentIntegration.uninstallOpenCode,
      (_e, request: AgentIntegrationOpenCodeRequest) => ipcInvoke(async () => {
        await installer.uninstallOpenCode(request.host);
        return this.broadcastStatus();
      })
    );
    ipcMain.handle(
      IpcChannels.agentIntegration.installGrok,
      (_e, request: AgentIntegrationGrokRequest) => ipcInvoke(async () => {
        await installer.installGrok(request.host);
        return this.broadcastStatus();
      })
    );
    ipcMain.handle(
      IpcChannels.agentIntegration.uninstallGrok,
      (_e, request: AgentIntegrationGrokRequest) => ipcInvoke(async () => {
        await installer.uninstallGrok(request.host);
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
    ipcMain.removeHandler(IpcChannels.agentIntegration.installOpenCode);
    ipcMain.removeHandler(IpcChannels.agentIntegration.uninstallOpenCode);
    ipcMain.removeHandler(IpcChannels.agentIntegration.installGrok);
    ipcMain.removeHandler(IpcChannels.agentIntegration.uninstallGrok);
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
    const binaries = (await this.opts.getSettings?.())?.binaries;
    return enrichAgentCliStatus(status, binaries, this.agentCliDiscovery);
  }
}
