<script lang="ts">
  import { onMount } from 'svelte';
  import { Cpu, MemoryStick } from '@lucide/svelte';
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
  let title = $derived(
    error
      ? 'Usage unavailable'
      : `CPU ${cpuLabel} · Memory ${memoryLabel}`
  );

  function formatBytes(bytes: number): string {
    const mib = bytes / 1024 / 1024;
    if (mib < 1024) return `${Math.round(mib)}M`;
    return `${(mib / 1024).toFixed(1)}G`;
  }
</script>

<section
  class="mb-2 flex w-full flex-col items-center gap-1 px-1"
  aria-label="Soloe resource usage"
  {title}
>
  <div
    class={`flex w-8 flex-col items-center gap-0.5 rounded-md px-0.5 py-1 ${
      error ? 'bg-destructive/10 text-destructive' : 'bg-muted/45 text-muted-foreground'
    }`}
  >
    <Cpu class="size-3 shrink-0" />
    <span class="max-w-full truncate text-[9px] leading-none tabular-nums">{cpuLabel}</span>
  </div>
  <div
    class={`flex w-8 flex-col items-center gap-0.5 rounded-md px-0.5 py-1 ${
      error ? 'bg-destructive/10 text-destructive' : 'bg-muted/45 text-muted-foreground'
    }`}
  >
    <MemoryStick class="size-3 shrink-0" />
    <span class="max-w-full truncate text-[9px] leading-none tabular-nums">{memoryLabel}</span>
  </div>
</section>
