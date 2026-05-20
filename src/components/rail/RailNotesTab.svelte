<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    Plus,
    Loader2,
    Check,
    AlertCircle,
    Trash2,
    PencilLine,
    ArrowLeftToLine,
    TextSelect,
    Send,
    Eraser
  } from '@lucide/svelte';
  import { notes } from '../../stores/notes.svelte';
  import { projects } from '../../stores/projects.svelte';
  import { sessions } from '../../stores/sessions.svelte';
  import { confirmStore } from '../../stores/confirm.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import { ipc } from '../../lib/ipc';
  import { sendBracketedPaste } from '../../lib/terminal-paste';
  import { kbdHints } from '../../stores/kbd-hints.svelte';
  import { rightRail } from '../../stores/right-rail.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { Kbd } from '$lib/components/ui/kbd';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as ContextMenu from '$lib/components/ui/context-menu';

  type DialogState =
    | { kind: 'save-draft'; name: string }
    | { kind: 'rename'; filename: string; name: string }
    | null;

  let dialog = $state<DialogState>(null);
  let dialogInput: HTMLInputElement | null = $state(null);
  let textareaEl: HTMLTextAreaElement | null = $state(null);
  let hasSelection = $state(false);

  let activeProjectId = $derived(notes.activeProjectId);
  let activeProject = $derived(activeProjectId ? projects.get(activeProjectId) : null);

  let activeTerminalId = $derived.by<string | null>(() => {
    const sel = sessions.selected;
    if (!sel) return null;
    return sessions.terminalIdFor(sel.id);
  });
  let canSend = $derived(activeTerminalId !== null);

  $effect(() => {
    const id = activeProjectId;
    if (!id) return;
    void notes.ensureLoaded(id).catch(reportError);
  });

  // Debounced auto-save for the currently-open saved note.
  $effect(() => {
    if (!activeProjectId) return;
    if (notes.isDraft) return;
    if (!notes.savedDirty) return;
    const timer = setTimeout(() => {
      void notes.flushSaved().catch(reportError);
    }, 400);
    return () => clearTimeout(timer);
  });

  let editorValue = $derived(notes.isDraft ? notes.draftContent : notes.savedContent);
  let editorPlaceholder = $derived(
    notes.isDraft ? 'Start typing… save when you want to keep it.' : ''
  );
  let editorDisabled = $derived(activeProjectId === null);

  let editorTitle = $derived.by<string>(() => {
    if (!activeProjectId) return '';
    if (notes.isDraft) return 'Untitled draft';
    return notes.selectedFilename ?? '';
  });

  let statusLabel = $derived.by<string>(() => {
    if (!activeProjectId) return '';
    if (notes.isDraft) {
      const dirty = notes.draftContent.trim().length > 0;
      return dirty ? 'Unsaved' : '';
    }
    if (notes.status === 'saving') return 'Saving…';
    if (notes.status === 'error') return notes.errorMessage ?? 'Error';
    if (notes.savedDirty) return 'Unsaved';
    return 'Saved';
  });

  function onTextareaInput(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    if (notes.isDraft) {
      notes.updateDraftContent(target.value);
    } else {
      notes.updateSavedContent(target.value);
    }
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read pasted image'));
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        resolve(result.replace(/^data:[^,]*,/u, ''));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function onTextareaPaste(event: ClipboardEvent): Promise<void> {
    const data = event.clipboardData;
    if (!data) return;
    const files: File[] = [];
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLTextAreaElement;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    const before = target.value.substring(0, start);
    const after = target.value.substring(end);
    try {
      const payloads = await Promise.all(
        files.map(async (file) => ({
          mimeType: file.type,
          dataBase64: await blobToBase64(file)
        }))
      );
      const saved = await notes.pasteImages(payloads);
      if (saved.length === 0) return;
      // Trailing space so the cursor lands ready for the user to keep typing
      // after the path, without having to space first.
      const insertedText = saved.map((img) => img.absolutePath).join(' ') + ' ';
      const newValue = before + insertedText + after;
      if (notes.isDraft) {
        notes.updateDraftContent(newValue);
      } else {
        notes.updateSavedContent(newValue);
      }
      await tick();
      const cursor = start + insertedText.length;
      target.setSelectionRange(cursor, cursor);
      target.focus();
    } catch (err) {
      reportError(err);
    }
  }

  function onTextareaKeydown(event: KeyboardEvent): void {
    const ctrlOrCmd = event.metaKey || event.ctrlKey;
    if (ctrlOrCmd && !event.altKey && event.key === 'Enter') {
      event.preventDefault();
      // ⌘⏎ submits (paste + CR like comments do); ⌘⇧⏎ stays as paste-only.
      if (event.shiftKey) {
        void sendSelectionOrAll();
      } else {
        void sendSelectionOrAllAndSubmit();
      }
      return;
    }
    if (
      ctrlOrCmd &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === 's'
    ) {
      event.preventDefault();
      if (notes.isDraft && notes.draftContent.trim().length > 0) {
        openSaveDialog();
      }
    }
  }

  function readSelection(): string {
    if (!textareaEl) return '';
    const s = textareaEl.selectionStart;
    const e = textareaEl.selectionEnd;
    return s === e ? '' : textareaEl.value.substring(s, e);
  }

  function updateSelection(): void {
    hasSelection = readSelection().length > 0;
  }

  // submit=true mirrors the comments path: bracketed paste + CR so the agent
  // sees one user message and presses enter. Without it, the text lands in
  // the prompt area for the user to edit / submit themselves.
  async function sendText(text: string, submit: boolean): Promise<void> {
    if (!text) return;
    const id = activeTerminalId;
    if (!id) return;
    try {
      await sendBracketedPaste(id, text, submit);
      window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
    } catch (err) {
      reportError(err);
    }
  }

  async function sendAll(): Promise<void> {
    await sendText(editorValue, false);
  }

  async function sendSelection(): Promise<void> {
    await sendText(readSelection(), false);
  }

  async function sendSelectionOrAll(): Promise<void> {
    const sel = readSelection();
    await sendText(sel || editorValue, false);
  }

  async function sendAllAndSubmit(): Promise<void> {
    await sendText(editorValue, true);
    notes.clearCurrent();
  }

  async function sendSelectionAndSubmit(): Promise<void> {
    await sendText(readSelection(), true);
  }

  async function sendSelectionOrAllAndSubmit(): Promise<void> {
    const sel = readSelection();
    await sendText(sel || editorValue, true);
  }

  async function onNewDraft(): Promise<void> {
    if (notes.draftContent.trim().length > 0) {
      const ok = await confirmStore.ask({
        title: 'Discard current draft?',
        message: 'Your unsaved draft will be lost.',
        confirmLabel: 'Discard',
        tone: 'danger'
      });
      if (!ok) return;
      notes.discardDraft();
    }
    notes.newDraft();
    void tick().then(() => textareaEl?.focus());
  }

  async function onClear(): Promise<void> {
    if (editorValue.trim().length === 0) return;
    const isDraft = notes.isDraft;
    const ok = await confirmStore.ask({
      title: isDraft ? 'Clear draft?' : 'Clear note contents?',
      message: isDraft
        ? 'The current draft will be emptied.'
        : 'The note will be saved as empty.',
      confirmLabel: 'Clear',
      tone: 'danger'
    });
    if (!ok) return;
    notes.clearCurrent();
    void tick().then(() => textareaEl?.focus());
  }

  function openSaveDialog(): void {
    dialog = { kind: 'save-draft', name: suggestName(notes.draftContent) };
    void tick().then(() => {
      dialogInput?.focus();
      dialogInput?.select();
    });
  }

  function openRenameDialog(filename: string): void {
    const stem = filename.replace(/\.md$/i, '');
    dialog = { kind: 'rename', filename, name: stem };
    void tick().then(() => {
      dialogInput?.focus();
      dialogInput?.select();
    });
  }

  async function confirmDialog(): Promise<void> {
    if (!dialog) return;
    const name = dialog.name.trim();
    if (!name) return;
    try {
      if (dialog.kind === 'save-draft') {
        await notes.saveDraft(name);
      } else {
        await notes.rename(dialog.filename, name);
      }
      dialog = null;
    } catch (err) {
      reportError(err);
    }
  }

  function onDialogKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void confirmDialog();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dialog = null;
    }
  }

  async function onDelete(filename: string): Promise<void> {
    const ok = await confirmStore.ask({
      title: 'Delete note',
      message: `Delete "${filename}"? This can't be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger'
    });
    if (!ok) return;
    try {
      await notes.remove(filename);
    } catch (err) {
      reportError(err);
    }
  }

  async function onSelectNote(filename: string): Promise<void> {
    try {
      if (notes.selectedFilename === filename) {
        // Re-clicking the active saved note returns to the draft view so an
        // in-progress untitled draft (preserved in the store) is reachable
        // again — otherwise selecting a saved note hides the draft with no UI
        // path back short of the New button's discard prompt.
        notes.newDraft();
      } else {
        await notes.selectNote(filename);
      }
      void tick().then(() => textareaEl?.focus());
    } catch (err) {
      reportError(err);
    }
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

  function timeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return 'now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
  }

  function statusClass(): string {
    if (!activeProjectId) return 'text-muted-foreground';
    if (notes.isDraft) return 'text-muted-foreground';
    if (notes.status === 'saving') return 'text-muted-foreground';
    if (notes.status === 'error') return 'text-destructive';
    if (notes.savedDirty) return 'text-muted-foreground';
    return 'text-emerald-500';
  }

  function normalizeForDisplay(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return '';
    return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  }

  onMount(() => {
    const onRefocus = () => {
      if (rightRail.activeTab !== 'notes') return;
      textareaEl?.focus();
    };
    window.addEventListener('soloe:refocus-rail', onRefocus);
    return () => window.removeEventListener('soloe:refocus-rail', onRefocus);
  });
</script>

<div class="flex min-h-0 min-w-0 flex-1 flex-col">
  <header class="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
    <div class="flex min-w-0 flex-col">
      <span class="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">Notes</span>
      <span class="truncate text-xs text-foreground">
        {activeProject?.name ?? 'No project selected'}
      </span>
    </div>
    <Button
      variant="outline"
      size="xs"
      onclick={() => void onNewDraft()}
      disabled={!activeProjectId}
      aria-label="New note"
      title="New note"
    >
      <Plus class="size-3" />
      <span>New</span>
    </Button>
  </header>

  {#if !activeProjectId}
    <div class="flex flex-1 items-center justify-center px-3 text-center text-xs text-muted-foreground">
      Select a session in a project to view its notes.
    </div>
  {:else}
    <ScrollArea class="max-h-48 shrink-0 border-b border-border">
      <ul class="flex flex-col gap-px p-1.5">
        {#if notes.notes.length === 0 && !notes.isDraft && !notes.selectedFilename}
          <li class="px-1.5 py-2 text-xs text-muted-foreground">
            No notes yet. Click <span class="font-medium text-foreground">New</span> to start.
          </li>
        {/if}
        {#each notes.notes as note (note.filename)}
          {@const selected = notes.selectedFilename === note.filename}
          <li>
            <ContextMenu.Root>
              <ContextMenu.Trigger>
                {#snippet child({ props })}
                  <button
                    {...props}
                    type="button"
                    class={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors ${
                      selected
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                    title={selected ? 'Click again to return to the untitled draft' : note.filename}
                    onclick={() => void onSelectNote(note.filename)}
                  >
                    <span class="truncate">{note.filename}</span>
                    <span class="shrink-0 text-[10px] text-muted-foreground">{timeAgo(note.updatedAt)}</span>
                  </button>
                {/snippet}
              </ContextMenu.Trigger>
              <ContextMenu.Content class="w-44">
                <ContextMenu.Item onclick={() => openRenameDialog(note.filename)}>
                  <PencilLine class="size-3.5" />
                  Rename
                </ContextMenu.Item>
                <ContextMenu.Separator />
                <ContextMenu.Item
                  class="text-destructive focus:text-destructive"
                  onclick={() => void onDelete(note.filename)}
                >
                  <Trash2 class="size-3.5" />
                  Delete
                </ContextMenu.Item>
              </ContextMenu.Content>
            </ContextMenu.Root>
          </li>
        {/each}
      </ul>
    </ScrollArea>

    <section class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div class="flex min-w-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        <span class="truncate text-xs font-medium">
          {editorTitle || 'Pick a note or create a new one'}
        </span>
        <span class={`flex shrink-0 items-center gap-1 text-[10px] ${statusClass()}`}>
          {#if notes.status === 'saving'}
            <Loader2 class="size-3 animate-spin" />
          {:else if statusLabel === 'Saved'}
            <Check class="size-3" />
          {:else if notes.status === 'error'}
            <AlertCircle class="size-3" />
          {/if}
          {statusLabel}
        </span>
      </div>
      <div class="flex items-center gap-1.5 border-b border-border px-3 py-1.5">
        <Button
          variant="default"
          size="xs"
          class="min-w-0 flex-1 justify-center gap-1.5 px-2"
          onclick={() => void sendAllAndSubmit()}
          disabled={!canSend || editorValue.trim().length === 0}
          aria-label="Send"
          title="Send (paste and submit)"
        >
          {#if kbdHints.altHeld}
            <Kbd keys={['Ctrl', 'Enter']} />
          {:else}
            <Send class="size-3 shrink-0" />
            <span class="min-w-0 truncate">Send</span>
          {/if}
        </Button>
        <Button
          variant="outline"
          size="xs"
          class="min-w-0 flex-1 justify-center gap-1.5 px-2"
          onclick={() => void sendAll()}
          disabled={!canSend || editorValue.trim().length === 0}
          aria-label="Add as context"
          title="Add as context (paste without submitting)"
        >
          {#if kbdHints.altHeld}
            <Kbd keys={['Ctrl', 'Shift', 'Enter']} />
          {:else}
            <ArrowLeftToLine class="size-3 shrink-0" />
            <span class="min-w-0 truncate">Add as context</span>
          {/if}
        </Button>
        {#if notes.isDraft}
          <Button
            variant="outline"
            size="xs"
            class="min-w-0 shrink-0 gap-1.5 px-2"
            onclick={openSaveDialog}
            disabled={notes.draftContent.trim().length === 0}
            aria-label="Save"
          >
            {#if kbdHints.altHeld}
              <Kbd keys={['Ctrl', 'S']} />
            {:else}
              <span class="min-w-0 truncate">Save</span>
            {/if}
          </Button>
        {/if}
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-destructive"
          onclick={() => void onClear()}
          disabled={editorValue.trim().length === 0}
          aria-label="Clear contents"
          title="Clear"
        >
          <Eraser class="size-3" />
        </Button>
      </div>
      <ContextMenu.Root>
        <ContextMenu.Trigger>
          {#snippet child({ props })}
            <textarea
              {...props}
              bind:this={textareaEl}
              value={editorValue}
              placeholder={editorPlaceholder}
              oninput={onTextareaInput}
              onkeydown={onTextareaKeydown}
              onkeyup={updateSelection}
              onmouseup={updateSelection}
              onselect={updateSelection}
              onfocus={updateSelection}
              onblur={updateSelection}
              onpaste={(e) => void onTextareaPaste(e)}
              disabled={editorDisabled}
              spellcheck="false"
              class="flex-1 resize-none border-0 bg-transparent px-4 py-3 font-mono text-xs leading-relaxed outline-none placeholder:text-muted-foreground/70"
              aria-label="Note editor"
            ></textarea>
          {/snippet}
        </ContextMenu.Trigger>
        <ContextMenu.Content class="w-56">
          <ContextMenu.Item
            disabled={!canSend || editorValue.trim().length === 0}
            onclick={() => void sendAllAndSubmit()}
          >
            <Send class="size-3.5" />
            Send
          </ContextMenu.Item>
          {#if hasSelection}
            <ContextMenu.Item disabled={!canSend} onclick={() => void sendSelectionAndSubmit()}>
              <TextSelect class="size-3.5" />
              Send selection
            </ContextMenu.Item>
          {/if}
          <ContextMenu.Separator />
          <ContextMenu.Item
            disabled={!canSend || editorValue.trim().length === 0}
            onclick={() => void sendAll()}
          >
            <ArrowLeftToLine class="size-3.5" />
            Add as context
          </ContextMenu.Item>
          {#if hasSelection}
            <ContextMenu.Item disabled={!canSend} onclick={() => void sendSelection()}>
              <TextSelect class="size-3.5" />
              Add selection as context
            </ContextMenu.Item>
          {/if}
        </ContextMenu.Content>
      </ContextMenu.Root>
    </section>
  {/if}
</div>

<Dialog.Root open={dialog !== null} onOpenChange={(open) => (dialog = open ? dialog : null)}>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>
        {dialog?.kind === 'rename' ? 'Rename note' : 'Save note'}
      </Dialog.Title>
      <Dialog.Description>
        {dialog?.kind === 'rename'
          ? 'Pick a new filename for this note.'
          : 'Pick a filename to save this draft as.'}
      </Dialog.Description>
    </Dialog.Header>
    {#if dialog}
      <div class="flex flex-col gap-2 py-1">
        <Input
          bind:ref={dialogInput}
          bind:value={dialog.name}
          placeholder="my-note"
          onkeydown={onDialogKeydown}
          aria-label="Note filename"
        />
        <p class="text-[11px] text-muted-foreground">
          Saved as <span class="font-mono">{normalizeForDisplay(dialog.name)}</span>
        </p>
      </div>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (dialog = null)}>Cancel</Button>
      <Button size="sm" onclick={() => void confirmDialog()} disabled={!dialog?.name.trim()}>
        {dialog?.kind === 'rename' ? 'Rename' : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
