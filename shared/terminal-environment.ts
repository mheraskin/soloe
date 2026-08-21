/**
 * Merge environment layers for an interactive terminal process.
 *
 * Soloe can itself be launched by an automation process that sets NO_COLOR
 * for its own captured logs. That preference must not leak into a real PTY:
 * terminal applications such as Codex use its presence to disable their
 * entire rich-color palette even when TERM and COLORTERM advertise support.
 */
export function mergeTerminalEnvironment(
  ...layers: ReadonlyArray<Record<string, string | undefined>>
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (key.toUpperCase() === 'NO_COLOR' || value === undefined) continue;
      environment[key] = value;
    }
  }
  return environment;
}
