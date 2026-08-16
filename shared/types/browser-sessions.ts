import type { DeviceId } from './devices.js';

export interface BrowserTabDevice {
  presetId: string;
  width: number;
  height: number;
  dpr: number;
  mobile: boolean;
  ua: string;
  rotated: boolean;
}

export interface BrowserTargetDevice {
  deviceId: DeviceId;
  name: string;
  tailscaleDnsName: string | null;
  local: boolean;
}

export interface BrowserSessionTab {
  id: string;
  title: string;
  history: string[];
  historyIndex: number;
  device?: BrowserTabDevice;
  targetDevice?: BrowserTargetDevice;
  pageZoom?: number;
  canvasZoom?: number;
  pausedAt?: number;
}

export interface BrowserSessionScopeState {
  tabs: BrowserSessionTab[];
  activeTabId: string | null;
}

export interface BrowserSessionSnapshot {
  version: 1;
  scopeRecency: string[];
  scopes: Record<string, BrowserSessionScopeState>;
}

export interface BrowserSessionUpdateRequest {
  scopeKey: string;
  state: BrowserSessionScopeState;
}
