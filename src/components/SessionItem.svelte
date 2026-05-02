<script lang="ts">
  import { tick } from 'svelte';
  import { Archive, ArchiveRestore, Pencil, FolderOpen, Copy, Trash2, GitBranch } from '@lucide/svelte';
  import type { AgentObservedState, Session } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { nav } from '../stores/nav.svelte';
  import { modal } from '../stores/modal.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import { confirmDeleteSession } from '../lib/session-delete-confirmation';
  import { cn } from '$lib/utils';
  import { Button } from '$lib/components/ui/button';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import StatusDot from './StatusDot.svelte';
  import KindIcon from './KindIcon.svelte';
  import KbdHint from './KbdHint.svelte';

  let { session, branch = null }: { session: Session; branch?: string | null } = $props();

  let editing = $state(false);
  let editValue = $state('');
  let nameInput: HTMLInputElement | null = $state(null);

  let isSelected = $derived(sessions.selectedId === session.id);
  let status = $derived(sessions.statusFor(session.id));
  let workerCount = $derived(sessions.childWorkersFor(session.id).length);
  let kbdIndex = $derived(nav.sessionIndexHints[session.id] ?? null);
  let observation = $derived(sessions.observationFor(session.id));
  let observedState = $derived(observation?.state ?? null);
  let observedSummary = $derived(sessions.eventsFor(session.id)[0]?.summary ?? null);
  let showAgentStatus = $derived(
    !!observedState &&
      !(session.kind === 'standard_terminal' && observation?.provider === 'standard_terminal')
  );
  let statusLabel = $derived(showAgentStatus && observedState ? observedStateLabel(observedState) : status);
  let statusTitle = $derived(
    observedSummary ? `${statusLabel} · ${observedSummary}` : statusLabel
  );

  function onClick(e: MouseEvent) {
    if (e.button !== 0 || editing) return;
    sessions.select(session.id);
  }

  async function startEditing(e?: Event) {
    e?.stopPropagation();
    if (editing) return;
    editValue = session.name;
    editing = true;
    await tick();
    nameInput?.focus();
    nameInput?.select();
  }

  function cancelEditing() {
    editing = false;
    editValue = '';
  }

  async function commitEditing() {
    const trimmed = editValue.trim();
    if (!trimmed || trimmed === session.name) {
      cancelEditing();
      return;
    }
    const next = trimmed;
    editing = false;
    editValue = '';
    try {
      await sessions.update(session.id, { name: next });
    } catch (err) {
      reportError(err);
    }
  }

  function onNameKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitEditing();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    }
  }

  function onRowKey(e: KeyboardEvent) {
    if (editing) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      sessions.select(session.id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      void startEditing();
    }
  }

  async function start() {
    try { await sessions.start(session.id); } catch (err) { reportError(err); }
  }
  async function stop() {
    try { await sessions.stop(session.id); } catch (err) { reportError(err); }
  }
  async function restart() {
    try { await sessions.restart(session.id); } catch (err) { reportError(err); }
  }
  function edit() {
    modal.openEdit(session);
  }
  async function remove() {
    const ok = await confirmDeleteSession(session);
    if (!ok) return;
    try { await sessions.remove(session.id); } catch (err) { reportError(err); }
  }
  async function archive(e?: Event) {
    e?.stopPropagation();
    try { await sessions.archive(session.id); } catch (err) { reportError(err); }
  }
  async function restore(e?: Event) {
    e?.stopPropagation();
    try { await sessions.restore(session.id); } catch (err) { reportError(err); }
  }
  function restoreFromButton(e: Event) {
    e.stopPropagation();
    void restore();
  }
  function removeFromButton(e: Event) {
    e.stopPropagation();
    void remove();
  }
  async function openCwd() {
    try { await ipc.system.openPath(session.id); } catch (err) { reportError(err); }
  }
  async function copyCmd() {
    try {
      const spec = await ipc.sessions.previewCommand(session.id);
      await navigator.clipboard.writeText(spec.description);
    } catch (err) {
      reportError(err);
    }
  }

  let canStart = $derived(status === 'stopped' || status === 'exited' || status === 'error');
  let isRunning = $derived(status === 'running' || status === 'starting');

  function observedStateLabel(state: AgentObservedState): string {
    const labels = {
      starting: 'starting',
      idle: 'idle',
      working: 'thinking',
      running_tool: observedSummary?.replace(/^tool:\s*/i, '') ?? 'tool',
      waiting_for_input: 'input',
      waiting_for_approval: 'approval',
      completed: 'done',
      failed: 'failed',
      exited: 'exited'
    } satisfies Record<AgentObservedState, string>;
    return labels[state] ?? state;
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      <div
        {...props}
        class={cn(
          'group flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors',
          'hover:bg-accent/40',
          isSelected && 'bg-accent/60 border-border'
        )}
        onclick={onClick}
        ondblclick={startEditing}
        onkeydown={onRowKey}
        role="button"
        tabindex="0"
        title={session.cwd}
      >
        <KindIcon kind={session.kind} size={14} />
        <span class="flex min-w-0 flex-1 flex-col gap-1">
          <span class="flex min-w-0 items-center gap-1.5">
            {#if editing}
              <input
                class="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 text-sm outline-none focus:border-ring"
                bind:this={nameInput}
                bind:value={editValue}
                onkeydown={onNameKey}
                onblur={() => void commitEditing()}
                onclick={(e) => e.stopPropagation()}
                spellcheck="false"
                autocomplete="off"
              />
            {:else}
              <span class="min-w-0 truncate text-sm leading-4 font-medium text-foreground">
                {session.name || '(unnamed)'}
              </span>
            {/if}
            <span
              class="inline-flex max-w-[92px] shrink-0 items-center gap-1 rounded-full border border-border bg-muted/35 px-1.5 py-px text-[10px] leading-none font-medium text-muted-foreground uppercase"
              title={statusTitle}
              aria-label={statusTitle}
            >
              <StatusDot {status} class="size-1.5" />
              <span class="truncate">{statusLabel}</span>
            </span>
          </span>
          <span class="flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-3.5 text-muted-foreground">
            <span class="min-w-0 truncate">{session.cwd}</span>
            {#if branch}
              <span class="inline-flex min-w-0 shrink-0 items-center gap-0.5">
                <span class="text-muted-foreground/55">·</span>
                <GitBranch class="size-2.5" />
                <span class="max-w-[90px] truncate">{branch}</span>
              </span>
            {/if}
          </span>
        </span>
        {#if workerCount > 0}
          <span
            class="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-muted px-1 text-[11px] text-primary"
            title={`${workerCount} background worker${workerCount === 1 ? '' : 's'}`}
          >
            {workerCount}
          </span>
        {/if}
        {#if kbdIndex !== null}
          <KbdHint keys={['Ctrl', String(kbdIndex)]} class="shrink-0" />
        {/if}
        <div class="flex shrink-0 items-center gap-0.5">
          {#if session.projectId && !session.archivedAt}
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground"
              onclick={archive}
              title="Archive session"
              aria-label={`Archive ${session.name || 'session'}`}
            >
              <Archive />
            </Button>
          {/if}
          {#if session.archivedAt}
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground"
              onclick={restoreFromButton}
              title="Restore session"
              aria-label={`Restore ${session.name || 'session'}`}
            >
              <ArchiveRestore />
            </Button>
          {/if}
          <Button
            variant="ghost"
            size="icon-sm"
            class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            onclick={removeFromButton}
            title="Delete session"
            aria-label={`Delete ${session.name || 'session'}`}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content class="w-52">
    {#if canStart}
      <ContextMenu.Item onSelect={start}>Start</ContextMenu.Item>
    {/if}
    {#if isRunning}
      <ContextMenu.Item onSelect={stop}>Stop</ContextMenu.Item>
    {/if}
    {#if status === 'running'}
      <ContextMenu.Item onSelect={restart}>Restart</ContextMenu.Item>
    {/if}
    <ContextMenu.Separator />
    <ContextMenu.Item onSelect={() => void startEditing()}>
      <Pencil /> <span>Rename</span>
      <ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={edit}>
      <Pencil /> <span>Edit…</span>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={openCwd}>
      <FolderOpen /> <span>Open cwd</span>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={copyCmd}>
      <Copy /> <span>Copy command</span>
    </ContextMenu.Item>
    <ContextMenu.Separator />
    {#if session.projectId && !session.archivedAt}
      <ContextMenu.Item onSelect={() => void archive()}>
        <Archive /> <span>Archive</span>
      </ContextMenu.Item>
    {/if}
    {#if session.archivedAt}
      <ContextMenu.Item onSelect={() => void restore()}>
        <ArchiveRestore /> <span>Restore</span>
      </ContextMenu.Item>
    {/if}
    <ContextMenu.Item variant="destructive" onSelect={remove}>
      <Trash2 /> <span>Delete</span>
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
