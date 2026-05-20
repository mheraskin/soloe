<script lang="ts">
  import { onMount, untrack } from 'svelte';
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
    KeyRound,
    Smartphone,
    Tablet,
    Monitor
  } from '@lucide/svelte';
  import { browserStore, type BrowserTabDevice } from '../../stores/browser.svelte';
  import { findPreset } from '../../lib/browser-devices';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import type { VaultEntry } from '../../../shared/types/vault';
  import type { ElectronWebview } from '../../types/webview';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Popover from '$lib/components/ui/popover';
  import { toast } from 'svelte-sonner';
  import BrowserAutofillPopover from './BrowserAutofillPopover.svelte';
  import BrowserDeviceMenu from './BrowserDeviceMenu.svelte';

  let activeTab = $derived(browserStore.activeTab);
  let activeUrl = $derived(activeTab ? activeTab.history[activeTab.historyIndex] ?? '' : '');
  let canBack = $derived(activeTab ? browserStore.canGoBack(activeTab.id) : false);
  let canForward = $derived(activeTab ? browserStore.canGoForward(activeTab.id) : false);
  let device = $derived(activeTab?.device);
  // Width/height swap when rotated. `rotated` lives on the device so a single
  // toggle can flip portrait↔landscape without rewriting the preset numbers.
  let deviceWidth = $derived(
    device ? (device.rotated ? device.height : device.width) : 0
  );
  let deviceHeight = $derived(
    device ? (device.rotated ? device.width : device.height) : 0
  );

  // Captured once at mount so the initial `src=` doesn't react. The effect
  // below takes over for subsequent navigations.
  const seededTab = browserStore.ensureSomeTab();
  const initialUrl = seededTab.history[seededTab.historyIndex] ?? 'about:blank';

  // Chrome-like display: hide the http(s):// prefix when the URL bar isn't
  // focused. The full URL stays in `lastSyncedUrl` so we can restore it on
  // focus and submit it correctly on Enter.
  function stripProtocol(url: string): string {
    return url.replace(/^https?:\/\//i, '');
  }

  let webview = $state<ElectronWebview | null>(null);
  let domReady = $state(false);
  let lastLoadedUrl = $state(initialUrl);
  let urlInput = $state(stripProtocol(initialUrl));
  let urlInputEl = $state<HTMLInputElement | null>(null);
  let isLoading = $state(false);
  let failureSuggestion = $state<{ httpsUrl: string; httpUrl: string; reason: string } | null>(null);

  // Tracks the URL that the bar most recently auto-synced to. When the user
  // types into the bar, urlInput diverges from this value — that's our signal
  // that the bar is "dirty" and shouldn't be clobbered by auto-syncing.
  // Resets explicitly on submit, escape, and tab switch.
  let lastSyncedUrl = $state(initialUrl);
  // Dirty when the bar matches neither the canonical URL nor its display form.
  // Comparing both forms lets the bar render the stripped variant without
  // appearing dirty to the auto-sync effect.
  let isDirty = $derived(
    urlInput !== lastSyncedUrl && urlInput !== stripProtocol(lastSyncedUrl)
  );

  // Auto-sync the URL bar to the active page URL — but only when the user
  // isn't mid-edit. Same-tab in-page navigations (link clicks, redirects)
  // update the bar; user's pending typed text is preserved across blurs.
  $effect(() => {
    const target = activeUrl;
    if (untrack(() => isDirty)) return;
    lastSyncedUrl = target;
    urlInput = untrack(() => urlInputFocused) ? target : stripProtocol(target);
  });

  // Tab-switch reset: forces a fresh sync regardless of dirty state, since
  // the typed-but-uncommitted text belonged to the previous tab. Seed value
  // is intentionally a snapshot (not reactive) — the effect below tracks the
  // live id.
  let prevTabId: string | null = untrack(() => activeTab?.id ?? null);
  $effect(() => {
    const id = activeTab?.id ?? null;
    if (id === prevTabId) return;
    prevTabId = id;
    const target = activeUrl;
    lastSyncedUrl = target;
    urlInput = untrack(() => urlInputFocused) ? target : stripProtocol(target);
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
      // Cross-page navigations invalidate the fill prompt (it referenced
      // the previous page's password field). The save prompt is kept until
      // the user acts on it — a form-submit-driven nav arrives right after
      // the prompt appears and would otherwise dismiss it instantly.
      fillPrompt = null;
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
    // ipc-message fires when the webview preload calls
    // ipcRenderer.sendToHost(). We branch on the channel: shortcut forwarding
    // synthesizes a host-side keydown so App.svelte's keymap sees it;
    // password-focus and form-submit drive the inline autofill popovers.
    const onIpcMessage = (event: Event) => {
      const e = event as Event & { channel?: string; args?: unknown[] };
      if (e.channel === 'soloe:webview-shortcut') {
        const payload = e.args?.[0] as
          | {
              key?: string;
              code?: string;
              ctrlKey?: boolean;
              metaKey?: boolean;
              shiftKey?: boolean;
              altKey?: boolean;
            }
          | undefined;
        if (!payload?.key) return;
        const synthesized = new KeyboardEvent('keydown', {
          key: payload.key,
          code: payload.code ?? '',
          ctrlKey: payload.ctrlKey ?? false,
          metaKey: payload.metaKey ?? false,
          shiftKey: payload.shiftKey ?? false,
          altKey: payload.altKey ?? false,
          bubbles: true,
          cancelable: true
        });
        window.dispatchEvent(synthesized);
        return;
      }
      if (e.channel === 'soloe:webview-password-focus') {
        const payload = e.args?.[0] as { origin?: string } | undefined;
        void handlePasswordFocus(payload?.origin ?? '');
        return;
      }
      if (e.channel === 'soloe:webview-form-submit') {
        const payload = e.args?.[0] as
          | { origin?: string; username?: string; password?: string }
          | undefined;
        if (!payload?.origin || !payload.username || !payload.password) return;
        void handleFormSubmit(payload.origin, payload.username, payload.password);
        return;
      }
    };
    el.addEventListener('dom-ready', onDomReady);
    el.addEventListener('did-navigate', onNavigate);
    el.addEventListener('did-navigate-in-page', onNavigate);
    el.addEventListener('page-title-updated', onTitle);
    el.addEventListener('did-start-loading', onLoadStart);
    el.addEventListener('did-stop-loading', onLoadStop);
    el.addEventListener('did-fail-load', onFail);
    el.addEventListener('ipc-message', onIpcMessage);
    return () => {
      el.removeEventListener('dom-ready', onDomReady);
      el.removeEventListener('did-navigate', onNavigate);
      el.removeEventListener('did-navigate-in-page', onNavigate);
      el.removeEventListener('page-title-updated', onTitle);
      el.removeEventListener('did-start-loading', onLoadStart);
      el.removeEventListener('did-stop-loading', onLoadStop);
      el.removeEventListener('did-fail-load', onFail);
      el.removeEventListener('ipc-message', onIpcMessage);
    };
  });

  // Localhost-ish hosts get http://; everything else defaults to https://.
  // Catches localhost, loopback, private network ranges, and bare ports
  // (":3000") which can only mean a local dev server. The host may carry a
  // port (e.g. "localhost:3000") — strip it before matching so port-bearing
  // hosts aren't accidentally treated as public.
  function looksLocal(host: string): boolean {
    if (!host) return false;
    if (host.startsWith(':')) return true;
    // IPv6 in brackets: [::1] or [::1]:8080
    if (host.startsWith('[')) {
      const closing = host.indexOf(']');
      if (closing < 0) return false;
      return host.slice(1, closing).toLowerCase() === '::1';
    }
    const lower = host.toLowerCase();
    const hostname = lower.split(':')[0] ?? '';
    if (!hostname) return false;
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
    if (/^127\./.test(hostname)) return true;
    if (/^10\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return true;
    return false;
  }

  function normalizeUrl(input: string): string {
    const trimmed = input.trim();
    if (!trimmed) return 'about:blank';
    // Already has a scheme (http:, https:, file:, about:, data:, …) — leave it.
    if (/^[a-z][a-z0-9+\-.]*:/i.test(trimmed)) return trimmed;
    // No dot, no colon, no slash → not a URL, treat as a search query.
    // Without this, "foo" would be navigated to as "https://foo" which
    // produces a "site can't be reached" error instead of useful behavior.
    if (!/[.:\/]/.test(trimmed) && !looksLocal(trimmed)) {
      return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
    }
    const hostPart = trimmed.split(/[\/?#]/, 1)[0] ?? '';
    // Bare port "/3000" or ":3000" → assume localhost on that port.
    if (trimmed.startsWith(':')) {
      return `http://localhost${trimmed}`;
    }
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

  let devToolsOpen = $state(false);
  let devToolsHeight = $state(280);
  let devToolsHost = $state<HTMLDivElement | null>(null);
  // The DevTools panel is rendered by a main-process WebContentsView that
  // floats over `devToolsHost`. <webview> can't be a DevTools container
  // (Chromium disallows guest views — see electron/electron#14095), so the
  // host lives in main and we just send it the placeholder's bounds.
  let lastSentBounds: { x: number; y: number; width: number; height: number } | null = null;
  let boundsRaf = 0;

  async function openDevTools() {
    const main = webview;
    if (!main || !domReady) return;
    if (devToolsOpen) return;
    devToolsOpen = true;
    // Defer one frame so the placeholder is laid out before we measure it.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve())
    );
    const bounds = computeBounds();
    if (!bounds) {
      devToolsOpen = false;
      return;
    }
    try {
      await window.soloe.browser.openDevTools({
        webContentsId: main.getWebContentsId(),
        bounds
      });
      lastSentBounds = bounds;
      startBoundsSync();
    } catch (err) {
      reportError(err, 'Failed to open DevTools');
      devToolsOpen = false;
    }
  }

  function computeBounds(): { x: number; y: number; width: number; height: number } | null {
    const el = devToolsHost;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }

  function syncBoundsOnce() {
    const main = webview;
    if (!main || !devToolsOpen) return;
    if (devToolsSuspended) return;
    const bounds = computeBounds();
    if (!bounds) return;
    const prev = lastSentBounds;
    if (
      prev &&
      prev.x === bounds.x &&
      prev.y === bounds.y &&
      prev.width === bounds.width &&
      prev.height === bounds.height
    ) {
      return;
    }
    lastSentBounds = bounds;
    try {
      void window.soloe.browser
        .setDevToolsBounds({ webContentsId: main.getWebContentsId(), bounds })
        .catch(() => {
          // bounds updates are fire-and-forget; ignore transient failures
        });
    } catch {
      // ignore
    }
  }

  function startBoundsSync() {
    cancelBoundsSync();
    const loop = () => {
      if (!devToolsOpen) {
        boundsRaf = 0;
        return;
      }
      syncBoundsOnce();
      boundsRaf = requestAnimationFrame(loop);
    };
    boundsRaf = requestAnimationFrame(loop);
  }

  function cancelBoundsSync() {
    if (boundsRaf) {
      cancelAnimationFrame(boundsRaf);
      boundsRaf = 0;
    }
  }

  function closeDevTools() {
    if (!devToolsOpen) return;
    devToolsOpen = false;
    cancelBoundsSync();
    lastSentBounds = null;
    const main = webview;
    if (!main) return;
    let webContentsId: number;
    try {
      webContentsId = main.getWebContentsId();
    } catch {
      return;
    }
    try {
      void window.soloe.browser
        .closeDevTools({ webContentsId })
        .catch((err) => reportError(err, 'Failed to close DevTools'));
    } catch (err) {
      reportError(err, 'Failed to close DevTools');
    }
  }

  function toggleDevTools() {
    if (devToolsOpen) closeDevTools();
    else void openDevTools();
  }

  // Drag-to-resize the DevTools panel (Chrome-like). Math anchors to the
  // outer container height so the panel grows up from the bottom edge.
  // Pointer capture + DevTools suspend keep the drag from sticking when the
  // cursor crosses the page <webview> (above) or the DevTools WebContentsView
  // (below). The native view ignores DOM pointer capture, so we hide it.
  let devToolsResizing = $state(false);
  function startDevToolsResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    devToolsResizing = true;
    suspendDevToolsView();
    const startY = event.clientY;
    const startHeight = devToolsHeight;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      // Dragging up (negative dy) grows the panel; clamp to a sane range.
      devToolsHeight = Math.min(Math.max(startHeight - dy, 120), 800);
    };
    const onUp = () => {
      devToolsResizing = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      resumeDevToolsView();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  // While suspended, the DevTools WebContentsView is moved offscreen so it
  // can't eat pointer events during a drag. The rAF bounds sync skips its
  // work, and `lastSentBounds` is cleared on resume so the next frame's
  // sync re-pushes the real bounds even if they happened to match.
  let devToolsSuspended = $state(false);
  function suspendDevToolsView() {
    if (!devToolsOpen || devToolsSuspended) return;
    const main = webview;
    if (!main) return;
    devToolsSuspended = true;
    try {
      void window.soloe.browser
        .setDevToolsBounds({
          webContentsId: main.getWebContentsId(),
          bounds: { x: -10000, y: -10000, width: 1, height: 1 }
        })
        .catch(() => {});
    } catch {
      // ignore
    }
  }

  function resumeDevToolsView() {
    if (!devToolsSuspended) return;
    devToolsSuspended = false;
    lastSentBounds = null;
    syncBoundsOnce();
  }

  let autofillOpen = $state(false);
  let deviceMenuOpen = $state(false);

  // Apply the active device's emulation settings to the underlying webContents
  // whenever the device changes or the page reaches dom-ready. Tracks the
  // last applied UA so we can force a reload when it changes (UA is consulted
  // by the page at navigation time, not after the fact).
  let lastAppliedUa = $state<string | null>(null);
  let lastAppliedDeviceKey = $state<string | null>(null);

  function deviceKey(d: BrowserTabDevice | undefined): string | null {
    if (!d) return null;
    const w = d.rotated ? d.height : d.width;
    const h = d.rotated ? d.width : d.height;
    return `${d.presetId}:${w}x${h}@${d.dpr}:${d.mobile ? 'm' : 'd'}:${d.ua}`;
  }

  async function applyEmulation(): Promise<void> {
    const el = webview;
    if (!el || !domReady) return;
    let webContentsId: number;
    try {
      webContentsId = el.getWebContentsId();
    } catch {
      return;
    }
    if (!device) {
      if (lastAppliedDeviceKey === null) return;
      lastAppliedDeviceKey = null;
      try {
        await window.soloe.browser.disableDeviceEmulation({ webContentsId });
        if (lastAppliedUa !== null) {
          await window.soloe.browser.setUserAgent({ webContentsId, userAgent: null });
          const previousUa = lastAppliedUa;
          lastAppliedUa = null;
          if (previousUa) el.reload();
        }
      } catch (err) {
        reportError(err, 'Failed to disable device emulation');
      }
      return;
    }
    const key = deviceKey(device);
    if (key === lastAppliedDeviceKey) return;
    lastAppliedDeviceKey = key;
    try {
      await window.soloe.browser.enableDeviceEmulation({
        webContentsId,
        emulation: {
          width: deviceWidth,
          height: deviceHeight,
          deviceScaleFactor: device.dpr,
          mobile: device.mobile,
          ...(device.ua ? { userAgent: device.ua } : {})
        }
      });
      const nextUa = device.ua || null;
      if (nextUa !== lastAppliedUa) {
        const hadPreviousUa = lastAppliedUa !== null;
        lastAppliedUa = nextUa;
        if (nextUa || hadPreviousUa) el.reload();
      }
    } catch (err) {
      reportError(err, 'Failed to enable device emulation');
    }
  }

  // Re-apply when device changes or dom becomes ready (covers page reloads
  // that drop emulation on the floor — Chromium clears it on cross-process
  // navigation).
  $effect(() => {
    // Track all relevant inputs so the effect fires on any of them.
    void device;
    void deviceWidth;
    void deviceHeight;
    void domReady;
    void applyEmulation();
  });

  function setDevice(next: BrowserTabDevice | null) {
    const tab = browserStore.activeTab;
    if (!tab) return;
    browserStore.setDevice(tab.id, next);
  }

  function rotateDevice() {
    const tab = browserStore.activeTab;
    if (!tab) return;
    browserStore.rotateDevice(tab.id);
  }

  function deviceIcon() {
    if (!device) return Monitor;
    const preset = findPreset(device.presetId);
    if (preset?.kind === 'mobile') return Smartphone;
    if (preset?.kind === 'tablet') return Tablet;
    // For 'custom' use a phone icon if mobile flag set, else monitor — gives
    // a quick visual hint about what flavor of viewport is active.
    if (device.presetId === 'custom') return device.mobile ? Smartphone : Monitor;
    return Monitor;
  }

  // Custom event from App.svelte: Ctrl+/-/0 while the browser tab is active.
  onMount(() => {
    const onZoom = (event: Event) => {
      const direction = (event as CustomEvent<{ direction: 'in' | 'out' | 'reset' }>).detail
        ?.direction;
      if (!direction) return;
      const el = webview;
      if (!el || !domReady) return;
      const current = el.getZoomLevel();
      if (direction === 'reset') el.setZoomLevel(0);
      else if (direction === 'in') el.setZoomLevel(Math.min(current + 0.5, 5));
      else el.setZoomLevel(Math.max(current - 0.5, -5));
    };
    const onResizeStart = () => suspendDevToolsView();
    const onResizeEnd = () => resumeDevToolsView();
    const onFocusPane = (e: Event) => {
      const detail = (e as CustomEvent<{ tabId: string }>).detail;
      if (detail?.tabId !== 'browser') return;
      urlInputEl?.focus();
      requestAnimationFrame(() => urlInputEl?.select());
    };
    const onAutofillEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!fillPrompt && !savePrompt) return;
      fillPrompt = null;
      savePrompt = null;
    };
    window.addEventListener('soloe:browser-zoom', onZoom);
    window.addEventListener('soloe:rail-resize-start', onResizeStart);
    window.addEventListener('soloe:rail-resize-end', onResizeEnd);
    window.addEventListener('soloe:focus-pane', onFocusPane);
    window.addEventListener('keydown', onAutofillEscape);
    return () => {
      window.removeEventListener('soloe:browser-zoom', onZoom);
      window.removeEventListener('soloe:rail-resize-start', onResizeStart);
      window.removeEventListener('soloe:rail-resize-end', onResizeEnd);
      window.removeEventListener('soloe:focus-pane', onFocusPane);
      window.removeEventListener('keydown', onAutofillEscape);
      // Tear down DevTools when the rail unmounts. The main-side 'destroyed'
      // listener also covers webview destruction, but cancelling the rAF
      // loop here avoids a stray frame after the component is gone.
      cancelBoundsSync();
    };
  });

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

  // Inline autofill prompt state: shown when the guest page reports a
  // password field gaining focus AND the vault has entries for the page's
  // origin. The host owns the popover UI so the page can't observe or
  // restyle it. Dismissed on Esc, click outside, or after Fill.
  interface FillPrompt {
    origin: string;
    matches: VaultEntry[];
  }
  let fillPrompt = $state<FillPrompt | null>(null);

  // Inline save prompt state: shown after a form submit when we detect
  // credentials that aren't already saved for that origin+username. The
  // user can save (writes to the vault) or dismiss.
  interface SavePrompt {
    origin: string;
    username: string;
    password: string;
  }
  let savePrompt = $state<SavePrompt | null>(null);
  let savePromptBusy = $state(false);

  async function handlePasswordFocus(origin: string): Promise<void> {
    if (!origin) return;
    try {
      await vaultStore.ensureLoaded();
    } catch {
      // Vault load failure is non-fatal — just skip the prompt.
      return;
    }
    const matches = vaultStore.matchesForOrigin(origin);
    if (matches.length === 0) {
      fillPrompt = null;
      return;
    }
    fillPrompt = { origin, matches };
  }

  async function fillFromPrompt(entry: VaultEntry): Promise<void> {
    try {
      const secret = await vaultStore.getSecret(entry.id);
      const result = await runAutofill(secret.username, secret.password);
      if (!result.filledUser) {
        toast.success('Filled password (no username field detected)');
      } else {
        toast.success('Filled');
      }
    } catch (err) {
      reportError(err, 'Autofill failed');
    } finally {
      fillPrompt = null;
    }
  }

  async function handleFormSubmit(
    origin: string,
    username: string,
    password: string
  ): Promise<void> {
    try {
      await vaultStore.ensureLoaded();
    } catch {
      return;
    }
    const matches = vaultStore.matchesForOrigin(origin);
    // Already saved for this exact (origin, username) — don't nag the user
    // again. We don't compare passwords here because matchesForOrigin
    // returns metadata, not secrets; a stale password is the user's
    // problem to update manually for now.
    const alreadyKnown = matches.some(
      (m) => m.username.toLowerCase() === username.toLowerCase()
    );
    if (alreadyKnown) {
      savePrompt = null;
      return;
    }
    savePrompt = { origin, username, password };
  }

  async function confirmSave(): Promise<void> {
    if (!savePrompt || savePromptBusy) return;
    savePromptBusy = true;
    try {
      await vaultStore.save({
        origin: savePrompt.origin,
        username: savePrompt.username,
        password: savePrompt.password
      });
      toast.success('Password saved');
      savePrompt = null;
    } catch (err) {
      reportError(err, 'Failed to save password');
    } finally {
      savePromptBusy = false;
    }
  }

  function dismissFillPrompt(): void {
    fillPrompt = null;
  }

  function dismissSavePrompt(): void {
    savePrompt = null;
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

  // Word-edit a URL input. Chromium's native Ctrl+Backspace handling can be
  // platform-flaky inside Electron (and Ctrl+Alt+Backspace is eaten by some
  // Linux DEs as the X "zap" combo), so we run the boundary walk ourselves
  // and accept any of Ctrl/Alt/Meta as the word modifier — whichever the
  // user reaches for ends up doing the same thing.
  function deleteWordInUrlInput(direction: 'backward' | 'forward'): void {
    const el = urlInputEl;
    if (!el) return;
    const value = el.value;
    const selStart = el.selectionStart ?? value.length;
    const selEnd = el.selectionEnd ?? value.length;
    let nextValue: string;
    let nextCaret: number;
    if (selStart !== selEnd) {
      nextValue = value.slice(0, selStart) + value.slice(selEnd);
      nextCaret = selStart;
    } else if (direction === 'backward') {
      let i = selStart;
      while (i > 0 && /\s/.test(value[i - 1]!)) i--;
      if (i > 0) {
        const wordish = /\w/.test(value[i - 1]!);
        while (i > 0 && wordish === /\w/.test(value[i - 1]!) && !/\s/.test(value[i - 1]!)) i--;
      }
      nextValue = value.slice(0, i) + value.slice(selStart);
      nextCaret = i;
    } else {
      let i = selStart;
      while (i < value.length && /\s/.test(value[i]!)) i++;
      if (i < value.length) {
        const wordish = /\w/.test(value[i]!);
        while (i < value.length && wordish === /\w/.test(value[i]!) && !/\s/.test(value[i]!)) i++;
      }
      nextValue = value.slice(0, selStart) + value.slice(i);
      nextCaret = selStart;
    }
    if (nextValue === value) return;
    urlInput = nextValue;
    requestAnimationFrame(() => {
      if (!el.isConnected) return;
      el.selectionStart = el.selectionEnd = nextCaret;
    });
  }

  function onUrlKey(event: KeyboardEvent) {
    const wordMod = event.ctrlKey || event.altKey || event.metaKey;
    if (wordMod && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault();
      deleteWordInUrlInput(event.key === 'Backspace' ? 'backward' : 'forward');
      return;
    }
    if (event.key === 'Enter') {
      // Handle Enter explicitly so navigation doesn't rely on the form's
      // onsubmit firing (some Input wrappers or surrounding keyboard
      // handlers may swallow the default submit).
      event.preventDefault();
      if (suggestionIndex >= 0 && suggestionIndex < suggestions.length) {
        commitNavigation(suggestions[suggestionIndex]!);
      } else {
        commitNavigation(urlInput);
      }
      return;
    }
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
    class="relative flex min-w-0 items-center gap-1 border-b border-border bg-sidebar px-1 py-1"
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
    <div class="relative min-w-0 flex-1">
      <Input
        bind:ref={urlInputEl}
        bind:value={urlInput}
        onfocus={() => {
          urlInputFocused = true;
          suppressDropdown = false;
          // Expand to full URL so the user sees the protocol while editing.
          if (urlInput === stripProtocol(lastSyncedUrl) && urlInput !== lastSyncedUrl) {
            urlInput = lastSyncedUrl;
          }
          // Select all on focus so the next keystroke replaces the URL —
          // matching Chrome's omnibox behavior. Defer one frame so the value
          // update above lands first.
          requestAnimationFrame(() => urlInputEl?.select());
        }}
        onblur={() => {
          urlInputFocused = false;
          // Collapse back to the stripped form if the user didn't edit.
          if (urlInput === lastSyncedUrl) {
            urlInput = stripProtocol(lastSyncedUrl);
          }
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
    <Popover.Root bind:open={deviceMenuOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          {@const Icon = deviceIcon()}
          <Button
            {...props}
            type="button"
            variant="ghost"
            size="icon"
            class={`size-7 ${device ? 'text-foreground' : ''}`}
            aria-label="Responsive viewer"
            title={device
              ? `Device: ${findPreset(device.presetId)?.label ?? 'custom'} (${deviceWidth}×${deviceHeight})`
              : 'Responsive viewer'}
            aria-pressed={!!device}
          >
            <Icon class="size-3.5" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content align="end" class="w-auto p-0">
        <BrowserDeviceMenu
          {device}
          onSelect={setDevice}
          onRotate={rotateDevice}
          onClose={() => (deviceMenuOpen = false)}
        />
      </Popover.Content>
    </Popover.Root>
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
      class={`size-7 ${devToolsOpen ? 'text-foreground' : ''}`}
      aria-label="DevTools"
      title={devToolsOpen ? 'Close DevTools' : 'DevTools'}
      aria-pressed={devToolsOpen}
      disabled={!activeTab}
      onclick={toggleDevTools}
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
    {#if device}
      <div class="flex shrink-0 items-center justify-center gap-2 border-b border-border bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground">
        <span class="rounded bg-background/80 px-1.5 py-0.5 font-mono">
          {deviceWidth} × {deviceHeight}
        </span>
        <span>DPR {device.dpr}</span>
        <button
          type="button"
          class="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-background/80"
          onclick={rotateDevice}
          title="Rotate"
        >
          <RotateCw class="size-3" />
          Rotate
        </button>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 hover:bg-background/80"
          onclick={() => setDevice(null)}
        >
          Exit
        </button>
      </div>
    {/if}
    <!--
      Keep a single <webview> element mounted across device toggles so the
      page (cookies, scroll, in-page state, webContentsId) survives. Switching
      between native/device modes flips only the wrapper's classes and the
      device-box's inline size — the webview node itself never unmounts.
    -->
    <div
      class={device
        ? 'relative flex min-h-0 flex-1 items-start justify-center overflow-auto bg-muted/40 p-4'
        : 'relative flex min-h-0 flex-1 flex-col'}
    >
      <div
        class={device
          ? 'shrink-0 overflow-hidden rounded border border-border bg-background shadow-lg'
          : 'flex min-h-0 flex-1 flex-col'}
        style={device ? `width: ${deviceWidth}px; height: ${deviceHeight}px;` : ''}
      >
        <!-- svelte-ignore element_invalid_self_closing_tag -->
        <webview
          bind:this={webview}
          src={initialUrl}
          partition="persist:soloe-browser"
          class={device ? 'h-full w-full' : 'min-h-0 flex-1'}
          style="display: flex;"
        ></webview>
      </div>

      {#if fillPrompt}
        <div
          class="absolute top-2 right-2 z-20 flex w-72 flex-col gap-1 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg"
          role="dialog"
          aria-label="Autofill suggestion"
        >
          <div class="flex items-center gap-2 pb-1">
            <KeyRound class="size-3.5 text-muted-foreground" />
            <span class="text-[11px] font-medium">Sign in with saved password</span>
            <button
              type="button"
              class="ml-auto opacity-60 hover:opacity-100"
              aria-label="Dismiss"
              onclick={dismissFillPrompt}
            >
              <X class="size-3" />
            </button>
          </div>
          {#each fillPrompt.matches as entry (entry.id)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-left hover:border-border hover:bg-muted/60"
              onclick={() => fillFromPrompt(entry)}
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs">{entry.username}</div>
                {#if entry.label}
                  <div class="truncate text-[10px] text-muted-foreground">{entry.label}</div>
                {/if}
              </div>
              <span class="text-[10px] text-muted-foreground">Fill</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if savePrompt}
        <div
          class="absolute top-2 right-2 z-20 flex w-72 flex-col gap-2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          role="dialog"
          aria-label="Save password"
        >
          <div class="flex items-center gap-2">
            <KeyRound class="size-3.5 text-muted-foreground" />
            <span class="text-[11px] font-medium">Save password?</span>
            <button
              type="button"
              class="ml-auto opacity-60 hover:opacity-100"
              aria-label="Dismiss"
              onclick={dismissSavePrompt}
            >
              <X class="size-3" />
            </button>
          </div>
          <div class="text-[11px] text-muted-foreground">
            Save the password for <span class="font-mono">{savePrompt.username}</span> on
            this site?
          </div>
          <div class="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              class="h-6 text-[11px]"
              onclick={dismissSavePrompt}
              disabled={savePromptBusy}
            >
              Not now
            </Button>
            <Button
              type="button"
              variant="default"
              size="xs"
              class="h-6 text-[11px]"
              onclick={confirmSave}
              disabled={savePromptBusy}
            >
              {savePromptBusy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      {/if}
    </div>
    <!--
      DevTools panel: an empty placeholder div whose bounds are forwarded to
      a main-process WebContentsView (the only DevTools host Chromium
      accepts — guest views like <webview> render blank). The panel only
      mounts while open so the WebContentsView is created lazily.
    -->
    {#if devToolsOpen}
      <div
        class="flex shrink-0 flex-col border-t border-border"
        style={`height: ${devToolsHeight}px;`}
      >
        <div
          role="separator"
          aria-orientation="horizontal"
          class={`h-1 shrink-0 cursor-row-resize bg-border hover:bg-primary/40 ${
            devToolsResizing ? 'bg-primary/40' : ''
          }`}
          onpointerdown={startDevToolsResize}
        ></div>
        <div bind:this={devToolsHost} class="min-h-0 flex-1 bg-[#1e1e1e]"></div>
      </div>
    {/if}
  {:else}
    <div class="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
      No browser tabs yet. Use the <Plus class="inline-block size-3" /> button above to open one.
    </div>
  {/if}
</div>
