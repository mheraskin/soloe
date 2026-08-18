export interface TerminalWindowFocusOptions {
  host: HTMLElement;
  canRestore(): boolean;
  restore(): void | Promise<void>;
  requestFrame?: (callback: FrameRequestCallback) => number;
}

/**
 * Browser shells can leave xterm's textarea as the logical active element
 * while dropping its native keyboard focus when the OS activates another app.
 * Remember the last in-app focus target and explicitly restore xterm only when
 * the user did not return by focusing another Soloe control.
 */
export function restoreTerminalFocusOnWindowActivation(
  options: TerminalWindowFocusOptions
): () => void {
  const requestFrame = options.requestFrame ?? window.requestAnimationFrame.bind(window);
  let terminalHadFocus = options.host.contains(document.activeElement);

  const onDocumentFocusIn = (event: FocusEvent): void => {
    terminalHadFocus = event.target instanceof Node && options.host.contains(event.target);
  };
  const onWindowFocus = (): void => {
    if (!terminalHadFocus) return;
    requestFrame(() => {
      if (!terminalHadFocus || !options.canRestore()) return;
      const active = document.activeElement;
      const terminalOrNeutral = !active
        || active === document.body
        || active === document.documentElement
        || options.host.contains(active);
      if (!terminalOrNeutral) return;
      try {
        void Promise.resolve(options.restore()).catch(() => undefined);
      } catch {
        // Native focus restoration is best-effort during window activation.
      }
    });
  };

  document.addEventListener('focusin', onDocumentFocusIn, true);
  window.addEventListener('focus', onWindowFocus);
  return () => {
    document.removeEventListener('focusin', onDocumentFocusIn, true);
    window.removeEventListener('focus', onWindowFocus);
  };
}
