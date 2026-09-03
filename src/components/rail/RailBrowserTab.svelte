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
    Monitor,
    CircleAlert,
    PowerOff,
    Power,
    ScanLine,
    ChevronDown
  } from '@lucide/svelte';
  import {
    browserStore,
    type BrowserTabDevice,
    type BrowserTargetDevice
  } from '../../stores/browser.svelte';
  import { git } from '../../stores/git.svelte';
  import { projects } from '../../stores/projects.svelte';
  import { deviceSessions } from '../../stores/device-sessions.svelte';
  import { elementSourceInspector } from '../../stores/element-source-inspector.svelte';
  import { findPreset } from '../../lib/browser-devices';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { settings } from '../../stores/settings.svelte';
  import { vaultStore } from '../../stores/vault.svelte';
  import type { ScopedVaultEntry } from '../../lib/vault-groups';
  import type { ElectronWebview } from '../../types/webview';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Popover from '$lib/components/ui/popover';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import { toast } from 'svelte-sonner';
  import BrowserAutofillPopover from './BrowserAutofillPopover.svelte';
  import BrowserDeviceMenu from './BrowserDeviceMenu.svelte';
  import { ipc } from '../../lib/ipc';
  import { BrowserDevToolsViewController } from '../../lib/browser-devtools-bounds';
  import {
    browserTargetOptions,
    defaultBrowserTarget,
    resolveDeviceBrowserUrl
  } from '../../lib/browser-device-navigation';
  import {
    browserFailureFromFailedLoad,
    browserFailureFromHttpResponse,
    type BrowserLoadFailure
  } from '../../lib/browser-load-failure';
  import {
    mapGuestRectToHost,
    shortcutLabel,
    type ElementSourcePayload,
    type ElementSourceRect
  } from '../../lib/element-source-inspector';
  import { nextContentZoomFactor } from '../../lib/content-zoom';

  let activeTab = $derived(browserStore.activeTab);
  let activeId = $derived(browserStore.activeTabId);
  let activeUrl = $derived(activeTab ? activeTab.history[activeTab.historyIndex] ?? '' : '');
  let canBack = $derived(activeTab ? browserStore.canGoBack(activeTab.id) : false);
  let canForward = $derived(activeTab ? browserStore.canGoForward(activeTab.id) : false);
  let device = $derived(activeTab?.device);
  let targetOptions = $derived.by(() => browserTargetOptions());
  let multiDeviceActive = $derived(
    targetOptions.some((option) => !option.target.local)
  );
  let targetDevice = $derived.by(() => {
    const stored = activeTab?.targetDevice;
    if (stored) {
      return targetOptions.find((option) => option.target.deviceId === stored.deviceId)?.target
        ?? defaultBrowserTarget();
    }
    return targetOptions.find((option) => option.target.local)?.target
      ?? defaultBrowserTarget();
  });
  let targetMenuOpen = $state(false);
  let navigationPending = $state(false);
  // Width/height swap when rotated. `rotated` lives on the device so a single
  // toggle can flip portrait↔landscape without rewriting the preset numbers.
  let deviceWidth = $derived(
    device ? (device.rotated ? device.height : device.width) : 0
  );
  let deviceHeight = $derived(
    device ? (device.rotated ? device.width : device.height) : 0
  );

  // Per-tab webview state. Each non-paused tab gets its own <webview> element
  // so switching between tabs doesn't reload the page. Records are keyed by
  // BrowserTab.id; entries are added by the attachment factory below and
  // removed in its cleanup when the webview unmounts.
  let webviewsById = $state<Record<string, ElectronWebview>>({});
  let domReadyById = $state<Record<string, boolean>>({});
  let isLoadingById = $state<Record<string, boolean>>({});
  let lastLoadedById = $state<Record<string, string>>({});
  let failureById = $state<Record<string, BrowserLoadFailure | null>>({});
  let lastAppliedDeviceKeyById = $state<Record<string, string | null>>({});
  let lastAppliedUaById = $state<Record<string, string | null>>({});
  let activeWebview = $derived(activeId ? webviewsById[activeId] ?? null : null);
  let activeDomReady = $derived(activeId ? !!domReadyById[activeId] : false);
  let isLoading = $derived(activeId ? !!isLoadingById[activeId] : false);
  let activeFailure = $derived(activeId ? failureById[activeId] ?? null : null);
  let activePageZoom = $derived(activeTab?.pageZoom ?? 1);
  let activeCanvasZoom = $derived(activeTab?.canvasZoom ?? 1);
  // While a device is active Ctrl+/-/0 drives the canvas; otherwise the
  // webview's page zoom. The indicator and reset button follow the same rule.
  let activeZoomFactor = $derived(device ? activeCanvasZoom : activePageZoom);
  let zoomPercent = $derived(Math.round(activeZoomFactor * 100));
  let browserSurfaceEl = $state<HTMLDivElement | null>(null);
  let inspectorSettingEnabled = $derived(settings.current.browser.elementSourceInspectorEnabled);
  let inspectorViewAvailable = $derived(
    !!activeTab && activeDomReady && activeUrl !== '' && activeUrl !== 'about:blank'
  );
  let inspectorModeActive = $derived(
    activeId ? elementSourceInspector.isModeActive(browserStore.activeWorktreeKey, activeId) : false
  );

  function setTabRecordValue<T>(
    getRecord: () => Record<string, T>,
    tabId: string,
    value: T
  ): Record<string, T> {
    const current = untrack(getRecord);
    if (current[tabId] === value) return current;
    return { ...current, [tabId]: value };
  }

  function deleteTabRecordValue<T>(
    getRecord: () => Record<string, T>,
    tabId: string
  ): Record<string, T> {
    const current = untrack(getRecord);
    if (!(tabId in current)) return current;
    const { [tabId]: _removed, ...rest } = current;
    return rest;
  }

  function inspectorContext(tabId: string, pageUrl = activeUrl) {
    const session = deviceSessions.activeSession;
    if (!session) return null;
    const project = deviceSessions.selectedProjection
      ? null
      : session.projectId ? projects.get(session.projectId) : null;
    const inventoryRoot = project?.path ?? session.cwd;
    const context = {
      ...session,
      ...(deviceSessions.activeRemoteDeviceId
        ? { deviceId: deviceSessions.activeRemoteDeviceId }
        : {})
    };
    const worktreeRoots = git.worktreesFor(inventoryRoot, context)?.map((worktree) => worktree.path)
      ?? [session.cwd];
    return {
      tabId,
      scopeKey: browserStore.activeWorktreeKey,
      cwd: session.cwd,
      runMode: session.runMode,
      ...(session.wslDistro ? { wslDistro: session.wslDistro } : {}),
      ...(deviceSessions.activeRemoteDeviceId
        ? { deviceId: deviceSessions.activeRemoteDeviceId }
        : {}),
      projectRoot: session.cwd,
      worktreeRoots,
      pageUrl
    };
  }

  function sendInspectorMode(tabId: string, enabled: boolean): void {
    const webview = webviewsById[tabId];
    if (!webview || !domReadyById[tabId]) return;
    try {
      webview.send('soloe:webview-element-source-mode', { enabled });
    } catch {
      // The guest can disappear between the ready check and send during a
      // reload. The next dom-ready event resynchronizes the mode.
    }
  }

  function setInspectorMode(tabId: string, enabled: boolean): void {
    if (!inspectorSettingEnabled && enabled) return;
    const scopeKey = browserStore.activeWorktreeKey;
    const context = inspectorContext(tabId);
    if (context) elementSourceInspector.registerContext(context);
    elementSourceInspector.setMode(scopeKey, tabId, enabled);
    sendInspectorMode(tabId, enabled);
  }

  function toggleInspectorMode(): void {
    const tabId = activeId;
    if (!tabId || !inspectorSettingEnabled || !inspectorViewAvailable) return;
    setInspectorMode(
      tabId,
      !elementSourceInspector.isModeActive(browserStore.activeWorktreeKey, tabId)
    );
  }

  function sanitizeInspectorPayload(raw: unknown): ElementSourcePayload | null {
    if (!raw || typeof raw !== 'object') return null;
    const value = raw as Record<string, unknown>;
    const kind = value['kind'];
    if (kind !== 'hover' && kind !== 'select' && kind !== 'leave') return null;
    const frame = (candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const source = candidate as Record<string, unknown>;
      if (typeof source['filePath'] !== 'string') return null;
      return {
        filePath: source['filePath'].slice(0, 4096),
        lineNumber: typeof source['lineNumber'] === 'number' ? source['lineNumber'] : null,
        columnNumber: typeof source['columnNumber'] === 'number' ? source['columnNumber'] : null,
        componentName: typeof source['componentName'] === 'string'
          ? source['componentName'].slice(0, 160)
          : null
      };
    };
    const rectValue = value['rect'];
    let rect: ElementSourceRect | null = null;
    if (rectValue && typeof rectValue === 'object') {
      const rawRect = rectValue as Record<string, unknown>;
      const numeric = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight'];
      if (numeric.every((key) => typeof rawRect[key] === 'number' && Number.isFinite(rawRect[key]))) {
        rect = {
          x: rawRect['x'] as number,
          y: rawRect['y'] as number,
          width: rawRect['width'] as number,
          height: rawRect['height'] as number,
          viewportWidth: rawRect['viewportWidth'] as number,
          viewportHeight: rawRect['viewportHeight'] as number
        };
      }
    }
    const stack = Array.isArray(value['stack'])
      ? value['stack'].map(frame).filter((entry): entry is NonNullable<ReturnType<typeof frame>> => entry !== null).slice(0, 16)
      : [];
    return {
      kind,
      ...(typeof value['tagName'] === 'string' ? { tagName: value['tagName'].slice(0, 80) } : {}),
      componentName: typeof value['componentName'] === 'string'
        ? value['componentName'].slice(0, 160)
        : null,
      source: frame(value['source']),
      stack,
      rect,
      label: typeof value['label'] === 'string' ? value['label'].slice(0, 320) : null,
      pageUrl: typeof value['pageUrl'] === 'string' ? value['pageUrl'].slice(0, 8192) : activeUrl
    };
  }

  // Electron's setZoomLevel uses `factor = 1.2^level`. We track factors
  // directly (for the indicator + Chrome-like steps) and convert on the way
  // out to setZoomLevel.
  function factorToLevel(factor: number): number {
    return Math.log(factor) / Math.log(1.2);
  }

  function applyPageZoom(tabId: string, factor: number): void {
    browserStore.setPageZoom(tabId, factor);
    const el = webviewsById[tabId];
    if (!el || !domReadyById[tabId]) return;
    try {
      el.setZoomLevel(factorToLevel(factor));
    } catch {
      // Webview not ready or destroyed — value persists in our map and will
      // be re-applied at the next dom-ready sync.
    }
  }

  function applyCanvasZoom(tabId: string, factor: number): void {
    browserStore.setCanvasZoom(tabId, factor);
  }

  function resetActiveZoom(): void {
    const tabId = activeId;
    if (!tabId) return;
    if (device) applyCanvasZoom(tabId, 1);
    else applyPageZoom(tabId, 1);
  }

  // BrowserStore owns the residency invariant: active is always live and the
  // most-recent background tabs fill the configured remaining slots. Manual
  // pauses and automatic suspension both unmount the Chromium webview.
  let residentTabs = $derived(
    browserStore.residentTabs(settings.current.browser.maxResidentTabs)
  );
  let residentTabIds = $derived(new Set(residentTabs.map((tab) => tab.id)));

  // Make sure we have at least one tab so the URL bar has something to drive.
  browserStore.ensureSomeTab();

  $effect(() => {
    const scopeKey = browserStore.activeWorktreeKey;
    untrack(() => elementSourceInspector.setActiveScope(scopeKey));
    const surface = browserSurfaceEl;
    if (!surface) return;
    const updateBounds = () => {
      const rect = surface.getBoundingClientRect();
      untrack(() => {
        elementSourceInspector.setPanelBounds({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom
        });
      });
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(surface);
    window.addEventListener('resize', updateBounds);
    window.addEventListener('scroll', updateBounds, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
      window.removeEventListener('scroll', updateBounds, true);
    };
  });

  $effect(() => {
    const scopeKey = browserStore.activeWorktreeKey;
    const enabled = inspectorSettingEnabled;
    for (const tab of browserStore.tabs) {
      const context = inspectorContext(tab.id, tab.id === activeId ? activeUrl : undefined);
      if (context) elementSourceInspector.registerContext(context);
      if (!enabled && elementSourceInspector.isModeActive(scopeKey, tab.id)) {
        elementSourceInspector.setMode(scopeKey, tab.id, false);
        sendInspectorMode(tab.id, false);
      }
    }
  });

  function getActiveInitialUrl(): string {
    const t = browserStore.activeTab;
    return t ? t.history[t.historyIndex] ?? 'about:blank' : 'about:blank';
  }

  // Chrome-like display: hide the http(s):// prefix when the URL bar isn't
  // focused. The full URL stays in `lastSyncedUrl` so we can restore it on
  // focus and submit it correctly on Enter.
  function stripProtocol(url: string): string {
    return url.replace(/^https?:\/\//i, '');
  }

  const initialActiveUrl = getActiveInitialUrl();
  let urlInput = $state(stripProtocol(initialActiveUrl));
  let urlInputEl = $state<HTMLInputElement | null>(null);
  let urlInputFocused = $state(false);

  // Tracks the URL that the bar most recently auto-synced to. When the user
  // types into the bar, urlInput diverges from this value — that's our signal
  // that the bar is "dirty" and shouldn't be clobbered by auto-syncing.
  // Resets explicitly on submit, escape, and tab switch.
  let lastSyncedUrl = $state(initialActiveUrl);
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
    // The autofill rect refers to the prior tab's webview — dropping the
    // popover avoids it floating against an unrelated page.
    fillPrompt = null;
    savePrompt = null;
  });

  // Drive the active webview to whatever the store currently points at. The
  // guard prevents an in-page navigation that we just persisted (via
  // did-navigate) from being re-loaded into the same page. On tab switch the
  // target matches lastLoadedById[newId] so no reload happens — that's the
  // whole point of the per-tab webview architecture.
  $effect(() => {
    const tabId = activeId;
    if (!tabId) return;
    const target = activeUrl;
    const el = webviewsById[tabId];
    const ready = !!domReadyById[tabId];
    if (!el || !ready) return;
    if (target === lastLoadedById[tabId]) return;
    lastLoadedById = { ...lastLoadedById, [tabId]: target };
    el.loadURL(target).catch(() => {
      // Some URLs (about:blank, blocked schemes) reject — ignore; the
      // webview's error page will still render.
    });
  });

  // Captured src= for each tab's <webview>. Storing this in a Map keeps the
  // attribute non-reactive after first mount; otherwise `tab.history`
  // changing (from in-page navigation) would push a new src into the DOM and
  // Chromium would treat it as a reload. Navigations after mount go through
  // `el.loadURL()` via the reactive effect below, not through `src=`.
  const initialUrlByTabId = new Map<string, string>();

  function getOrCaptureInitialUrl(tabId: string, fallback: string): string {
    const cached = initialUrlByTabId.get(tabId);
    if (cached !== undefined) return cached;
    initialUrlByTabId.set(tabId, fallback);
    return fallback;
  }

  // Attachment factory: registers listeners on a freshly mounted <webview>
  // and returns a cleanup that removes them when the element unmounts. The
  // factory is cached per-tab so Svelte sees a stable function reference
  // across re-renders (otherwise it would tear down and re-add listeners on
  // every reactive update).
  type AttachFn = (node: Element) => () => void;
  const attachmentsByTabId = new Map<string, AttachFn>();
  const attachmentGenerationByTabId = new Map<string, number>();
  let attachmentGeneration = 0;

  function attachWebview(tabId: string, initialUrl: string): AttachFn {
    const cached = attachmentsByTabId.get(tabId);
    if (cached) return cached;
    const fn: AttachFn = (node) => {
      const wv = node as unknown as ElectronWebview;
      const worktreeKey = browserStore.activeWorktreeKey;
      const generation = ++attachmentGeneration;
      attachmentGenerationByTabId.set(tabId, generation);
      const isCurrentAttachment = () =>
        browserStore.activeWorktreeKey === worktreeKey
        && attachmentGenerationByTabId.get(tabId) === generation
        && webviewsById[tabId] === wv;
      webviewsById = setTabRecordValue(() => webviewsById, tabId, wv);
      domReadyById = setTabRecordValue(() => domReadyById, tabId, false);
      isLoadingById = setTabRecordValue(() => isLoadingById, tabId, false);
      lastLoadedById = setTabRecordValue(() => lastLoadedById, tabId, initialUrl);
      failureById = setTabRecordValue(() => failureById, tabId, null);
      lastAppliedDeviceKeyById = deleteTabRecordValue(
        () => lastAppliedDeviceKeyById,
        tabId
      );
      lastAppliedUaById = deleteTabRecordValue(() => lastAppliedUaById, tabId);

      const onDomReady = () => {
        if (!isCurrentAttachment()) return;
        domReadyById = { ...domReadyById, [tabId]: true };
        const context = inspectorContext(tabId);
        if (context) elementSourceInspector.registerContext(context);
        sendInspectorMode(
          tabId,
          inspectorSettingEnabled
            && elementSourceInspector.isModeActive(worktreeKey, tabId)
        );
        // Re-apply any previously-set page zoom: a resumed tab has a fresh
        // webContents whose zoom level resets to 0 (= 100%), so without this
        // the indicator and the actual page would silently disagree.
        const factor =
          browserStore.tabs.find((tab) => tab.id === tabId)?.pageZoom ?? 1;
        try {
          wv.setZoomLevel(factorToLevel(factor));
        } catch {
          // Webview destroyed between dom-ready firing and us applying —
          // the next attach will re-try on the new webContents.
        }
        void applyEmulationFor(tabId);
      };
      const onNavigate = (e: Event) => {
        if (!isCurrentAttachment()) return;
        const url = (e as Event & { url?: string }).url;
        if (!url) return;
        // Cross-page navigations invalidate the fill prompt (it referenced
        // the previous page's password field). Only the active tab owns the
        // visible prompt, so don't clear it for background-tab navigations.
        if (tabId === browserStore.activeTabId) {
          fillPrompt = null;
        }
        if (url === lastLoadedById[tabId]) return;
        lastLoadedById = { ...lastLoadedById, [tabId]: url };
        if (elementSourceInspector.isModeActive(worktreeKey, tabId)) {
          elementSourceInspector.receive(worktreeKey, tabId, {
            kind: 'leave',
            pageUrl: url
          }, null);
        }
        browserStore.navigate(tabId, url);
      };
      const onTitle = (e: Event) => {
        if (!isCurrentAttachment()) return;
        const title = (e as Event & { title?: string }).title;
        if (!title) return;
        browserStore.setTitle(tabId, title);
      };
      const onLoadStart = () => {
        if (!isCurrentAttachment()) return;
        isLoadingById = { ...isLoadingById, [tabId]: true };
        failureById = { ...failureById, [tabId]: null };
      };
      const onLoadStop = () => {
        if (!isCurrentAttachment()) return;
        isLoadingById = { ...isLoadingById, [tabId]: false };
      };
      const onFail = (e: Event) => {
        if (!isCurrentAttachment()) return;
        const failure = browserFailureFromFailedLoad(e as Event & {
          errorCode: number;
          errorDescription: string;
          validatedURL: string;
          isMainFrame: boolean;
        });
        if (!failure) return;
        isLoadingById = { ...isLoadingById, [tabId]: false };
        failureById = { ...failureById, [tabId]: failure };
      };
      const onFrameNavigate = (e: Event) => {
        if (!isCurrentAttachment()) return;
        const failure = browserFailureFromHttpResponse(e as Event & {
          url: string;
          httpResponseCode: number;
          httpStatusText: string;
          isMainFrame: boolean;
        });
        if (!failure) return;
        failureById = { ...failureById, [tabId]: failure };
      };
      // ipc-message fires when the webview preload calls
      // ipcRenderer.sendToHost(). We only act on messages from the active
      // tab — a backgrounded page triggering a password-focus shouldn't
      // surface a popover the user can't see the source of.
      const onIpcMessage = (event: Event) => {
        if (!isCurrentAttachment()) return;
        if (tabId !== browserStore.activeTabId) return;
        const e = event as Event & { channel?: string; args?: unknown[] };
        if (e.channel === 'soloe:webview-element-source-exit') {
          setInspectorMode(tabId, false);
          return;
        }
        if (e.channel === 'soloe:webview-element-source') {
          if (!inspectorSettingEnabled || !elementSourceInspector.isModeActive(worktreeKey, tabId)) return;
          const payload = sanitizeInspectorPayload(e.args?.[0]);
          if (!payload) {
            console.warn('[element-source] ignored malformed webview metadata', { tabId });
            return;
          }
          const context = inspectorContext(tabId, payload.pageUrl ?? activeUrl);
          if (!context) return;
          elementSourceInspector.registerContext(context);
          const guestRect = payload.rect;
          let targetRect = null;
          if (guestRect) {
            const viewRect = wv.getBoundingClientRect();
            targetRect = mapGuestRectToHost(guestRect, {
              left: viewRect.left,
              top: viewRect.top,
              width: viewRect.width,
              height: viewRect.height
            });
          }
          elementSourceInspector.receive(worktreeKey, tabId, payload, targetRect);
          return;
        }
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
        if (e.channel === 'soloe:webview-pointerdown') {
          deviceMenuOpen = false;
          autofillOpen = false;
          fillPrompt = null;
          savePrompt = null;
          return;
        }
        if (e.channel === 'soloe:webview-password-focus') {
          const payload = e.args?.[0] as
            | { origin?: string; rect?: FieldRect | null }
            | undefined;
          void handlePasswordFocus(payload?.origin ?? '', payload?.rect ?? null);
          return;
        }
        if (e.channel === 'soloe:webview-password-rect') {
          // Scroll / layout updates: only nudge an already-visible popover —
          // we don't want to re-summon one the user explicitly dismissed.
          if (!fillPrompt) return;
          const payload = e.args?.[0] as
            | { origin?: string; rect?: FieldRect | null }
            | undefined;
          if (!payload || payload.origin !== fillPrompt.origin) return;
          const rect = payload.rect ?? null;
          fillPrompt = { ...fillPrompt, rect, anchor: computeFillAnchor(rect) };
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

      wv.addEventListener('dom-ready', onDomReady);
      wv.addEventListener('did-navigate', onNavigate);
      wv.addEventListener('did-navigate-in-page', onNavigate);
      wv.addEventListener('page-title-updated', onTitle);
      wv.addEventListener('did-start-loading', onLoadStart);
      wv.addEventListener('did-stop-loading', onLoadStop);
      wv.addEventListener('did-fail-load', onFail);
      wv.addEventListener('did-frame-navigate', onFrameNavigate);
      wv.addEventListener('ipc-message', onIpcMessage);

      return () => {
        wv.removeEventListener('dom-ready', onDomReady);
        wv.removeEventListener('did-navigate', onNavigate);
        wv.removeEventListener('did-navigate-in-page', onNavigate);
        wv.removeEventListener('page-title-updated', onTitle);
        wv.removeEventListener('did-start-loading', onLoadStart);
        wv.removeEventListener('did-stop-loading', onLoadStop);
        wv.removeEventListener('did-fail-load', onFail);
        wv.removeEventListener('did-frame-navigate', onFrameNavigate);
        wv.removeEventListener('ipc-message', onIpcMessage);
        // A replacement attachment for the same logical tab may already own
        // these records. Old cleanup must not erase the new generation.
        if (attachmentGenerationByTabId.get(tabId) !== generation) return;
        elementSourceInspector.removeContext(worktreeKey, tabId);
        attachmentGenerationByTabId.delete(tabId);
        webviewsById = deleteTabRecordValue(() => webviewsById, tabId);
        domReadyById = deleteTabRecordValue(() => domReadyById, tabId);
        isLoadingById = deleteTabRecordValue(() => isLoadingById, tabId);
        lastLoadedById = deleteTabRecordValue(() => lastLoadedById, tabId);
        failureById = deleteTabRecordValue(() => failureById, tabId);
        lastAppliedDeviceKeyById = deleteTabRecordValue(
          () => lastAppliedDeviceKeyById,
          tabId
        );
        lastAppliedUaById = deleteTabRecordValue(() => lastAppliedUaById, tabId);
        attachmentsByTabId.delete(tabId);
        // Drop the captured src so a resumed tab loads its current URL
        // rather than the URL it was on when first opened.
        initialUrlByTabId.delete(tabId);
      };
    };
    attachmentsByTabId.set(tabId, fn);
    return fn;
  }

  async function commitNavigation(rawUrl: string): Promise<void> {
    const tab = browserStore.activeTab;
    if (!tab || navigationPending) return;
    navigationPending = true;
    try {
      const resolved = await resolveDeviceBrowserUrl(rawUrl, targetDevice);
      browserStore.setTargetDevice(tab.id, resolved.target);
      browserStore.navigate(tab.id, resolved.url);
      urlInput = resolved.url;
      lastSyncedUrl = resolved.url;
      suggestionIndex = -1;
      suppressDropdown = true;
      urlInputEl?.blur();
    } catch (error) {
      reportError(error, 'Could not open Device port');
    } finally {
      navigationPending = false;
    }
  }

  function submitUrl(event: SubmitEvent) {
    event.preventDefault();
    if (suggestionIndex >= 0 && suggestionIndex < suggestions.length) {
      void commitNavigation(suggestions[suggestionIndex]!);
      return;
    }
    void commitNavigation(urlInput);
  }

  function tryHttpFallback() {
    const failure = activeFailure;
    if (!failure?.httpFallbackUrl || !activeId) return;
    failureById = { ...failureById, [activeId]: null };
    void commitNavigation(failure.httpFallbackUrl);
  }

  function retryFailedPage() {
    if (!activeId) return;
    failureById = { ...failureById, [activeId]: null };
    reload();
  }

  function dismissFailure() {
    if (!activeId) return;
    failureById = { ...failureById, [activeId]: null };
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
    const el = activeWebview;
    if (!el || !activeDomReady) return;
    el.reload();
  }

  let devToolsOpen = $state(false);
  let devToolsHeight = $state(280);
  let devToolsHost = $state<HTMLDivElement | null>(null);
  // The DevTools panel is rendered by a main-process WebContentsView that
  // floats over `devToolsHost`. <webview> can't be a DevTools container
  // (Chromium disallows guest views — see electron/electron#14095), so the
  // host lives in main and we just send it the placeholder's bounds.
  const devToolsView = new BrowserDevToolsViewController({
    open: async (webContentsId, bounds) => {
      await ipc.browser.openDevTools({ webContentsId, bounds });
    },
    setLayout: async (webContentsId, layout) => {
      await ipc.browser.setDevToolsLayout({ webContentsId, ...layout });
    },
    close: async (webContentsId) => {
      await ipc.browser.closeDevTools({ webContentsId });
    }
  });

  // Closing DevTools on tab switch keeps things simple: the WebContentsView
  // is bound to a specific webContents, and re-targeting it across tabs has
  // ordering pitfalls (bounds vs. webContentsId vs. ready state). The user
  // can reopen on the new tab if they want.
  let lastActiveIdForDevtools: string | null = null;
  $effect(() => {
    const id = activeId;
    if (id === lastActiveIdForDevtools) return;
    lastActiveIdForDevtools = id;
    if (devToolsOpen) closeDevTools();
  });

  // Pane order/fullscreen changes can move the placeholder without changing
  // its size. ResizeObserver owns ordinary size changes; this explicit
  // invalidation covers the position-only layout case.
  $effect(() => {
    const layoutIdentity = [
      rightRail.openTabs.join(','),
      rightRail.fullscreen ? 'fullscreen' : 'windowed',
      rightRail.fullscreenTab ?? 'none'
    ].join(':');
    void layoutIdentity;
    if (devToolsOpen) devToolsView.invalidate();
  });

  async function openDevTools(): Promise<void> {
    const main = activeWebview;
    if (!main || !activeDomReady) return;
    if (devToolsOpen) return;
    let webContentsId: number;
    try {
      webContentsId = main.getWebContentsId();
    } catch {
      return;
    }
    devToolsOpen = true;
    try {
      const opened = await devToolsView.open(webContentsId, () => devToolsHost);
      if (!opened) devToolsOpen = false;
    } catch (err) {
      reportError(err, 'Failed to open DevTools');
      devToolsOpen = false;
    }
  }

  function closeDevTools() {
    if (!devToolsOpen) return;
    devToolsOpen = false;
    void devToolsView.close().catch((err) => reportError(err, 'Failed to close DevTools'));
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
  let finishDevToolsResize: (() => void) | null = null;
  function startDevToolsResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    finishDevToolsResize?.();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    devToolsResizing = true;
    suspendDevToolsView();
    const startY = event.clientY;
    const startHeight = devToolsHeight;
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      // Dragging up (negative dy) grows the panel; clamp to a sane range.
      devToolsHeight = Math.min(Math.max(startHeight - dy, 120), 800);
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      devToolsResizing = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      handle.removeEventListener('lostpointercapture', finish);
      try {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      } catch {
        // The handle may already be detached during rail teardown.
      }
      if (finishDevToolsResize === finish) finishDevToolsResize = null;
      resumeDevToolsView();
    };
    finishDevToolsResize = finish;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    handle.addEventListener('lostpointercapture', finish);
  }

  // While suspended, the native Browser DevTools View is hidden so it cannot
  // consume pointer events during a drag. Resume atomically restores bounds
  // and visibility after one forced measurement.
  function suspendDevToolsView() {
    devToolsView.suspend();
  }

  function resumeDevToolsView() {
    devToolsView.resume();
  }

  let autofillOpen = $state(false);
  let deviceMenuOpen = $state(false);

  function deviceKey(d: BrowserTabDevice | undefined, canvasZoom = 1): string | null {
    if (!d) return null;
    const w = d.rotated ? d.height : d.width;
    const h = d.rotated ? d.width : d.height;
    return `${d.presetId}:${w}x${h}@${d.dpr}:${d.mobile ? 'm' : 'd'}:${d.ua}:${canvasZoom}`;
  }

  // Apply the per-tab device emulation. Called from the dom-ready handler
  // for that tab and from an effect that watches the active tab's device and
  // canvas zoom.
  // Inactive tabs keep their emulation applied as long as their webContents
  // is alive — that way switching back doesn't trigger a UA-induced reload.
  async function applyEmulationFor(tabId: string): Promise<void> {
    const el = webviewsById[tabId];
    if (!el || !domReadyById[tabId]) return;
    const generation = attachmentGenerationByTabId.get(tabId);
    if (generation === undefined) return;
    const isCurrentAttachment = () =>
      attachmentGenerationByTabId.get(tabId) === generation
      && webviewsById[tabId] === el;
    const tab = browserStore.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const tabDevice = tab.device;
    let webContentsId: number;
    try {
      webContentsId = el.getWebContentsId();
    } catch {
      return;
    }
    if (!tabDevice) {
      if ((lastAppliedDeviceKeyById[tabId] ?? null) === null) return;
      lastAppliedDeviceKeyById = { ...lastAppliedDeviceKeyById, [tabId]: null };
      try {
        await ipc.browser.disableDeviceEmulation({ webContentsId });
        if (!isCurrentAttachment()) return;
        if ((lastAppliedUaById[tabId] ?? null) !== null) {
          await ipc.browser.setUserAgent({ webContentsId, userAgent: null });
          if (!isCurrentAttachment()) return;
          const previousUa = lastAppliedUaById[tabId] ?? null;
          lastAppliedUaById = { ...lastAppliedUaById, [tabId]: null };
          if (previousUa) el.reload();
        }
      } catch (err) {
        if (isCurrentAttachment()) reportError(err, 'Failed to disable device emulation');
      }
      return;
    }
    const canvasZoom = tab.canvasZoom ?? 1;
    const key = deviceKey(tabDevice, canvasZoom);
    if (key === (lastAppliedDeviceKeyById[tabId] ?? null)) return;
    lastAppliedDeviceKeyById = { ...lastAppliedDeviceKeyById, [tabId]: key };
    const w = tabDevice.rotated ? tabDevice.height : tabDevice.width;
    const h = tabDevice.rotated ? tabDevice.width : tabDevice.height;
    try {
      await ipc.browser.enableDeviceEmulation({
        webContentsId,
        emulation: {
          width: w,
          height: h,
          deviceScaleFactor: tabDevice.dpr,
          mobile: tabDevice.mobile,
          scale: canvasZoom,
          ...(tabDevice.ua ? { userAgent: tabDevice.ua } : {})
        }
      });
      if (!isCurrentAttachment()) return;
      const nextUa = tabDevice.ua || null;
      const prevUa = lastAppliedUaById[tabId] ?? null;
      if (nextUa !== prevUa) {
        lastAppliedUaById = { ...lastAppliedUaById, [tabId]: nextUa };
        if (nextUa || prevUa !== null) el.reload();
      }
    } catch (err) {
      if (isCurrentAttachment()) reportError(err, 'Failed to enable device emulation');
    }
  }

  // Re-apply emulation when the active tab's device or canvas zoom changes.
  // Switching tabs doesn't trigger this (each tab's emulation was set at its
  // own dom-ready); only mutating the active tab's emulation does.
  $effect(() => {
    const tab = activeTab;
    if (!tab) return;
    void tab.device;
    void deviceWidth;
    void deviceHeight;
    void activeCanvasZoom;
    void applyEmulationFor(tab.id);
  });

  // Native Chromium zoom is shared by same-origin webContents in one
  // partition. Restore the selected logical tab's intended factor on every
  // switch, including 100%, so a sibling tab cannot leak its zoom into it.
  $effect(() => {
    const tab = activeTab;
    if (!tab || !activeDomReady) return;
    const el = webviewsById[tab.id];
    if (!el) return;
    const factor = tab.pageZoom ?? 1;
    try {
      el.setZoomLevel(factorToLevel(factor));
    } catch {
      // A concurrent pause or scope switch can destroy the guest.
    }
  });

  // Canvas zoom is a CSS transform, which doesn't fire ResizeObserver — but
  // it does change the webview's visual rect, so an open autofill popover
  // has to follow.
  $effect(() => {
    void activeCanvasZoom;
    void activeId;
    refreshFillAnchor();
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

  // Auto-resume paused tabs whose deadline has elapsed. A single timeout is
  // scheduled for the nearest deadline; with no paused tabs there is no timer
  // and therefore no periodic background wake-up.
  let autoResumeTimer = 0;
  function checkAutoResume() {
    const minutes = settings.current.browser.pauseAutoResumeMinutes;
    if (minutes <= 0) return;
    const threshold = Date.now() - minutes * 60_000;
    for (const tab of browserStore.tabs) {
      if (tab.pausedAt !== undefined && tab.pausedAt <= threshold) {
        // Expiry removes the explicit pause but does not allocate a hidden
        // renderer. The tab becomes resident when the user selects it.
        browserStore.resumeTab(tab.id, false);
      }
    }
  }

  $effect(() => {
    const minutes = settings.current.browser.pauseAutoResumeMinutes;
    const pausedAt = browserStore.tabs
      .map((tab) => tab.pausedAt)
      .filter((value): value is number => value !== undefined);
    if (minutes <= 0 || pausedAt.length === 0) return;
    const nextDeadline = Math.min(...pausedAt) + minutes * 60_000;
    const delay = Math.min(2_147_483_647, Math.max(0, nextDeadline - Date.now()));
    const handle = window.setTimeout(() => {
      if (autoResumeTimer === handle) autoResumeTimer = 0;
      checkAutoResume();
    }, delay);
    autoResumeTimer = handle;
    return () => {
      window.clearTimeout(handle);
      if (autoResumeTimer === handle) autoResumeTimer = 0;
    };
  });

  // Custom event from App.svelte: Ctrl+/-/0 while the browser tab is active.
  onMount(() => {
    const onZoom = (event: Event) => {
      const direction = (event as CustomEvent<{ direction: 'in' | 'out' | 'reset' }>).detail
        ?.direction;
      if (!direction) return;
      const tabId = activeId;
      if (!tabId) return;
      const tab = browserStore.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      // In responsive mode the keystrokes drive the canvas scale (so the
      // user can see the whole emulated device), not the page's own zoom.
      if (tab.device) {
        const current = tab.canvasZoom ?? 1;
        const next = nextContentZoomFactor(current, direction);
        if (next === current) return;
        applyCanvasZoom(tabId, next);
        return;
      }
      const current = tab.pageZoom ?? 1;
      const next = nextContentZoomFactor(current, direction);
      if (next === current) return;
      applyPageZoom(tabId, next);
    };
    const onToggleDevTools = () => toggleDevTools();
    const onToggleInspector = () => toggleInspectorMode();
    const onRestoreTab = () => restoreClosedTab();
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
    const onBrowserOverlayPointerDown = (event: PointerEvent) => {
      if (!fillPrompt && !savePrompt) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (fillPromptEl?.contains(target) || savePromptEl?.contains(target)) return;
      fillPrompt = null;
      savePrompt = null;
    };
    // Whenever the host layout shifts the popover's anchor goes stale —
    // capture-phase scroll covers nested containers (responsive-mode
    // wrapper, devtools resize), resize covers window changes, and the
    // rail-resize-end fires when the user drops the splitter.
    const onLayoutShift = () => refreshFillAnchor();
    window.addEventListener('soloe:browser-zoom', onZoom);
    window.addEventListener('soloe:browser-toggle-devtools', onToggleDevTools);
    window.addEventListener('soloe:browser-toggle-element-source-inspector', onToggleInspector);
    window.addEventListener('soloe:browser-restore-tab', onRestoreTab);
    window.addEventListener('soloe:rail-resize-start', onResizeStart);
    window.addEventListener('soloe:rail-resize-end', onResizeEnd);
    window.addEventListener('soloe:rail-resize-end', onLayoutShift);
    window.addEventListener('soloe:focus-pane', onFocusPane);
    window.addEventListener('keydown', onAutofillEscape);
    window.addEventListener('pointerdown', onBrowserOverlayPointerDown, true);
    window.addEventListener('scroll', onLayoutShift, true);
    window.addEventListener('resize', onLayoutShift);

    return () => {
      window.removeEventListener('soloe:browser-zoom', onZoom);
      window.removeEventListener('soloe:browser-toggle-devtools', onToggleDevTools);
      window.removeEventListener('soloe:browser-toggle-element-source-inspector', onToggleInspector);
      window.removeEventListener('soloe:browser-restore-tab', onRestoreTab);
      window.removeEventListener('soloe:rail-resize-start', onResizeStart);
      window.removeEventListener('soloe:rail-resize-end', onResizeEnd);
      window.removeEventListener('soloe:rail-resize-end', onLayoutShift);
      window.removeEventListener('soloe:focus-pane', onFocusPane);
      window.removeEventListener('keydown', onAutofillEscape);
      window.removeEventListener('pointerdown', onBrowserOverlayPointerDown, true);
      window.removeEventListener('scroll', onLayoutShift, true);
      window.removeEventListener('resize', onLayoutShift);
      browserStore.releaseResidents();
      finishDevToolsResize?.();
      // Invalidate pending opens and retire the native view immediately. The
      // main-side target-destroyed listener remains a final safety net.
      closeDevTools();
      void devToolsView.dispose().catch(() => {});
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
    const el = activeWebview;
    if (!el || !activeDomReady) {
      throw new Error('Browser is not ready');
    }
    const script = `(function(u, p) {
      const passwordSelector = 'input[type="password"]:not([disabled]):not([readonly])';
      const active = document.activeElement;
      function findPasswordField() {
        if (active instanceof HTMLInputElement && active.type === 'password' && !active.disabled && !active.readOnly) {
          return active;
        }
        if (active instanceof HTMLInputElement) {
          const activeScope = active.closest('form');
          if (activeScope) {
            const scopedPassword = activeScope.querySelector(passwordSelector);
            if (scopedPassword) return scopedPassword;
          }
        }
        return document.querySelector(passwordSelector);
      }
      const pwd = findPasswordField();
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
  interface FieldRect {
    x: number;
    y: number;
    width: number;
    height: number;
    viewportWidth: number;
    viewportHeight: number;
  }
  interface FillPrompt {
    origin: string;
    matches: ScopedVaultEntry[];
    // Last rect reported by the preload (in page CSS pixels). Kept so we
    // can re-derive the host-side anchor when the layout shifts without
    // having to round-trip through the webview again.
    rect: FieldRect | null;
    // Computed viewport position for the popover; null falls back to the
    // top-right corner of the webview area.
    anchor: { left: number; top: number } | null;
  }
  let fillPrompt = $state<FillPrompt | null>(null);
  let fillPromptEl = $state<HTMLDivElement | null>(null);
  let suppressFillPromptOrigin = '';
  let suppressFillPromptUntil = 0;

  const FILL_POPOVER_WIDTH = 288; // tailwind w-72
  const FILL_PROMPT_SUPPRESS_MS = 1200;

  function computeFillAnchor(rect: FieldRect | null): { left: number; top: number } | null {
    if (!rect) return null;
    const wv = activeWebview;
    if (!wv) return null;
    const wvRect = wv.getBoundingClientRect();
    if (wvRect.width <= 0 || wvRect.height <= 0) return null;
    // The webview's outer size already reflects canvas zoom (transform:
    // scale on the frame). Ratio of host-side size to page-side viewport
    // gives us the conversion factor; with no canvas scaling it's 1.
    const scaleX = rect.viewportWidth > 0 ? wvRect.width / rect.viewportWidth : 1;
    const scaleY = rect.viewportHeight > 0 ? wvRect.height / rect.viewportHeight : 1;
    const left = wvRect.left + rect.x * scaleX;
    // 6px gap below the field — matches Chrome's autofill spacing.
    const top = wvRect.top + (rect.y + rect.height) * scaleY + 6;
    // Keep the popover inside the window horizontally. If the field is
    // near the right edge, shift the popover left so it stays visible.
    const clampedLeft = Math.min(Math.max(8, left), window.innerWidth - FILL_POPOVER_WIDTH - 8);
    return { left: clampedLeft, top };
  }

  function refreshFillAnchor(): void {
    if (!fillPrompt) return;
    const anchor = computeFillAnchor(fillPrompt.rect);
    if (
      (anchor === null && fillPrompt.anchor === null) ||
      (anchor !== null &&
        fillPrompt.anchor !== null &&
        anchor.left === fillPrompt.anchor.left &&
        anchor.top === fillPrompt.anchor.top)
    ) {
      return;
    }
    fillPrompt = { ...fillPrompt, anchor };
  }

  // Inline save prompt state: shown after a form submit when we detect
  // credentials that aren't already saved for that origin+username. The
  // user can save (writes to the vault) or dismiss.
  interface SavePrompt {
    origin: string;
    username: string;
    password: string;
  }
  let savePrompt = $state<SavePrompt | null>(null);
  let savePromptEl = $state<HTMLDivElement | null>(null);
  let savePromptBusy = $state(false);

  async function handlePasswordFocus(
    origin: string,
    rect: FieldRect | null
  ): Promise<void> {
    if (!origin) return;
    if (origin === suppressFillPromptOrigin && Date.now() < suppressFillPromptUntil) {
      fillPrompt = null;
      return;
    }
    // Updating an open popover's rect (scroll/layout shift) shouldn't have
    // to wait on the vault — recompute the anchor immediately and bail
    // before the async load if we already have the matches list.
    if (fillPrompt && fillPrompt.origin === origin) {
      fillPrompt = { ...fillPrompt, rect, anchor: computeFillAnchor(rect) };
      return;
    }
    try {
      await vaultStore.ensureProjectLoaded();
    } catch {
      // Vault load failure is non-fatal — just skip the prompt.
      return;
    }
    const matches = vaultStore.projectMatchesForOrigin(origin);
    if (matches.length === 0) {
      fillPrompt = null;
      return;
    }
    fillPrompt = { origin, matches, rect, anchor: computeFillAnchor(rect) };
  }

  async function fillFromPrompt(item: ScopedVaultEntry): Promise<void> {
    const promptOrigin = fillPrompt?.origin ?? '';
    const suppressPrompt = () => {
      if (!promptOrigin) return;
      suppressFillPromptOrigin = promptOrigin;
      suppressFillPromptUntil = Date.now() + FILL_PROMPT_SUPPRESS_MS;
    };
    suppressPrompt();
    fillPrompt = null;
    try {
      const secret = await vaultStore.getSecret(item.entry.id, item.vaultCwd);
      suppressPrompt();
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
    fillPrompt = null;
    try {
      await vaultStore.ensureProjectLoaded();
    } catch {
      return;
    }
    const matches = vaultStore.projectMatchesForOrigin(origin);
    // Already saved for this exact (origin, username) — don't nag the user
    // again. We don't compare passwords here because matchesForOrigin
    // returns metadata, not secrets; a stale password is the user's
    // problem to update manually for now.
    const alreadyKnown = matches.some(
      ({ entry }) => entry.username.toLowerCase() === username.toLowerCase()
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
      await vaultStore.save(
        {
          origin: savePrompt.origin,
          username: savePrompt.username,
          password: savePrompt.password
        },
        vaultStore.saveTarget('project')
      );
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

  function duplicateTab(id: string) {
    browserStore.duplicateTab(id);
  }

  function restoreClosedTab() {
    browserStore.restoreClosedTab();
  }

  let draggedTabId = $state<string | null>(null);
  let tabDropTarget = $state<{ id: string; position: 'before' | 'after' } | null>(null);

  function onTabDragStart(event: DragEvent, id: string) {
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
    draggedTabId = id;
    tabDropTarget = null;
  }

  function onTabDragOver(event: DragEvent, targetId: string) {
    if (!draggedTabId || draggedTabId === targetId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const position = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    tabDropTarget = { id: targetId, position };
  }

  function onTabDrop(event: DragEvent, targetId: string) {
    if (!draggedTabId || draggedTabId === targetId) return;
    event.preventDefault();
    const position = tabDropTarget?.id === targetId ? tabDropTarget.position : 'after';
    browserStore.reorderTab(draggedTabId, targetId, position);
    onTabDragEnd();
  }

  function onTabDragEnd() {
    draggedTabId = null;
    tabDropTarget = null;
  }

  function selectTab(id: string) {
    // Selection atomically resumes a manually-paused tab and promotes an
    // automatically suspended tab into the resident set.
    browserStore.selectTab(id);
  }

  function closeTab(id: string, event: MouseEvent) {
    event.stopPropagation();
    browserStore.closeTab(id);
  }

  function pauseTabAction(id: string) {
    // Never pause the active tab — it would leave the browser pane blank.
    if (id === browserStore.activeTabId) return;
    browserStore.pauseTab(id);
  }

  function resumeTabAction(id: string) {
    browserStore.resumeTab(id);
  }

  function tabLabel(t: {
    title: string;
    history: string[];
    historyIndex: number;
    targetDevice?: BrowserTargetDevice;
  }): string {
    const title = t.title?.trim();
    const url = t.history[t.historyIndex] ?? '';
    let label = title && title.length > 0 && title !== 'about:blank' ? title : '';
    try {
      const parsed = new URL(url);
      label ||= parsed.host || parsed.pathname || url;
    } catch {
      label ||= url || 'New tab';
    }
    if (!t.targetDevice || !multiDeviceActive) return label;
    let port = '';
    try {
      const parsed = new URL(url);
      port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
    } catch {
      // Keep the Device identity even while the tab is blank or editing.
    }
    return `${t.targetDevice.name} · ${port ? `:${port}` : label}`;
  }

  function selectTargetDevice(target: BrowserTargetDevice): void {
    const tab = browserStore.activeTab;
    if (!tab) return;
    browserStore.setTargetDevice(tab.id, target);
    targetMenuOpen = false;
  }

  function tabInitialUrl(t: { history: string[]; historyIndex: number }): string {
    return t.history[t.historyIndex] ?? 'about:blank';
  }

  // Type-ahead dropdown sourced from all per-worktree tab histories.
  // Deduplicated, ranked by host-match-first then substring match.
  let suggestionIndex = $state(-1);
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
        void commitNavigation(suggestions[suggestionIndex]!);
      } else {
        void commitNavigation(urlInput);
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
    void commitNavigation(url);
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

<div
  bind:this={browserSurfaceEl}
  data-browser-surface
  class="mobile-browser-surface flex h-full min-w-0 flex-col bg-background"
>
  <div class="mobile-browser-tabs flex h-8 min-h-8 items-center gap-0.5 overflow-x-auto border-b border-border bg-sidebar px-1">
    {#each browserStore.tabs as tab (tab.id)}
      {@const isActive = tab.id === activeId}
      {@const isPausedTab = tab.pausedAt !== undefined}
      {@const isResidentTab = residentTabIds.has(tab.id)}
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <button
              {...props}
              type="button"
              class={`group relative flex h-6 max-w-[160px] min-w-0 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors ${
                isActive
                  ? 'bg-background text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
              } ${isPausedTab || !isResidentTab ? 'opacity-60' : ''}`}
              onclick={() => selectTab(tab.id)}
              draggable={true}
              aria-grabbed={draggedTabId === tab.id}
              ondragstart={(event) => onTabDragStart(event, tab.id)}
              ondragover={(event) => onTabDragOver(event, tab.id)}
              ondrop={(event) => onTabDrop(event, tab.id)}
              ondragend={onTabDragEnd}
              title={`${tab.history[tab.historyIndex] ?? ''}${
                isPausedTab
                  ? ' — paused'
                  : !isResidentTab
                    ? ' — suspended to save memory'
                    : ''
              }`}
            >
              {#if tabDropTarget?.id === tab.id && draggedTabId !== tab.id}
                <span
                  aria-hidden="true"
                  class={`pointer-events-none absolute inset-y-0 w-0.5 rounded-full bg-primary ${
                    tabDropTarget.position === 'before' ? 'left-0' : 'right-0'
                  }`}
                ></span>
              {/if}
              {#if isPausedTab || !isResidentTab}
                <PowerOff class="size-3 shrink-0" />
              {:else}
                <Globe class="size-3 shrink-0" />
              {/if}
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
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Content class="w-64">
          <ContextMenu.Item onclick={() => duplicateTab(tab.id)}>
            <Plus class="mr-2 size-3.5" />
            Duplicate tab
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={!browserStore.canRestoreClosedTab}
            onclick={restoreClosedTab}
          >
            <History class="mr-2 size-3.5" />
            Reopen closed tab
            <ContextMenu.Shortcut>Ctrl/Cmd+Shift+T</ContextMenu.Shortcut>
          </ContextMenu.Item>
          <ContextMenu.Separator />
          {#if isPausedTab}
            <ContextMenu.Item onclick={() => resumeTabAction(tab.id)}>
              <Power class="mr-2 size-3.5" />
              Resume tab
            </ContextMenu.Item>
          {:else}
            <ContextMenu.Item
              disabled={isActive}
              onclick={() => pauseTabAction(tab.id)}
            >
              <PowerOff class="mr-2 size-3.5" />
              Pause tab
            </ContextMenu.Item>
          {/if}
          <ContextMenu.Separator />
          <ContextMenu.Item
            onclick={(e) => closeTab(tab.id, e as unknown as MouseEvent)}
          >
            <X class="mr-2 size-3.5" />
            Close tab
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Root>
    {/each}
    <button
      type="button"
      class="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      aria-label="New tab"
      onclick={addTab}
    >
      <Plus class="size-3.5" />
    </button>
  </div>

  <form
    class="mobile-browser-toolbar no-scrollbar relative flex h-8 min-h-8 min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain border-b border-border bg-sidebar px-1"
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
    {#if multiDeviceActive}
    <Popover.Root bind:open={targetMenuOpen}>
      <Popover.Trigger>
        {#snippet child({ props })}
          <Button
            {...props}
            type="button"
            variant="ghost"
            class="h-7 max-w-48 shrink-0 gap-1 px-1.5 text-[10px]"
            aria-label="Choose navigation Device"
            title={targetDevice ? targetDevice.name : 'Choose navigation Device'}
          >
            <Monitor class="size-3 shrink-0" />
            <span class="min-w-0 truncate">
              {targetDevice ? targetDevice.name : 'Choose Device'}
            </span>
            <ChevronDown class="size-3 shrink-0 opacity-60" />
          </Button>
        {/snippet}
      </Popover.Trigger>
      <Popover.Content
        align="start"
        class="w-80 p-1"
        trapFocus={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        data-browser-pane-popover="target-device"
      >
        <div class="px-2 py-1 text-[10px] font-medium text-muted-foreground">
          Resolve localhost on
        </div>
        {#each targetOptions as option (option.target.deviceId)}
          <button
            type="button"
            class={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent ${
              targetDevice?.deviceId === option.target.deviceId ? 'bg-accent/70' : ''
            } disabled:cursor-not-allowed disabled:opacity-50`}
            disabled={!option.available}
            onclick={() => selectTargetDevice(option.target)}
          >
            <Monitor class="size-3.5 shrink-0" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium">
                {option.target.name}{option.target.local ? ' (this Device)' : ''}
              </span>
              <span class="block truncate font-mono text-[10px] text-muted-foreground">
                {option.target.tailscaleDnsName ?? `Tailscale ${option.state}`}
              </span>
            </span>
          </button>
        {/each}
      </Popover.Content>
    </Popover.Root>
    {/if}
    <Popover.Root open={dropdownOpen}>
      <div class="relative min-w-40 flex-1">
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
          disabled={navigationPending}
          spellcheck={false}
          autocomplete="off"
        />
      </div>
      {#if dropdownOpen && urlInputEl}
        <Popover.Content
          customAnchor={urlInputEl}
          side="bottom"
          align="start"
          sideOffset={4}
          trapFocus={false}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          class="w-[var(--bits-popover-anchor-width)] max-w-[calc(100vw-1rem)] gap-0 overflow-hidden p-0"
        >
          <ul class="max-h-60 overflow-y-auto">
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
        </Popover.Content>
      {/if}
    </Popover.Root>
    {#if zoomPercent !== 100}
      <Button
        type="button"
        variant="ghost"
        class="h-7 shrink-0 px-1.5 font-mono text-[10px] tabular-nums"
        aria-label="Reset zoom"
        title={device
          ? `Canvas zoom ${zoomPercent}% — click to reset`
          : `Page zoom ${zoomPercent}% — click to reset`}
        onclick={resetActiveZoom}
      >
        {zoomPercent}%
      </Button>
    {/if}
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
      <Popover.Content
        align="end"
        class="w-auto p-0"
        trapFocus={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        data-browser-pane-popover="device"
      >
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
      <Popover.Content
        align="end"
        class="w-auto p-0"
        trapFocus={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        data-browser-pane-popover="autofill"
      >
        <BrowserAutofillPopover
          currentUrl={activeUrl}
          onFill={runAutofill}
          onNavigate={(url) => commitNavigation(url)}
          onClose={() => (autofillOpen = false)}
        />
      </Popover.Content>
    </Popover.Root>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class={`size-7 ${inspectorModeActive ? 'bg-primary/15 text-primary' : ''}`}
      aria-label="Inspect components"
      title={inspectorSettingEnabled
        ? `Inspect components (${shortcutLabel(settings.current.shortcuts.elementSourceInspector)})`
        : 'Component inspection disabled in settings'}
      aria-pressed={inspectorModeActive}
      disabled={!inspectorSettingEnabled || !inspectorViewAvailable}
      onclick={toggleInspectorMode}
    >
      <ScanLine class="size-3.5" />
    </Button>
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

  {#if activeFailure?.kind === 'http'}
    <div
      class="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
      role="status"
      aria-live="polite"
    >
      <CircleAlert class="size-3.5 shrink-0" />
      <span class="min-w-0 flex-1 truncate" title={`${activeFailure.title} — ${activeFailure.url}`}>
        <span class="font-medium">{activeFailure.title}</span>
        <span class="text-muted-foreground"> — {activeFailure.url}</span>
      </span>
      <button
        type="button"
        class="cursor-pointer rounded border border-destructive/40 px-1.5 py-0.5 font-medium transition-colors hover:bg-destructive/15 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onclick={retryFailedPage}
      >
        Retry
      </button>
      <button
        type="button"
        class="cursor-pointer rounded opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label="Dismiss"
        onclick={dismissFailure}
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
      One <webview> per resident tab. Inactive residents use display:none so
      their renderer preserves page state; older background tabs and manual
      pauses are absent entirely. Selecting either remounts its current URL.
    -->
    <div class="relative flex min-h-0 flex-1 flex-col">
      {#each residentTabs as tab (tab.id)}
        {@const isActive = tab.id === activeId}
        {@const tabDevice = tab.device}
        {@const tabW = tabDevice ? (tabDevice.rotated ? tabDevice.height : tabDevice.width) : 0}
        {@const tabH = tabDevice ? (tabDevice.rotated ? tabDevice.width : tabDevice.height) : 0}
        {@const initialUrl = getOrCaptureInitialUrl(tab.id, tabInitialUrl(tab))}
        {@const tabCanvasZoom = tab.canvasZoom ?? 1}
        {#if tabDevice}
          <!--
            Responsive mode uses Chromium's native emulation scale so the
            guest is laid out at the requested device viewport without a CSS
            transform resampling the embedded webview.
          -->
          <div
            class="absolute inset-0 flex items-start justify-center overflow-auto bg-muted/40 p-4"
            style={isActive ? undefined : 'display: none;'}
          >
            <div
              class="shrink-0"
              style={`width: ${tabW * tabCanvasZoom}px; height: ${tabH * tabCanvasZoom}px;`}
            >
              <div
                class="h-full w-full overflow-hidden rounded border border-border bg-background shadow-lg"
              >
                <!-- svelte-ignore element_invalid_self_closing_tag -->
                <webview
                  {@attach attachWebview(tab.id, initialUrl)}
                  src={initialUrl}
                  partition="persist:soloe-browser"
                  class="h-full w-full"
                  style="display: flex;"
                ></webview>
              </div>
            </div>
          </div>
        {:else}
          <div
            class="absolute inset-0 flex flex-col"
            style={isActive ? undefined : 'display: none;'}
          >
            <div class="flex min-h-0 flex-1 flex-col">
              <!-- svelte-ignore element_invalid_self_closing_tag -->
              <webview
                {@attach attachWebview(tab.id, initialUrl)}
                src={initialUrl}
                partition="persist:soloe-browser"
                class="min-h-0 flex-1"
                style="display: flex;"
              ></webview>
            </div>
          </div>
        {/if}
      {/each}

      {#if activeFailure?.kind === 'network'}
        <section
          class="absolute inset-0 z-10 flex items-center justify-center overflow-auto bg-background px-5 py-8 text-foreground"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div class="flex w-full max-w-xl flex-col items-start">
            <CircleAlert class="mb-5 size-10 text-muted-foreground" aria-hidden="true" />
            <h2 class="text-lg font-semibold tracking-tight">{activeFailure.title}</h2>
            <p class="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">
              {activeFailure.description}
            </p>
            <div class="mt-4 w-full rounded-md border border-border bg-muted/30 px-3 py-2">
              <div class="truncate font-mono text-xs" title={activeFailure.url}>
                {activeFailure.url}
              </div>
              <div class="mt-1 font-mono text-[10px] text-muted-foreground">
                {activeFailure.code} ({activeFailure.errorCode})
              </div>
            </div>
            <div class="mt-5 flex flex-wrap gap-2">
              <Button type="button" size="sm" class="cursor-pointer" onclick={retryFailedPage}>
                <RotateCw class="size-3.5" />
                Retry
              </Button>
              {#if activeFailure.httpFallbackUrl}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="cursor-pointer"
                  onclick={tryHttpFallback}
                >
                  Try HTTP
                </Button>
              {/if}
            </div>
          </div>
        </section>
      {/if}

      {#if fillPrompt}
        {@const fillAnchor = fillPrompt.anchor}
        <div
          bind:this={fillPromptEl}
          class={fillAnchor
            ? 'fixed z-30 flex w-72 flex-col gap-1 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg'
            : 'absolute top-2 right-2 z-20 flex w-72 flex-col gap-1 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-lg'}
          class:mobile-browser-prompt={true}
          style={fillAnchor ? `left: ${fillAnchor.left}px; top: ${fillAnchor.top}px;` : undefined}
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
          {#each fillPrompt.matches as item (`${item.vaultCwd}:${item.entry.id}`)}
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded border border-border/60 bg-muted/30 px-2 py-1.5 text-left hover:border-border hover:bg-muted/60"
              onclick={() => fillFromPrompt(item)}
            >
              <div class="min-w-0 flex-1">
                <div class="truncate text-xs">{item.entry.username}</div>
                {#if item.entry.label}
                  <div class="truncate text-[10px] text-muted-foreground">{item.entry.label}</div>
                {/if}
              </div>
              <span class="text-[10px] text-muted-foreground">Fill</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if savePrompt}
        <div
          bind:this={savePromptEl}
          class="mobile-browser-prompt absolute top-2 right-2 z-20 flex w-72 flex-col gap-2 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-lg"
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
      mounts while open so the WebContentsView is created lazily, and it
      auto-closes on tab switch since it's bound to one webContents.
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
