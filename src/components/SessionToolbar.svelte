<script lang="ts">
  import {
    Pencil,
    FolderOpen,
    Copy,
    Search,
    FileText,
    MoreHorizontal,
    Code2
  } from '@lucide/svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { modal } from '../stores/modal.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Separator } from '$lib/components/ui/separator';
  import StatusDot from './StatusDot.svelte';
  import GitBranchWidget from './GitBranchWidget.svelte';
  import KindIcon from './KindIcon.svelte';

  let selected = $derived(sessions.selected);
  let status = $derived(selected ? sessions.statusFor(selected.id) : 'stopped');
  let isRunning = $derived(status === 'running' || status === 'starting');

  function edit() {
    if (selected) modal.openEdit(selected);
  }
  async function openCwd() {
    if (!selected) return;
    try { await ipc.system.openPath(selected.id); } catch (e) { reportError(e); }
  }
  async function openInEditor() {
    if (!selected) return;
    try {
      await ipc.files.openInEditor({ absolutePath: selected.cwd });
      toasts.push('Opened cwd in editor', 'info');
    } catch (e) {
      reportError(e);
    }
  }
  async function copyCmd() {
    if (!selected) return;
    try {
      const spec = await ipc.sessions.previewCommand(selected.id);
      await navigator.clipboard.writeText(spec.description);
      toasts.push('Copied command to clipboard', 'info');
    } catch (e) {
      reportError(e);
    }
  }
  function terminalAction(name: string) {
    window.dispatchEvent(new CustomEvent(name));
  }
</script>

<div class="flex items-center justify-between gap-3 border-b border-border bg-card px-3 py-2 min-h-[48px] shadow-elevation-1">
  {#if selected}
    <div class="flex min-w-0 items-center gap-2.5">
      <StatusDot {status} />
      <KindIcon kind={selected.kind} size={16} />
      <div class="flex min-w-0 flex-col leading-tight">
        <span class="truncate text-sm font-medium text-foreground">{selected.name}</span>
        <span class="truncate font-mono text-[11px] text-muted-foreground" title={selected.cwd}>
          {selected.cwd}
        </span>
      </div>
      <GitBranchWidget cwd={selected.cwd} />
    </div>

    <Tooltip.Provider delayDuration={250}>
      <div class="flex items-center gap-1">
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-sm" onclick={openCwd} aria-label="Open working directory">
                <FolderOpen />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Open cwd</Tooltip.Content>
        </Tooltip.Root>

        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-sm" onclick={openInEditor} aria-label="Open in editor">
                <Code2 />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Open in editor</Tooltip.Content>
        </Tooltip.Root>

        <Separator orientation="vertical" class="mx-1 h-5" />

        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-sm" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-56">
            <DropdownMenu.Label>Session</DropdownMenu.Label>
            <DropdownMenu.Item onSelect={edit}>
              <Pencil /> <span>Edit session…</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={copyCmd}>
              <Copy /> <span>Copy launch command</span>
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Label>Terminal</DropdownMenu.Label>
            <DropdownMenu.Item disabled={!isRunning} onSelect={() => terminalAction('soloe:terminal-find')}>
              <Search /> <span>Find</span>
              <DropdownMenu.Shortcut>⌘F</DropdownMenu.Shortcut>
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={!isRunning} onSelect={() => terminalAction('soloe:terminal-copy-buffer')}>
              <Copy /> <span>Copy buffer</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={!isRunning} onSelect={() => terminalAction('soloe:terminal-save-buffer')}>
              <FileText /> <span>Save buffer…</span>
            </DropdownMenu.Item>
            <DropdownMenu.Item disabled={!isRunning} onSelect={() => terminalAction('soloe:terminal-copy-markdown')}>
              <FileText /> <span>Copy as Markdown</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </Tooltip.Provider>
  {:else}
    <div class="text-sm text-muted-foreground">No session selected</div>
  {/if}
</div>
