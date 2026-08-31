<script lang="ts">
  import { onMount } from 'svelte';
  import type { GitBranch, GitWorktree } from '@shared/types/git.js';
  import { worktreeCreateModal } from '../stores/worktree-create-modal.svelte';
  import { git } from '../stores/git.svelte';
  import { newSessionPicker } from '../stores/new-session-picker.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { ipc } from '../lib/ipc';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Dialog from '$lib/components/ui/dialog';

  let branches = $state<GitBranch[]>([]);
  let existingWorktrees = $state<GitWorktree[]>([]);
  let loadingBranches = $state(true);
  let loadingWorktrees = $state(false);
  let branchLoadError = $state<string | null>(null);
  let worktreeLoadError = $state<string | null>(null);
  let submitting = $state(false);

  onMount(() => {
    const draft = worktreeCreateModal.draft;
    if (!draft) return;
    void refreshExistingWorktrees();
    void ipc.git.branches({
      repoPath: draft.repoPath,
      force: true,
      ...(draft.runMode ? { runMode: draft.runMode } : {}),
      ...(draft.wslDistro ? { wslDistro: draft.wslDistro } : {}),
      ...(draft.deviceId ? { deviceId: draft.deviceId } : {})
    }).then((result) => {
      branches = result;
      if (draft.baseRef === 'HEAD') {
        const current = result.find((branch) => branch.current);
        if (current) worktreeCreateModal.setBaseRef(current.name);
      }
    }).catch((error) => {
      branchLoadError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      loadingBranches = false;
    });
  });

  function repoContext() {
    const draft = worktreeCreateModal.draft;
    return {
      ...(draft?.runMode ? { runMode: draft.runMode } : {}),
      ...(draft?.wslDistro ? { wslDistro: draft.wslDistro } : {}),
      ...(draft?.deviceId ? { deviceId: draft.deviceId } : {})
    };
  }

  async function refreshExistingWorktrees(): Promise<void> {
    const draft = worktreeCreateModal.draft;
    if (!draft || loadingWorktrees) return;
    loadingWorktrees = true;
    worktreeLoadError = null;
    try {
      const context = repoContext();
      existingWorktrees = await git.loadWorktrees(draft.repoPath, true, context);
      worktreeLoadError = git.worktreesErrorFor(draft.repoPath, context);
    } finally {
      loadingWorktrees = false;
    }
  }

  function worktreeLabel(worktree: GitWorktree): string {
    if (worktree.branch) return worktree.branch;
    if (worktree.detached) {
      return worktree.head ? `Detached at ${worktree.head.slice(0, 8)}` : 'Detached worktree';
    }
    return worktree.isMain ? 'Main worktree' : 'Worktree';
  }

  function openExistingWorktree(worktree: GitWorktree): void {
    const draft = worktreeCreateModal.draft;
    if (!draft) return;
    worktreeCreateModal.close();
    newSessionPicker.open({
      projectId: draft.projectId,
      cwd: worktree.path,
      ...(worktree.branch ? { branch: worktree.branch } : {})
    });
  }

  function validate(): string | null {
    const draft = worktreeCreateModal.draft;
    if (!draft) return 'Project context is missing';
    if (!draft.baseRef.trim()) return 'Base branch is required';
    if (!draft.branch.trim()) return 'New branch name is required';
    if (!draft.path.trim()) return 'Worktree folder is required';
    return null;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    const draft = worktreeCreateModal.draft;
    const validationError = validate();
    if (!draft || validationError) {
      worktreeCreateModal.error = validationError;
      return;
    }
    submitting = true;
    worktreeCreateModal.error = null;
    try {
      const created = await ipc.git.createWorktree({
        repoPath: draft.repoPath,
        path: draft.path,
        branch: draft.branch,
        baseRef: draft.baseRef,
        ...(draft.runMode ? { runMode: draft.runMode } : {}),
        ...(draft.wslDistro ? { wslDistro: draft.wslDistro } : {}),
        ...(draft.deviceId ? { deviceId: draft.deviceId } : {})
      });
      await git.loadWorktrees(draft.repoPath, true, {
        ...(draft.runMode ? { runMode: draft.runMode } : {}),
        ...(draft.wslDistro ? { wslDistro: draft.wslDistro } : {}),
        ...(draft.deviceId ? { deviceId: draft.deviceId } : {})
      });
      if (deviceSessions.multiDeviceActive) await deviceSessions.refresh().catch(reportError);
      worktreeCreateModal.recordCreated(created.path);
      worktreeCreateModal.close();
      toasts.push(`Created ${created.branch ?? draft.branch}`, 'info');
    } catch (error) {
      worktreeCreateModal.error = error instanceof Error ? error.message : String(error);
      reportError(error);
    } finally {
      submitting = false;
    }
  }

  function onOpenChange(open: boolean): void {
    if (!open) worktreeCreateModal.close();
  }
</script>

<Dialog.Root open={worktreeCreateModal.open} {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Create worktree</Dialog.Title>
      <Dialog.Description>
        Open a discovered checkout or create a sibling working directory for
        {worktreeCreateModal.draft?.projectName ?? 'this project'}{worktreeCreateModal.draft?.deviceName
          ? ` on ${worktreeCreateModal.draft.deviceName}`
          : ''}.
      </Dialog.Description>
    </Dialog.Header>

    {#if worktreeCreateModal.draft}
      <form class="flex flex-col gap-3" onsubmit={submit}>
        <div class="grid gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <Label>Existing worktrees</Label>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={loadingWorktrees}
              onclick={() => void refreshExistingWorktrees()}
            >
              {loadingWorktrees ? 'Scanning…' : 'Rescan'}
            </Button>
          </div>
          <div class="max-h-40 overflow-y-auto rounded-lg border border-border/70 bg-muted/15 p-1">
            {#each existingWorktrees as worktree (worktree.path)}
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                onclick={() => openExistingWorktree(worktree)}
              >
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="truncate text-xs font-medium">
                    {worktreeLabel(worktree)}{worktree.isMain ? ' · main' : ''}
                  </span>
                  <span class="truncate font-mono text-[10px] text-muted-foreground" title={worktree.path}>
                    {worktree.path}
                  </span>
                </span>
                <span class="shrink-0 text-[10px] font-medium text-primary">Open session</span>
              </button>
            {:else}
              <p class="m-0 px-2 py-2 text-xs text-muted-foreground">
                {loadingWorktrees
                  ? 'Scanning Git worktrees…'
                  : worktreeLoadError ?? 'No worktrees found.'}
              </p>
            {/each}
          </div>
        </div>

        <div class="flex items-center gap-2 py-0.5" aria-hidden="true">
          <span class="h-px flex-1 bg-border"></span>
          <span class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">Create new</span>
          <span class="h-px flex-1 bg-border"></span>
        </div>

        <div class="grid gap-1.5">
          <Label for="worktree-base">From branch</Label>
          <Input
            id="worktree-base"
            list="worktree-base-options"
            value={worktreeCreateModal.draft.baseRef}
            oninput={(event) =>
              worktreeCreateModal.setBaseRef(event.currentTarget.value)}
            placeholder="main, branch, tag, or revision"
            autocomplete="off"
          />
          <datalist id="worktree-base-options">
            {#each branches as branch (branch.name)}
              <option value={branch.name}>{branch.current ? `${branch.name} · current` : branch.name}</option>
            {/each}
          </datalist>
          <p class="m-0 text-[11px] text-muted-foreground">
            {#if loadingBranches}
              Loading local branch suggestions…
            {:else if branchLoadError}
              Branch suggestions failed to load. You can still type a branch, tag, or revision.
            {:else}
              Choose a local branch suggestion or type any Git revision.
            {/if}
          </p>
        </div>

        <div class="grid gap-1.5">
          <Label for="worktree-branch">New branch</Label>
          <Input
            id="worktree-branch"
            value={worktreeCreateModal.draft.branch}
            oninput={(event) =>
              worktreeCreateModal.setBranch(event.currentTarget.value)}
            placeholder="feature/my-change"
            autocomplete="off"
            autofocus
          />
        </div>

        <div class="grid gap-1.5">
          <Label for="worktree-path">Folder</Label>
          <Input
            id="worktree-path"
            class="font-mono text-xs"
            value={worktreeCreateModal.draft.path}
            oninput={(event) =>
              worktreeCreateModal.setPath(event.currentTarget.value)}
            autocomplete="off"
          />
          <p class="m-0 text-[11px] text-muted-foreground">
            The folder must not already contain another worktree.
          </p>
        </div>

        {#if worktreeCreateModal.error}
          <p class="m-0 text-xs text-destructive">{worktreeCreateModal.error}</p>
        {/if}

        <Dialog.Footer>
          <Button type="button" variant="outline" onclick={() => worktreeCreateModal.close()}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create worktree'}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
