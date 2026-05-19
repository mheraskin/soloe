<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import {
    AlertCircle,
    ArrowLeft,
    Check,
    FolderTree,
    Loader2,
    Maximize2,
    Minimize2,
    RefreshCw,
    Save
  } from '@lucide/svelte';
  import type { GitStatusEntry } from '@pierre/trees';
  import type { WorkingChange } from '@shared/types/git.js';
  import { sessions } from '../../stores/sessions.svelte';
  import { filesStore } from '../../stores/files.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { Button } from '$lib/components/ui/button';
  import FileTreeView from './FileTreeView.svelte';
  import FileEditor from './FileEditor.svelte';
  import EditorSelectionMenu from './EditorSelectionMenu.svelte';
  import EditorContextMenu from './EditorContextMenu.svelte';

  let rootEl: HTMLDivElement | null = $state(null);
  let treeWrapperEl: HTMLDivElement | null = $state(null);
  let editorWrapperEl: HTMLElement | null = $state(null);

  // Once the rail is wide enough we render tree + editor side-by-side instead
  // of the narrow click-into-file flow. 640px is roughly the max non-fullscreen
  // rail width (see RAIL_WIDTH_KEY in RightRail.svelte), so split mode normally
  // only kicks in when the user enters fullscreen — but a manual wide drag
  // gets the same treatment.
  const SPLIT_THRESHOLD_PX = 640;
  // Plain `let` (not $state) — the ResizeObserver pushes via the effect below
  // by writing to a $state cell, so subscribers re-derive without us having
  // to track every intermediate measurement.
  let rootWidth = $state(0);
  let isSplit = $derived(rootWidth >= SPLIT_THRESHOLD_PX);

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    rootWidth = el.clientWidth;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      rootWidth = Math.round(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  });

  let selected = $derived(sessions.selected);
  let activeCwd = $derived.by<string | null>(() => {
    const cwd = selected?.cwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
  });

  let tree = $derived(activeCwd ? filesStore.treeFor(activeCwd) : null);
  let openFile = $derived(activeCwd ? filesStore.openFileFor(activeCwd) : null);
  let dirty = $derived(activeCwd ? filesStore.dirtyFor(activeCwd) : false);

  // Map working-tree changes onto Pierre's status union. 'copied' isn't a
  // Pierre status — flag the destination as 'added' since that's the closest
  // semantically (a brand-new path appeared). Renames also surface fromPath so
  // the old name is painted as 'deleted' alongside the new name as 'renamed'.
  let gitStatus = $derived.by<GitStatusEntry[] | undefined>(() => {
    if (!activeCwd) return undefined;
    const result = workingDiff.changesFor(activeCwd).result;
    if (!result) return undefined;
    const entries: GitStatusEntry[] = [];
    for (const change of result.changes as WorkingChange[]) {
      entries.push({ path: change.path, status: mapKind(change.kind) });
      if ((change.kind === 'renamed' || change.kind === 'copied') && change.fromPath) {
        entries.push({ path: change.fromPath, status: change.kind === 'renamed' ? 'deleted' : 'modified' });
      }
    }
    return entries;
  });

  function mapKind(kind: WorkingChange['kind']): GitStatusEntry['status'] {
    switch (kind) {
      case 'added':
        return 'added';
      case 'modified':
        return 'modified';
      case 'deleted':
        return 'deleted';
      case 'renamed':
        return 'renamed';
      case 'copied':
        return 'added';
      case 'untracked':
        return 'untracked';
    }
  }

  let cwdLabel = $derived.by<string>(() => {
    if (!activeCwd) return '';
    const parts = activeCwd.split(/[\\/]/u).filter(Boolean);
    return parts[parts.length - 1] ?? activeCwd;
  });

  // Re-register context whenever the active worktree (or its run mode) changes
  // so listTree/readFile dispatch through the right native vs WSL path.
  $effect(() => {
    if (!activeCwd || !selected) return;
    filesStore.setContext(activeCwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    });
  });

  // Mirror the diff tab's context registration so the file tree's git-status
  // overlay works even when the diff tab has never been opened. workingDiff
  // coalesces concurrent loadChanges callers, so this doesn't double-fetch
  // when both tabs are mounted.
  $effect(() => {
    if (!activeCwd || !selected) return;
    workingDiff.setContext(activeCwd, {
      runMode: selected.runMode,
      ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
    });
  });

  // Auto-load the tree on worktree change. Subsequent refreshes are user-driven.
  $effect(() => {
    const cwd = activeCwd;
    if (!cwd) return;
    void filesStore.loadTree(cwd).catch(reportError);
  });

  // Prime the working-tree changes so the status badges appear immediately on
  // the first paint. The git change listener attached in RailDiffTab pushes
  // subsequent refreshes app-wide.
  $effect(() => {
    const cwd = activeCwd;
    if (!cwd) return;
    void workingDiff.loadChanges(cwd).catch(reportError);
  });

  function onSelectPath(path: string): void {
    if (!activeCwd) return;
    void filesStore.openFileAt(activeCwd, path).catch(reportError);
  }

  function onBack(): void {
    if (!activeCwd) return;
    if (dirty) {
      const ok = window.confirm('Discard unsaved changes?');
      if (!ok) return;
    }
    filesStore.closeFile(activeCwd);
  }

  function onSave(): void {
    if (!activeCwd) return;
    void filesStore.save(activeCwd).catch(reportError);
  }

  function onRefresh(): void {
    if (!activeCwd) return;
    void filesStore.loadTree(activeCwd, { force: true }).catch(reportError);
  }

  function onChange(next: string): void {
    if (!activeCwd) return;
    filesStore.setContent(activeCwd, next);
  }

  // Per-cwd scroll persistence for both surfaces. Mirrors RailDiffTab's
  // restore-with-retry pattern: the scroll container appears asynchronously
  // (Pierre Trees mounts into a shadow root; CodeMirror mounts after its host
  // is bound) and the target offset may exceed scrollHeight until content has
  // hydrated. Each effect polls until the scroller is ready, then attaches a
  // debounced save listener and tries to land the saved offset.
  const SCROLL_SAVE_DEBOUNCE_MS = 150;
  const RESTORE_POLL_MS = 80;
  const RESTORE_TIMEOUT_MS = 3000;
  const SCROLLER_POLL_MS = 50;

  function findTreeScroller(): HTMLElement | null {
    const host = treeWrapperEl?.querySelector<HTMLElement>('.soloe-tree-host');
    return host?.shadowRoot?.querySelector<HTMLElement>(
      '[data-file-tree-virtualized-scroll="true"]'
    ) ?? null;
  }

  function findEditorScroller(): HTMLElement | null {
    return editorWrapperEl?.querySelector<HTMLElement>('.cm-scroller') ?? null;
  }

  type ScrollWiring = {
    save: (value: number) => void;
    get: () => number;
    find: () => HTMLElement | null;
  };

  function wireScrollPersistence(wiring: ScrollWiring): (() => void) | void {
    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    let scroller: HTMLElement | null = null;
    let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let restoring = false;

    const onScroll = () => {
      // Programmatic restore writes shouldn't count as user input.
      if (restoring) return;
      if (scrollSaveTimer !== null) clearTimeout(scrollSaveTimer);
      scrollSaveTimer = setTimeout(() => {
        scrollSaveTimer = null;
        if (scroller) wiring.save(scroller.scrollTop);
      }, SCROLL_SAVE_DEBOUNCE_MS);
    };

    const tryRestore = (target: number) => {
      if (!scroller) return;
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (max >= target || Date.now() >= deadline) {
        restoring = true;
        scroller.scrollTop = Math.min(Math.max(0, target), Math.max(0, max));
        // Let the scroll event fire and bail before re-enabling saves.
        setTimeout(() => {
          restoring = false;
        }, 0);
        restoreTimer = null;
        return;
      }
      restoreTimer = setTimeout(() => tryRestore(target), RESTORE_POLL_MS);
    };

    const attach = () => {
      scroller = wiring.find();
      if (!scroller) {
        if (Date.now() >= deadline) return;
        pollTimer = setTimeout(attach, SCROLLER_POLL_MS);
        return;
      }
      scroller.addEventListener('scroll', onScroll, { passive: true });
      const target = untrack(wiring.get);
      if (target > 0) tryRestore(target);
    };

    attach();

    return () => {
      if (pollTimer !== null) clearTimeout(pollTimer);
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      if (scrollSaveTimer !== null) clearTimeout(scrollSaveTimer);
      scroller?.removeEventListener('scroll', onScroll);
    };
  }

  // Tree scroll: only meaningful when the file tree is visible (no file open).
  $effect(() => {
    const cwd = activeCwd;
    const hasTree = !!treeWrapperEl;
    if (!cwd || !hasTree) return;
    return wireScrollPersistence({
      get: () => rightRail.getFilesTreeScrollTop(cwd),
      save: (v) => rightRail.setFilesTreeScrollTop(cwd, v),
      find: findTreeScroller
    });
  });

  // Editor scroll: keyed by (cwd, relativePath) so opening a second file in
  // the same worktree doesn't restore the previous file's offset into
  // unrelated content. Re-runs when the file changes so the scroller-find
  // polling picks up a freshly mounted CodeMirror after a file swap.
  $effect(() => {
    const cwd = activeCwd;
    const path = openFile?.relativePath ?? null;
    const hasEditor = !!editorWrapperEl;
    if (!cwd || !path || !hasEditor) return;
    const key = `${cwd}::${path}`;
    return wireScrollPersistence({
      get: () => rightRail.getFilesEditorScrollTop(key),
      save: (v) => rightRail.setFilesEditorScrollTop(key, v),
      find: findEditorScroller
    });
  });

  onMount(() => {
    const onRefocus = () => {
      if (rightRail.activeTab !== 'files') return;
      // Focus the editor's CodeMirror content if a file is open.
      const cm = document.querySelector<HTMLElement>('.soloe-cm-host .cm-content');
      cm?.focus();
    };
    window.addEventListener('soloe:refocus-rail', onRefocus);
    return () => window.removeEventListener('soloe:refocus-rail', onRefocus);
  });
</script>

<div bind:this={rootEl} class="flex min-h-0 flex-1 flex-col">
  <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
    <div class="flex min-w-0 flex-col">
      <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Files</span>
      <span class="truncate text-xs text-foreground" title={activeCwd ?? ''}>
        {cwdLabel || 'No session selected'}
      </span>
    </div>
    <div class="flex items-center gap-1">
      {#if activeCwd && (!openFile || isSplit)}
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={onRefresh}
          disabled={tree?.loading}
          aria-label="Refresh file tree"
          title="Refresh"
        >
          {#if tree?.loading}
            <Loader2 class="size-3 animate-spin" />
          {:else}
            <RefreshCw class="size-3" />
          {/if}
        </Button>
      {/if}
      <Button
        variant="ghost"
        size="icon-xs"
        onclick={() => rightRail.toggleFullscreen()}
        aria-label={rightRail.fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        title={rightRail.fullscreen ? 'Exit fullscreen (Ctrl+Shift+M)' : 'Fullscreen (Ctrl+Shift+M)'}
        aria-pressed={rightRail.fullscreen}
      >
        {#if rightRail.fullscreen}
          <Minimize2 class="size-3" />
        {:else}
          <Maximize2 class="size-3" />
        {/if}
      </Button>
    </div>
  </header>

  {#if !activeCwd}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      Select a session to browse its files.
    </div>
  {:else if tree?.loading && tree.paths.length === 0}
    <div class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
      <Loader2 class="mr-2 size-3 animate-spin" />
      Listing files…
    </div>
  {:else if tree?.error}
    <div class="flex flex-col items-center justify-center gap-2 px-3 py-6 text-center text-xs text-destructive">
      <AlertCircle class="size-4" />
      <span>{tree.error}</span>
      <Button variant="outline" size="xs" onclick={onRefresh}>Retry</Button>
    </div>
  {:else if tree && tree.paths.length === 0}
    <div class="flex flex-col items-center justify-center gap-2 px-3 py-6 text-center text-xs text-muted-foreground">
      <FolderTree class="size-4" />
      <span>No files in this worktree.</span>
    </div>
  {:else if tree}
    <!-- Split mode lays out editor on the left and tree on the right; narrow
         mode shows one or the other based on whether a file is open. Both
         wrappers stay in the DOM either way so FileTreeView/CodeMirror keep
         their internal state (expansion, selection, scroll) across mode and
         file-open transitions. -->
    <div class="flex min-h-0 flex-1 flex-row">
      <section
        bind:this={editorWrapperEl}
        class={[
          'min-h-0 flex-col',
          isSplit ? 'flex flex-1' : openFile ? 'flex flex-1' : 'hidden'
        ]}
      >
        {#if openFile}
          <div class="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            {#if !isSplit}
              <Button
                variant="ghost"
                size="icon-xs"
                onclick={onBack}
                aria-label="Back to file tree"
                title="Back"
              >
                <ArrowLeft class="size-3.5" />
              </Button>
            {/if}
            <span class="min-w-0 flex-1 truncate font-mono text-[11px]" title={openFile.relativePath}>
              {openFile.relativePath}
            </span>
            <span class="flex shrink-0 items-center gap-1 text-[10px]">
              {#if openFile.saving}
                <Loader2 class="size-3 animate-spin text-muted-foreground" />
                <span class="text-muted-foreground">Saving…</span>
              {:else if openFile.error}
                <AlertCircle class="size-3 text-destructive" />
                <span class="text-destructive">Error</span>
              {:else if dirty}
                <span class="text-muted-foreground">Unsaved</span>
              {:else if !openFile.loading && !openFile.binary}
                <Check class="size-3 text-emerald-500" />
                <span class="text-emerald-500">Saved</span>
              {/if}
            </span>
            <Button
              variant="outline"
              size="xs"
              class="gap-1.5 px-2"
              onclick={onSave}
              disabled={!dirty || openFile.saving || openFile.binary}
              aria-label="Save file"
              title="Save (Ctrl/Cmd+S)"
            >
              <Save class="size-3" />
              <span>Save</span>
            </Button>
          </div>

          {#if openFile.error && !openFile.saving}
            <div class="border-b border-border bg-destructive/10 px-3 py-1.5 text-[11px] text-destructive">
              {openFile.error}
            </div>
          {/if}

          {#if openFile.loading}
            <div class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
              <Loader2 class="mr-2 size-3 animate-spin" />
              Loading…
            </div>
          {:else if openFile.binary}
            <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
              Binary file — preview not available.
            </div>
          {:else if openFile.truncated}
            <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
              File too large to open in the in-rail editor.
            </div>
          {:else}
            <EditorContextMenu
              relativePath={openFile.relativePath}
              rootEl={editorWrapperEl}
            >
              {#snippet children()}
                <FileEditor
                  value={openFile.content}
                  relativePath={openFile.relativePath}
                  onChange={onChange}
                  onSave={onSave}
                />
              {/snippet}
            </EditorContextMenu>
            <EditorSelectionMenu
              relativePath={openFile.relativePath}
              rootEl={editorWrapperEl}
            />
          {/if}
        {:else if isSplit}
          <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
            Pick a file from the tree to view its contents.
          </div>
        {/if}
      </section>

      <div
        bind:this={treeWrapperEl}
        class={[
          'min-h-0 flex-col',
          isSplit
            ? 'flex w-60 shrink-0 border-l border-border text-[11px]'
            : openFile
              ? 'hidden'
              : 'flex flex-1 text-xs'
        ]}
      >
        <FileTreeView paths={tree.paths} gitStatus={gitStatus} onSelect={onSelectPath} />
        {#if tree.truncated}
          <div class="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
            Listing truncated — narrow the worktree to see more.
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
