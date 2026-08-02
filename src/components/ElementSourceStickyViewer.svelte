<script lang="ts">
  import { onMount } from 'svelte';
  import {
    AlertCircle,
    ChevronLeft,
    ChevronUp,
    ChevronDown,
    ExternalLink,
    Loader2,
    Pin,
    PinOff,
    ScanLine,
    X
  } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Select from '$lib/components/ui/select';
  import {
    createFilesScope,
    filesStore
  } from '../stores/files.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { rightRail } from '../stores/right-rail.svelte';
  import { elementSourceInspector, type ElementSourceViewer, type SourceHistoryEntry } from '../stores/element-source-inspector.svelte';
  import { worktreeScopeKey } from '@shared/worktree-identity.js';
  import type { FileEditorController, SourceReveal } from './files/FileEditor.svelte';

  type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
  type Interaction = {
    viewerId: string;
    kind: 'drag' | 'resize';
    handle?: ResizeHandle;
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    origin: ElementSourceViewer['position'];
    target: HTMLElement;
  };

  type FileEditorSurfaceComponent = typeof import('./files/FileEditorSurface.svelte').default;
  let fileEditorSurfacePromise: Promise<FileEditorSurfaceComponent> | null = null;

  function loadFileEditorSurface(): Promise<FileEditorSurfaceComponent> {
    fileEditorSurfacePromise ??= import('./files/FileEditorSurface.svelte')
      .then((module) => module.default)
      .catch((error: unknown) => {
        fileEditorSurfacePromise = null;
        throw error;
      });
    return fileEditorSurfacePromise;
  }

  let interactions = $state<Record<string, Interaction>>({});
  let suppressNextClick = false;
  const editorControllers = new Map<string, FileEditorController>();
  const revealCache = new Map<string, { key: string; value: SourceReveal }>();
  const loadKeys = new Map<string, string>();
  const sourcePreviewCache = new Map<string, { content: string; loadedPath: string }>();
  let viewers = $derived([
    ...elementSourceInspector.pinned,
    ...(elementSourceInspector.transient ? [elementSourceInspector.transient] : [])
  ].sort((a, b) => a.zIndex - b.zIndex));

  onMount(() => {
    const onPointerMove = (event: PointerEvent) => {
      const current = Object.values(interactions).find((entry) => entry.pointerId === event.pointerId);
      if (!current) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (current.kind === 'drag' && !current.active) {
        if (Math.hypot(dx, dy) < 4) return;
        setInteraction(current.viewerId, { ...current, active: true });
        event.preventDefault();
      }
      const viewer = findViewer(current.viewerId);
      if (!viewer) return;
      const bounds = elementSourceInspector.panelBounds ?? {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight
      };
      if (current.kind === 'drag') {
        updatePosition(viewer, {
          ...viewer.position,
          left: current.origin.left + dx,
          top: current.origin.top + dy
        }, bounds);
        return;
      }
      const handle = current.handle ?? 'se';
      const next = {
        ...viewer.position,
        left: handle.includes('w') ? current.origin.left + dx : current.origin.left,
        top: handle.includes('n') ? current.origin.top + dy : current.origin.top,
        width: handle.includes('e') || handle.includes('w')
          ? Math.max(320, handle.includes('w') ? current.origin.width - dx : current.origin.width + dx)
          : current.origin.width,
        height: handle.includes('n') || handle.includes('s')
          ? Math.max(220, handle.includes('n') ? current.origin.height - dy : current.origin.height + dy)
          : current.origin.height
      };
      updatePosition(viewer, next, bounds);
    };

    const onPointerEnd = (event: PointerEvent) => {
      const current = Object.values(interactions).find((entry) => entry.pointerId === event.pointerId);
      if (!current) return;
      deleteInteraction(current.viewerId);
      if (current.kind === 'drag' && current.active) {
        suppressNextClick = true;
        event.preventDefault();
        window.setTimeout(() => { suppressNextClick = false; }, 0);
      }
      try {
        if (current.target.hasPointerCapture(current.pointerId)) {
          current.target.releasePointerCapture(current.pointerId);
        }
      } catch {
        // The viewer may have closed during a captured drag.
      }
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    window.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('click', onClickCapture, true);
    };
  });

  function findViewer(id: string): ElementSourceViewer | null {
    if (elementSourceInspector.transient?.id === id) return elementSourceInspector.transient;
    return elementSourceInspector.pinned.find((viewer) => viewer.id === id) ?? null;
  }

  function setInteraction(id: string, interaction: Interaction): void {
    interactions = { ...interactions, [id]: interaction };
  }

  function deleteInteraction(id: string): void {
    const { [id]: _removed, ...rest } = interactions;
    interactions = rest;
  }

  function beginInteraction(
    event: PointerEvent,
    viewerId: string,
    kind: Interaction['kind'],
    handle?: ResizeHandle
  ): void {
    if (event.button !== 0) return;
    const control = kind === 'drag' && event.target instanceof Element
      ? event.target.closest('button, [role="option"], [data-slot="select-content"]')
      : null;
    if (control) {
      // Header controls own their pointer gesture. Capturing it here makes
      // native/select triggers lose the click and can let a transient viewer
      // fall back to the guest page's pointer path.
      event.stopPropagation();
      elementSourceInspector.beginViewerInteraction(viewerId);
      elementSourceInspector.focusViewer(viewerId);
      return;
    }
    const viewer = findViewer(viewerId);
    if (!viewer) return;
    event.preventDefault();
    event.stopPropagation();
    elementSourceInspector.focusViewer(viewerId);
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setInteraction(viewerId, {
      viewerId,
      kind,
      handle,
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...viewer.position },
      target
    });
  }

  function updatePosition(
    viewer: ElementSourceViewer,
    position: ElementSourceViewer['position'],
    bounds: { left: number; top: number; right: number; bottom: number }
  ): void {
    const left = Math.min(
      Math.max(bounds.left + 8, position.left),
      Math.max(bounds.left + 8, bounds.right - position.width - 8)
    );
    const top = Math.min(
      Math.max(bounds.top + 8, position.top),
      Math.max(bounds.top + 8, bounds.bottom - position.height - 8)
    );
    elementSourceInspector.updateViewer(viewer.id, {
      position: { ...position, left, top }
    });
  }

  function currentEntry(viewer: ElementSourceViewer): SourceHistoryEntry | null {
    return viewer.history[viewer.historyIndex] ?? null;
  }

  function currentPath(viewer: ElementSourceViewer): string | null {
    return currentEntry(viewer)?.frame?.filePath ?? null;
  }

  function editorReveal(viewer: ElementSourceViewer, entry: SourceHistoryEntry): SourceReveal | null {
    const frame = entry.frame;
    if (!frame) return null;
    const key = [viewer.id, viewer.historyIndex, frame.filePath, entry.scrollTop ?? 'center'].join(':');
    const cached = revealCache.get(viewer.id);
    if (cached?.key === key) return cached.value;
    const value: SourceReveal = {
      line: frame.lineNumber ?? 1,
      column: frame.columnNumber ?? 1,
      scrollTop: entry.scrollTop,
      focus: false,
      nonce: viewer.historyIndex
    };
    revealCache.set(viewer.id, { key, value });
    return value;
  }

  function editorReady(viewerId: string, controller: FileEditorController): void {
    editorControllers.set(viewerId, controller);
  }

  function loadViewerSource(viewer: ElementSourceViewer): void {
    const entry = currentEntry(viewer);
    const frame = entry?.frame;
    const key = `${viewer.id}:${viewer.historyIndex}:${frame?.filePath ?? ''}`;
    if (loadKeys.get(viewer.id) === key) return;
    loadKeys.set(viewer.id, key);
    if (!frame) {
      elementSourceInspector.updateViewer(viewer.id, {
        status: 'error',
        error: 'Source metadata is unavailable for this element.',
        content: null,
        loadedPath: null
      });
      return;
    }
    const scope = createFilesScope(viewer.cwd, {
      runMode: viewer.runMode,
      ...(viewer.wslDistro ? { wslDistro: viewer.wslDistro } : {})
    });
    const requestedPath = frame.filePath;
    const previewKey = sourcePreviewKey(viewer, requestedPath);
    const cached = getCachedSourcePreview(previewKey);
    if (cached) {
      elementSourceInspector.updateViewer(viewer.id, {
        status: 'ready',
        error: null,
        content: cached.content,
        loadedPath: cached.loadedPath
      });
      return;
    }
    const lines = (value: string) => value.split('\n').length;
    void filesStore.loadSourceFile(scope, requestedPath).then((source) => {
      const current = findViewer(viewer.id);
      if (!current || loadKeys.get(viewer.id) !== key) return;
      if (source.unavailable || source.binary || source.truncated || source.oversized) {
        elementSourceInspector.updateViewer(viewer.id, {
          status: 'error',
          error: source.unavailable
            ? `File unavailable — ${source.unavailableReason ?? 'the backend could not read it'}.`
            : source.binary
              ? 'Binary files cannot be previewed.'
              : 'This file is too large to preview in the editor.',
          content: source.content,
          loadedPath: source.relativePath
        });
        return;
      }
      if (frame.lineNumber !== null && frame.lineNumber > lines(source.content)) {
        elementSourceInspector.updateViewer(viewer.id, {
          status: 'error',
          error: `Source line ${frame.lineNumber} is outside the current file.`,
          content: source.content,
          loadedPath: source.relativePath
        });
        return;
      }
      cacheSourcePreview(previewKey, {
        content: source.content,
        loadedPath: source.relativePath
      });
      elementSourceInspector.updateViewer(viewer.id, {
        status: 'ready',
        error: null,
        content: source.content,
        loadedPath: source.relativePath
      });
    }).catch((error: unknown) => {
      if (!findViewer(viewer.id) || loadKeys.get(viewer.id) !== key) return;
      console.warn('[element-source] source preview load failed', {
        path: requestedPath,
        error
      });
      elementSourceInspector.updateViewer(viewer.id, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        content: null,
        loadedPath: null
      });
    });
  }

  function openStackFrame(viewerId: string, frame: ElementSourceViewer['stack'][number]): void {
    const controller = editorControllers.get(viewerId);
    if (controller) elementSourceInspector.updateViewerSnapshot(viewerId, {
      scrollTop: controller.getScrollTop()
    });
    elementSourceInspector.openStackFrame(viewerId, frame);
  }

  function goBack(viewerId: string): void {
    const controller = editorControllers.get(viewerId);
    if (controller) elementSourceInspector.updateViewerSnapshot(viewerId, {
      scrollTop: controller.getScrollTop()
    });
    elementSourceInspector.goBack(viewerId);
  }

  async function openInMain(viewer: ElementSourceViewer): Promise<void> {
    const entry = currentEntry(viewer);
    const frame = entry?.frame;
    if (!frame) return;
    const selected = sessions.selected;
    const scope = createFilesScope(viewer.cwd, {
      runMode: viewer.runMode,
      ...(viewer.wslDistro ? { wslDistro: viewer.wslDistro } : {})
    });
    if (!selected || worktreeScopeKey(createFilesScope(selected.cwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    })) !== worktreeScopeKey(scope)) {
      elementSourceInspector.updateViewer(viewer.id, {
        status: 'error',
        error: 'Switch to the associated worktree to open this file in the main viewer.'
      });
      return;
    }
    const current = filesStore.openFileFor(scope);
    const discardDirty = Boolean(
      current && current.relativePath !== frame.filePath && filesStore.dirtyFor(scope)
    );
    if (discardDirty && !window.confirm('Discard unsaved changes and open the source file?')) return;
    const reveal = filesStore.requestReveal(
      scope,
      frame.filePath,
      frame.lineNumber ?? 1,
      frame.columnNumber ?? 1
    );
    const opened = await filesStore.openFileAt(scope, frame.filePath, { discardDirty });
    if (!opened) return;
    rightRail.openTab('files');
    window.dispatchEvent(new CustomEvent('soloe:focus-pane', { detail: { tabId: 'files' } }));
    window.setTimeout(() => filesStore.clearReveal(scope, reveal.nonce), 5000);
  }

  function frameLabel(frame: SourceHistoryEntry['frame']): string {
    if (!frame) return 'Source unavailable';
    return `${frame.filePath}${frame.lineNumber ? `:${frame.lineNumber}` : ''}`;
  }

  function sourceHierarchy(viewer: ElementSourceViewer): ElementSourceViewer['stack'] {
    return [...viewer.stack].reverse();
  }

  function currentHierarchyIndex(
    viewer: ElementSourceViewer,
    hierarchy: ElementSourceViewer['stack']
  ): number {
    const current = currentEntry(viewer)?.frame;
    if (!current) return -1;
    return hierarchy.findIndex((candidate) => isCurrentFrame(current, candidate));
  }

  function selectHierarchyFrame(viewerId: string, hierarchyIndex: number): void {
    const viewer = findViewer(viewerId);
    if (!viewer) return;
    const frame = sourceHierarchy(viewer)[hierarchyIndex];
    if (frame) openStackFrame(viewerId, frame);
  }

  function moveInHierarchy(viewerId: string, direction: 'out' | 'in'): void {
    const viewer = findViewer(viewerId);
    if (!viewer) return;
    const hierarchy = sourceHierarchy(viewer);
    const currentIndex = currentHierarchyIndex(viewer, hierarchy);
    if (currentIndex < 0) return;
    const nextIndex = direction === 'out' ? currentIndex - 1 : currentIndex + 1;
    if (nextIndex < 0 || nextIndex >= hierarchy.length) return;
    const frame = hierarchy[nextIndex];
    if (frame) openStackFrame(viewerId, frame);
  }

  function componentLabel(viewer: ElementSourceViewer, frame: SourceHistoryEntry['frame']): string {
    return frame ? frameName(frame) : viewer.label;
  }

  function componentHeaderLabel(viewer: ElementSourceViewer, frame: SourceHistoryEntry['frame']): string {
    return `[${componentLabel(viewer, frame)}]`;
  }

  function sourcePreviewKey(viewer: ElementSourceViewer, filePath: string): string {
    return [viewer.cwd, viewer.runMode, viewer.wslDistro ?? '', filePath].join('\0');
  }

  function getCachedSourcePreview(key: string): { content: string; loadedPath: string } | null {
    const cached = sourcePreviewCache.get(key);
    if (!cached) return null;
    sourcePreviewCache.delete(key);
    sourcePreviewCache.set(key, cached);
    return cached;
  }

  function cacheSourcePreview(key: string, value: { content: string; loadedPath: string }): void {
    sourcePreviewCache.delete(key);
    sourcePreviewCache.set(key, value);
    while (sourcePreviewCache.size > 12) {
      const oldest = sourcePreviewCache.keys().next().value as string | undefined;
      if (!oldest) break;
      sourcePreviewCache.delete(oldest);
    }
  }

  function frameName(frame: ElementSourceViewer['stack'][number]): string {
    if (frame.componentName) return frame.componentName;
    const filename = frame.filePath.split('/').at(-1) ?? frame.filePath;
    return filename.replace(/\.[^.]+$/, '') || 'Source frame';
  }

  function isCurrentFrame(
    current: SourceHistoryEntry['frame'],
    candidate: ElementSourceViewer['stack'][number]
  ): boolean {
    return !!current
      && current.filePath === candidate.filePath
      && current.lineNumber === candidate.lineNumber
      && current.columnNumber === candidate.columnNumber;
  }

  function handleViewerEnter(viewerId: string): void {
    elementSourceInspector.enterViewer(viewerId);
    elementSourceInspector.focusViewer(viewerId);
  }

  function handleViewerLeave(viewerId: string): void {
    elementSourceInspector.leaveViewer(viewerId);
  }
</script>

{#each viewers as viewer (viewer.id)}
  {@const entry = currentEntry(viewer)}
  {@const frame = entry?.frame ?? null}
  {@const sourceReveal = editorReveal(viewer, entry ?? { frame: null, componentName: null, scrollTop: null })}
  {@const isTransient = !viewer.pinned}
  {@const interaction = interactions[viewer.id]}
  {@const sourcePath = currentPath(viewer)}
  {@const hierarchy = sourceHierarchy(viewer)}
  {@const hierarchyIndex = currentHierarchyIndex(viewer, hierarchy)}
  <div
    class="element-source-sticky fixed"
    role="dialog"
    tabindex="-1"
    aria-label={`Component inspector: ${viewer.label}`}
    style={`left: ${viewer.position.left}px; top: ${viewer.position.top}px; width: ${viewer.position.width}px; height: ${viewer.position.height}px; z-index: ${80 + Math.min(120, viewer.zIndex)};`}
    onpointerenter={() => handleViewerEnter(viewer.id)}
    onpointerleave={() => handleViewerLeave(viewer.id)}
    onpointerdown={() => elementSourceInspector.focusViewer(viewer.id)}
  >
    <div class="element-source-sticky-body flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-primary/30 bg-card/95 text-card-foreground shadow-2xl backdrop-blur-sm">
      <header
        role="toolbar"
        aria-label="Component source viewer"
        tabindex="-1"
        class={`flex min-h-0 min-w-0 shrink-0 touch-none select-none items-center gap-1 border-b border-border/70 px-1.5 py-1 ${
          interaction?.kind === 'drag' && interaction.active ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onpointerdown={(event) => beginInteraction(event, viewer.id, 'drag')}
      >
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          disabled={!elementSourceInspector.canGoBack(viewer.id)}
          onclick={() => goBack(viewer.id)}
          aria-label="Back to previous source location"
          title="Back"
        >
          <ChevronLeft class="size-3.5" />
        </Button>
        <div class="flex min-w-0 flex-1 items-center gap-0.5">
          <ScanLine class="mx-0.5 size-3 shrink-0 text-primary" />
          {#if hierarchy.length > 0}
            <Select.Root
              type="single"
              value={String(Math.max(0, hierarchyIndex))}
              onValueChange={(value) => value !== undefined && selectHierarchyFrame(viewer.id, Number(value))}
            >
              <Select.Trigger
                size="sm"
                class="h-6 min-w-0 max-w-[12rem] flex-1 justify-start border-transparent bg-transparent px-1.5 text-[11px] font-medium shadow-none hover:bg-muted/70"
                aria-label="Choose component source location"
              >
                <span class="min-w-0 truncate">{componentHeaderLabel(viewer, frame)}</span>
              </Select.Trigger>
              <Select.Content
                align="start"
                portalProps={{ disabled: true }}
                class="z-[120] max-h-72 min-w-48"
              >
                {#each hierarchy as stackFrame, stackIndex (`${stackFrame.filePath}:${stackFrame.lineNumber}:${stackIndex}`)}
                  <Select.Item value={String(stackIndex)} label={frameName(stackFrame)}>
                    <span class="truncate">{frameName(stackFrame)}</span>
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Button
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              disabled={hierarchyIndex <= 0}
              onclick={() => moveInHierarchy(viewer.id, 'out')}
              aria-label="Show parent component"
              title="Show parent component"
            >
              <ChevronUp class="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              disabled={hierarchyIndex < 0 || hierarchyIndex >= hierarchy.length - 1}
              onclick={() => moveInHierarchy(viewer.id, 'in')}
              aria-label="Show nested component"
              title="Show nested component"
            >
              <ChevronDown class="size-3" />
            </Button>
          {:else}
            <span class="min-w-0 truncate px-1 text-[11px] font-medium" title={viewer.label}>
              {componentHeaderLabel(viewer, frame)}
            </span>
          {/if}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          onclick={() => isTransient
            ? elementSourceInspector.pinViewer(viewer.id)
            : elementSourceInspector.unpinViewer(viewer.id)}
          aria-label={isTransient ? 'Pin source viewer' : 'Unpin source viewer'}
          title={isTransient ? 'Pin source viewer' : 'Unpin source viewer'}
        >
          {#if isTransient}<Pin class="size-3" />{:else}<PinOff class="size-3" />{/if}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          onclick={() => void openInMain(viewer)}
          disabled={!frame}
          aria-label="Open source in main file viewer"
          title="Open in main file viewer"
        >
          <ExternalLink class="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          onclick={() => elementSourceInspector.closeViewer(viewer.id)}
          aria-label="Close source viewer"
          title="Close source viewer"
        >
          <X class="size-3" />
        </Button>
      </header>

      <button
        type="button"
        class="mx-2 mt-1 min-w-0 whitespace-normal break-all rounded px-1 text-left font-mono text-[10px] leading-4 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        title={sourcePath ? `Open ${sourcePath} in main file viewer` : 'Source unavailable'}
        disabled={!frame}
        onclick={() => void openInMain(viewer)}
      >
        {frameLabel(frame)}
      </button>

      {#if viewer.status === 'error'}
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-[11px] text-muted-foreground">
          <AlertCircle class="size-4 text-destructive" />
          <span>{viewer.error ?? 'Source unavailable'}</span>
          {#if viewer.content !== null && frame}
            <span class="font-mono text-[10px] text-muted-foreground/70">{frame.filePath}</span>
          {/if}
        </div>
      {:else if viewer.content !== null}
        <div class="relative flex min-h-0 flex-1">
          {#await loadFileEditorSurface()}
            <div class="flex min-h-0 flex-1 items-center justify-center text-[11px] text-muted-foreground">
              <Loader2 class="size-3.5 animate-spin" />
              Preparing editor…
            </div>
          {:then FileEditorSurface}
            <FileEditorSurface
              value={viewer.content}
              relativePath={viewer.loadedPath ?? frame?.filePath ?? ''}
              rootEl={null}
              readOnly={true}
              reveal={sourceReveal}
              onReady={(controller) => editorReady(viewer.id, controller)}
            />
          {:catch}
            <div class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[11px] text-destructive">
              <AlertCircle class="size-3.5" />
              Editor module could not be loaded.
            </div>
          {/await}
          {#if viewer.status === 'loading'}
            <div class="pointer-events-none absolute top-2 right-2 inline-flex items-center gap-1 rounded border border-border/70 bg-background/90 px-1.5 py-1 text-[9px] text-muted-foreground shadow-sm" role="status" aria-live="polite">
              <Loader2 class="size-3 animate-spin" />
              Updating preview…
            </div>
          {/if}
        </div>
      {:else}
        <div class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 class="size-3.5 animate-spin" />
          Preparing preview…
        </div>
      {/if}
    </div>

    <button type="button" class="absolute top-[-2px] left-4 right-4 z-10 h-2 cursor-n-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from top edge" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 'n')}></button>
    <button type="button" class="absolute top-4 right-[-2px] bottom-4 z-10 w-2 cursor-e-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from right edge" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 'e')}></button>
    <button type="button" class="absolute right-4 bottom-[-2px] left-4 z-10 h-2 cursor-s-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from bottom edge" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 's')}></button>
    <button type="button" class="absolute top-4 bottom-4 left-[-2px] z-10 w-2 cursor-w-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from left edge" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 'w')}></button>
    <button type="button" class="absolute top-[-2px] left-[-2px] z-10 size-4 cursor-nwse-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from top left" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 'nw')}></button>
    <button type="button" class="absolute top-[-2px] right-[-2px] z-10 size-4 cursor-nesw-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from top right" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 'ne')}></button>
    <button type="button" class="absolute bottom-[-2px] left-[-2px] z-10 size-4 cursor-nesw-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from bottom left" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 'sw')}></button>
    <button type="button" class="absolute right-[-2px] bottom-[-2px] z-10 size-4 cursor-nwse-resize opacity-0 focus-visible:opacity-100" aria-label="Resize source viewer from bottom right" onpointerdown={(event) => beginInteraction(event, viewer.id, 'resize', 'se')}></button>
  </div>

  {@const _load = loadViewerSource(viewer)}
{/each}

<style>
  .element-source-sticky {
    container-type: inline-size;
    min-width: 0;
    min-height: 0;
    max-width: none;
    max-height: none;
    user-select: none;
  }

  .element-source-sticky :global(.cm-editor) {
    font-size: 11px;
  }

  .element-source-sticky :global(.cm-content) {
    user-select: text;
  }

  @media (prefers-reduced-motion: reduce) {
    .element-source-sticky * {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
