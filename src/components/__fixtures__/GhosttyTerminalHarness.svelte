<script lang="ts">
  import type { GhosttyTheme } from '../../lib/ghostty/core';
  import type { TerminalSessionState } from '../../lib/terminal-session';
  import GhosttyTerminal from '../GhosttyTerminal.svelte';

  let visible = $state(true);
  let terminalState: TerminalSessionState = $state({
    terminalId: 'terminal-1',
    sessionId: 'session-1',
    reset: {
      generation: 1,
      data: 'restored screen',
      replay: { cols: 80, rows: 24, resizes: [] },
      fromSeq: 1,
      toSeq: 1
    },
    tail: [],
    fromSeq: 1,
    toSeq: 1,
    cols: 80,
    rows: 24,
    byteLength: 15,
    status: { kind: 'ready', truncated: false }
  });

  export function setVisible(next: boolean): void {
    visible = next;
  }

  export function switchTerminal(): void {
    terminalState = {
      ...terminalState,
      terminalId: 'terminal-2',
      sessionId: 'session-2',
      reset: {
        ...terminalState.reset,
        data: 'different terminal'
      }
    };
  }
</script>

<GhosttyTerminal
  state={terminalState}
  presented={visible}
  focused={false}
  theme={{} as GhosttyTheme}
  font={{}}
  onData={() => undefined}
  onResize={() => undefined}
/>
