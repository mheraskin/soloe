<script lang="ts">
  import { onMount } from 'svelte';
  import { Cpu, MemoryStick } from '@lucide/svelte';
  import type { SystemUsageSnapshot } from '@shared/types/system.js';
  import { ipc } from '../lib/ipc';

  const POLL_INTERVAL_MS = 10_000;
  const WSL_BASELINE_INTERVAL_MS = 2_000;

  let usage = $state<SystemUsageSnapshot | null>(null);
  let error = $state<string | null>(null);
  let wslDetailDemanded = $state(false);
  let wslHovered = false;
  let wslFocused = false;
  let requestRefresh: (() => void) | null = null;

  function syncWslDetailDemand(): void {
    const next = wslHovered || wslFocused;
    if (wslDetailDemanded === next) return;
    wslDetailDemanded = next;
    if (next) requestRefresh?.();
  }

  function setWslHovered(next: boolean): void {
    wslHovered = next;
    syncWslDetailDemand();
  }

  function setWslFocused(next: boolean): void {
    wslFocused = next;
    syncWslDetailDemand();
  }

  onMount(() => {
    let active = true;
    let refreshing = false;
    let refreshAgain = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function clearTimer() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }

    function schedule(delayMs = POLL_INTERVAL_MS) {
      clearTimer();
      if (!active || document.hidden) return;
      timer = setTimeout(() => void refresh(), delayMs);
    }

    async function refresh() {
      if (!active || document.hidden) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      clearTimer();
      refreshing = true;
      let nextDelayMs = POLL_INTERVAL_MS;
      try {
        const detail = wslDetailDemanded ? 'wsl' : 'summary';
        const next = await ipc.system.usage({ detail });
        if (!active) return;
        usage = next;
        error = null;
        // CPU is delta-based. While the user is inspecting WSL detail, take
        // the second demanded sample promptly, then return to the normal rate.
        if (detail === 'wsl' && wslDetailDemanded && next.wsl?.cpuPercent === null) {
          nextDelayMs = WSL_BASELINE_INTERVAL_MS;
        }
      } catch (err) {
        if (!active) return;
        error = err instanceof Error ? err.message : 'Usage unavailable';
      } finally {
        refreshing = false;
        if (!active) return;
        if (refreshAgain && !document.hidden) {
          refreshAgain = false;
          void refresh();
        } else {
          schedule(nextDelayMs);
        }
      }
    }

    function handleVisibilityChange() {
      clearTimer();
      refreshAgain = false;
      if (!document.hidden) void refresh();
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    requestRefresh = () => void refresh();
    if (!document.hidden) void refresh();

    return () => {
      active = false;
      clearTimer();
      requestRefresh = null;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

  let appMemoryLabel = $derived(formatBytes(usage?.memoryBytes ?? null));
  let appCpuLabel = $derived(formatPercent(usage?.cpuPercent ?? null));
  let wslCpuLabel = $derived(
    usage?.wsl?.cpuPercent == null ? '--' : `${usage.wsl.cpuPercent.toFixed(1)}%`
  );
  let wslMemoryLabel = $derived(usage?.wsl ? formatBytes(usage.wsl.memoryBytes) : '--');
  let wslMemoryTitle = $derived(
    usage?.wsl
      ? `${formatBytes(usage.wsl.memoryBytes)} used of ${formatBytes(usage.wsl.memoryTotalBytes)}`
      : 'WSL measurement unavailable'
  );
  let wslDetailTitle = $derived(
    wslDetailDemanded
      ? usage?.wsl
        ? 'WSL detail sampling is active while this control is hovered or focused.'
        : 'Gathering WSL detail…'
      : 'Hover or focus here to sample WSL detail without a permanent background probe.'
  );
  let title = $derived(
    error
      ? 'Usage unavailable'
      : usage
        ? `${usage.scope === 'backend' ? 'Soloe environment' : 'Soloe Client'}${usage.availability === 'available' ? '' : ` (${usage.availability})`}: CPU ${appCpuLabel} · Memory ${appMemoryLabel}${usage.wslActive ? ` · WSL VM-wide: CPU ${wslCpuLabel} · Memory ${wslMemoryTitle}. ${wslDetailTitle}` : ''}${usage.message ? `. ${usage.message}` : ''}`
        : 'Gathering usage…'
  );

  function formatBytes(bytes: number | null): string {
    if (bytes === null) return '--';
    const mib = bytes / 1024 / 1024;
    if (mib < 1024) return `${Math.round(mib)}M`;
    return `${(mib / 1024).toFixed(1)}G`;
  }

  function formatPercent(percent: number | null): string {
    return percent === null ? '--' : `${percent.toFixed(1)}%`;
  }
</script>

<button
  type="button"
  class="mb-2 flex w-full flex-col items-center gap-1 rounded-sm border-0 bg-transparent px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
  aria-label={usage?.wslActive ? 'Inspect Soloe and WSL resource usage' : 'Inspect Soloe resource usage'}
  {title}
  onpointerenter={() => setWslHovered(true)}
  onpointerleave={() => setWslHovered(false)}
  onfocus={() => setWslFocused(true)}
  onblur={() => setWslFocused(false)}
>
  <span class="text-[8px] font-semibold leading-none tracking-wide text-muted-foreground/70">
    {usage?.scope === 'backend' ? 'BACK' : 'APP'}
  </span>
  <div
    class={`flex w-8 flex-col items-center gap-0.5 rounded-md px-0.5 py-1 ${
      error ? 'bg-destructive/10 text-destructive' : 'bg-muted/45 text-muted-foreground'
    }`}
  >
    <Cpu class="size-3 shrink-0" />
    <span class="max-w-full truncate text-[9px] leading-none tabular-nums">{appCpuLabel}</span>
  </div>
  <div
    class={`flex w-8 flex-col items-center gap-0.5 rounded-md px-0.5 py-1 ${
      error ? 'bg-destructive/10 text-destructive' : 'bg-muted/45 text-muted-foreground'
    }`}
  >
    <MemoryStick class="size-3 shrink-0" />
    <span class="max-w-full truncate text-[9px] leading-none tabular-nums">{appMemoryLabel}</span>
  </div>
  {#if usage?.wslActive}
    <span class="mt-1 text-[8px] font-semibold leading-none tracking-wide text-primary/75">WSL</span>
    <div class="flex w-8 flex-col items-center gap-0.5 rounded-md bg-primary/10 px-0.5 py-1 text-primary/80">
      <Cpu class="size-3 shrink-0" />
      <span class="max-w-full truncate text-[9px] leading-none tabular-nums">{wslCpuLabel}</span>
    </div>
    <div
      class="flex w-8 flex-col items-center gap-0.5 rounded-md bg-primary/10 px-0.5 py-1 text-primary/80"
      title={wslMemoryTitle}
    >
      <MemoryStick class="size-3 shrink-0" />
      <span class="max-w-full truncate text-[9px] leading-none tabular-nums">{wslMemoryLabel}</span>
    </div>
  {/if}
</button>
