<script lang="ts">
  import { onMount } from 'svelte';
  import { FileTree, type GitStatusEntry } from '@pierre/trees';

  interface Props {
    paths: readonly string[];
    gitStatus?: readonly GitStatusEntry[];
    onSelect?: (path: string) => void;
  }

  let { paths, gitStatus, onSelect }: Props = $props();

  let host: HTMLDivElement | null = $state(null);
  let tree: FileTree | null = null;
  // Captures the prop references handed to the FileTree on mount so the
  // reactive effects can skip the first run (the tree already holds them).
  let mountedPaths: readonly string[] | null = null;
  let mountedGitStatus: readonly GitStatusEntry[] | undefined = undefined;

  onMount(() => {
    if (!host) return;
    mountedPaths = paths;
    mountedGitStatus = gitStatus;
    tree = new FileTree({
      paths: paths.slice(),
      flattenEmptyDirectories: true,
      initialExpansion: 'closed',
      search: true,
      ...(gitStatus ? { gitStatus: gitStatus.slice() } : {}),
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

  // Push live git status updates onto the tree. Pierre fingerprints the entry
  // list internally, so a same-reference no-op is cheap, but skipping the
  // identity-equal case avoids the redundant signature hash on mount.
  $effect(() => {
    if (!tree) return;
    if (gitStatus === mountedGitStatus) return;
    mountedGitStatus = gitStatus;
    tree.setGitStatus(gitStatus ? gitStatus.slice() : undefined);
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
    /* Match the diff tab's ChangeRow palette so a file's status badge means
       the same thing in both panes (emerald=add, amber=mod, rose=del, sky=ren). */
    --trees-status-added-override: var(--color-emerald-500);
    --trees-status-modified-override: var(--color-amber-500);
    --trees-status-deleted-override: var(--color-rose-500);
    --trees-status-renamed-override: var(--color-sky-500);
    --trees-status-untracked-override: var(--color-emerald-400);
    --trees-status-ignored-override: var(--muted-foreground);
    font-family: var(--font-sans);
  }
</style>
