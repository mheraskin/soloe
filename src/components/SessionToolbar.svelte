<script lang="ts">
  import {
    Pencil,
    FolderOpen,
    Copy,
    Search,
    FileText,
    MoreHorizontal,
    Code2,
    PanelLeftOpen,
    Monitor,
    X
  } from '@lucide/svelte';
  import type { MultiDeviceSessionView } from '@shared/types/multi-device-sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { modal } from '../stores/modal.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import { displaySessionKind } from '../lib/session-agent';
  import { deviceSessionStatus } from '../lib/device-terminal-presentation';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Separator } from '$lib/components/ui/separator';
  import StatusDot from './StatusDot.svelte';
  import GitBranchWidget from './GitBranchWidget.svelte';
  import KindIcon from './KindIcon.svelte';

  interface Props {
    onOpenNavigation?: () => void;
    projection?: MultiDeviceSessionView | null;
    onClose?: (() => void) | null;
  }

  let { onOpenNavigation, projection = null, onClose = null }: Props = $props();
  let selected = $derived(projection?.session ?? sessions.selected);
  let worktreeDeviceId = $derived(
    projection && deviceSessions.state?.devices
      ?.find((device) => device.deviceId === projection.ref.deviceId)?.local !== true
      ? projection.ref.deviceId
      : undefined
  );
  let status = $derived(
    projection
      ? deviceSessionStatus(projection)
      : selected ? sessions.statusFor(selected.id) : 'stopped'
  );
  let observed = $derived(
    projection
      ? projection.observation ?? null
      : selected ? sessions.observationFor(selected.id) : null
  );
  let currentCwd = $derived(
    projection
      ? projection.runtime?.cwd ?? selected?.cwd ?? null
      : selected ? sessions.currentCwdFor(selected.id) : null
  );
  let displayKind = $derived(selected ? displaySessionKind(selected, observed) : 'terminal');
  let isRunning = $derived(status === 'running' || status === 'starting');

  function edit() {
    if (!selected) return;
    modal.openEdit(
      selected,
      projection
        ? (draft) => deviceSessions.updateSession(projection!.key, draft)
        : null
    );
  }
  async function openCwd() {
    if (!selected) return;
    try { await ipc.system.openPath(selected.id); } catch (e) { reportError(e); }
  }
  async function openInEditor() {
    if (!selected) return;
    try {
      await ipc.files.openInEditor({
        absolutePath: selected.cwd,
        cwd: selected.cwd,
        runMode: selected.runMode,
        ...(selected.wslDistro ? { wslDistro: selected.wslDistro } : {}),
        ...(worktreeDeviceId ? { deviceId: worktreeDeviceId } : {})
      });
      toasts.push('Opened cwd in editor', 'info');
    } catch (e) {
      reportError(e);
    }
  }
  async function copyCmd() {
    if (!selected) return;
    try {
      const spec = projection
        ? await deviceSessions.previewCommand(projection.key)
        : await ipc.sessions.previewCommand(selected.id);
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

<div class="session-toolbar soloe-pane-header">
  {#if onOpenNavigation}
    <Button
      variant="ghost"
      class="mobile-workspace-menu-button shrink-0"
      onclick={onOpenNavigation}
      aria-label="Open session list"
      title="Open session list"
    >
      <PanelLeftOpen />
    </Button>
  {/if}
  {#if selected}
    <div class="session-toolbar-scroll no-scrollbar min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain">
      <div class="session-toolbar-content flex min-w-max items-center gap-1.5">
        <StatusDot {status} />
        <KindIcon kind={displayKind} size={13} />
        <span class="session-toolbar-title max-w-44 shrink truncate text-xs font-medium text-foreground">
          {selected.name}
        </span>
        {#if projection}
          <span class="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
            <Monitor class="size-3" />
            <span class="max-w-28 truncate">{projection.deviceName}</span>
          </span>
        {/if}
        <span class="shrink-0 text-muted-foreground/35" aria-hidden="true">·</span>
        <Tooltip.Provider delayDuration={250}>
          <Tooltip.Root>
            <Tooltip.Trigger>
              {#snippet child({ props })}
                <span
                  {...props}
                  class="block shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground"
                >
                  {currentCwd ?? selected.cwd}
                </span>
              {/snippet}
            </Tooltip.Trigger>
            <Tooltip.Content class="max-w-[min(90vw,40rem)] break-all font-mono text-[11px]">
              {currentCwd ?? selected.cwd}
            </Tooltip.Content>
          </Tooltip.Root>
        </Tooltip.Provider>
      </div>
    </div>

    <Tooltip.Provider delayDuration={250}>
      <div class="session-toolbar-actions flex shrink-0 items-center gap-0.5">
        <div class="session-toolbar-branch shrink-0">
          <GitBranchWidget
            cwd={selected.cwd}
            runMode={selected.runMode}
            wslDistro={selected.wslDistro}
            deviceId={worktreeDeviceId}
          />
        </div>
        {#if !projection}
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-xs" onclick={openCwd} aria-label="Open working directory">
                <FolderOpen />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Open cwd</Tooltip.Content>
        </Tooltip.Root>

        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-xs" onclick={openInEditor} aria-label="Open in editor">
                <Code2 />
              </Button>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Content>Open in editor</Tooltip.Content>
        </Tooltip.Root>

        <Separator orientation="vertical" class="mx-0.5 h-4" />
        {/if}

        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <Button {...props} variant="ghost" size="icon-xs" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="end" class="w-56">
            <DropdownMenu.Label>Session</DropdownMenu.Label>
            {#if projection && onClose}
              <DropdownMenu.Item onSelect={onClose}>
                <X /> <span>Close remote terminal</span>
              </DropdownMenu.Item>
            {/if}
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
