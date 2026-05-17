<script lang="ts">
  import { onMount } from 'svelte';
  import {
    AlertCircle,
    ArrowLeft,
    Check,
    FolderTree,
    Loader2,
    RefreshCw,
    Save
  } from '@lucide/svelte';
  import { sessions } from '../../stores/sessions.svelte';
  import { filesStore } from '../../stores/files.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { Button } from '$lib/components/ui/button';
  import FileTreeView from './FileTreeView.svelte';
  import FileEditor from './FileEditor.svelte';

  let selected = $derived(sessions.selected);
  let activeCwd = $derived.by<string | null>(() => {
    const cwd = selected?.cwd?.trim();
    return cwd && cwd.length > 0 ? cwd : null;
  });

  let tree = $derived(activeCwd ? filesStore.treeFor(activeCwd) : null);
  let openFile = $derived(filesStore.openFile);
  let dirty = $derived(filesStore.dirty);

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

  // Auto-load the tree on worktree change. Subsequent refreshes are user-driven.
  $effect(() => {
    const cwd = activeCwd;
    if (!cwd) return;
    void filesStore.loadTree(cwd).catch(reportError);
  });

  // Close any open file when the user switches worktrees — the path it points
  // at almost certainly doesn't exist in the new tree.
  let lastCwd: string | null = null;
  $effect(() => {
    const cwd = activeCwd;
    if (cwd !== lastCwd) {
      if (lastCwd !== null && filesStore.openFile) filesStore.closeFile();
      lastCwd = cwd;
    }
  });

  function onSelectPath(path: string): void {
    if (!activeCwd) return;
    void filesStore.openFileAt(activeCwd, path).catch(reportError);
  }

  function onBack(): void {
    if (dirty) {
      const ok = window.confirm('Discard unsaved changes?');
      if (!ok) return;
    }
    filesStore.closeFile();
  }

  function onSave(): void {
    void filesStore.save().catch(reportError);
  }

  function onRefresh(): void {
    if (!activeCwd) return;
    void filesStore.loadTree(activeCwd, { force: true }).catch(reportError);
  }

  function onChange(next: string): void {
    filesStore.setContent(next);
  }

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

<div class="flex min-h-0 flex-1 flex-col">
  <header class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
    <div class="flex min-w-0 flex-col">
      <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Files</span>
      <span class="truncate text-xs text-foreground" title={activeCwd ?? ''}>
        {cwdLabel || 'No session selected'}
      </span>
    </div>
    {#if activeCwd && !openFile}
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
  </header>

  {#if !activeCwd}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      Select a session to browse its files.
    </div>
  {:else if openFile}
    <section class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon-xs"
          onclick={onBack}
          aria-label="Back to file tree"
          title="Back"
        >
          <ArrowLeft class="size-3.5" />
        </Button>
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
        <FileEditor
          value={openFile.content}
          relativePath={openFile.relativePath}
          onChange={onChange}
          onSave={onSave}
        />
      {/if}
    </section>
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
    <div class="flex min-h-0 flex-1 flex-col">
      <FileTreeView paths={tree.paths} onSelect={onSelectPath} />
      {#if tree.truncated}
        <div class="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">
          Listing truncated — narrow the worktree to see more.
        </div>
      {/if}
    </div>
  {/if}
</div>
