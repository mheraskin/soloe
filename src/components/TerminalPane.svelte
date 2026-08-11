<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { TerminalId } from '@shared/types/terminal.js';
  import type { SessionId } from '@shared/types/sessions.js';
  import { effectiveAgentProvider, launchKind } from '@shared/types/sessions.js';
  import { ipc, rendererBackendTransportKind } from '../lib/ipc';
  import type { TerminalPresentation as TerminalOutputPresentationLease } from '../lib/terminal-output-router';
  import {
    createTerminalPresentationFactory,
    defaultTerminalPresentationConfiguration,
    type TerminalPresentation
  } from '../lib/terminal-presentation';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { nav } from '../stores/nav.svelte';
  import { sidebar } from '../stores/sidebar.svelte';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import * as ContextMenu from '$lib/components/ui/context-menu';
  import { Copy, Loader2, MessageSquarePlus, Send, X } from '@lucide/svelte';
  import AskAgentPopover from './ask-agent/AskAgentPopover.svelte';
  import { Keymap, shiftNumberIndexFromEvent, tabIndexFromEvent } from '../lib/keymap';
  import { toggleRailTabAndFocus } from '../lib/rail-focus';
  import {
    AGENT_IMAGE_PASTE_SEQUENCE,
    ctrlSlashSequence,
    isClipboardPasteShortcut,
    SHIFT_ENTER_SEQUENCE,
    shouldPasteImageViaSavedPath,
    shouldSendShiftEnterSequence
  } from '../lib/terminal-input';
  import type { ClipboardImagePayload } from '@shared/types/files.js';

  let {
    terminalId,
    sessionId,
    visible,
    focused
  }: {
    terminalId: TerminalId;
    sessionId: SessionId;
    visible: boolean;
    focused: boolean;
  } = $props();

  let terminalScrollback = $derived(
    settings.current.terminal.keepFullHistory ? 4_294_967_295 : 5000
  );
  let presentationConfiguration = $derived(
    defaultTerminalPresentationConfiguration(
      settings.current.terminal.fontSize,
      terminalScrollback
    )
  );
  let compactViewport = $state(window.matchMedia('(max-width: 767px)').matches);
  let host: HTMLDivElement | undefined = $state();
  let presentation = $state.raw<TerminalPresentation | null>(null);
  let outputLease: TerminalOutputPresentationLease | null = null;
  let findInput: HTMLInputElement | null = $state(null);
  let findOpen = $state(false);
  let findQuery = $state('');
  let ready = $state(false);
  let loadingLabel = $derived(
    sessions.runtime[sessionId]?.status === 'starting' ? 'Starting' : 'Restoring terminal'
  );
  let chipText = $state('');
  let chipAnchor = $state<{ top: number; left: number } | null>(null);
  let chipEl: HTMLButtonElement | null = $state(null);
  let askOpen = $state(false);
  let askSelection = $state('');
  let menuHasSelection = $state(false);

  const READY_QUIET_MS = 300;
  const READY_HARD_CAP_MS = 5000;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  onMount(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const update = () => {
      compactViewport = media.matches;
    };
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  });

  function shouldAutofocusTerminal(): boolean {
    return !compactViewport || !window.matchMedia('(pointer: coarse)').matches;
  }

  function clearReadyTimers(): void {
    if (quietTimer) clearTimeout(quietTimer);
    if (capTimer) clearTimeout(capTimer);
    quietTimer = null;
    capTimer = null;
  }

  function markReady(): void {
    ready = true;
    clearReadyTimers();
  }

  function noteOutput(byteCount: number): void {
    if (ready || byteCount === 0) return;
    capTimer ??= setTimeout(markReady, READY_HARD_CAP_MS);
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(markReady, READY_QUIET_MS);
  }

  async function bufferText(): Promise<string> {
    return presentation?.exportBuffer() ?? '';
  }

  function openFind(): void {
    if (!focused) return;
    findOpen = true;
    requestAnimationFrame(() => findInput?.focus());
  }

  function find(direction: 'next' | 'previous'): void {
    if (!findQuery) return;
    void presentation?.find(findQuery, direction);
  }

  async function saveBuffer(): Promise<void> {
    if (!focused) return;
    await ipc.system.saveText({
      defaultPath: `${terminalId}.log`,
      content: await bufferText()
    });
  }

  async function copyBuffer(): Promise<void> {
    if (!focused) return;
    await navigator.clipboard.writeText(await bufferText());
    toasts.push('Copied terminal buffer', 'info');
  }

  async function copyMarkdown(): Promise<void> {
    if (!focused) return;
    const session = sessions.sessions.find((item) => item.id === sessionId);
    const header = session
      ? `# ${session.name || session.id}\n\n- cwd: ${session.cwd}\n- launch: ${launchKind(session)}\n- run mode: ${session.runMode}\n\n`
      : `# ${sessionId}\n\n`;
    await navigator.clipboard.writeText(`${header}\`\`\`text\n${await bufferText()}\`\`\`\n`);
    toasts.push('Copied session as Markdown', 'info');
  }

  async function clipboardImages(): Promise<ClipboardImagePayload[]> {
    if (!navigator.clipboard?.read) return [];
    const items = await navigator.clipboard.read();
    const images: ClipboardImagePayload[] = [];
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      images.push({ mimeType: imageType, dataBase64: await blobToBase64(blob) });
    }
    return images;
  }

  function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'));
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        resolve(result.replace(/^data:[^,]*,/u, ''));
      };
      reader.readAsDataURL(blob);
    });
  }

  async function pasteFromClipboard(): Promise<void> {
    const current = presentation;
    if (!current) return;
    const session = sessions.sessions.find((item) => item.id === sessionId);
    if (session && effectiveAgentProvider(session)) {
      const images = await clipboardImages().catch(() => []);
      if (images.length > 0) {
        if (shouldPasteImageViaSavedPath(session)) {
          await ipc.files.pasteImagesIntoTerminal({ terminalId, sessionId, images });
        } else {
          await ipc.terminal.input(terminalId, AGENT_IMAGE_PASTE_SEQUENCE);
        }
        return;
      }
    }
    const text = await navigator.clipboard.readText().catch(() => '');
    if (text) current.paste(text);
  }

  function clearChip(): void {
    chipText = '';
    chipAnchor = null;
  }

  function anchorChipAtPointer(clientX: number, clientY: number): void {
    const buttonWidth = 112;
    const buttonHeight = 28;
    const margin = 8;
    let top = clientY + 12;
    let left = clientX - buttonWidth;
    if (top + buttonHeight + margin > window.innerHeight) top = clientY - buttonHeight - 12;
    if (left < margin) left = margin;
    if (left + buttonWidth + margin > window.innerWidth) {
      left = window.innerWidth - buttonWidth - margin;
    }
    chipAnchor = { top, left };
  }

  function onHostMouseUp(event: MouseEvent): void {
    requestAnimationFrame(() => {
      const text = presentation?.getSelection() ?? '';
      if (!text) return;
      chipText = text;
      anchorChipAtPointer(event.clientX, event.clientY);
    });
  }

  function onHostMouseDown(): void {
    if (!askOpen) clearChip();
  }

  function openAskFromChip(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!chipText) return;
    askSelection = chipText;
    askOpen = true;
  }

  function onAskOpenChange(next: boolean): void {
    askOpen = next;
    if (!next) {
      askSelection = '';
      presentation?.focus();
    }
  }

  function onMenuOpenChange(open: boolean): void {
    if (open) menuHasSelection = presentation?.hasSelection() ?? false;
  }

  function ctxAskAgent(): void {
    if (!presentation?.hasSelection()) return;
    askSelection = presentation.getSelection();
    askOpen = true;
  }

  async function ctxCopy(): Promise<void> {
    if (!presentation?.hasSelection()) return;
    try {
      await navigator.clipboard.writeText(presentation.getSelection());
      presentation.clearSelection();
    } catch (error) {
      reportError(error);
    }
  }

  function handleTerminalKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown') return true;
    const ctrlSlash = ctrlSlashSequence(event);
    if (ctrlSlash !== null) {
      event.preventDefault();
      void ipc.terminal.input(terminalId, ctrlSlash).catch(() => {});
      return false;
    }
    if (tabIndexFromEvent(event) !== null || shiftNumberIndexFromEvent(event) !== null) return false;
    if (Keymap.deleteSelectedSession.match(event)) {
      event.preventDefault();
      void nav.closeActive();
      return false;
    }
    const railBindings = [
      [Keymap.toggleNotesRail, 'notes'],
      [Keymap.toggleDiffRail, 'diff'],
      [Keymap.toggleFilesRail, 'files'],
      [Keymap.toggleFeatureRail, 'feature'],
      [Keymap.toggleBrowserRail, 'browser']
    ] as const;
    for (const [binding, rail] of railBindings) {
      if (!binding.match(event)) continue;
      event.preventDefault();
      void toggleRailTabAndFocus(rail);
      return false;
    }
    if (Keymap.toggleSidebar.match(event)) {
      event.preventDefault();
      sidebar.toggle();
      return false;
    }
    const handledIds = new Set<string>([
      Keymap.deleteSelectedSession.id,
      Keymap.toggleNotesRail.id,
      Keymap.toggleDiffRail.id,
      Keymap.toggleFilesRail.id,
      Keymap.toggleFeatureRail.id,
      Keymap.toggleBrowserRail.id,
      Keymap.toggleSidebar.id
    ]);
    for (const binding of Object.values(Keymap)) {
      if (!handledIds.has(binding.id) && binding.match(event)) return false;
    }
    if (isClipboardPasteShortcut(event)) {
      event.preventDefault();
      void pasteFromClipboard().catch(reportError);
      return false;
    }
    if (shouldSendShiftEnterSequence(event)) {
      event.preventDefault();
      void ipc.terminal.input(terminalId, SHIFT_ENTER_SEQUENCE).catch(() => {});
      return false;
    }
    const ctrlOrCmd = (event.ctrlKey || event.metaKey) && !event.altKey;
    if (ctrlOrCmd && event.key.toLowerCase() === 'c') {
      const current = presentation;
      if (!event.shiftKey && !current?.hasSelection()) return true;
      if (current?.hasSelection()) {
        void navigator.clipboard.writeText(current.getSelection()).catch(() => {});
        current.clearSelection();
      }
      return false;
    }
    return true;
  }

  $effect(() => {
    if (!host) return;
    const target = host;
    const preference = settings.current.terminal.presentation;
    const configuration = untrack(() => presentationConfiguration);
    const initiallyVisible = untrack(() => visible);
    const initiallyFocused = untrack(() => focused);
    let cancelled = false;
    let created: TerminalPresentation | null = null;
    let lease: TerminalOutputPresentationLease | null = null;

    void (async () => {
      const transport = rendererBackendTransportKind();
      const factory = await createTerminalPresentationFactory({
        preference,
        transport
      });
      created = await factory.create({
        terminalId,
        sessionId,
        host: target,
        configuration,
        visible: initiallyVisible,
        focused: initiallyFocused,
        compactViewport: untrack(() => compactViewport),
        callbacks: {
          onInput: (data) => {
            void ipc.terminal.input(terminalId, data).catch(() => {});
          },
          onResize: ({ cols, rows }) => {
            if (Number.isFinite(cols) && Number.isFinite(rows)) {
              void ipc.terminal.resize(terminalId, cols, rows).catch(() => {});
            }
          },
          onSelectionChange: (selection) => {
            // Keep the Ask Agent chip's mouseup snapshot independent from the
            // live selection. Animated agent TUIs can clear native selection
            // on redraw before the user has time to click the chip.
            menuHasSelection = selection.length > 0;
          },
          onLink: (uri) => void ipc.system.openExternal(uri).catch(reportError),
          onKey: handleTerminalKey,
          onRendererFailure: ({ renderer, error, recovered }) => {
            console.warn(`[terminal-presentation] ${renderer} initialization failed`, {
              terminalId,
              sessionId,
              recovered,
              error
            });
          }
        }
      });
      if (cancelled) {
        created.dispose();
        return;
      }
      presentation = created;
      lease = ipc.terminal.attachPresentation(
        terminalId,
        sessionId,
        {
          write: async (data) => {
            await created!.write(data);
            noteOutput(data.length);
          },
          replace: async (data) => {
            await created!.replace(data);
            noteOutput(data.length);
          }
        },
        initiallyVisible
      );
      outputLease = lease;
    })().catch((error) => {
      if (!cancelled) reportError(error);
    });

    return () => {
      cancelled = true;
      lease?.dispose();
      if (outputLease === lease) outputLease = null;
      if (presentation === created) presentation = null;
      created?.dispose();
      clearReadyTimers();
    };
  });

  $effect(() => {
    const nextVisible = visible;
    untrack(() => {
      presentation?.setVisible(nextVisible);
      outputLease?.setVisible(nextVisible);
    });
  });

  $effect(() => {
    const nextFocused = focused;
    const autofocus = shouldAutofocusTerminal();
    untrack(() => presentation?.setFocused(nextFocused, autofocus));
  });

  $effect(() => {
    const compact = compactViewport;
    untrack(() => presentation?.setCompactViewport(compact));
  });

  $effect(() => {
    const configuration = presentationConfiguration;
    untrack(() => presentation?.setConfiguration(configuration));
  });

  $effect(() => {
    if (!focused || !presentation) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (askOpen) return;
      const target = event.target as Node | null;
      if (!target || host?.contains(target) || chipEl?.contains(target)) return;
      clearChip();
      presentation?.clearSelection();
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || askOpen || !chipText) return;
      clearChip();
      presentation?.clearSelection();
    };
    const onFind = () => openFind();
    const onSave = () => void saveBuffer().catch(reportError);
    const onCopy = () => void copyBuffer().catch(reportError);
    const onCopyMarkdown = () => void copyMarkdown().catch(reportError);
    const onRefocus = () => {
      if (shouldAutofocusTerminal()) presentation?.focus();
    };
    window.addEventListener('mousedown', onDocMouseDown, true);
    window.addEventListener('keydown', onDocKeyDown);
    window.addEventListener('soloe:terminal-find', onFind);
    window.addEventListener('soloe:terminal-save-buffer', onSave);
    window.addEventListener('soloe:terminal-copy-buffer', onCopy);
    window.addEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
    window.addEventListener('soloe:refocus-terminal', onRefocus);
    return () => {
      window.removeEventListener('mousedown', onDocMouseDown, true);
      window.removeEventListener('keydown', onDocKeyDown);
      window.removeEventListener('soloe:terminal-find', onFind);
      window.removeEventListener('soloe:terminal-save-buffer', onSave);
      window.removeEventListener('soloe:terminal-copy-buffer', onCopy);
      window.removeEventListener('soloe:terminal-copy-markdown', onCopyMarkdown);
      window.removeEventListener('soloe:refocus-terminal', onRefocus);
    };
  });
</script>

<div class="terminal-pane-shell relative h-full w-full bg-[#0f0f10] p-2">
  {#if !ready}
    <div
      class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-[#0f0f10]/75 backdrop-blur-sm transition-opacity duration-500 ease-out"
    >
      <div class="flex flex-col items-center gap-3">
        <span class="relative flex size-9 items-center justify-center">
          <span class="absolute inset-0 animate-ping rounded-full bg-foreground/5"></span>
          <span class="relative flex size-9 items-center justify-center rounded-full bg-background/50 ring-1 ring-border/40">
            <Loader2 class="size-4 animate-spin text-foreground/70" />
          </span>
        </span>
        <span class="text-[10px] font-medium tracking-[0.18em] text-muted-foreground/80 uppercase">
          {loadingLabel}
        </span>
      </div>
    </div>
  {/if}
  {#if findOpen && focused}
    <div class="terminal-find absolute top-2.5 right-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg">
      <Input
        bind:ref={findInput}
        bind:value={findQuery}
        oninput={() => find('next')}
        onkeydown={(event) => {
          if (event.key === 'Escape') findOpen = false;
          if (event.key === 'Enter') find('next');
        }}
        placeholder="Find"
        aria-label="Find in terminal"
        class="h-7 w-44 text-xs"
      />
      <Button variant="ghost" size="xs" onclick={() => find('previous')}>Prev</Button>
      <Button variant="ghost" size="xs" onclick={() => find('next')}>Next</Button>
      <Button variant="ghost" size="icon-xs" onclick={() => (findOpen = false)} aria-label="Close find">
        <X />
      </Button>
    </div>
  {/if}
  <ContextMenu.Root onOpenChange={onMenuOpenChange}>
    <ContextMenu.Trigger>
      {#snippet child({ props })}
        <div
          {...props}
          class="h-full w-full min-w-0 overflow-hidden"
          bind:this={host}
          onmouseup={onHostMouseUp}
          onmousedown={onHostMouseDown}
        ></div>
      {/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Content class="w-44">
      <ContextMenu.Item disabled={!menuHasSelection} onclick={ctxAskAgent}>
        <MessageSquarePlus class="size-3.5" />
        Ask Agent
      </ContextMenu.Item>
      <ContextMenu.Item disabled={!menuHasSelection} onclick={() => void ctxCopy()}>
        <Copy class="size-3.5" />
        Copy
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Root>
</div>

{#if chipText || askOpen}
  <button
    bind:this={chipEl}
    type="button"
    class="mobile-selection-menu fixed z-50 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 font-sans text-[11px] text-popover-foreground shadow-md hover:bg-accent hover:text-accent-foreground"
    style:top="{chipAnchor?.top ?? 0}px"
    style:left="{chipAnchor?.left ?? 0}px"
    style:visibility={chipAnchor ? 'visible' : 'hidden'}
    onmousedown={openAskFromChip}
    aria-label="Ask Agent about selection"
    title="Ask Agent about selection"
  >
    <Send class="size-3.5" />
    <span>Ask Agent</span>
  </button>
{/if}

{#if askSelection.length > 0}
  <AskAgentPopover
    open={askOpen}
    onOpenChange={onAskOpenChange}
    selectionText={askSelection}
    anchorEl={chipEl}
    side="top"
    align="end"
  />
{/if}

<style>
  @media (max-width: 767px) {
    .terminal-pane-shell {
      display: grid;
      width: 100%;
      max-width: 100%;
      min-width: 0;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr);
      overflow: hidden;
      padding: 0.25rem;
    }

    .terminal-find {
      top: 0.5rem;
      right: 0.5rem;
      left: 0.5rem;
      flex-wrap: wrap;
    }

    .terminal-find :global([data-slot='input']) {
      width: min(100%, 15rem);
      height: 2.75rem;
      flex: 1 1 10rem;
    }

    .terminal-find :global([data-slot='button']) {
      min-width: 2.75rem;
      min-height: 2.75rem;
    }
  }
</style>
