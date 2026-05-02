<script lang="ts">
  import { onMount } from 'svelte';
  import { Cpu, MemoryStick, Workflow } from '@lucide/svelte';
  import type { SystemUsageSnapshot } from '@shared/types/system.js';
  import { ipc } from '../lib/ipc';

  const POLL_INTERVAL_MS = 2000;

  let usage = $state<SystemUsageSnapshot | null>(null);
  let error = $state<string | null>(null);

  onMount(() => {
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function refresh() {
      try {
        const next = await ipc.system.usage();
        if (!active) return;
        usage = next;
        error = null;
      } catch (err) {
        if (!active) return;
        error = err instanceof Error ? err.message : 'Usage unavailable';
      }
    }

    void refresh();
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  });

  let memoryLabel = $derived(usage ? formatBytes(usage.memoryBytes) : '--');
  let cpuLabel = $derived(usage ? `${usage.cpuPercent.toFixed(1)}%` : '--');
  let processLabel = $derived(usage ? String(usage.processCount) : '--');

  function formatBytes(bytes: number): string {
    const mib = bytes / 1024 / 1024;
    if (mib < 1024) return `${Math.round(mib)} MB`;
    return `${(mib / 1024).toFixed(1)} GB`;
  }
</script>

<section class="border-t border-border bg-sidebar px-3 py-2" aria-label="Soloe resource usage">
  <div class="mb-1.5 flex items-center justify-between gap-2">
    <span class="text-[10px] font-medium text-muted-foreground uppercase">Usage</span>
    {#if error}
      <span class="truncate text-[10px] text-destructive">Unavailable</span>
    {:else}
      <span class="text-[10px] text-muted-foreground">Soloe</span>
    {/if}
  </div>

  <div class="grid grid-cols-3 gap-1.5">
    <div class="flex min-w-0 items-center gap-1 rounded-md bg-muted/45 px-1.5 py-1">
      <Cpu class="size-3 shrink-0 text-muted-foreground" />
      <span class="truncate text-[11px] tabular-nums">{cpuLabel}</span>
    </div>
    <div class="flex min-w-0 items-center gap-1 rounded-md bg-muted/45 px-1.5 py-1">
      <MemoryStick class="size-3 shrink-0 text-muted-foreground" />
      <span class="truncate text-[11px] tabular-nums">{memoryLabel}</span>
    </div>
    <div class="flex min-w-0 items-center gap-1 rounded-md bg-muted/45 px-1.5 py-1">
      <Workflow class="size-3 shrink-0 text-muted-foreground" />
      <span class="truncate text-[11px] tabular-nums">{processLabel}</span>
    </div>
  </div>
</section>
