export const TERMINAL_SCREEN_SNAPSHOT_TIMEOUT_MS = 1_500;

/**
 * A screen snapshot is an optimization, not a prerequisite for mounting a terminal.
 * Mobile connections can suspend an in-flight request indefinitely, so fall back to
 * sequence-aware raw replay after a short deadline.
 */
export async function loadTerminalScreenSnapshot<T>(
  load: () => Promise<T>,
  timeoutMs = TERMINAL_SCREEN_SNAPSHOT_TIMEOUT_MS
): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });

  try {
    return await Promise.race([load(), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
