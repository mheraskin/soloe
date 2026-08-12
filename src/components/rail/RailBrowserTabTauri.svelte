<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import {
    ArrowLeft,
    ArrowRight,
    Bug,
    Maximize2,
    Minimize2,
    Plus,
    RotateCw,
    Smartphone,
    X
  } from '@lucide/svelte';
  import { browserStore, type BrowserTabDevice } from '../../stores/browser.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { normalizeBrowserUrl } from '../../lib/browser-navigation';
  import {
    onTauriBrowserPageLoad,
    TauriBrowserSurface,
    type TauriBrowserSurfaceBounds
  } from '../../lib/tauri-browser-host';
  import { reportError } from '../../stores/toast.svelte';
  import { ipc } from '../../lib/ipc';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Popover from '$lib/components/ui/popover';
  import BrowserDeviceMenu from './BrowserDeviceMenu.svelte';
  import {
    isNativeSurfaceBlocked,
    subscribeNativeSurfaceBlocker
  } from '../../lib/native-surface-layout';

  browserStore.ensureSomeTab();

  let activeTab = $derived(browserStore.activeTab);
  let activeId = $derived(browserStore.activeTabId);
  let activeUrl = $derived(activeTab?.history[activeTab.historyIndex] ?? 'about:blank');
  let canBack = $derived(activeTab ? browserStore.canGoBack(activeTab.id) : false);
  let canForward = $derived(activeTab ? browserStore.canGoForward(activeTab.id) : false);
  let device = $derived(activeTab?.device);
  let deviceWidth = $derived(device ? (device.rotated ? device.height : device.width) : 0);
  let deviceHeight = $derived(device ? (device.rotated ? device.width : device.height) : 0);
  let pageZoom = $derived(activeTab?.pageZoom ?? 1);

  let host: HTMLDivElement | null = $state(null);
  let surface: TauriBrowserSurface | null = null;
  let urlInput = $state(untrack(() => activeUrl));
  let deviceMenuOpen = $state(false);
  let loading = $state(false);
  let initializationError = $state<string | null>(null);
  let lastNavigation = '';
  let resizeObserver: ResizeObserver | null = null;
  let boundsFrame: number | null = null;
  let boundsInFlight = false;
  let boundsRequested = false;
  let showAfterBounds = false;
  let nativeBlocked = isNativeSurfaceBlocked();

  function bounds(): TauriBrowserSurfaceBounds {
    const rect = host?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0, width: 1, height: 1 };
    if (!device) {
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
    const scale = Math.min(1, rect.width / deviceWidth, rect.height / deviceHeight);
    const width = Math.max(1, Math.round(deviceWidth * scale));
    const height = Math.max(1, Math.round(deviceHeight * scale));
    return {
      x: rect.x + Math.max(0, (rect.width - width) / 2),
      y: rect.y + Math.max(0, (rect.height - height) / 2),
      width,
      height
    };
  }

  function syncBounds(): void {
    boundsRequested = true;
    if (!surface || nativeBlocked || boundsFrame !== null || boundsInFlight) return;
    boundsFrame = requestAnimationFrame(() => {
      boundsFrame = null;
      runBoundsUpdate();
    });
  }

  function runBoundsUpdate(): void {
    const current = surface;
    if (!current || nativeBlocked || !boundsRequested) return;
    boundsRequested = false;
    boundsInFlight = true;
    void current.setBounds(bounds()).then(() => {
      if (showAfterBounds && !nativeBlocked && surface === current) {
        showAfterBounds = false;
        return current.setVisible(true);
      }
    }).catch(reportError).finally(() => {
      boundsInFlight = false;
      if (boundsRequested) syncBounds();
    });
  }

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const unsubscribeBlocker = subscribeNativeSurfaceBlocker((nextBlocked) => {
      if (nativeBlocked === nextBlocked) return;
      nativeBlocked = nextBlocked;
      const current = surface;
      if (!current) return;
      if (nextBlocked) {
        showAfterBounds = false;
        void current.setVisible(false).catch(reportError);
      } else {
        showAfterBounds = true;
        syncBounds();
      }
    });
    const onRendererZoom = () => syncBounds();
    window.addEventListener('soloe:renderer-zoom', onRendererZoom);

    void (async () => {
      await tick();
      unlisten = await onTauriBrowserPageLoad((event) => {
        if (event.surfaceId !== surface?.surfaceId) return;
        loading = event.phase === 'started';
        if (event.phase !== 'finished') return;
        const tabId = untrack(() => activeId);
        if (tabId && event.url !== 'about:blank') browserStore.navigate(tabId, event.url);
      });
      const created = await TauriBrowserSurface.create({
        url: activeUrl,
        bounds: bounds(),
        visible: !nativeBlocked,
        userAgent: device?.ua || null
      });
      if (disposed) {
        await created.dispose();
        return;
      }
      surface = created;
      lastNavigation = activeUrl;
      resizeObserver = new ResizeObserver(syncBounds);
      if (host) resizeObserver.observe(host);
      window.addEventListener('resize', syncBounds);
      window.addEventListener('scroll', syncBounds, true);
    })().catch((error) => {
      initializationError = error instanceof Error ? error.message : String(error);
    });

    return () => {
      disposed = true;
      unlisten?.();
      resizeObserver?.disconnect();
      unsubscribeBlocker();
      window.removeEventListener('soloe:renderer-zoom', onRendererZoom);
      if (boundsFrame !== null) cancelAnimationFrame(boundsFrame);
      boundsFrame = null;
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('scroll', syncBounds, true);
      const current = surface;
      surface = null;
      if (current) void current.dispose().catch(() => {});
      browserStore.releaseResidents();
    };
  });

  $effect(() => {
    const target = activeUrl;
    urlInput = target;
    if (!surface || target === lastNavigation) return;
    lastNavigation = target;
    void surface.navigate(target).catch(reportError);
  });

  $effect(() => {
    const _device = device;
    const _rotated = device?.rotated;
    if (!surface) return;
    syncBounds();
  });

  $effect(() => {
    const zoom = pageZoom;
    if (surface) void surface.setZoom(zoom).catch(reportError);
  });

  function submitUrl(event: SubmitEvent): void {
    event.preventDefault();
    const tabId = activeId;
    if (!tabId) return;
    const url = normalizeBrowserUrl(urlInput);
    browserStore.navigate(tabId, url);
    urlInput = url;
  }

  function goBack(): void {
    if (!activeId) return;
    const url = browserStore.goBack(activeId);
    if (url) void surface?.navigate(url).catch(reportError);
  }

  function goForward(): void {
    if (!activeId) return;
    const url = browserStore.goForward(activeId);
    if (url) void surface?.navigate(url).catch(reportError);
  }

  function addTab(): void {
    browserStore.addTab();
  }

  function closeTab(id: string): void {
    browserStore.closeTab(id);
    browserStore.ensureSomeTab();
  }

  function setDevice(next: BrowserTabDevice | null): void {
    if (!activeId) return;
    browserStore.setDevice(activeId, next);
    syncBounds();
  }

  function rotateDevice(): void {
    if (!activeId) return;
    browserStore.rotateDevice(activeId);
    syncBounds();
  }

  async function openDevTools(): Promise<void> {
    if (!surface) return;
    try {
      await ipc.browser.openDevTools({
        webContentsId: surface.webContentsId,
        bounds: { x: 0, y: 0, width: 1, height: 1 }
      });
    } catch (error) {
      reportError(error);
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col overflow-hidden bg-background">
  <div class="flex h-8 min-h-8 items-center gap-1 overflow-x-auto border-b border-border px-1">
    {#each browserStore.tabs as tab (tab.id)}
      <button
        type="button"
        class={`flex h-6 min-w-20 max-w-40 items-center gap-1 rounded px-2 text-[10px] ${tab.id === activeId ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60'}`}
        onclick={() => browserStore.selectTab(tab.id)}
      >
        <span class="min-w-0 flex-1 truncate">{tab.title || 'New tab'}</span>
        <span
          role="button"
          tabindex="0"
          aria-label="Close tab"
          onclick={(event) => {
            event.stopPropagation();
            closeTab(tab.id);
          }}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') closeTab(tab.id);
          }}
        >
          <X class="size-3" />
        </span>
      </button>
    {/each}
    <Button type="button" variant="ghost" size="icon" class="size-6" onclick={addTab} aria-label="New tab">
      <Plus class="size-3.5" />
    </Button>
  </div>

  <form class="flex h-8 min-h-8 items-center gap-1 border-b border-border px-1" onsubmit={submitUrl}>
    <Button type="button" variant="ghost" size="icon" class="size-7" disabled={!canBack} onclick={goBack} aria-label="Back">
      <ArrowLeft class="size-3.5" />
    </Button>
    <Button type="button" variant="ghost" size="icon" class="size-7" disabled={!canForward} onclick={goForward} aria-label="Forward">
      <ArrowRight class="size-3.5" />
    </Button>
    <Button type="button" variant="ghost" size="icon" class="size-7" onclick={() => surface?.reload()} aria-label="Reload">
      <RotateCw class={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
    </Button>
    <Input bind:value={urlInput} class="h-7 min-w-0 flex-1 text-[11px]" spellcheck={false} />
    <Popover.Root bind:open={deviceMenuOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button {...props} type="button" variant="ghost" size="icon" class={`size-7 ${device ? 'text-foreground' : ''}`} aria-label="Responsive viewer">
            <Smartphone class="size-3.5" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content align="end" class="w-auto p-0" trapFocus={false}>
        <BrowserDeviceMenu
          {device}
          onSelect={setDevice}
          onRotate={rotateDevice}
          onClose={() => (deviceMenuOpen = false)}
        />
      </Popover.Content>
    </Popover.Root>
    <Button type="button" variant="ghost" size="icon" class="size-7" onclick={openDevTools} aria-label="Open external DevTools" title="Open external DevTools">
      <Bug class="size-3.5" />
    </Button>
    <Button type="button" variant="ghost" size="icon" class="size-7" onclick={() => rightRail.toggleFullscreen()} aria-label="Toggle fullscreen">
      {#if rightRail.fullscreen}<Minimize2 class="size-3.5" />{:else}<Maximize2 class="size-3.5" />{/if}
    </Button>
  </form>

  {#if device}
    <div class="border-b border-border bg-muted/50 px-2 py-1 text-center font-mono text-[10px] text-muted-foreground">
      {deviceWidth} × {deviceHeight} — native surface sizing; full mobile emulation is not yet implemented
    </div>
  {/if}

  <div class="relative min-h-0 flex-1 overflow-hidden bg-muted/30">
    <div bind:this={host} class="absolute inset-y-0 right-0 left-1.5"></div>
    {#if initializationError}
      <div class="absolute inset-0 z-10 flex items-center justify-center bg-background p-6 text-center text-xs text-destructive">
        Could not initialize the Tauri browser surface: {initializationError}
      </div>
    {/if}
  </div>
</div>
