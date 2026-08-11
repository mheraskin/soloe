import { toast } from 'svelte-sonner';

export const toasts = {
  push(message: string, kind: 'error' | 'info' = 'error'): void {
    if (kind === 'error') toast.error(message);
    else toast(message);
  }
};

export function reportError(err: unknown, fallback = 'Something went wrong'): void {
  const message = err instanceof Error ? err.message : String(err) || fallback;
  toast.error(message);
}
