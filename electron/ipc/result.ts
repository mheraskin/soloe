import type { IpcResult } from '@shared/types/ipc.js';

export async function ipcInvoke<T>(fn: () => Promise<T> | T): Promise<IpcResult<T>> {
  try {
    const value = await fn();
    return { ok: true, value };
  } catch (err) {
    const failure = err as {
      message?: unknown;
      code?: unknown;
      remediation?: unknown;
    };
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
      ...(typeof failure?.remediation === 'string'
        ? { remediation: failure.remediation }
        : {})
    };
  }
}
