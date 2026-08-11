export type ConfirmTone = 'default' | 'danger';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  dontAskAgainLabel?: string;
  onDontAskAgain?: () => void | Promise<void>;
  tone?: ConfirmTone;
}

class ConfirmStore {
  open = $state(false);
  title = $state('');
  message = $state('');
  confirmLabel = $state('Confirm');
  cancelLabel = $state('Cancel');
  dontAskAgainLabel = $state('');
  tone = $state<ConfirmTone>('default');

  private resolver: ((value: boolean) => void) | null = null;
  private onDontAskAgain: (() => void | Promise<void>) | null = null;

  ask(opts: ConfirmOptions): Promise<boolean> {
    if (this.resolver) {
      this.resolver(false);
      this.resolver = null;
    }
    this.title = opts.title ?? '';
    this.message = opts.message;
    this.confirmLabel = opts.confirmLabel ?? 'Confirm';
    this.cancelLabel = opts.cancelLabel ?? 'Cancel';
    this.dontAskAgainLabel = opts.dontAskAgainLabel ?? '';
    this.onDontAskAgain = opts.onDontAskAgain ?? null;
    this.tone = opts.tone ?? 'default';
    this.open = true;
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  confirm(): void {
    this.resolve(true);
  }

  dontAskAgain(): void {
    const action = this.onDontAskAgain;
    if (!action) {
      this.resolve(true);
      return;
    }
    void Promise.resolve(action()).finally(() => {
      this.resolve(true);
    });
  }

  cancel(): void {
    this.resolve(false);
  }

  private resolve(value: boolean): void {
    const r = this.resolver;
    this.resolver = null;
    this.onDontAskAgain = null;
    this.open = false;
    if (r) r(value);
  }
}

export const confirmStore = new ConfirmStore();
