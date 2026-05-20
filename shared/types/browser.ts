export interface DeviceEmulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  userAgent?: string;
}

export interface EnableDeviceEmulationRequest {
  webContentsId: number;
  emulation: DeviceEmulation;
}

export interface DisableDeviceEmulationRequest {
  webContentsId: number;
}

export interface SetUserAgentRequest {
  webContentsId: number;
  userAgent: string | null;
}

export interface AttachDevToolsRequest {
  // The main page being inspected.
  webContentsId: number;
  // A separate <webview> that will host the DevTools UI inside the app — the
  // panel below the page — so DevTools doesn't pop a detached window.
  devToolsWebContentsId: number;
}

export interface CloseDevToolsRequest {
  webContentsId: number;
}
