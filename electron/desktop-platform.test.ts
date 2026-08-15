import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applicationMenuTemplate,
  desktopApplicationIdentity,
  desktopWindowPolicy,
  shouldPreventWindowCloseShortcut,
  shouldQuitAfterLastWindow,
  shouldRecreateWindowForReopen,
  shouldShowCustomWindowControls
} from './desktop-platform.js';

describe('desktopApplicationIdentity', () => {
  it('provides native development metadata before Electron starts', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../apps/desktop-electron/package.json', import.meta.url), 'utf8')
    ) as { productName?: string; desktopName?: string };

    expect(packageJson.productName).toBe('Soloe');
    expect(packageJson.desktopName).toBe('com.soloe.app.desktop');
    expect(
      (packageJson as { scripts?: { dev?: string } }).scripts?.dev
    ).toBe('node ../../scripts/run-electron-dev.mjs');
  });

  it('brands the macOS development bundle before the OS sees it', async () => {
    // @ts-expect-error The launcher is intentionally plain Node ESM.
    const launcher = await import('../scripts/run-electron-dev.mjs') as {
      DEVELOPMENT_APP_NAME: string;
      DEVELOPMENT_APP_ID: string;
      DEVELOPMENT_HELPER_BUNDLES: Array<[string, string, string]>;
      DEVELOPMENT_NESTED_SIGNABLES: string[];
    };

    expect(launcher.DEVELOPMENT_APP_NAME).toBe('Soloe');
    expect(launcher.DEVELOPMENT_APP_ID).toBe('com.soloe.app.dev');
    expect(launcher.DEVELOPMENT_HELPER_BUNDLES.map(([, destination]) => destination)).toEqual([
      'Soloe Helper.app',
      'Soloe Helper (GPU).app',
      'Soloe Helper (Plugin).app',
      'Soloe Helper (Renderer).app'
    ]);
    expect(launcher.DEVELOPMENT_NESTED_SIGNABLES).toContain(
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework'
    );
    expect(launcher.DEVELOPMENT_NESTED_SIGNABLES).toContain(
      'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'
    );
  });

  it('brands the macOS development application and its Dock icon as Soloe', () => {
    expect(desktopApplicationIdentity('darwin')).toEqual({
      name: 'Soloe',
      setDockIcon: true,
      setWindowIcon: false
    });
  });

  it('uses the packaged desktop ID for Linux launchers and window grouping', () => {
    expect(desktopApplicationIdentity('linux')).toEqual({
      name: 'Soloe',
      desktopName: 'com.soloe.app.desktop',
      setDockIcon: false,
      setWindowIcon: true
    });
  });

  it('keeps the Soloe application name on Windows', () => {
    expect(desktopApplicationIdentity('win32')).toEqual({
      name: 'Soloe',
      setDockIcon: false,
      setWindowIcon: true
    });
  });
});

describe('desktopWindowPolicy', () => {
  it('uses native inset traffic lights on macOS', () => {
    expect(desktopWindowPolicy('darwin')).toEqual({
      autoHideMenuBar: false,
      frame: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 10, y: 7 }
    });
    expect(shouldShowCustomWindowControls('darwin')).toBe(false);
    expect(shouldShowCustomWindowControls('macos')).toBe(false);
  });

  it('preserves the frameless desktop shell on Windows and Linux', () => {
    expect(desktopWindowPolicy('win32')).toEqual({
      autoHideMenuBar: true,
      frame: false
    });
    expect(desktopWindowPolicy('linux')).toEqual({
      autoHideMenuBar: true,
      frame: false
    });
    expect(shouldShowCustomWindowControls('linux')).toBe(true);
  });
});

describe('shouldQuitAfterLastWindow', () => {
  it('releases the tray-supervised macOS UI process after its window closes', () => {
    expect(shouldQuitAfterLastWindow('darwin', true)).toBe(true);
  });

  it('preserves normal standalone macOS activation behavior', () => {
    expect(shouldQuitAfterLastWindow('darwin', false)).toBe(false);
    expect(shouldQuitAfterLastWindow('win32', false)).toBe(true);
    expect(shouldQuitAfterLastWindow('linux', false)).toBe(true);
  });
});

describe('shouldRecreateWindowForReopen', () => {
  it('recreates a missing or destroyed window for a second-instance request', () => {
    expect(shouldRecreateWindowForReopen(null)).toBe(true);
    expect(shouldRecreateWindowForReopen({ isDestroyed: () => true })).toBe(true);
    expect(shouldRecreateWindowForReopen({ isDestroyed: () => false })).toBe(false);
  });
});

describe('shouldPreventWindowCloseShortcut', () => {
  it('allows the standard macOS close-window shortcut', () => {
    expect(shouldPreventWindowCloseShortcut('darwin')).toBe(false);
  });

  it('preserves existing shortcut routing off macOS', () => {
    expect(shouldPreventWindowCloseShortcut('win32')).toBe(true);
    expect(shouldPreventWindowCloseShortcut('linux')).toBe(true);
  });
});

describe('applicationMenuTemplate', () => {
  it('provides the standard native menu groups on macOS', () => {
    expect(applicationMenuTemplate('darwin').map((item) => item.role)).toEqual([
      'appMenu',
      'fileMenu',
      'editMenu',
      'viewMenu',
      'windowMenu'
    ]);
  });

  it('keeps the application menu disabled off macOS', () => {
    expect(applicationMenuTemplate('win32')).toEqual([]);
    expect(applicationMenuTemplate('linux')).toEqual([]);
  });
});
