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

// Bounds for the embedded DevTools host, in DIP coordinates relative to the
// owning BrowserWindow's content area — same coordinate system the renderer
// gets back from getBoundingClientRect().
export interface DevToolsBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OpenDevToolsRequest {
  webContentsId: number;
  bounds: DevToolsBounds;
}

export interface SetDevToolsLayoutRequest {
  webContentsId: number;
  bounds?: DevToolsBounds;
  visible?: boolean;
}

export interface CloseDevToolsRequest {
  webContentsId: number;
}
