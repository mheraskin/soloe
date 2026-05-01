export type ConfirmTone = 'default' | 'danger';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

class ConfirmStore {
  open = $state(false);
  title = $state('');
  message = $state('');
  confirmLabel = $state('Confirm');
  cancelLabel = $state('Cancel');
  tone = $state<ConfirmTone>('default');

  private resolver: ((value: boolean) => void) | null = null;

  ask(opts: ConfirmOptions): Promise<boolean> {
    if (this.resolver) {
      this.resolver(false);
      this.resolver = null;
    }
    this.title = opts.title ?? '';
    this.message = opts.message;
    this.confirmLabel = opts.confirmLabel ?? 'Confirm';
    this.cancelLabel = opts.cancelLabel ?? 'Cancel';
    this.tone = opts.tone ?? 'default';
    this.open = true;
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  confirm(): void {
    this.resolve(true);
  }

  cancel(): void {
    this.resolve(false);
  }

  private resolve(value: boolean): void {
    const r = this.resolver;
    this.resolver = null;
    this.open = false;
    if (r) r(value);
  }
}

export const confirmStore = new ConfirmStore();
