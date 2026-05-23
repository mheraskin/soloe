const CLOSE_EVENT = 'soloe:session-context-menu-close';

export const sessionContextMenus = {
  closeAll(): void {
    window.dispatchEvent(new CustomEvent(CLOSE_EVENT));
  },

  onCloseAll(listener: () => void): () => void {
    window.addEventListener(CLOSE_EVENT, listener);
    return () => window.removeEventListener(CLOSE_EVENT, listener);
  }
};
