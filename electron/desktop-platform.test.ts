import { describe, expect, it } from 'vitest';
import {
  applicationMenuTemplate,
  desktopWindowPolicy,
  shouldPreventWindowCloseShortcut,
  shouldQuitAfterLastWindow,
  shouldShowCustomWindowControls
} from './desktop-platform.js';

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
