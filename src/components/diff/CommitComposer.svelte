<script lang="ts">
  import {
    Check,
    ChevronDown,
    Cloud,
    CloudOff,
    Download,
    Loader2,
    RefreshCw,
    Upload
  } from '@lucide/svelte';
  import { onMount, tick } from 'svelte';
  import { ipc } from '../../lib/ipc';
  import { git } from '../../stores/git.svelte';
  import { workingDiff } from '../../stores/working-diff.svelte';
  import { reportError, toasts } from '../../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

  let { cwd }: { cwd: string } = $props();

  const MESSAGE_KEY_PREFIX = 'soloe.commitMessage.v1::';

  let message = $state('');
  let busy = $state<null | 'commit' | 'push' | 'pull' | 'fetch'>(null);
  let textareaEl: HTMLTextAreaElement | null = $state(null);

  let status = $derived(git.statusFor(cwd));
  let isRepo = $derived(!!status?.isRepo);
  let staged = $derived(status?.staged ?? 0);
  let unstaged = $derived(status?.unstaged ?? 0);
  let untracked = $derived(status?.untracked ?? 0);
  let ahead = $derived(status?.ahead ?? 0);
  let behind = $derived(status?.behind ?? 0);
  let branch = $derived(status?.branch ?? null);
  let detached = $derived(!!status?.detached);

  // VS Code's source-control sync model: pick the most likely primary action
  // based on the current dirty/ahead/behind state, and surface the rest in the
  // dropdown. Commit takes priority whenever something is staged.
  type PrimaryAction = 'commit' | 'commit-push' | 'sync' | 'push' | 'pull' | 'publish' | 'fetch';

  let primary = $derived.by<PrimaryAction>(() => {
    if (staged > 0) return ahead > 0 ? 'commit-push' : 'commit';
    if (!branch || detached) return 'fetch';
    // No upstream: branch hasn't been published yet (the "Publish Branch" hint).
    if (!status?.branch) return 'fetch';
    if (ahead > 0 && behind > 0) return 'sync';
    if (ahead > 0) return 'push';
    if (behind > 0) return 'pull';
    return 'fetch';
  });

  let primaryLabel = $derived.by<string>(() => {
    switch (primary) {
      case 'commit':
        return 'Commit';
      case 'commit-push':
        return 'Commit & Push';
      case 'sync':
        return 'Sync Changes';
      case 'push':
        return ahead > 0 ? `Push (${ahead})` : 'Push';
      case 'pull':
        return behind > 0 ? `Pull (${behind})` : 'Pull';
      case 'publish':
        return 'Publish Branch';
      case 'fetch':
        return 'Fetch';
    }
  });

  let needsMessage = $derived(primary === 'commit' || primary === 'commit-push');
  let canRunPrimary = $derived(isRepo && (!needsMessage || message.trim().length > 0));

  // Render the textarea whenever there's anything to commit, even before the
  // user stages. Tying visibility to `primary === 'commit'` would pop the box
  // in only after the optimistic stage flips the git status — that's the
  // layout shift the user noticed mid-stage. The dropdown's "Commit" item
  // auto-stages, so the box is still useful when nothing is staged yet.
  let showMessageBox = $derived(staged + unstaged + untracked > 0);

  // While an action is running, the button label should reflect what's
  // actually happening rather than the resting primary. Otherwise picking
  // "Commit" from the dropdown while primary is "Fetch" leaves the label
  // saying "Fetch" with a spinner — confusing.
  let busyLabel = $derived.by<string>(() => {
    switch (busy) {
      case 'commit':
        return 'Committing…';
      case 'push':
        return 'Pushing…';
      case 'pull':
        return 'Pulling…';
      case 'fetch':
        return 'Fetching…';
      case null:
        return primaryLabel;
    }
  });

  // Parent re-keys this component on cwd change, so onMount is enough to
  // restore the saved draft — no need for an effect that fights with $state.
  onMount(() => {
    if (!cwd) return;
    const raw = localStorage.getItem(MESSAGE_KEY_PREFIX + cwd);
    if (raw) message = raw;
  });

  function persistMessage(): void {
    if (!cwd) return;
    if (message) localStorage.setItem(MESSAGE_KEY_PREFIX + cwd, message);
    else localStorage.removeItem(MESSAGE_KEY_PREFIX + cwd);
  }

  function ctx() {
    return git.contextFor(cwd);
  }

  async function runCommit(thenPush: boolean): Promise<void> {
    if (!isRepo || message.trim().length === 0) return;
    busy = 'commit';
    try {
      // Auto-stage when the user has only unstaged changes — matches VS Code's
      // default "commit everything" prompt; explicit stage actions still take
      // precedence whenever the user already staged something themselves.
      const stageAll = staged === 0 && unstaged > 0;
      await ipc.git.commit({ cwd, message: message.trim(), stageAll, ...ctx() });
      message = '';
      persistMessage();
      if (thenPush) await runPush();
      toasts.push('Committed', 'info');
      void workingDiff.loadChanges(cwd);
    } catch (err) {
      reportError(err);
    } finally {
      busy = null;
    }
  }

  async function runPush(): Promise<void> {
    if (!isRepo) return;
    busy = 'push';
    try {
      const setUpstream = !!status && status.branch !== null && status.ahead >= 0;
      await ipc.git.push({ cwd, setUpstream, ...ctx() });
      toasts.push('Pushed', 'info');
    } catch (err) {
      reportError(err);
    } finally {
      busy = null;
    }
  }

  async function runPull(): Promise<void> {
    if (!isRepo) return;
    busy = 'pull';
    try {
      await ipc.git.pull({ cwd, ...ctx() });
      toasts.push('Pulled', 'info');
      void workingDiff.loadChanges(cwd);
    } catch (err) {
      reportError(err);
    } finally {
      busy = null;
    }
  }

  async function runFetch(): Promise<void> {
    if (!isRepo) return;
    busy = 'fetch';
    try {
      await ipc.git.fetch({ cwd, ...ctx() });
      toasts.push('Fetched', 'info');
    } catch (err) {
      reportError(err);
    } finally {
      busy = null;
    }
  }

  async function runSync(): Promise<void> {
    await runPull();
    if (busy === null) await runPush();
  }

  async function runPrimary(): Promise<void> {
    switch (primary) {
      case 'commit':
        await runCommit(false);
        break;
      case 'commit-push':
        await runCommit(true);
        break;
      case 'sync':
        await runSync();
        break;
      case 'push':
        await runPush();
        break;
      case 'pull':
        await runPull();
        break;
      case 'publish':
        await runPush();
        break;
      case 'fetch':
        await runFetch();
        break;
    }
  }

  function onMessageKeydown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void runPrimary();
    }
  }

  async function focusMessage(): Promise<void> {
    await tick();
    textareaEl?.focus();
  }
</script>

{#if isRepo}
  <div class="flex flex-col gap-1.5 border-b border-border bg-card/40 px-3 py-2">
    {#if showMessageBox}
      <Textarea
        bind:ref={textareaEl}
        bind:value={message}
        oninput={persistMessage}
        onkeydown={onMessageKeydown}
        placeholder={staged > 0
          ? `Message (Ctrl+Enter to ${primary === 'commit-push' ? 'commit & push' : 'commit'})`
          : 'Message (Ctrl+Enter to commit all changes)'}
        rows={2}
        class="min-h-[44px] resize-none text-[11px]"
        aria-label="Commit message"
      />
    {/if}

    <div class="flex items-center gap-1">
      <Button
        variant="default"
        size="xs"
        class="flex-1 gap-1.5"
        disabled={!canRunPrimary || busy !== null}
        onclick={() => void runPrimary()}
        title={branch ? `${busyLabel} on ${branch}` : busyLabel}
      >
        {#if busy !== null}
          <Loader2 class="animate-spin" />
        {:else if primary === 'commit' || primary === 'commit-push'}
          <Check />
        {:else if primary === 'sync'}
          <RefreshCw />
        {:else if primary === 'push' || primary === 'publish'}
          <Upload />
        {:else if primary === 'pull'}
          <Download />
        {:else}
          <RefreshCw />
        {/if}
        <span class="truncate">{busyLabel}</span>
      </Button>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {#snippet child({ props })}
            <Button
              {...props}
              variant="default"
              size="icon-xs"
              aria-label="More commit actions"
              disabled={busy !== null}
            >
              <ChevronDown />
            </Button>
          {/snippet}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" class="w-48">
          <DropdownMenu.Item
            disabled={staged + unstaged + untracked === 0 || message.trim().length === 0}
            onSelect={() => void runCommit(false)}
          >
            <Check />
            <span>Commit</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={staged + unstaged + untracked === 0 || message.trim().length === 0}
            onSelect={() => void runCommit(true)}
          >
            <Upload />
            <span>Commit & Push</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => void runPush()}>
            <Upload />
            <span>Push</span>
            {#if ahead > 0}
              <DropdownMenu.Shortcut>↑{ahead}</DropdownMenu.Shortcut>
            {/if}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void runPull()}>
            <Download />
            <span>Pull</span>
            {#if behind > 0}
              <DropdownMenu.Shortcut>↓{behind}</DropdownMenu.Shortcut>
            {/if}
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => void runSync()}>
            <RefreshCw />
            <span>Sync</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => void runFetch()}>
            {#if behind > 0 || ahead > 0}
              <Cloud />
            {:else}
              <CloudOff />
            {/if}
            <span>Fetch</span>
          </DropdownMenu.Item>
          {#if showMessageBox}
            <DropdownMenu.Separator />
            <DropdownMenu.Item onSelect={() => void focusMessage()}>
              <span>Focus message</span>
              <DropdownMenu.Shortcut>⌘↵</DropdownMenu.Shortcut>
            </DropdownMenu.Item>
          {/if}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
  </div>
{/if}
