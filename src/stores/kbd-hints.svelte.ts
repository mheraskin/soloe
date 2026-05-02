class KbdHintsStore {
  altHeld = $state(false);

  attach(): () => void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') this.altHeld = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' || !e.altKey) this.altHeld = false;
    };
    const onBlur = () => {
      this.altHeld = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }
}

export const kbdHints = new KbdHintsStore();
