<script lang="ts">
  import type { ShellKind, StandardTerminalSession, SessionDraft } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';

  // The draft is narrowed to standard_terminal here.
  let draft = $derived(modal.draft as Extract<SessionDraft, { kind: 'standard_terminal' }>);

  function update<K extends keyof StandardTerminalSession>(key: K, value: StandardTerminalSession[K]) {
    modal.draft = { ...draft, [key]: value } as SessionDraft;
  }

  const shells: ShellKind[] = ['auto', 'bash', 'zsh', 'pwsh', 'cmd', 'custom'];
</script>

<label>
  Shell
  <select
    value={draft.shell}
    onchange={(e) => update('shell', (e.currentTarget as HTMLSelectElement).value as ShellKind)}
  >
    {#each shells as s}
      <option value={s}>{s}</option>
    {/each}
  </select>
</label>

{#if draft.shell === 'custom'}
  <label>
    Command
    <input
      type="text"
      placeholder="/usr/local/bin/my-shell"
      value={draft.command ?? ''}
      oninput={(e) => update('command', (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
{:else}
  <label>
    Command (optional, runs via shell -c)
    <input
      type="text"
      placeholder="e.g. tail -f /var/log/app.log"
      value={draft.command ?? ''}
      oninput={(e) => update('command', (e.currentTarget as HTMLInputElement).value || undefined as unknown as string)}
    />
  </label>
{/if}
