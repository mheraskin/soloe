const KEYBOARD_THRESHOLD_PX = 140;

export function attachMobileViewport(root: HTMLElement = document.documentElement): () => void {
  const viewport = window.visualViewport;

  const update = () => {
    const height = Math.round(viewport?.height ?? window.innerHeight);
    const keyboardInset = viewport
      ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))
      : 0;

    root.style.setProperty('--app-height', `${height}px`);
    root.style.setProperty('--keyboard-inset', `${keyboardInset}px`);
    root.toggleAttribute('data-mobile-keyboard-open', keyboardInset >= KEYBOARD_THRESHOLD_PX);
    window.dispatchEvent(new CustomEvent('soloe:rail-layout'));
  };

  update();
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('orientationchange', update);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    root.style.removeProperty('--app-height');
    root.style.removeProperty('--keyboard-inset');
    root.removeAttribute('data-mobile-keyboard-open');
  };
}
