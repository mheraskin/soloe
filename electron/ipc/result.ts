import type { IpcResult } from '@shared/types/ipc.js';

export async function ipcInvoke<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
