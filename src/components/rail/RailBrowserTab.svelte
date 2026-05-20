<script lang="ts">
  import { untrack } from 'svelte';
  import {
    ArrowLeft,
    ArrowRight,
    RotateCw,
    Bug,
    X,
    Plus,
    Globe,
    History,
    Maximize2,
    Minimize2,
    KeyRound
  } from '@lucide/svelte';
  import { browserStore } from '../../stores/browser.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import type { ElectronWebview } from '../../types/webview';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Popover from '$lib/components/ui/popover';
  import BrowserAutofillPopover from './BrowserAutofillPopover.svelte';

  let activeTab = $derived(browserStore.activeTab);
  let activeUrl = $derived(activeTab ? activeTab.history[activeTab.historyIndex] ?? '' : '');
  let canBack = $derived(activeTab ? browserStore.canGoBack(activeTab.id) : false);
  let canForward = $derived(activeTab ? browserStore.canGoForward(activeTab.id) : false);

  // Captured once at mount so the initial `src=` doesn't react. The effect
  // below takes over for subsequent navigations.
  const seededTab = browserStore.ensureSomeTab();
  const initialUrl = seededTab.history[seededTab.historyIndex] ?? 'about:blank';

  let webview = $state<ElectronWebview | null>(null);
  let domReady = $state(false);
  let lastLoadedUrl = $state(initialUrl);
  let urlInput = $state(initialUrl);
  let urlInputEl = $state<HTMLInputElement | null>(null);
  let isLoading = $state(false);
  let failureSuggestion = $state<{ httpsUrl: string; httpUrl: string; reason: string } | null>(null);

  // Tracks the URL that the bar most recently auto-synced to. When the user
  // types into the bar, urlInput diverges from this value — that's our signal
  // that the bar is "dirty" and shouldn't be clobbered by auto-syncing.
  // Resets explicitly on submit, escape, and tab switch.
  let lastSyncedUrl = $state(initialUrl);
  let isDirty = $derived(urlInput !== lastSyncedUrl);

  // Auto-sync the URL bar to the active page URL — but only when the user
  // isn't mid-edit. Same-tab in-page navigations (link clicks, redirects)
  // update the bar; user's pending typed text is preserved across blurs.
  $effect(() => {
    const target = activeUrl;
    if (target === urlInput) return;
    if (untrack(() => isDirty)) return;
    urlInput = target;
    lastSyncedUrl = target;
  });

  // Tab-switch reset: forces a fresh sync regardless of dirty state, since
  // the typed-but-uncommitted text belonged to the previous tab.
  let prevTabId: string | null = activeTab?.id ?? null;
  $effect(() => {
    const id = activeTab?.id ?? null;
    if (id === prevTabId) return;
    prevTabId = id;
    const target = activeUrl;
    urlInput = target;
    lastSyncedUrl = target;
    suggestionIndex = -1;
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

  // Attach Electron-webview events imperatively. Svelte's lowercased on:event
  // syntax doesn't reach custom DOM events with dashes.
  $effect(() => {
    const el = webview;
    if (!el) return;
    domReady = false;
    isLoading = false;
    failureSuggestion = null;
    const onDomReady = () => {
      domReady = true;
    };
    const onNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url;
      const tab = browserStore.activeTab;
      if (!tab || !url) return;
      failureSuggestion = null;
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
    const onFail = (e: Event) => {
      const event = e as Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      };
      // -3 is ABORTED (user navigated away); ignore. Also ignore subframe
      // errors so an ad iframe failing doesn't pop a misleading suggestion.
      if (event.errorCode === -3) return;
      if (event.isMainFrame === false) return;
      const url = event.validatedURL ?? '';
      if (!url.startsWith('https://')) return;
      failureSuggestion = {
        httpsUrl: url,
        httpUrl: 'http://' + url.slice('https://'.length),
        reason: event.errorDescription || 'Failed to load over HTTPS'
      };
    };
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-start-loading', onLoadStart);
    el.addEventListener('did-stop-loading', onLoadStop);
    el.addEventListener('did-fail-load', onFail);
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-start-loading', onLoadStart);
      el.removeEventListener('did-stop-loading', onLoadStop);
      el.removeEventListener('did-fail-load', onFail);
    };
  });

  // Localhost-ish hosts get http://; everything else defaults to https://.
  // Catches localhost, loopback, private network ranges, and bare ports
  // (":3000") which can only mean a local dev server.
  function looksLocal(host: string): boolean {
    if (!host) return false;
    if (host.startsWith(':')) return true;
    const lower = host.toLowerCase();
    if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
    if (lower === '::1' || lower === '[::1]') return true;
    if (/^127\./.test(lower)) return true;
    if (/^10\./.test(lower)) return true;
    if (/^192\.168\./.test(lower)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(lower)) return true;
    return false;
  }

  function normalizeUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return 'about:blank';
    if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return trimmed;
    const hostPart = trimmed.split(/[\/?#]/, 1)[0] ?? '';
    const scheme = looksLocal(hostPart) ? 'http' : 'https';
    return `${scheme}://${trimmed}`;
  }

  function commitNavigation(rawUrl: string): void {
    const tab = browserStore.activeTab;
    if (!tab) return;
    const target = normalizeUrl(rawUrl);
    browserStore.navigate(tab.id, target);
    urlInput = target;
    lastSyncedUrl = target;
    suggestionIndex = -1;
    suppressDropdown = true;
    urlInputEl?.blur();
  }

  function submitUrl(event: SubmitEvent) {
    event.preventDefault();
    if (suggestionIndex >= 0 && suggestionIndex < suggestions.length) {
      commitNavigation(suggestions[suggestionIndex]!);
      return;
    }
    commitNavigation(urlInput);
  }

  function tryHttpFallback() {
    const suggestion = failureSuggestion;
    if (!suggestion) return;
    failureSuggestion = null;
    commitNavigation(suggestion.httpUrl);
  }

  function dismissFallback() {
    failureSuggestion = null;
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

  let autofillOpen = $state(false);

  // Inject a one-shot autofill into the loaded page. Returns whether a
  // username-like field was found alongside the password. The script uses
  // the native value setter so React/Vue/etc. controlled inputs see the
  // change; otherwise frameworks silently ignore the new value.
  async function runAutofill(
    username: string,
    password: string
  ): Promise<{ filledUser: boolean }> {
    const el = webview;
    if (!el || !domReady) {
      throw new Error('Browser is not ready');
    }
    const script = `(function(u, p) {
      const pwd = document.querySelector('input[type="password"]:not([disabled]):not([readonly])');
      if (!pwd) return { ok: false, filledUser: false };
      function setValue(input, value) {
        const proto = input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const scope = pwd.closest('form') || document;
      const candidates = scope.querySelectorAll(
        'input[type="email"]:not([disabled]):not([readonly]),' +
        'input[type="tel"]:not([disabled]):not([readonly]),' +
        'input[type="text"]:not([disabled]):not([readonly]),' +
        'input[name*="user" i]:not([disabled]):not([readonly]),' +
        'input[name*="email" i]:not([disabled]):not([readonly]),' +
        'input[name*="login" i]:not([disabled]):not([readonly]),' +
        'input[id*="user" i]:not([disabled]):not([readonly]),' +
        'input[id*="email" i]:not([disabled]):not([readonly]),' +
        'input[autocomplete*="username" i]:not([disabled]):not([readonly]),' +
        'input[autocomplete*="email" i]:not([disabled]):not([readonly])'
      );
      let userInput = null;
      for (const c of candidates) {
        if (c === pwd) continue;
        if (c.type === 'password') continue;
        userInput = c;
        break;
      }
      if (userInput) setValue(userInput, u);
      setValue(pwd, p);
      try { pwd.focus(); } catch {}
      return { ok: true, filledUser: !!userInput };
    })(${JSON.stringify(username)}, ${JSON.stringify(password)})`;
    const result = (await el.executeJavaScript(script)) as
      | { ok: boolean; filledUser: boolean }
      | undefined;
    if (!result || !result.ok) {
      throw new Error('No password field found on this page');
    }
    return { filledUser: result.filledUser };
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

  // Type-ahead dropdown sourced from all per-worktree tab histories.
  // Deduplicated, ranked by host-match-first then substring match.
  let suggestionIndex = $state(-1);
  let urlInputFocused = $state(false);
  let suppressDropdown = $state(false);

  let allHistoryUrls = $derived.by<string[]>(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const tab of browserStore.tabs) {
      for (const url of tab.history) {
        if (!url || url === 'about:blank') continue;
        if (seen.has(url)) continue;
        seen.add(url);
        out.push(url);
      }
    }
    return out;
  });

  let suggestions = $derived.by<string[]>(() => {
    const q = urlInput.trim().toLowerCase();
    if (!q) return [];
    if (q === activeUrl.toLowerCase()) return [];
    const matches = allHistoryUrls.filter(
      (url) => url.toLowerCase().includes(q) && url.toLowerCase() !== q
    );
    return matches.slice(0, 8);
  });

  let dropdownOpen = $derived(
    urlInputFocused && !suppressDropdown && suggestions.length > 0
  );

  function onUrlKey(event: KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      suggestionIndex = (suggestionIndex + 1) % suggestions.length;
      suppressDropdown = false;
    } else if (event.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      suggestionIndex = suggestionIndex <= 0 ? suggestions.length - 1 : suggestionIndex - 1;
      suppressDropdown = false;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (dropdownOpen) {
        suppressDropdown = true;
        suggestionIndex = -1;
      } else {
        urlInput = activeUrl;
        lastSyncedUrl = activeUrl;
        urlInputEl?.blur();
      }
    } else {
      suggestionIndex = -1;
      suppressDropdown = false;
    }
  }

  function pickSuggestion(event: PointerEvent, url: string) {
    // Prevent the input from losing focus before we commit; otherwise the
    // blur runs first and the click target gets pulled out from under us.
    event.preventDefault();
    commitNavigation(url);
  }

  function shortLabel(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
    } catch {
      return url;
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
    class="relative flex items-center gap-1 border-b border-border bg-sidebar px-1 py-1"
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
    <div class="relative flex-1">
      <Input
        bind:ref={urlInputEl}
        bind:value={urlInput}
        onfocus={() => {
          urlInputFocused = true;
          suppressDropdown = false;
        }}
        onblur={() => {
          urlInputFocused = false;
        }}
        onkeydown={onUrlKey}
        placeholder="localhost:3000 or example.com"
        class="h-7 text-[11px]"
        spellcheck={false}
        autocomplete="off"
      />
      {#if dropdownOpen}
        <ul
          class="absolute top-full right-0 left-0 z-20 mt-1 max-h-60 overflow-y-auto rounded-md border border-border bg-popover text-popover-foreground shadow-md"
        >
          {#each suggestions as url, i (url)}
            {@const isFocused = i === suggestionIndex}
            <li>
              <button
                type="button"
                class={`flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] ${
                  isFocused ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                onpointerdown={(e) => pickSuggestion(e, url)}
                onmouseenter={() => (suggestionIndex = i)}
              >
                <History class="size-3 shrink-0 text-muted-foreground" />
                <span class="min-w-0 truncate">{shortLabel(url)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <Popover.Root bind:open={autofillOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            type="button"
            variant="ghost"
            size="icon"
            class="size-7"
            aria-label="Autofill"
            title="Autofill credentials"
          >
            <KeyRound class="size-3.5" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content align="end" class="w-auto p-0">
        <BrowserAutofillPopover
          currentUrl={activeUrl}
          onFill={runAutofill}
          onClose={() => (autofillOpen = false)}
        />
      </Popover.Content>
    </Popover.Root>
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
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="size-7"
      onclick={() => rightRail.toggleFullscreen()}
      aria-label={rightRail.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
      title={rightRail.fullscreen ? 'Exit fullscreen (Ctrl+Shift+M)' : 'Fullscreen (Ctrl+Shift+M)'}
      aria-pressed={rightRail.fullscreen}
    >
      {#if rightRail.fullscreen}
        <Minimize2 class="size-3.5" />
      {:else}
        <Maximize2 class="size-3.5" />
      {/if}
    </Button>
  </form>

  {#if failureSuggestion}
    <div
      class="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300"
    >
      <span class="min-w-0 flex-1 truncate">
        {failureSuggestion.reason}.
      </span>
      <button
        type="button"
        class="rounded border border-amber-500/40 px-1.5 py-0.5 font-medium hover:bg-amber-500/15"
        onclick={tryHttpFallback}
      >
        Try HTTP
      </button>
      <button
        type="button"
        class="opacity-60 hover:opacity-100"
        aria-label="Dismiss"
        onclick={dismissFallback}
      >
        <X class="size-3" />
      </button>
    </div>
  {/if}

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
