import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export interface TauriBrowserSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TauriBrowserPageLoadEvent {
  surfaceId: number;
  url: string;
  phase: 'started' | 'finished';
}

interface BrowserSurfaceDescriptor {
  surfaceId: number;
  webContentsId: number;
}

export interface TauriBrowserSurfaceCreateRequest {
  url: string;
  bounds: TauriBrowserSurfaceBounds;
  visible: boolean;
  userAgent?: string | null;
}

/** Thin renderer-side Adapter for the shell-owned native browser surface. */
export class TauriBrowserSurface {
  readonly surfaceId: number;
  readonly webContentsId: number;

  private constructor(descriptor: BrowserSurfaceDescriptor) {
    this.surfaceId = descriptor.surfaceId;
    this.webContentsId = descriptor.webContentsId;
  }

  static async create(request: TauriBrowserSurfaceCreateRequest): Promise<TauriBrowserSurface> {
    const descriptor = await invoke<BrowserSurfaceDescriptor>('browser_surface_create', {
      request
    });
    return new TauriBrowserSurface(descriptor);
  }

  navigate(url: string): Promise<void> {
    return invoke('browser_surface_navigate', { surfaceId: this.surfaceId, url });
  }

  setBounds(bounds: TauriBrowserSurfaceBounds): Promise<void> {
    return invoke('browser_surface_set_bounds', { surfaceId: this.surfaceId, bounds });
  }

  setVisible(visible: boolean): Promise<void> {
    return invoke('browser_surface_set_visible', { surfaceId: this.surfaceId, visible });
  }

  reload(): Promise<void> {
    return invoke('browser_surface_reload', { surfaceId: this.surfaceId });
  }

  setZoom(factor: number): Promise<void> {
    return invoke('browser_surface_set_zoom', { surfaceId: this.surfaceId, factor });
  }

  dispose(): Promise<void> {
    return invoke('browser_surface_dispose', { surfaceId: this.surfaceId });
  }
}

export function onTauriBrowserPageLoad(
  listener: (event: TauriBrowserPageLoadEvent) => void
): Promise<UnlistenFn> {
  return listen<TauriBrowserPageLoadEvent>('soloe://browser-page-load', ({ payload }) => {
    listener(payload);
  });
}
