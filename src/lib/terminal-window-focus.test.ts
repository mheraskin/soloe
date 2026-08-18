/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreTerminalFocusOnWindowActivation } from './terminal-window-focus';

describe('restoreTerminalFocusOnWindowActivation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('restores a terminal that held focus before window activation', () => {
    const host = document.createElement('div');
    const textarea = document.createElement('textarea');
    host.append(textarea);
    document.body.append(host);
    textarea.focus();
    const restore = vi.fn();
    const dispose = restoreTerminalFocusOnWindowActivation({
      host,
      canRestore: () => true,
      restore,
      requestFrame: (callback) => {
        callback(0);
        return 1;
      }
    });

    window.dispatchEvent(new Event('focus'));

    expect(restore).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('does not steal focus from another Soloe field', () => {
    const host = document.createElement('div');
    const textarea = document.createElement('textarea');
    const otherInput = document.createElement('input');
    host.append(textarea);
    document.body.append(host, otherInput);
    textarea.focus();
    const restore = vi.fn();
    const dispose = restoreTerminalFocusOnWindowActivation({
      host,
      canRestore: () => true,
      restore,
      requestFrame: (callback) => {
        callback(0);
        return 1;
      }
    });

    otherInput.focus();
    window.dispatchEvent(new Event('focus'));

    expect(restore).not.toHaveBeenCalled();
    dispose();
  });
});
