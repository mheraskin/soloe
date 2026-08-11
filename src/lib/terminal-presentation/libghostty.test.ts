// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTerminalPresentationConfiguration } from './configuration';
import { LibghosttyTerminalPresentationAdapter } from './libghostty';
import type { NativeTerminalHost, NativeTerminalSurface } from './native-host';
import type { TerminalPresentationCreateRequest } from './types';

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
}

function nativeSurface(calls: string[]): NativeTerminalSurface {
  let selection = 'selected output';
  return {
    write: vi.fn(async (data: string) => { calls.push(`write:${data}`); }),
    replace: vi.fn(async (data: string) => { calls.push(`replace:${data}`); }),
    setVisible: vi.fn(async (visible: boolean) => { calls.push(`visible:${visible}`); }),
    setFocused: vi.fn(async (focused: boolean) => { calls.push(`focused:${focused}`); }),
    setBounds: vi.fn(async () => {
      calls.push('bounds');
      return { cols: 120, rows: 40 };
    }),
    setConfiguration: vi.fn(async () => { calls.push('configuration'); }),
    paste: vi.fn(async (text: string) => { calls.push(`paste:${text}`); }),
    hasSelection: vi.fn(() => selection.length > 0),
    getSelection: vi.fn(() => selection),
    clearSelection: vi.fn(() => { selection = ''; }),
    find: vi.fn(async (query: string, direction: 'next' | 'previous') => {
      calls.push(`find:${direction}:${query}`);
      return true;
    }),
    exportBuffer: vi.fn(async () => 'complete buffer\n'),
    scrollToBottom: vi.fn(async () => { calls.push('bottom'); }),
    dispose: vi.fn(async () => { calls.push('dispose'); })
  };
}

function request(host: HTMLElement, onResize = vi.fn()): TerminalPresentationCreateRequest {
  return {
    terminalId: 'terminal-1',
    sessionId: 'session-1',
    host,
    configuration: defaultTerminalPresentationConfiguration(13, 5_000),
    visible: true,
    focused: false,
    compactViewport: false,
    callbacks: {
      onInput: vi.fn(),
      onResize,
      onLink: vi.fn(),
      onKey: vi.fn(() => true)
    }
  };
}

describe('LibghosttyTerminalPresentationAdapter contract', () => {
  beforeEach(() => {
    TestResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it('presents a native surface without taking ownership of terminal lifetime', async () => {
    const calls: string[] = [];
    const surface = nativeSurface(calls);
    const nativeHost: NativeTerminalHost = {
      capabilities: vi.fn(async () => ({ available: true, complete: true })),
      createSurface: vi.fn(async () => surface)
    };
    const element = document.createElement('div');
    element.getBoundingClientRect = () => new DOMRect(10, 20, 900, 500);
    document.body.append(element);
    const onResize = vi.fn();

    const presentation = await LibghosttyTerminalPresentationAdapter.create(
      nativeHost,
      request(element, onResize)
    );
    await Promise.resolve();

    expect(presentation.kind).toBe('libghostty');
    expect(nativeHost.createSurface).toHaveBeenCalledOnce();
    expect(calls.slice(0, 4)).toEqual([
      'configuration',
      'visible:true',
      'focused:false',
      'bounds'
    ]);
    expect(onResize).toHaveBeenCalledWith({ cols: 120, rows: 40 });

    await presentation.replace('replay');
    await presentation.write('live-1');
    await presentation.write('live-2');
    presentation.paste('clipboard');
    await expect(presentation.find('needle', 'previous')).resolves.toBe(true);
    await expect(presentation.exportBuffer()).resolves.toBe('complete buffer\n');
    expect(calls).toEqual(expect.arrayContaining([
      'replace:replay',
      'write:live-1',
      'write:live-2',
      'paste:clipboard',
      'find:previous:needle'
    ]));

    expect(presentation.hasSelection()).toBe(true);
    expect(presentation.getSelection()).toBe('selected output');
    presentation.clearSelection();
    expect(presentation.hasSelection()).toBe(false);

    presentation.setVisible(false);
    presentation.setFocused(true, true);
    presentation.setVisible(true);
    presentation.scrollToBottom();
    presentation.dispose();
    await Promise.resolve();
    expect(TestResizeObserver.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(calls).toContain('dispose');

    const callCount = calls.length;
    await presentation.write('after-dispose');
    expect(calls).toHaveLength(callCount);
  });
});
