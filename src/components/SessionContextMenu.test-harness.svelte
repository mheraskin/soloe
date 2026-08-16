<script lang="ts">
  import type { SessionUpdate } from '@shared/types/sessions.js';
  import type { SpawnSpec } from '@shared/types/terminal.js';
  import SessionContextMenu from './SessionContextMenu.svelte';

  let {
    update,
    remove,
    previewCommand
  }: {
    update: (patch: SessionUpdate) => Promise<void>;
    remove: () => Promise<void>;
    previewCommand: () => Promise<SpawnSpec>;
  } = $props();

  const session = {
    id: 'remote-session',
    name: 'Remote agent',
    cwd: '/home/dev/soloe',
    runMode: 'linux' as const,
    launch: { type: 'terminal' as const, shell: 'auto' as const },
    createdAt: '2026-08-16T00:00:00.000Z',
    lastUsedAt: '2026-08-16T00:00:00.000Z'
  };
</script>

<SessionContextMenu
  {session}
  statusOverride="running"
  lifecycle={{ start: async () => undefined, stop: async () => undefined, restart: async () => undefined }}
  mutations={{ update, remove, previewCommand }}
>
  {#snippet trigger({ props })}
    <button {...props} type="button">Remote agent</button>
  {/snippet}
</SessionContextMenu>
