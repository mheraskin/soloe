<script lang="ts">
  import { FileText, FolderOpen, Terminal } from '@lucide/svelte';
  import type { FileSearchResult } from '@shared/types/files.js';
  import { filePalette } from '../stores/file-palette.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { projects } from '../stores/projects.svelte';
  import { settings } from '../stores/settings.svelte';
  import { filesStore } from '../stores/files.svelte';
  import { rightRail } from '../stores/right-rail.svelte';
  import { ipc, supportsBackendOperation } from '../lib/ipc';
  import { reportError } from '../stores/toast.svelte';
  import { terminalControl } from '../stores/terminal-control.svelte';
  import { terminalControlProof } from '@shared/types/terminal.js';
  import * as Command from '$lib/components/ui/command';

  let query = $state('');
  let results = $state<FileSearchResult[]>([]);
  let loading = $state(false);
  let searchSeq = 0;

  let fileScope = $derived.by(() => {
    const selected = sessions.selected;
    if (selected?.cwd) {
      return {
        cwd: selected.cwd,
        runMode: selected.runMode,
        ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {})
      };
    }
    const selectedProject = selected?.projectId ? projects.get(selected.projectId) : null;
    if (!selectedProject?.path) return null;
    const runMode = selectedProject.defaultRunMode ?? settings.current.defaults.runMode;
    const wslDistro = selectedProject.defaultWslDistro ?? settings.current.defaults.wslDistro;
    return {
      cwd: selectedProject.path,
      runMode,
      ...(runMode === 'wsl' && wslDistro ? { wslDistro } : {})
    };
  });
  let rootPath = $derived(fileScope?.cwd ?? '');

  $effect(() => {
    if (!filePalette.open) return;
    query = '';
    results = [];
  });

  $effect(() => {
    const scope = fileScope;
    if (!filePalette.open || !scope) return;
    const seq = ++searchSeq;
    loading = true;
    const timer = window.setTimeout(() => {
      ipc.files.search({ ...scope, query, limit: 80 })
        .then((next) => {
          if (seq === searchSeq) {
            results = next;
          }
        })
        .catch(reportError)
        .finally(() => {
          if (seq === searchSeq) loading = false;
        });
    }, 80);
    return () => window.clearTimeout(timer);
  });

  async function openResult(result: FileSearchResult): Promise<void> {
    filePalette.close();
    const scope = fileScope;
    if (!scope) return;
    if (supportsBackendOperation('files', 'openInEditor')) {
      await ipc.files.openInEditor({ ...scope, absolutePath: result.absolutePath });
      return;
    }
    rightRail.openTab('files');
    await filesStore.openFileAt(scope, result.path);
    window.dispatchEvent(new CustomEvent('soloe:focus-pane', { detail: { tabId: 'files' } }));
  }

  async function pasteResult(result: FileSearchResult): Promise<void> {
    const selected = sessions.selected;
    const terminalId = selected ? sessions.terminalIdFor(selected.id) : null;
    const lease = terminalId ? terminalControl.lease(terminalId) : null;
    if (!terminalId || !terminalControl.owns(terminalId) || !lease) {
      await navigator.clipboard.writeText(result.path);
      filePalette.close();
      return;
    }
    filePalette.close();
    await ipc.files.pasteIntoTerminal({
      terminalId,
      path: result.path,
      control: terminalControlProof(lease)
    });
  }

  function onOpenChange(next: boolean) {
    if (!next) filePalette.close();
  }

  function onKey(e: KeyboardEvent) {
    if (!filePalette.open) return;
    if (e.key === 'Enter' && e.shiftKey) {
      // We can't easily intercept Command's Enter; let Shift+Enter trigger paste of focused item.
      // The Command primitive uses cmdk which sends onSelect on Enter only — so add a separate handler.
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<Command.Dialog open={filePalette.open} {onOpenChange} shouldFilter={false} class="mobile-command-dialog sm:max-w-2xl">
  <Command.Input bind:value={query} placeholder="Find file" />
  <div class="flex items-center gap-1.5 border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground" title={rootPath}>
    <FolderOpen class="size-2.5" />
    <span class="truncate">{rootPath || 'No active session'}</span>
  </div>
  <Command.List class="max-h-[60vh]">
    {#if !rootPath}
      <Command.Empty>No active root</Command.Empty>
    {:else if loading && results.length === 0}
      <Command.Empty>Searching…</Command.Empty>
    {:else if results.length === 0}
      <Command.Empty>No matches</Command.Empty>
    {:else}
      <Command.Group heading="Files">
        {#each results as result (result.absolutePath)}
          <Command.Item
            value={result.absolutePath}
            onSelect={() => void openResult(result).catch(reportError)}
          >
            <FileText />
            <span class="flex-1 truncate font-mono text-xs">{result.path}</span>
            <button
              type="button"
              class="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
              onclick={(e) => {
                e.stopPropagation();
                void pasteResult(result).catch(reportError);
              }}
              title="Paste path into terminal"
            >
              <Terminal class="size-2.5" /> paste
            </button>
          </Command.Item>
        {/each}
      </Command.Group>
    {/if}
  </Command.List>
</Command.Dialog>
