<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    AlertCircle,
    ArrowLeftToLine,
    Check,
    ChevronDown,
    Loader2,
    NotebookPen,
    Plus,
    Save,
    Send,
    X
  } from '@lucide/svelte';
  import { notes } from '../stores/notes.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { sendBracketedPaste } from '../lib/terminal-paste';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import ElementSourceStickyViewer from './ElementSourceStickyViewer.svelte';

  type StickyLayout = {
    left: number;
    top: number;
    width: number;
    height: number;
  };

  type ResizeHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

  type Interaction = {
    kind: 'drag' | 'resize';
    handle?: ResizeHandle;
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    origin: StickyLayout;
    target: HTMLElement;
  };

  const LAYOUT_KEY = 'soloe.notes.sticky-layout.v2';
  const DRAG_THRESHOLD = 4;
  const VISIBLE_EDGE = 24;

  function defaultLayout(): StickyLayout {
    const viewportWidth = typeof window === 'undefined' ? 960 : window.innerWidth;
    return {
      left: Math.max(16, viewportWidth - 360),
      top: 44,
      width: 360,
      height: 240
    };
  }

  function readLayout(): StickyLayout {
    const fallback = defaultLayout();
    if (typeof localStorage === 'undefined') return fallback;
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      if (!raw) return fallback;
      const value = JSON.parse(raw) as Partial<StickyLayout>;
      return {
        left: typeof value.left === 'number' && Number.isFinite(value.left) ? value.left : fallback.left,
        top: typeof value.top === 'number' && Number.isFinite(value.top) ? value.top : fallback.top,
        width:
          typeof value.width === 'number' && Number.isFinite(value.width)
            ? Math.max(0, value.width)
            : fallback.width,
        height:
          typeof value.height === 'number' && Number.isFinite(value.height)
            ? Math.max(0, value.height)
            : fallback.height
      };
    } catch {
      return fallback;
    }
  }

  function keepVisible(value: StickyLayout): StickyLayout {
    if (typeof window === 'undefined') return value;
    const minLeft = VISIBLE_EDGE - Math.max(value.width, VISIBLE_EDGE);
    const maxLeft = Math.max(0, window.innerWidth - VISIBLE_EDGE);
    const minTop = VISIBLE_EDGE - Math.max(value.height, VISIBLE_EDGE);
    const maxTop = Math.max(0, window.innerHeight - VISIBLE_EDGE);
    return {
      ...value,
      left: Math.min(maxLeft, Math.max(minLeft, value.left)),
      top: Math.min(maxTop, Math.max(minTop, value.top))
    };
  }

  let layout = $state<StickyLayout>(defaultLayout());
  let layoutReady = $state(false);
  let interaction = $state<Interaction | null>(null);
  let saveDialog = $state<{ name: string } | null>(null);
  let saveInput: HTMLInputElement | null = $state(null);
  let suppressNextClick = false;

  let activeProjectId = $derived(notes.activeProjectId);
  let activeTerminalId = $derived.by<string | null>(() => {
    const selected = sessions.selected;
    return selected ? sessions.terminalIdFor(selected.id) : null;
  });
  let editorValue = $derived(notes.isDraft ? notes.draftContent : notes.savedContent);
  let editorTitle = $derived.by<string>(() => {
    if (!activeProjectId) return 'No note selected';
    return notes.isDraft ? 'Untitled draft' : notes.selectedFilename ?? 'No note selected';
  });
  let statusLabel = $derived.by<string>(() => {
    if (!activeProjectId) return 'No project';
    if (notes.isDraft) return notes.draftContent.trim().length > 0 ? 'Unsaved' : 'Draft';
    if (notes.status === 'saving') return 'Saving…';
    if (notes.status === 'error') return notes.errorMessage ?? 'Error';
    if (notes.savedDirty) return 'Unsaved';
    return 'Saved';
  });
  let hasContent = $derived(editorValue.trim().length > 0);
  let canSend = $derived(activeTerminalId !== null && hasContent);

  $effect(() => {
    if (!notes.stickyOpen) return;
    const id = activeProjectId;
    if (!id) return;
    void notes.ensureLoaded(id).catch(reportError);
  });

  $effect(() => {
    if (!notes.stickyOpen) return;
    const id = notes.activeProjectId;
    const identityKey = notes.activeWorktreeKey;
    if (!id || !identityKey) return;
    void notes.restoreForActiveWorktree().catch(reportError);
  });

  $effect(() => {
    if (!layoutReady || typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Best effort: the sticky note remains usable when storage is unavailable.
    }
  });

  onMount(() => {
    layout = keepVisible(readLayout());
    layoutReady = true;

    const onViewportResize = () => {
      layout = keepVisible(layout);
    };
    const onPointerMove = (event: PointerEvent) => {
      const current = interaction;
      if (!current || current.pointerId !== event.pointerId) return;
      const dx = event.clientX - current.startX;
      const dy = event.clientY - current.startY;
      if (current.kind === 'drag' && !current.active) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        interaction = { ...current, active: true };
        event.preventDefault();
      }
      if (current.kind === 'drag') {
        layout = keepVisible({
          ...layout,
          left: current.origin.left + dx,
          top: current.origin.top + dy
        });
      } else {
        const handle = current.handle ?? 'se';
        const resizesWidth = handle.includes('e') || handle.includes('w');
        const resizesHeight = handle.includes('n') || handle.includes('s');
        const nextLayout: StickyLayout = {
          ...layout,
          left: handle.includes('w') ? current.origin.left + dx : current.origin.left,
          top: handle.includes('n') ? current.origin.top + dy : current.origin.top,
          width: resizesWidth
            ? Math.max(0, handle.includes('w') ? current.origin.width - dx : current.origin.width + dx)
            : current.origin.width,
          height: resizesHeight
            ? Math.max(0, handle.includes('n') ? current.origin.height - dy : current.origin.height + dy)
            : current.origin.height
        };
        layout = keepVisible(nextLayout);
      }
    };
    const onPointerEnd = (event: PointerEvent) => {
      const current = interaction;
      if (!current || current.pointerId !== event.pointerId) return;
      interaction = null;
      if (current.kind === 'drag' && current.active) {
        suppressNextClick = true;
        event.preventDefault();
        window.setTimeout(() => {
          suppressNextClick = false;
        }, 0);
      }
      try {
        if (current.target.hasPointerCapture(current.pointerId)) {
          current.target.releasePointerCapture(current.pointerId);
        }
      } catch {
        // The card may have closed while a pointer was captured.
      }
    };

    window.addEventListener('resize', onViewportResize);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    const onClickCapture = (event: MouseEvent) => {
      if (!suppressNextClick) return;
      suppressNextClick = false;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('click', onClickCapture, true);
    return () => {
      window.removeEventListener('resize', onViewportResize);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      window.removeEventListener('click', onClickCapture, true);
    };
  });

  function beginInteraction(
    event: PointerEvent,
    kind: Interaction['kind'],
    handle?: ResizeHandle
  ): void {
    if (event.button !== 0) return;
    const button =
      kind === 'drag' && event.target instanceof Element
        ? event.target.closest('button')
        : null;
    const active = button === null;
    if (active) {
      event.preventDefault();
      event.stopPropagation();
    }
    const target = (button ?? event.currentTarget) as HTMLElement;
    target.setPointerCapture(event.pointerId);
    interaction = {
      kind,
      handle,
      active,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: { ...layout },
      target
    };
  }

  function onEditorInput(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    if (notes.isDraft) {
      notes.updateDraftContent(target.value);
    } else {
      notes.updateSavedContent(target.value);
    }
  }

  function onEditorKeydown(event: KeyboardEvent): void {
    const commandKey = event.metaKey || event.ctrlKey;
    if (!commandKey || event.altKey) return;

    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      openSaveDialog();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void sendCurrent(!event.shiftKey);
    }
  }

  async function selectDraft(): Promise<void> {
    if (!activeProjectId) return;
    try {
      await notes.newDraft();
    } catch (err) {
      reportError(err);
    }
  }

  async function selectNote(filename: string): Promise<void> {
    try {
      await notes.selectNote(filename);
    } catch (err) {
      reportError(err);
    }
  }

  async function sendText(text: string, submit: boolean): Promise<boolean> {
    if (!text.trim() || !activeTerminalId) return false;
    const selected = sessions.selected;
    try {
      await sendBracketedPaste(
        activeTerminalId,
        text,
        submit,
        selected ? sessions.providerFor(selected.id) : null
      );
      window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
      return true;
    } catch (err) {
      reportError(err);
      return false;
    }
  }

  async function sendCurrent(submit: boolean): Promise<void> {
    if (!(await sendText(editorValue, submit))) return;
    if (submit) notes.clearCurrent();
  }

  function suggestName(content: string): string {
    const firstLine = content.split('\n')[0]?.trim() ?? '';
    const slug = firstLine
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40);
    return slug || 'untitled';
  }

  function normalizeForDisplay(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '';
    return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  }

  function openSaveDialog(): void {
    if (!activeProjectId || !notes.isDraft || !hasContent) return;
    saveDialog = { name: suggestName(notes.draftContent) };
    void tick().then(() => {
      saveInput?.focus();
      saveInput?.select();
    });
  }

  async function confirmSave(): Promise<void> {
    if (!saveDialog || !saveDialog.name.trim()) return;
    try {
      await notes.saveDraft(saveDialog.name.trim());
      saveDialog = null;
    } catch (err) {
      reportError(err);
    }
  }

  function onSaveKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void confirmSave();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      saveDialog = null;
    }
  }
</script>

{#if notes.stickyOpen}
  <div
    class="notes-sticky-card fixed z-[80]"
    style={`left: ${layout.left}px; top: ${layout.top}px; width: ${layout.width}px; height: ${layout.height}px;`}
  >
    <div
      class="notes-sticky-body flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card/95 text-card-foreground shadow-xl backdrop-blur-sm"
    >
      <header
        role="toolbar"
        aria-label="Sticky note window"
        tabindex="-1"
        class={`flex min-h-0 min-w-0 shrink-0 touch-none select-none items-center gap-1 border-b border-border/70 px-1.5 py-1 ${
          interaction?.kind === 'drag' && interaction.active ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onpointerdown={(event) => beginInteraction(event, 'drag')}
      >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            {#snippet child({ props })}
              <button
                {...props}
                type="button"
                class="notes-sticky-title flex min-w-0 max-w-[60%] flex-[0_1_auto] cursor-pointer items-center gap-1 overflow-hidden rounded px-1 py-0.5 text-left text-[11px] font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring active:cursor-grabbing"
                title={editorTitle}
                aria-label={`Select note: ${editorTitle}`}
              >
                <span class="block min-w-0 truncate">{editorTitle}</span>
                <ChevronDown class="size-3 shrink-0 text-muted-foreground" />
              </button>
            {/snippet}
          </DropdownMenu.Trigger>
          <DropdownMenu.Content
            align="start"
            side="bottom"
            class="z-[120] max-h-64 w-64 overflow-y-auto"
          >
            <DropdownMenu.Label>Choose note</DropdownMenu.Label>
            <DropdownMenu.Item disabled={!activeProjectId} onSelect={() => void selectDraft()}>
              <NotebookPen class="size-3.5" />
              <span class="min-w-0 flex-1 truncate">Untitled draft</span>
              {#if notes.isDraft}<Check class="ml-auto size-3" />{/if}
            </DropdownMenu.Item>
            {#each notes.notes as note (note.filename)}
              <DropdownMenu.Item onSelect={() => void selectNote(note.filename)}>
                <NotebookPen class="size-3.5" />
                <span class="min-w-0 flex-1 truncate" title={note.filename}>{note.filename}</span>
                {#if notes.selectedFilename === note.filename}<Check class="ml-auto size-3" />{/if}
              </DropdownMenu.Item>
            {/each}
            {#if notes.notes.length === 0}
              <DropdownMenu.Item disabled>
                <span class="text-muted-foreground">No saved notes yet</span>
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>
        <Button
          variant="ghost"
          size="icon-xs"
          class="notes-sticky-control shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          onclick={() => void selectDraft()}
          disabled={!activeProjectId}
          aria-label="New note"
          title="New note"
        >
          <Plus class="size-3" />
        </Button>
        <div class="min-w-2 flex-1" aria-hidden="true"></div>
        <div
          class={`notes-sticky-header-status flex min-w-0 max-w-[25%] shrink items-center justify-end gap-1 text-right text-[10px] ${
            notes.status === 'error'
              ? 'text-destructive'
              : notes.status === 'saved'
                ? 'text-emerald-500'
                : 'text-muted-foreground'
          }`}
          role="status"
          aria-live="polite"
          title={statusLabel}
        >
          {#if notes.status === 'saving'}
            <Loader2 class="size-3 shrink-0 animate-spin" />
          {:else if notes.status === 'saved' && !notes.savedDirty}
            <Check class="size-3 shrink-0" />
          {:else if notes.status === 'error'}
            <AlertCircle class="size-3 shrink-0" />
          {/if}
          <span class="notes-sticky-status-label min-w-0 truncate">{statusLabel}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          class="notes-sticky-control relative z-20 shrink-0 cursor-grab text-muted-foreground hover:text-foreground active:cursor-grabbing"
          onclick={() => notes.setStickyOpen(false)}
          aria-label="Close sticky note"
          title="Close sticky note"
        >
          <X class="size-3" />
        </Button>
      </header>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 p-1.5">
        <textarea
          value={editorValue}
          placeholder={notes.isDraft ? 'Write a note…' : ''}
          disabled={!activeProjectId}
          spellcheck="false"
          aria-label="Sticky note editor"
          class="notes-sticky-editor min-h-0 min-w-0 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 font-mono text-[11px] leading-relaxed outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-60"
          oninput={onEditorInput}
          onkeydown={onEditorKeydown}
        ></textarea>

        <div class="notes-sticky-actions flex min-h-0 min-w-0 shrink-0 gap-1">
          {#if notes.isDraft}
            <Button
              variant="outline"
              size="xs"
              class="notes-sticky-action min-w-0 flex-1 cursor-grab gap-1 overflow-hidden px-1.5 active:cursor-grabbing"
              onclick={openSaveDialog}
              onpointerdown={(event) => beginInteraction(event, 'drag')}
              disabled={!hasContent}
              aria-label="Save note"
              title="Save note"
            >
              <Save class="size-3 shrink-0" />
              <span class="notes-sticky-action-label min-w-0 truncate">Save</span>
            </Button>
          {/if}
          <Button
            variant="default"
            size="xs"
            class="notes-sticky-action min-w-0 flex-1 cursor-grab gap-1 overflow-hidden px-1.5 active:cursor-grabbing"
            onclick={() => void sendCurrent(true)}
            onpointerdown={(event) => beginInteraction(event, 'drag')}
            disabled={!canSend}
            aria-label="Send note"
            title="Send note"
          >
            <Send class="size-3 shrink-0" />
            <span class="notes-sticky-action-label min-w-0 truncate">Send</span>
          </Button>
          <Button
            variant="outline"
            size="xs"
            class="notes-sticky-action min-w-0 flex-1 cursor-grab gap-1 overflow-hidden px-1.5 active:cursor-grabbing"
            onclick={() => void sendCurrent(false)}
            onpointerdown={(event) => beginInteraction(event, 'drag')}
            disabled={!canSend}
            aria-label="Add as context"
            title="Add as context"
          >
            <ArrowLeftToLine class="size-3 shrink-0" />
            <span class="notes-sticky-action-label min-w-0 truncate">Add as context</span>
          </Button>
        </div>
      </div>
    </div>

    <button
      type="button"
      class="absolute top-[-2px] left-4 right-4 z-10 h-2 touch-none cursor-n-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from top edge"
      onpointerdown={(event) => beginInteraction(event, 'resize', 'n')}
    ></button>
    <button
      type="button"
      class="absolute top-4 right-[-2px] bottom-4 z-10 w-2 touch-none cursor-e-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from right edge"
      onpointerdown={(event) => beginInteraction(event, 'resize', 'e')}
    ></button>
    <button
      type="button"
      class="absolute right-4 bottom-[-2px] left-4 z-10 h-2 touch-none cursor-s-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from bottom edge"
      onpointerdown={(event) => beginInteraction(event, 'resize', 's')}
    ></button>
    <button
      type="button"
      class="absolute top-4 bottom-4 left-[-2px] z-10 w-2 touch-none cursor-w-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from left edge"
      onpointerdown={(event) => beginInteraction(event, 'resize', 'w')}
    ></button>
    <button
      type="button"
      class="absolute top-[-2px] left-[-2px] z-10 size-4 touch-none cursor-nwse-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from top left"
      onpointerdown={(event) => beginInteraction(event, 'resize', 'nw')}
    ></button>
    <button
      type="button"
      class="absolute top-[-2px] right-[-2px] z-10 size-4 touch-none cursor-nesw-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from top right"
      onpointerdown={(event) => beginInteraction(event, 'resize', 'ne')}
    ></button>
    <button
      type="button"
      class="absolute bottom-[-2px] left-[-2px] z-10 size-4 touch-none cursor-nesw-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from bottom left"
      onpointerdown={(event) => beginInteraction(event, 'resize', 'sw')}
    ></button>
    <button
      type="button"
      class="absolute right-[-2px] bottom-[-2px] z-10 size-4 touch-none cursor-nwse-resize opacity-0 focus-visible:opacity-100"
      aria-label="Resize sticky note from bottom right"
      onpointerdown={(event) => beginInteraction(event, 'resize', 'se')}
    ></button>
  </div>
{/if}

<ElementSourceStickyViewer />

<Dialog.Root open={saveDialog !== null} onOpenChange={(open) => (saveDialog = open ? saveDialog : null)}>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Save note</Dialog.Title>
      <Dialog.Description>Pick a filename to save this draft as.</Dialog.Description>
    </Dialog.Header>
    {#if saveDialog}
      <div class="flex flex-col gap-2 py-1">
        <Input
          bind:ref={saveInput}
          bind:value={saveDialog.name}
          placeholder="my-note"
          onkeydown={onSaveKeydown}
          aria-label="Note filename"
        />
        <p class="text-[11px] text-muted-foreground">
          Saved as <span class="font-mono">{normalizeForDisplay(saveDialog.name)}</span>
        </p>
      </div>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (saveDialog = null)}>Cancel</Button>
      <Button size="sm" onclick={() => void confirmSave()} disabled={!saveDialog?.name.trim()}>
        Save
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .notes-sticky-card {
    container-type: inline-size;
    min-width: 0;
    min-height: 0;
    max-width: none;
    max-height: none;
    user-select: none;
  }

  .notes-sticky-editor {
    user-select: text;
  }

  @container (max-width: 220px) {
    .notes-sticky-action-label {
      display: none;
    }

    .notes-sticky-action {
      flex: 0 1 auto;
      padding-inline: 0.35rem;
    }
  }

  @container (max-width: 150px) {
    .notes-sticky-status-label {
      display: none;
    }

    .notes-sticky-actions {
      gap: 0.15rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .notes-sticky-card * {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: 0.01ms !important;
    }
  }
</style>
