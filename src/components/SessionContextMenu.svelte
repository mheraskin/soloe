<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import {
    ArrowRight,
    ChevronRight,
    CircleSlash,
    Copy,
    FolderOpen,
    Pencil,
    Trash2
  } from '@lucide/svelte';
  import type { Session, SessionColor } from '@shared/types/sessions.js';
  import { SESSION_COLOR_TOKENS } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { sessionContextMenus } from '../stores/session-context-menus.svelte';
  import { sessionHandoff } from '../stores/session-handoff.svelte';
  import { modal } from '../stores/modal.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { ipc } from '../lib/ipc';
  import { confirmDeleteSession } from '../lib/session-delete-confirmation';
  import { cn } from '$lib/utils';
  import * as ContextMenu from '$lib/components/ui/context-menu';

  const COLOR_LABELS: Record<SessionColor, string> = {
    red: 'Red',
    orange: 'Orange',
    amber: 'Amber',
    yellow: 'Yellow',
    green: 'Green',
    teal: 'Teal',
    cyan: 'Cyan',
    blue: 'Blue',
    violet: 'Violet',
    pink: 'Pink'
  };

  const QUICK_COLORS: readonly SessionColor[] = ['red', 'amber', 'green', 'blue', 'violet'];

  let {
    session,
    onRename = null,
    trigger
  }: {
    session: Session;
    onRename?: (() => void | Promise<void>) | null;
    trigger: Snippet<[{ props: Record<string, unknown> }]>;
  } = $props();

  let menuOpen = $state(false);
  let paletteExpanded = $state(false);

  let status = $derived(sessions.statusFor(session.id));
  let canStart = $derived(status === 'stopped' || status === 'exited' || status === 'error');
  let isRunning = $derived(status === 'running' || status === 'starting');
  let visibleColors = $derived(
    paletteExpanded
      ? [...SESSION_COLOR_TOKENS]
      : SESSION_COLOR_TOKENS.filter((c) => QUICK_COLORS.includes(c) || c === session.color)
  );

  onMount(() => sessionContextMenus.onCloseAll(() => {
    menuOpen = false;
    paletteExpanded = false;
  }));

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

  function continueElsewhere() {
    sessionHandoff.open(session.id);
  }

  async function rename() {
    if (onRename) {
      await onRename();
      return;
    }
    edit();
  }

  async function remove() {
    const ok = await confirmDeleteSession(session);
    if (!ok) return;
    try { await sessions.remove(session.id); } catch (err) { reportError(err); }
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

  async function setColor(color: SessionColor | null) {
    if ((session.color ?? null) === color) return;
    try {
      await sessions.update(session.id, { color: color ?? undefined });
    } catch (err) {
      reportError(err);
    }
  }

  function colorVar(color: SessionColor): string {
    return `var(--session-${color})`;
  }
</script>

<ContextMenu.Root
  open={menuOpen}
  onOpenChange={(v) => {
    menuOpen = v;
    if (!v) paletteExpanded = false;
  }}
>
  <ContextMenu.Trigger>
    {#snippet child({ props })}
      {@render trigger({ props })}
    {/snippet}
  </ContextMenu.Trigger>
  <ContextMenu.Content class="w-60">
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
    <ContextMenu.Item onSelect={() => void rename()}>
      <Pencil /> <span>Rename</span>
      <ContextMenu.Shortcut>F2</ContextMenu.Shortcut>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={edit}>
      <Pencil /> <span>Edit...</span>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={openCwd}>
      <FolderOpen /> <span>Open cwd</span>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={copyCmd}>
      <Copy /> <span>Copy command</span>
    </ContextMenu.Item>
    <ContextMenu.Item onSelect={continueElsewhere}>
      <ArrowRight /> <span>Continue in another session</span>
    </ContextMenu.Item>
    <ContextMenu.Separator />
    <div class="flex items-center gap-2 px-1 py-1">
      <div
        class={cn(
          'flex min-w-0 flex-1 items-center',
          paletteExpanded ? 'flex-wrap gap-1.5' : 'justify-between'
        )}
      >
        <button
          type="button"
          class={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-transform hover:scale-110 hover:text-foreground',
            !session.color && 'text-foreground ring-2 ring-foreground ring-offset-1 ring-offset-popover'
          )}
          onclick={(e) => {
            e.stopPropagation();
            void setColor(null);
            menuOpen = false;
          }}
          title="No color"
          aria-label="Set no color"
        >
          <CircleSlash class="size-5" />
        </button>
        {#each visibleColors as token (token)}
          <button
            type="button"
            class={cn(
              'size-5 shrink-0 rounded-full border border-border/60 transition-transform hover:scale-110',
              session.color === token && 'ring-2 ring-foreground ring-offset-1 ring-offset-popover'
            )}
            style={`background-color: ${colorVar(token)}`}
            onclick={(e) => {
              e.stopPropagation();
              void setColor(session.color === token ? null : token);
              menuOpen = false;
            }}
            title={COLOR_LABELS[token]}
            aria-label={session.color === token ? `Clear color ${COLOR_LABELS[token]}` : `Set color ${COLOR_LABELS[token]}`}
          ></button>
        {/each}
      </div>
      <button
        type="button"
        class="shrink-0 self-start rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onclick={(e) => {
          e.stopPropagation();
          paletteExpanded = !paletteExpanded;
        }}
        title={paletteExpanded ? 'Collapse palette' : 'Expand palette'}
        aria-label={paletteExpanded ? 'Collapse palette' : 'Expand palette'}
        aria-expanded={paletteExpanded}
      >
        <ChevronRight
          class={cn('size-3.5 transition-transform', paletteExpanded && 'rotate-90')}
        />
      </button>
    </div>
    <ContextMenu.Separator />
    <ContextMenu.Item variant="destructive" onSelect={remove}>
      <Trash2 /> <span>Delete</span>
      <ContextMenu.Shortcut>Ctrl+Del</ContextMenu.Shortcut>
    </ContextMenu.Item>
  </ContextMenu.Content>
</ContextMenu.Root>
