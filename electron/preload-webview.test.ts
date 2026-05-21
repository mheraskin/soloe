/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToHost } = vi.hoisted(() => ({
  sendToHost: vi.fn()
}));

vi.mock('electron', () => ({
  ipcRenderer: {
    sendToHost
  }
}));

await import('./preload-webview');

function focusInput(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

describe('webview preload credential focus telemetry', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sendToHost.mockClear();
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
});
