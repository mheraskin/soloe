<script lang="ts">
  import { onMount } from 'svelte';
  import { Activity, NotebookPen, GitCompare, ArrowLeftRight, FolderTree } from '@lucide/svelte';
  import type { Component } from 'svelte';
  import { rightRail, type RailTabId } from '../stores/right-rail.svelte';
  import { Keymap } from '../lib/keymap';
  import { kbdHints } from '../stores/kbd-hints.svelte';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Kbd } from '$lib/components/ui/kbd';
  import ProcessUsageWidget from './ProcessUsageWidget.svelte';
  import RailInspectorTab from './rail/RailInspectorTab.svelte';
  import RailNotesTab from './rail/RailNotesTab.svelte';
  import RailDiffTab from './diff/RailDiffTab.svelte';
  import RailFilesTab from './files/RailFilesTab.svelte';

  interface Tab {
    id: RailTabId;
    label: string;
    icon: Component<any, {}, ''>;
    shortcut?: readonly string[];
  }

  const tabs: Tab[] = [
    { id: 'inspector', label: 'Inspector', icon: Activity },
    { id: 'diff', label: 'Working diff', icon: GitCompare, shortcut: Keymap.toggleDiffRail.keys },
    { id: 'files', label: 'Files', icon: FolderTree },
    { id: 'notes', label: 'Notes', icon: NotebookPen, shortcut: Keymap.toggleNotesRail.keys }
  ];

  const RAIL_WIDTH_KEY = 'soloe.rightRailWidth.v1';
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 640;
  const DEFAULT_WIDTH = 320;

  interface Props {
    // When true, the rail content (typically the diff tab) stretches to
    // fill the entire main area; the resize handle is suppressed.
    fullscreen?: boolean;
  }

  let { fullscreen = false }: Props = $props();

  let width = $state(DEFAULT_WIDTH);
  let resizing = $state(false);

  // Keep RailDiffTab in the DOM across worktree switches as long as any
  // worktree has it active in its persisted state. Switching to a worktree
  // whose saved rail tab differs just hides the diff tab via CSS instead of
  // tearing it down — preserves scroll state, search, and any in-flight
  // diff requests across worktree hops.
  let diffMounted = $derived(rightRail.diffMountedCwds.length > 0);
  let diffVisible = $derived(rightRail.open && rightRail.activeTab === 'diff');
  // Same trick for the files tab — keeps the file tree + editor mounted so
  // unsaved edits, expansion state, and scroll positions all survive worktree
  // hops. RailFilesTab is a singleton; per-cwd state lives in filesStore.
  let filesMounted = $derived(rightRail.filesMountedCwds.length > 0);
  let filesVisible = $derived(rightRail.open && rightRail.activeTab === 'files');
  let otherTabVisible = $derived(
    rightRail.open && rightRail.activeTab !== 'diff' && rightRail.activeTab !== 'files'
  );

  onMount(() => {
    const stored = Number(localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(stored)) width = clampWidth(stored);
  });

  function clampWidth(value: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
  }

  function startResize(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = true;
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stopResize, { once: true });
  }

  function resize(event: PointerEvent) {
    width = clampWidth(window.innerWidth - event.clientX);
  }

  function stopResize() {
    resizing = false;
    window.removeEventListener('pointermove', resize);
    localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  }
</script>

<aside
  class={[
    'relative flex flex-row-reverse border-l border-border bg-sidebar',
    fullscreen ? 'min-w-0 flex-1' : 'flex-shrink-0',
    !rightRail.open && 'w-10',
    rightRail.open && 'overflow-hidden'
  ]}
  class:select-none={resizing}
  style={rightRail.open && !fullscreen ? `width: ${width}px` : undefined}
  aria-label="Session rail"
>
  <Tooltip.Provider delayDuration={250}>
    <nav class="flex w-10 flex-shrink-0 flex-col items-center gap-1 pt-2" aria-label="Rail tabs">
      {#each tabs as tab (tab.id)}
        {@const isActive = rightRail.open && rightRail.activeTab === tab.id}
        <Tooltip.Root disabled={kbdHints.altHeld}>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <div class="relative">
                <button
                  {...props}
                  type="button"
                  class={`flex size-8 items-center justify-center rounded-md transition-colors ${
                    isActive
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  }`}
                  onclick={() => rightRail.toggleTab(tab.id)}
                  aria-label={tab.label}
                  aria-pressed={isActive}
                >
                  <tab.icon class="size-4" />
                </button>
                {#if kbdHints.altHeld && !isActive}
                  <div
                    class="pointer-events-none absolute top-1/2 right-full z-50 mr-2 -translate-y-1/2 inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-foreground px-3 py-1.5 text-xs text-background shadow-md"
                  >
                    <span>{tab.label}</span>
                    {#if tab.shortcut}
                      <Kbd keys={[...tab.shortcut]} />
                    {/if}
                  </div>
                {/if}
              </div>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content side="left" class="flex items-center gap-1.5">
            <span>{tab.label}</span>
            {#if tab.shortcut}
              <Kbd keys={[...tab.shortcut]} />
            {/if}
          </Tooltip.Content>
        </Tooltip.Root>
      {/each}
      <div class="min-h-2 flex-1"></div>
      <Tooltip.Root>
        <Tooltip.Trigger>
          {#snippet child({ props })}
            <div
              {...props}
              role="note"
              aria-label="Switch focus between terminal and pane: Ctrl+;"
              class="flex flex-col items-center gap-0.5 pb-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            >
              <ArrowLeftRight class="size-3" />
              <kbd
                class="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded border border-border/70 bg-muted/70 px-1 font-mono text-[9px] leading-none tracking-tight"
                >Ctrl</kbd
              >
              <kbd
                class="inline-flex h-3.5 min-w-3.5 items-center justify-center rounded border border-border/70 bg-muted/70 px-1 font-mono text-[9px] leading-none tracking-tight"
                >;</kbd
              >
            </div>
          {/snippet}
        </Tooltip.Trigger>
        <Tooltip.Content side="left">Switch focus between terminal and pane</Tooltip.Content>
      </Tooltip.Root>
      <ProcessUsageWidget />
    </nav>
  </Tooltip.Provider>

  {#if diffMounted}
    <div
      class={[
        'min-w-0 flex-1 flex-col border-r border-border',
        diffVisible ? 'flex' : 'hidden'
      ]}
    >
      <RailDiffTab />
    </div>
  {/if}

  {#if filesMounted}
    <div
      class={[
        'min-w-0 flex-1 flex-col border-r border-border',
        filesVisible ? 'flex' : 'hidden'
      ]}
    >
      <RailFilesTab />
    </div>
  {/if}

  {#if otherTabVisible}
    <div class="flex min-w-0 flex-1 flex-col border-r border-border">
      {#if rightRail.activeTab === 'notes'}
        <RailNotesTab />
      {:else}
        <ScrollArea class="min-h-0 flex-1">
          {#if rightRail.activeTab === 'inspector'}
            <RailInspectorTab />
          {/if}
        </ScrollArea>
      {/if}
    </div>
  {/if}

  {#if rightRail.open && !fullscreen}
    <button
      type="button"
      class={`absolute top-0 left-[-3px] z-10 h-full w-1.5 cursor-col-resize outline-none hover:bg-ring/30 focus-visible:bg-ring/40 ${resizing ? 'bg-ring/20' : 'bg-transparent'}`}
      aria-label="Resize rail"
      onpointerdown={startResize}
    >
      <span class="absolute bottom-1 left-1 block size-2 border-b border-l border-muted-foreground/60"></span>
    </button>
  {/if}
</aside>
