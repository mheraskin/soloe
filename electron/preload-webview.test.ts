/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { electronListeners, executeInMainWorld, sendToHost } = vi.hoisted(() => ({
  electronListeners: new Map<string, (...args: unknown[]) => void>(),
  executeInMainWorld: vi.fn(() => null),
  sendToHost: vi.fn()
}));

vi.mock('electron', () => ({
  contextBridge: {
    executeInMainWorld
  },
  ipcRenderer: {
    sendToHost,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      electronListeners.set(channel, listener);
    })
  }
}));

await import('./preload-webview');

function focusInput(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

function setInspectorMode(enabled: boolean): void {
  electronListeners.get('soloe:webview-element-source-mode')?.({}, { enabled });
}

describe('webview preload credential focus telemetry', () => {
  beforeEach(() => {
    setInspectorMode(false);
    document.body.innerHTML = '';
    sendToHost.mockClear();
  });

  afterEach(() => {
    setInspectorMode(false);
  });

  it('reports email focus when the field belongs to a password form', () => {
    document.body.innerHTML = `
      <form>
        <input id="email" type="email" />
        <input id="password" type="password" />
      </form>
    `;

    focusInput(document.querySelector<HTMLInputElement>('#email')!);

    expect(sendToHost).toHaveBeenCalledWith('soloe:webview-password-focus', {
      origin: window.location.origin,
      rect: null
    });
  });

  it('does not report email focus without a related password field', () => {
    document.body.innerHTML = '<input id="email" type="email" />';

    focusInput(document.querySelector<HTMLInputElement>('#email')!);

    expect(sendToHost).not.toHaveBeenCalledWith(
      'soloe:webview-password-focus',
      expect.anything()
    );
  });

  it('reports guest-page pointer presses so host popovers can dismiss', () => {
    document.body.innerHTML = '<button type="button">Continue</button>';

    document.querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));

    expect(sendToHost).toHaveBeenCalledWith('soloe:webview-pointerdown');
  });

  it('blocks application activation while inspecting but preserves scrolling and Shift-click', () => {
    document.body.innerHTML = '<button type="button">Open dialog</button>';
    const button = document.querySelector('button')!;
    const onPointerUp = vi.fn();
    const onClick = vi.fn();
    const onWheel = vi.fn();
    button.addEventListener('pointerup', onPointerUp);
    button.addEventListener('click', onClick);
    button.addEventListener('wheel', onWheel);
    setInspectorMode(true);

    button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    button.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    const inspectedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    button.dispatchEvent(inspectedClick);
    button.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true }));

    expect(onPointerUp).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(inspectedClick.defaultPrevented).toBe(true);
    expect(onWheel).toHaveBeenCalledOnce();

    button.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      shiftKey: true
    }));
    button.dispatchEvent(new MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      shiftKey: true
    }));
    button.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      shiftKey: true
    }));

    expect(onPointerUp).toHaveBeenCalledOnce();
    expect(onClick).toHaveBeenCalledOnce();
  });
});
