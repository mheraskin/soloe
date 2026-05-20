import {
  BrowserWindow,
  ipcMain,
  WebContentsView,
  webContents as webContentsModule,
  type WebContents
} from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  CloseDevToolsRequest,
  DevToolsBounds,
  DisableDeviceEmulationRequest,
  EnableDeviceEmulationRequest,
  OpenDevToolsRequest,
  SetDevToolsBoundsRequest,
  SetUserAgentRequest
} from '@shared/types/browser.js';
import { ipcInvoke } from './result.js';

interface DevToolsHost {
  view: WebContentsView;
  window: BrowserWindow;
  target: WebContents;
  onTargetDestroyed: () => void;
}

export class BrowserIpc {
  private registered = false;
  // Keyed by the target webContents id (the inspected page), so opening
  // DevTools twice for the same page reuses the existing host instead of
  // stacking them.
  private hosts = new Map<number, DevToolsHost>();

  register(): void {
    if (this.registered) return;
    this.registered = true;

    ipcMain.handle(
      IpcChannels.browser.enableDeviceEmulation,
      (_event, request: EnableDeviceEmulationRequest) =>
        ipcInvoke(() => {
          const target = webContentsModule.fromId(request.webContentsId);
          if (!target || target.isDestroyed()) throw new Error('webview not found');
          if (request.emulation.userAgent != null) {
            target.setUserAgent(request.emulation.userAgent);
          }
          target.enableDeviceEmulation({
            screenPosition: request.emulation.mobile ? 'mobile' : 'desktop',
            screenSize: {
              width: Math.round(request.emulation.width),
              height: Math.round(request.emulation.height)
            },
            viewSize: {
              width: Math.round(request.emulation.width),
              height: Math.round(request.emulation.height)
            },
            viewPosition: { x: 0, y: 0 },
            deviceScaleFactor: request.emulation.deviceScaleFactor,
            scale: 1
          });
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.browser.disableDeviceEmulation,
      (_event, request: DisableDeviceEmulationRequest) =>
        ipcInvoke(() => {
          const target = webContentsModule.fromId(request.webContentsId);
          if (!target || target.isDestroyed()) return true as const;
          target.disableDeviceEmulation();
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.browser.setUserAgent,
      (_event, request: SetUserAgentRequest) =>
        ipcInvoke(() => {
          const target = webContentsModule.fromId(request.webContentsId);
          if (!target || target.isDestroyed()) throw new Error('webview not found');
          if (request.userAgent == null) {
            target.setUserAgent(target.session.getUserAgent());
          } else {
            target.setUserAgent(request.userAgent);
          }
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.browser.openDevTools,
      (event, request: OpenDevToolsRequest) =>
        ipcInvoke(() => {
          const target = webContentsModule.fromId(request.webContentsId);
          if (!target || target.isDestroyed()) throw new Error('target webContents not found');

          const win = BrowserWindow.fromWebContents(event.sender);
          if (!win || win.isDestroyed()) {
            throw new Error('owning BrowserWindow not found');
          }

          const existing = this.hosts.get(request.webContentsId);
          if (existing) {
            existing.view.setBounds(roundBounds(request.bounds));
            return true as const;
          }

          // The DevTools host MUST be a never-navigated WebContents — Chromium
          // forbids guest views (<webview>) as DevTools containers, which is
          // why the earlier two-webview attempt rendered blank. WebContentsView
          // is the supported host. See electron/electron#14095 and the
          // setDevToolsWebContents docs.
          const view = new WebContentsView({
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: false
            }
          });
          view.setBackgroundColor('#1e1e1e');
          win.contentView.addChildView(view);
          view.setBounds(roundBounds(request.bounds));

          const onTargetDestroyed = () => this.teardownHost(request.webContentsId);
          target.once('destroyed', onTargetDestroyed);

          this.hosts.set(request.webContentsId, {
            view,
            window: win,
            target,
            onTargetDestroyed
          });

          target.setDevToolsWebContents(view.webContents);
          // mode is forced to 'detach' when setDevToolsWebContents is used,
          // but passing it explicitly avoids the "last used mode" fallback.
          target.openDevTools({ mode: 'detach' });
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.browser.setDevToolsBounds,
      (_event, request: SetDevToolsBoundsRequest) =>
        ipcInvoke(() => {
          const host = this.hosts.get(request.webContentsId);
          if (!host) return true as const;
          host.view.setBounds(roundBounds(request.bounds));
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.browser.closeDevTools,
      (_event, request: CloseDevToolsRequest) =>
        ipcInvoke(() => {
          const host = this.hosts.get(request.webContentsId);
          if (host) {
            if (!host.target.isDestroyed() && host.target.isDevToolsOpened()) {
              host.target.closeDevTools();
            }
            this.teardownHost(request.webContentsId);
          } else {
            const target = webContentsModule.fromId(request.webContentsId);
            if (target && !target.isDestroyed() && target.isDevToolsOpened()) {
              target.closeDevTools();
            }
          }
          return true as const;
        })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    for (const id of Array.from(this.hosts.keys())) {
      this.teardownHost(id);
    }
    ipcMain.removeHandler(IpcChannels.browser.enableDeviceEmulation);
    ipcMain.removeHandler(IpcChannels.browser.disableDeviceEmulation);
    ipcMain.removeHandler(IpcChannels.browser.setUserAgent);
    ipcMain.removeHandler(IpcChannels.browser.openDevTools);
    ipcMain.removeHandler(IpcChannels.browser.setDevToolsBounds);
    ipcMain.removeHandler(IpcChannels.browser.closeDevTools);
    this.registered = false;
  }

  private teardownHost(targetId: number): void {
    const host = this.hosts.get(targetId);
    if (!host) return;
    this.hosts.delete(targetId);
    try {
      host.target.removeListener('destroyed', host.onTargetDestroyed);
    } catch {
      // listener may already be gone
    }
    if (!host.window.isDestroyed()) {
      try {
        host.window.contentView.removeChildView(host.view);
      } catch {
        // view may have been detached already
      }
    }
    // setDevToolsWebContents docs require the caller to destroy the host
    // webContents manually — close() is the supported way to free it.
    try {
      if (!host.view.webContents.isDestroyed()) {
        host.view.webContents.close();
      }
    } catch {
      // best-effort
    }
  }
}

function roundBounds(bounds: DevToolsBounds): DevToolsBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height))
  };
}
