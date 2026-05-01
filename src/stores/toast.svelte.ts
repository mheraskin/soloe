export interface Toast {
  id: number;
  message: string;
  kind: 'error' | 'info';
}

class ToastStore {
  items = $state<Toast[]>([]);
  private nextId = 1;

  push(message: string, kind: 'error' | 'info' = 'error'): void {
    const id = this.nextId++;
    this.items = [...this.items, { id, message, kind }];
    setTimeout(() => this.dismiss(id), 5000);
  }

  dismiss(id: number): void {
    this.items = this.items.filter((t) => t.id !== id);
  }
}

export const toasts = new ToastStore();

export function reportError(err: unknown, fallback = 'Something went wrong'): void {
  const message = err instanceof Error ? err.message : String(err) || fallback;
  toasts.push(message, 'error');
}
