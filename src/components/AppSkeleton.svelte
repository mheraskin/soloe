<script lang="ts">
  import appIconUrl from '../../build/favicon.svg';

  let {
    label = 'Loading Soloe',
    macosWindowControls = false
  }: {
    label?: string;
    macosWindowControls?: boolean;
  } = $props();
</script>

<div
  class="skeleton-shell flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
  role="status"
  aria-live="polite"
  aria-busy="true"
  aria-label={label}
>
  <header
    class="flex h-7 shrink-0 items-center border-b border-border bg-card"
    style="-webkit-app-region: drag"
    data-window-controls={macosWindowControls ? 'macos' : 'custom'}
  >
    <img
      src={appIconUrl}
      alt=""
      class={`mr-1.5 size-3.5 flex-none opacity-70 ${macosWindowControls ? 'ml-[76px]' : 'ml-3'}`}
    />
    <span class="text-[11px] tracking-wider text-muted-foreground">Soloe</span>
    {#if !macosWindowControls}
      <div
        class="ml-auto flex h-full items-center gap-3 px-3"
        data-loading-region="window-controls"
        aria-hidden="true"
      >
        <span class="loading-block h-2 w-8 rounded-sm"></span>
        <span class="loading-block h-2 w-8 rounded-sm"></span>
        <span class="loading-block h-2 w-8 rounded-sm"></span>
      </div>
    {/if}
  </header>

  <div class="flex min-h-0 flex-1">
    <aside
      class="loading-sidebar flex shrink-0 flex-col gap-4 border-r border-border bg-sidebar p-3"
      data-loading-region="sidebar"
      aria-hidden="true"
    >
      <div class="flex items-center gap-2">
        <span class="loading-block size-7 rounded-md"></span>
        <span class="loading-block h-3 w-28 rounded"></span>
      </div>
      <div class="space-y-2 pt-1">
        <span class="loading-block block h-2.5 w-16 rounded"></span>
        <span class="loading-block block h-7 w-full rounded-md"></span>
        <span class="loading-block block h-7 w-[88%] rounded-md"></span>
      </div>
      <div class="space-y-2 pt-2">
        <span class="loading-block block h-2.5 w-20 rounded"></span>
        {#each [0, 1, 2, 3] as row (row)}
          <div class="flex items-center gap-2">
            <span class="loading-block size-2 rounded-full"></span>
            <span class="loading-block h-6 flex-1 rounded-md"></span>
          </div>
        {/each}
      </div>
      <span class="loading-block mt-auto block h-7 w-full rounded-md"></span>
    </aside>

    <main
      class="flex min-w-0 flex-1 flex-col bg-background"
      data-loading-region="terminal"
      aria-hidden="true"
    >
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span class="loading-block h-3 w-24 rounded"></span>
        <span class="loading-block h-3 w-14 rounded"></span>
        <span class="loading-block ml-auto size-5 rounded"></span>
      </div>
      <div class="flex-1 space-y-2 p-5 font-mono">
        <span class="loading-block block h-2.5 w-44 rounded"></span>
        <span class="loading-block block h-2.5 w-[72%] rounded"></span>
        <span class="loading-block block h-2.5 w-[58%] rounded"></span>
        <span class="loading-block block h-2.5 w-[66%] rounded"></span>
        <span class="loading-block block h-2.5 w-[42%] rounded"></span>
        <span class="loading-block mt-5 block h-2.5 w-[78%] rounded"></span>
        <span class="loading-block block h-2.5 w-[52%] rounded"></span>
      </div>
      <div class="flex h-7 shrink-0 items-center gap-2 border-t border-border px-3">
        <span class="loading-block size-2 rounded-full"></span>
        <span class="loading-block h-2 w-28 rounded"></span>
      </div>
    </main>

    <aside
      class="loading-rail shrink-0 border-l border-border bg-card p-3"
      data-loading-region="rail"
      aria-hidden="true"
    >
      <div class="flex gap-2 border-b border-border pb-3">
        <span class="loading-block h-6 w-16 rounded-md"></span>
        <span class="loading-block h-6 w-14 rounded-md"></span>
      </div>
      <div class="space-y-3 pt-4">
        <span class="loading-block block h-3 w-24 rounded"></span>
        <span class="loading-block block h-20 w-full rounded-md"></span>
        <span class="loading-block block h-3 w-20 rounded"></span>
        <span class="loading-block block h-28 w-full rounded-md"></span>
      </div>
    </aside>
  </div>

  <span class="sr-only">{label}</span>
</div>

<style>
  .loading-sidebar {
    width: min(30vw, 390px);
    min-width: 220px;
  }

  .loading-rail {
    width: min(30vw, 390px);
    min-width: 220px;
  }

  .loading-block {
    background: color-mix(in oklab, var(--muted) 78%, var(--background));
    animation: skeleton-pulse 1.8s ease-in-out infinite;
  }

  @keyframes skeleton-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 0.9;
    }
  }

  @media (max-width: 900px) {
    .loading-rail {
      display: none;
    }
  }

  @media (max-width: 620px) {
    .loading-sidebar {
      width: 42vw;
      min-width: 150px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .loading-block {
      animation: none;
      opacity: 0.7;
    }
  }
</style>
