const KEYBOARD_THRESHOLD_PX = 140;

export function attachMobileViewport(root: HTMLElement = document.documentElement): () => void {
  const viewport = window.visualViewport;
  const standaloneQuery = window.matchMedia('(display-mode: standalone)');
  const standalone = () =>
    standaloneQuery.matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  let stableHeight = Math.round(
    standalone() ? window.innerHeight : (viewport?.height ?? window.innerHeight)
  );
  let keyboardOpen = false;

  const update = () => {
    const keyboardInset = viewport
      ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
      : 0;
    const nextKeyboardOpen = keyboardInset >= KEYBOARD_THRESHOLD_PX;
    const keyboardClosed = keyboardOpen && !nextKeyboardOpen;
    if (!nextKeyboardOpen) {
      stableHeight = Math.round(
        standalone() ? window.innerHeight : (viewport?.height ?? window.innerHeight)
      );
    }
    keyboardOpen = nextKeyboardOpen;

    root.style.setProperty('--app-height', `${stableHeight}px`);
    root.style.setProperty('--keyboard-inset', `${keyboardInset}px`);
    root.toggleAttribute('data-mobile-keyboard-open', keyboardOpen);
    window.dispatchEvent(new CustomEvent('soloe:rail-layout', {
      detail: { keyboardOpen, keyboardClosed }
    }));
  };

  update();
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  standaloneQuery.addEventListener('change', update);

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    standaloneQuery.removeEventListener('change', update);
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--keyboard-inset');
    root.removeAttribute('data-mobile-keyboard-open');
  };
}
