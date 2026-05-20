import { ipcMain, webContents as webContentsModule } from 'electron';
import { IpcChannels } from '@shared/types/ipc.js';
import type {
  AttachDevToolsRequest,
  CloseDevToolsRequest,
  DisableDeviceEmulationRequest,
  EnableDeviceEmulationRequest,
  SetUserAgentRequest
} from '@shared/types/browser.js';
import { ipcInvoke } from './result.js';

export class BrowserIpc {
  private registered = false;

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
      IpcChannels.browser.attachDevTools,
      (_event, request: AttachDevToolsRequest) =>
        ipcInvoke(() => {
          const main = webContentsModule.fromId(request.webContentsId);
          const dev = webContentsModule.fromId(request.devToolsWebContentsId);
          if (!main || main.isDestroyed()) throw new Error('main webview not found');
          if (!dev || dev.isDestroyed()) throw new Error('devtools host webview not found');
          // Route DevTools UI into the renderer-mounted <webview> instead of
          // spawning a detached window. Must happen before openDevTools().
          main.setDevToolsWebContents(dev);
          main.openDevTools({ mode: 'detach' });
          return true as const;
        })
    );

    ipcMain.handle(
      IpcChannels.browser.closeDevTools,
      (_event, request: CloseDevToolsRequest) =>
        ipcInvoke(() => {
          const target = webContentsModule.fromId(request.webContentsId);
          if (!target || target.isDestroyed()) return true as const;
          if (target.isDevToolsOpened()) target.closeDevTools();
          return true as const;
        })
    );
  }

  dispose(): void {
    if (!this.registered) return;
    ipcMain.removeHandler(IpcChannels.browser.enableDeviceEmulation);
    ipcMain.removeHandler(IpcChannels.browser.disableDeviceEmulation);
    ipcMain.removeHandler(IpcChannels.browser.setUserAgent);
    ipcMain.removeHandler(IpcChannels.browser.attachDevTools);
    ipcMain.removeHandler(IpcChannels.browser.closeDevTools);
    this.registered = false;
  }
}
