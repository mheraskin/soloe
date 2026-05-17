<script lang="ts">
  import { onMount } from 'svelte';
  import { FileTree } from '@pierre/trees';

  interface Props {
    paths: readonly string[];
    onSelect?: (path: string) => void;
  }

  let { paths, onSelect }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let tree: FileTree | null = null;
  // Captures the prop reference handed to the FileTree on mount so the reset
  // effect can skip the first run (the tree already holds those paths).
  let mountedPaths: readonly string[] | null = null;

  onMount(() => {
    if (!host) return;
    mountedPaths = paths;
    tree = new FileTree({
      paths: paths.slice(),
      flattenEmptyDirectories: true,
      initialExpansion: 'closed',
      search: true,
      onSelectionChange: (selected) => {
        // Pierre's selection model can hold multiple paths via shift/cmd-click;
        // we treat any single newly-focused file path as "open this". Folder
        // paths in the selection are ignored — clicking a folder toggles
        // expansion via the tree's own keymap.
        if (selected.length === 0) return;
        const path = selected[selected.length - 1];
        if (!path || path.endsWith('/')) return;
        onSelect?.(path);
      }
    });
    tree.render({ containerWrapper: host });
    return () => {
      tree?.cleanUp();
      tree = null;
    };
  });

  // Reset the underlying model when the path list changes (e.g. worktree switch
  // or refresh). Skip identity-equal cases — the host always passes a fresh
  // array on store update, so this fires once per legitimate change.
  $effect(() => {
    if (!tree) return;
    if (paths === mountedPaths) return;
    mountedPaths = paths;
    tree.resetPaths(paths.slice());
  });
</script>

<div
  bind:this={host}
  class="soloe-tree-host flex min-h-0 flex-1 flex-col text-xs"
></div>

<style>
  /* Map Pierre Trees' CSS variables onto the app palette. The trees shadow
     root inherits these from the host because CSS custom properties pierce
     shadow boundaries. Only the override vars are documented as theming
     hooks; chrome we don't override falls back to Pierre's defaults. */
  .soloe-tree-host {
    --trees-fg-override: var(--foreground);
    --trees-bg-override: var(--sidebar);
    --trees-border-color-override: var(--border);
    --trees-selected-bg-override: color-mix(in oklch, var(--muted) 70%, transparent);
    --trees-hover-bg-override: color-mix(in oklch, var(--muted) 35%, transparent);
    --trees-muted-fg-override: var(--muted-foreground);
    font-family: var(--font-sans);
  }
</style>
