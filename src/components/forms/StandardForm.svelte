<script lang="ts">
  import type { ShellKind, StandardTerminalSession, SessionDraft } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select';

  let draft = $derived(modal.draft as Extract<SessionDraft, { kind: 'standard_terminal' }>);

  function update<K extends keyof StandardTerminalSession>(key: K, value: StandardTerminalSession[K]) {
    modal.draft = { ...draft, [key]: value } as SessionDraft;
  }

  const shells: ShellKind[] = ['auto', 'bash', 'zsh', 'pwsh', 'cmd', 'custom'];
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Shell</Label>
  <Select.Root
    type="single"
    value={draft.shell}
    onValueChange={(v) => update('shell', v as ShellKind)}
  >
    <Select.Trigger class="w-full">{draft.shell}</Select.Trigger>
    <Select.Content>
      {#each shells as s (s)}
        <Select.Item value={s} label={s}>{s}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>

{#if draft.shell === 'custom'}
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="std-command-custom">Command</Label>
    <Input
      id="std-command-custom"
      type="text"
      placeholder="/usr/local/bin/my-shell"
      value={draft.command ?? ''}
      oninput={(e) => update('command', (e.currentTarget as HTMLInputElement).value)}
    />
  </div>
{:else}
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="std-command">Command (optional, runs via shell -c)</Label>
    <Input
      id="std-command"
      type="text"
      placeholder="e.g. tail -f /var/log/app.log"
      value={draft.command ?? ''}
      oninput={(e) => {
        const v = (e.currentTarget as HTMLInputElement).value;
        update('command', (v || undefined) as unknown as string);
      }}
    />
  </div>
{/if}
