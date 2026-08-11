// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { ctrlSlashSequence } from './terminal-input';

describe('xterm terminal input', () => {
  let terminal: Terminal | null = null;

  beforeEach(() => {
    vi.stubGlobal('devicePixelRatio', 1);
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        matches: false,
        removeEventListener: vi.fn(),
        removeListener: vi.fn()
      })
    });
  });

  afterEach(() => {
    terminal?.dispose();
    terminal = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it('emits Ctrl+/ from physical and layout-shifted slash keys', () => {
    const host = document.createElement('div');
    document.body.append(host);
    terminal = new Terminal();
    const input: string[] = [];
    terminal.onData((data) => input.push(data));
    terminal.open(host);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const sequence = ctrlSlashSequence(event);
      if (sequence === null) return true;
      event.preventDefault();
      input.push(sequence);
      return false;
    });

    const textarea = host.querySelector('textarea');
    expect(textarea).not.toBeNull();
    for (const keyEvent of [
      { code: 'Slash', key: '/', keyCode: 191, shiftKey: false },
      { code: 'Digit7', key: '/', keyCode: 55, shiftKey: true }
    ]) {
      textarea!.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code: keyEvent.code,
        ctrlKey: true,
        key: keyEvent.key,
        shiftKey: keyEvent.shiftKey,
        keyCode: keyEvent.keyCode
      }));
    }

    expect(input).toEqual(['\x1f', '\x1f']);
  });
});
