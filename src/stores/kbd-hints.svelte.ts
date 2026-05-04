const SHOW_DELAY_MS = 220;

class KbdHintsStore {
  altHeld = $state(false);
  private pending: ReturnType<typeof setTimeout> | null = null;

  attach(): () => void {
    const clearPending = () => {
      if (this.pending !== null) {
        clearTimeout(this.pending);
        this.pending = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') {
        if (e.repeat || this.altHeld || this.pending !== null) return;
        this.pending = setTimeout(() => {
          this.altHeld = true;
          this.pending = null;
        }, SHOW_DELAY_MS);
        return;
      }
      // Any non-Alt key cancels pending hint and clears any active hint —
      // so combos like Alt+Backspace pass through without flashing the UI.
      clearPending();
      if (this.altHeld) this.altHeld = false;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt' || !e.altKey) {
        clearPending();
        if (this.altHeld) this.altHeld = false;
      }
    };
    const onBlur = () => {
      clearPending();
      if (this.altHeld) this.altHeld = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      clearPending();
    };
  }
}

export const kbdHints = new KbdHintsStore();
