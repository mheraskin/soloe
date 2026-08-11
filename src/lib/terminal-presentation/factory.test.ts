import { describe, expect, it, vi } from 'vitest';
import { ConfigurableTerminalPresentationFactory } from './factory';
import type { NativeTerminalHost } from './native-host';
import type {
  TerminalPresentation,
  TerminalPresentationCreateRequest,
  TerminalPresentationKind
} from './types';

function presentation(kind: TerminalPresentationKind): TerminalPresentation {
  return {
    kind,
    write: async () => {},
    replace: async () => {},
    setVisible: () => {},
    setFocused: () => {},
    setCompactViewport: () => {},
    setConfiguration: () => {},
    fit: () => {},
    focus: () => {},
    paste: () => {},
    hasSelection: () => false,
    getSelection: () => '',
    clearSelection: () => {},
    find: async () => false,
    exportBuffer: async () => '',
    scrollToBottom: () => {},
    dispose: () => {}
  };
}

function request(onFallback = vi.fn()): TerminalPresentationCreateRequest {
  return {
    terminalId: 'terminal-1',
    sessionId: 'session-1',
    host: {} as HTMLElement,
    configuration: {
      fontFamily: 'monospace',
      fontSize: 13,
      fontWeight: 400,
      fontWeightBold: 700,
      lineHeight: 1,
      letterSpacing: 0,
      minimumContrastRatio: 4.5,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'outline',
      unicodeVersion: '11',
      scrollback: 5000,
      theme: {
        background: '#000', foreground: '#fff', cursor: '#fff', cursorAccent: '#000',
        selectionBackground: '#333', selectionForeground: '#fff', black: '#000', red: '#f00',
        green: '#0f0', yellow: '#ff0', blue: '#00f', magenta: '#f0f', cyan: '#0ff',
        white: '#fff', brightBlack: '#777', brightRed: '#f00', brightGreen: '#0f0',
        brightYellow: '#ff0', brightBlue: '#00f', brightMagenta: '#f0f',
        brightCyan: '#0ff', brightWhite: '#fff'
      }
    },
    visible: true,
    focused: true,
    compactViewport: false,
    callbacks: {
      onInput: () => {},
      onResize: () => {},
      onLink: () => {},
      onKey: () => true,
      onRendererFailure: onFallback
    }
  };
}

function host(complete: boolean, available = true): NativeTerminalHost {
  return {
    capabilities: async () => ({ available, complete, reason: complete ? undefined : 'not ready' }),
    createSurface: vi.fn()
  };
}

describe('ConfigurableTerminalPresentationFactory', () => {
  it.each(['browser', 'local-electron', 'remote-electron'] as const)(
    'uses xterm directly for the %s client',
    async (transport) => {
      const onFallback = vi.fn();
      const createXterm = vi.fn(() => presentation('xterm'));
      const createLibghostty = vi.fn(async () => presentation('libghostty'));
      const factory = new ConfigurableTerminalPresentationFactory({
        preference: 'libghostty',
        transport,
        nativeHost: host(true),
        createXterm,
        createLibghostty
      });

      await expect(factory.create(request(onFallback))).resolves.toMatchObject({ kind: 'xterm' });
      expect(createLibghostty).not.toHaveBeenCalled();
      expect(onFallback).not.toHaveBeenCalled();
    }
  );

  it('uses libghostty only after complete native initialization', async () => {
    const createLibghostty = vi.fn(async () => presentation('libghostty'));
    const factory = new ConfigurableTerminalPresentationFactory({
      preference: 'auto',
      transport: 'tauri',
      nativeHost: host(true),
      createXterm: () => presentation('xterm'),
      createLibghostty
    });

    await expect(factory.create(request())).resolves.toMatchObject({ kind: 'libghostty' });
    expect(createLibghostty).toHaveBeenCalledOnce();
  });

  it.each(['missing', 'incomplete', 'failed'] as const)(
    'falls back to xterm when native initialization is %s',
    async (failure) => {
      const onFallback = vi.fn();
      const createLibghostty = failure === 'failed'
        ? vi.fn(async () => { throw new Error('native create failed'); })
        : vi.fn(async () => presentation('libghostty'));
      const factory = new ConfigurableTerminalPresentationFactory({
        preference: 'libghostty',
        transport: 'tauri',
        nativeHost: failure === 'missing' ? null : host(failure !== 'incomplete'),
        createXterm: () => presentation('xterm'),
        createLibghostty
      });

      await expect(factory.create(request(onFallback))).resolves.toMatchObject({ kind: 'xterm' });
      expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
        renderer: 'native',
        recovered: true
      }));
    }
  );
});
