import { ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { IpcChannels } from '@shared/types/ipc.js';
import type { SessionId } from '@shared/types/sessions.js';
import type { SessionStore } from '../sessions/SessionStore.js';
import { ipcInvoke } from './result.js';

export interface SystemIpcOptions {
  store: SessionStore;
}

export class SystemIpc {
  private registered = false;

  constructor(private readonly opts: SystemIpcOptions) {}

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(IpcChannels.system.openPath, (_e, sessionId: SessionId) =>
      ipcInvoke(async () => {
        const session = await this.opts.store.get(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        if (session.runMode === 'wsl') {
          if (!session.wslDistro) throw new Error('Session has no wslDistro');
          await openInWsl(session.wslDistro, session.cwd);
        } else {
          const result = await shell.openPath(session.cwd);
          if (result) throw new Error(result);
        }
        return true as const;
      })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.system.openPath);
    this.registered = false;
  }
}

function openInWsl(distro: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'wsl.exe',
      ['-d', distro, '--cd', cwd, '--', 'explorer.exe', '.'],
      { detached: true, stdio: 'ignore' }
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
