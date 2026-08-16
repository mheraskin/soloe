import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from 'electron';

export interface DesktopApplicationIdentity {
  name: 'Soloe';
  desktopName?: 'com.soloe.app.desktop';
  setDockIcon: boolean;
  setWindowIcon: boolean;
}

export type DesktopRendererTarget =
  | { kind: 'url'; value: string }
  | { kind: 'file' };

export function desktopRendererTarget(input: {
  appIsPackaged: boolean;
  development: boolean;
  developmentUrl?: string;
}): DesktopRendererTarget {
  if (input.developmentUrl && (input.development || !input.appIsPackaged)) {
    return { kind: 'url', value: input.developmentUrl };
  }
  return { kind: 'file' };
}

export function desktopApplicationIdentity(
  platform: NodeJS.Platform = process.platform
): DesktopApplicationIdentity {
  return {
    name: 'Soloe',
    ...(platform === 'linux' ? { desktopName: 'com.soloe.app.desktop' as const } : {}),
    setDockIcon: platform === 'darwin',
    setWindowIcon: platform === 'linux' || platform === 'win32'
  };
}

export type DesktopWindowPolicy = Pick<
  BrowserWindowConstructorOptions,
  'autoHideMenuBar' | 'frame' | 'titleBarStyle' | 'trafficLightPosition'
>;

export function desktopWindowPolicy(
  platform: NodeJS.Platform = process.platform
): DesktopWindowPolicy {
  if (platform === 'darwin') {
    return {
      autoHideMenuBar: false,
      frame: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 7 }
    };
  }
  return { autoHideMenuBar: true, frame: false };
}

export function shouldQuitAfterLastWindow(
  platform: NodeJS.Platform = process.platform,
  supervised = false
): boolean {
  return platform !== 'darwin' || supervised;
}

export function shouldRecreateWindowForReopen(
  window: { isDestroyed(): boolean } | null
): boolean {
  return window === null || window.isDestroyed();
}

export function shouldPreventWindowCloseShortcut(
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'darwin';
}

export function shouldShowCustomWindowControls(
  platform: NodeJS.Platform | 'macos' = process.platform
): boolean {
  return platform !== 'darwin' && platform !== 'macos';
}

export function applicationMenuTemplate(
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  if (platform !== 'darwin') return [];
  return [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ];
}
