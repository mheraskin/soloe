<script lang="ts">
  import { ArrowLeft, ArrowRight, RotateCw, Bug, X, Plus, Globe } from '@lucide/svelte';
  import { browserStore } from '../../stores/browser.svelte';
  import type { ElectronWebview } from '../../types/webview';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';

  // Source-of-truth URL for the active tab. We drive `loadURL` from this and
  // also write back from did-navigate events. The `lastLoadedUrl` guard below
  // breaks the otherwise-symmetric loop between the two directions.
  let activeTab = $derived(browserStore.activeTab);
  let activeUrl = $derived(activeTab ? activeTab.history[activeTab.historyIndex] ?? '' : '');
  let canBack = $derived(activeTab ? browserStore.canGoBack(activeTab.id) : false);
  let canForward = $derived(activeTab ? browserStore.canGoForward(activeTab.id) : false);

  // Captured once at mount so the initial `src=` doesn't react. The effect
  // below takes over for subsequent navigations.
  const initialUrl = browserStore.ensureSomeTab().history[browserStore.ensureSomeTab().historyIndex] ?? 'about:blank';

  let webview = $state<ElectronWebview | null>(null);
  let domReady = $state(false);
  let lastLoadedUrl = $state(initialUrl);
  let urlInput = $state(initialUrl);
  let urlInputEl = $state<HTMLInputElement | null>(null);
  let isLoading = $state(false);

  // Keep URL bar text in sync with the active tab unless the user is editing
  // it. Track focus state so typing doesn't get clobbered mid-edit.
  let urlInputFocused = $state(false);
  $effect(() => {
    if (urlInputFocused) return;
    urlInput = activeUrl;
  });

  // Drive the webview to whatever the store currently points at. The guard
  // prevents an in-page navigation that we just persisted (via did-navigate)
  // from being re-loaded into the same page.
  $effect(() => {
    const target = activeUrl;
    const el = webview;
    if (!el || !domReady) return;
    if (target === lastLoadedUrl) return;
    lastLoadedUrl = target;
    el.loadURL(target).catch(() => {
      // Some URLs (about:blank, blocked schemes) reject — ignore; the
      // webview's error page will still render.
    });
  });

  // Attach Electron-webview events imperatively. Svelte's lowercased
  // on:event syntax doesn't reach custom DOM events with dashes.
  $effect(() => {
    const el = webview;
    if (!el) return;
    domReady = false;
    isLoading = false;
    const onDomReady = () => {
      domReady = true;
    };
    const onNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url;
      const tab = browserStore.activeTab;
      if (!tab || !url) return;
      if (url === lastLoadedUrl) return;
      lastLoadedUrl = url;
      browserStore.navigate(tab.id, url);
    };
    const onTitle = (e: Event) => {
      const title = (e as Event & { title?: string }).title;
      const tab = browserStore.activeTab;
      if (!tab || !title) return;
      browserStore.setTitle(tab.id, title);
    };
    const onLoadStart = () => {
      isLoading = true;
    };
    const onLoadStop = () => {
      isLoading = false;
    };
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-start-loading', onLoadStart);
    el.addEventListener('did-stop-loading', onLoadStop);
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-start-loading', onLoadStart);
      el.removeEventListener('did-stop-loading', onLoadStop);
    };
  });

  function normalizeUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return 'about:blank';
    if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return trimmed;
    return `http://${trimmed}`;
  }

  function submitUrl(event: SubmitEvent) {
    event.preventDefault();
    const tab = browserStore.activeTab;
    if (!tab) return;
    const target = normalizeUrl(urlInput);
    browserStore.navigate(tab.id, target);
    urlInputEl?.blur();
  }

  function goBack() {
    const tab = browserStore.activeTab;
    if (!tab) return;
    browserStore.goBack(tab.id);
  }

  function goForward() {
    const tab = browserStore.activeTab;
    if (!tab) return;
    browserStore.goForward(tab.id);
  }

  function reload() {
    const el = webview;
    if (!el || !domReady) return;
    el.reload();
  }

  function openDevTools() {
    const el = webview;
    if (!el || !domReady) return;
    el.openDevTools();
  }

  function addTab() {
    browserStore.addTab();
  }

  function selectTab(id: string) {
    browserStore.selectTab(id);
  }

  function closeTab(id: string, event: MouseEvent) {
    event.stopPropagation();
    browserStore.closeTab(id);
  }

  function tabLabel(t: { title: string; history: string[]; historyIndex: number }): string {
    const title = t.title?.trim();
    if (title && title.length > 0 && title !== 'about:blank') return title;
    const url = t.history[t.historyIndex] ?? '';
    try {
      const parsed = new URL(url);
      return parsed.host || parsed.pathname || url;
    } catch {
      return url || 'New tab';
    }
  }
</script>

<div class="flex h-full min-w-0 flex-col bg-background">
  <div class="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-sidebar px-1 py-1">
    {#each browserStore.tabs as tab (tab.id)}
      {@const isActive = tab.id === browserStore.activeTabId}
      <button
        type="button"
        class={`group flex h-7 max-w-[160px] min-w-0 shrink-0 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
          isActive
            ? 'bg-background text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        }`}
        onclick={() => selectTab(tab.id)}
        title={tab.history[tab.historyIndex] ?? ''}
      >
        <Globe class="size-3 shrink-0" />
        <span class="min-w-0 truncate">{tabLabel(tab)}</span>
        <span
          role="button"
          tabindex="0"
          aria-label="Close tab"
          class="ml-0.5 flex size-4 shrink-0 items-center justify-center rounded opacity-60 hover:bg-muted hover:opacity-100"
          onclick={(e) => closeTab(tab.id, e)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              closeTab(tab.id, e as unknown as MouseEvent);
            }
          }}
        >
          <X class="size-3" />
        </span>
      </button>
    {/each}
    <button
      type="button"
      class="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      aria-label="New tab"
      onclick={addTab}
    >
      <Plus class="size-3.5" />
    </button>
  </div>

  <form
    class="flex items-center gap-1 border-b border-border bg-sidebar px-1 py-1"
    onsubmit={submitUrl}
  >
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="size-7"
      aria-label="Back"
      disabled={!canBack}
      onclick={goBack}
    >
      <ArrowLeft class="size-3.5" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="size-7"
      aria-label="Forward"
      disabled={!canForward}
      onclick={goForward}
    >
      <ArrowRight class="size-3.5" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="size-7"
      aria-label="Reload"
      disabled={!activeTab}
      onclick={reload}
    >
      <RotateCw class={`size-3.5 ${isLoading ? 'animate-spin' : ''}`} />
    </Button>
    <Input
      bind:ref={urlInputEl}
      bind:value={urlInput}
      onfocus={() => (urlInputFocused = true)}
      onblur={() => (urlInputFocused = false)}
      placeholder="http://localhost:..."
      class="h-7 flex-1 text-xs"
      spellcheck={false}
      autocomplete="off"
    />
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="size-7"
      aria-label="DevTools"
      disabled={!activeTab}
      onclick={openDevTools}
    >
      <Bug class="size-3.5" />
    </Button>
  </form>

  {#if activeTab}
    <!-- svelte-ignore element_invalid_self_closing_tag -->
    <webview
      bind:this={webview}
      src={initialUrl}
      partition="persist:soloe-browser"
      class="min-h-0 flex-1"
      style="display: flex;"
    ></webview>
  {:else}
    <div class="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
      No browser tabs yet. Use the <Plus class="inline-block size-3" /> button above to open one.
    </div>
  {/if}
</div>
