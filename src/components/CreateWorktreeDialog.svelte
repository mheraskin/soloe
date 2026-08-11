<script lang="ts">
  import { onMount } from 'svelte';
  import type { GitBranch } from '@shared/types/git.js';
  import { worktreeCreateModal } from '../stores/worktree-create-modal.svelte';
  import { git } from '../stores/git.svelte';
  import { ipc } from '../lib/ipc';
  import { reportError, toasts } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Select from '$lib/components/ui/select';

  let branches = $state<GitBranch[]>([]);
  let loadingBranches = $state(true);
  let submitting = $state(false);

  onMount(() => {
    const draft = worktreeCreateModal.draft;
    if (!draft) return;
    void ipc.git.branches({
      repoPath: draft.repoPath,
      force: true,
      ...(draft.runMode ? { runMode: draft.runMode } : {}),
      ...(draft.wslDistro ? { wslDistro: draft.wslDistro } : {})
    }).then((result) => {
      branches = result;
      if (draft.baseRef === 'HEAD') {
        const current = result.find((branch) => branch.current);
        if (current) worktreeCreateModal.setBaseRef(current.name);
      }
    }).catch((error) => {
      worktreeCreateModal.error = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      loadingBranches = false;
    });
  });

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
        ...(draft.wslDistro ? { wslDistro: draft.wslDistro } : {})
      });
      await git.loadWorktrees(draft.repoPath, true, {
        ...(draft.runMode ? { runMode: draft.runMode } : {}),
        ...(draft.wslDistro ? { wslDistro: draft.wslDistro } : {})
      });
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
        Create a sibling working directory and a new branch for
        {worktreeCreateModal.draft?.projectName ?? 'this project'}.
      </Dialog.Description>
    </Dialog.Header>

    {#if worktreeCreateModal.draft}
      <form class="flex flex-col gap-3" onsubmit={submit}>
        <div class="grid gap-1.5">
          <Label for="worktree-base">From branch</Label>
          <Select.Root
            type="single"
            value={worktreeCreateModal.draft.baseRef}
            onValueChange={(value) => value && worktreeCreateModal.setBaseRef(value)}
            disabled={loadingBranches}
          >
            <Select.Trigger id="worktree-base" class="w-full">
              {loadingBranches ? 'Loading branches…' : worktreeCreateModal.draft.baseRef}
            </Select.Trigger>
            <Select.Content>
              {#each branches as branch (branch.name)}
                <Select.Item value={branch.name} label={branch.name}>
                  {branch.name}{branch.current ? ' · current' : ''}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>

        <div class="grid gap-1.5">
          <Label for="worktree-branch">New branch</Label>
          <Input
            id="worktree-branch"
            value={worktreeCreateModal.draft.branch}
            oninput={(event) =>
              worktreeCreateModal.setBranch((event.currentTarget as HTMLInputElement).value)}
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
              worktreeCreateModal.setPath((event.currentTarget as HTMLInputElement).value)}
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
          <Button type="submit" disabled={submitting || loadingBranches}>
            {submitting ? 'Creating…' : 'Create worktree'}
          </Button>
        </Dialog.Footer>
      </form>
    {/if}
  </Dialog.Content>
</Dialog.Root>
