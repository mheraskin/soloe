<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    Eye,
    EyeOff,
    Globe2,
    KeyRound,
    Pencil,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    X
  } from '@lucide/svelte';
  import type { ScopedVaultEntry } from '../../lib/vault-groups';
  import {
    filterCredentialGroups,
    groupCredentialsByOrigin
  } from '../../lib/vault-groups';
  import { reportError } from '../../stores/toast.svelte';
  import { vaultNormalizeOrigin, vaultStore } from '../../stores/vault.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { toast } from 'svelte-sonner';

  let query = $state('');
  let formOpen = $state(false);
  let editing = $state<ScopedVaultEntry | null>(null);
  let origin = $state('');
  let username = $state('');
  let password = $state('');
  let label = $state('');
  let scope = $state<'project' | 'worktree'>('project');
  let showPassword = $state(false);
  let saving = $state(false);
  let revealed = $state<{ key: string; password: string } | null>(null);
  let revealingKey = $state<string | null>(null);
  let revealTimer: ReturnType<typeof setTimeout> | null = null;

  let groups = $derived(
    filterCredentialGroups(
      groupCredentialsByOrigin(vaultStore.projectScopedEntries),
      query
    )
  );
  let normalizedOrigin = $derived(vaultNormalizeOrigin(origin));
  let canSave = $derived(
    normalizedOrigin.length > 0
      && username.trim().length > 0
      && (editing !== null || password.length > 0)
      && !saving
  );

  onMount(() => {
    void vaultStore.ensureProjectLoaded();
  });

  onDestroy(() => {
    if (revealTimer) clearTimeout(revealTimer);
    password = '';
    revealed = null;
  });

  function entryKey(item: ScopedVaultEntry): string {
    return `${item.vaultCwd}:${item.entry.id}`;
  }

  function scopeLabel(vaultCwd: string): string {
    return vaultCwd === vaultStore.projectCwd ? 'Project' : 'Worktree';
  }

  function beginCreate(): void {
    editing = null;
    origin = '';
    username = '';
    password = '';
    label = '';
    scope = 'project';
    showPassword = false;
    formOpen = true;
  }

  function beginEdit(item: ScopedVaultEntry): void {
    editing = item;
    origin = item.entry.origin;
    username = item.entry.username;
    password = '';
    label = item.entry.label ?? '';
    showPassword = false;
    formOpen = true;
  }

  function closeForm(): void {
    formOpen = false;
    editing = null;
    password = '';
    showPassword = false;
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!canSave) return;
    saving = true;
    try {
      if (editing) {
        await vaultStore.update(
          editing.entry.id,
          {
            username: username.trim(),
            label: label.trim(),
            ...(password ? { password } : {})
          },
          editing.vaultCwd
        );
        toast.success('Credential updated');
      } else {
        await vaultStore.save(
          {
            origin: normalizedOrigin,
            username: username.trim(),
            password,
            label: label.trim() || undefined
          },
          vaultStore.saveTarget(scope)
        );
        toast.success(
          scope === 'project'
            ? 'Credential saved for this project'
            : 'Credential saved for this worktree'
        );
      }
      closeForm();
    } catch (error) {
      reportError(error, editing ? 'Failed to update credential' : 'Failed to save credential');
    } finally {
      saving = false;
    }
  }

  async function remove(item: ScopedVaultEntry): Promise<void> {
    if (!confirm(`Delete ${item.entry.username} at ${item.entry.origin}?`)) return;
    try {
      await vaultStore.delete(item.entry.id, item.vaultCwd);
      if (revealed?.key === entryKey(item)) hideSecret();
      if (editing && entryKey(editing) === entryKey(item)) closeForm();
      toast.success('Credential deleted');
    } catch (error) {
      reportError(error, 'Failed to delete credential');
    }
  }

  async function toggleSecret(item: ScopedVaultEntry): Promise<void> {
    const key = entryKey(item);
    if (revealed?.key === key) {
      hideSecret();
      return;
    }
    revealingKey = key;
    try {
      const secret = await vaultStore.getSecret(item.entry.id, item.vaultCwd);
      if (revealTimer) clearTimeout(revealTimer);
      revealed = { key, password: secret.password };
      revealTimer = setTimeout(hideSecret, 30_000);
    } catch (error) {
      reportError(error, 'Failed to reveal credential');
    } finally {
      revealingKey = null;
    }
  }

  function hideSecret(): void {
    if (revealTimer) clearTimeout(revealTimer);
    revealTimer = null;
    revealed = null;
  }
</script>

<section class="flex flex-col gap-4" aria-labelledby="vault-management-title">
  <div class="flex flex-col gap-1">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h2 id="vault-management-title" class="m-0 text-sm font-medium">Credential Vault</h2>
        <p class="m-0 text-[11px] text-muted-foreground">
          Metadata is shared by the backend. Secrets load only when you explicitly reveal one.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        class="shrink-0"
        disabled={!vaultStore.cwd}
        onclick={beginCreate}
      >
        <Plus class="size-3.5" />
        Add
      </Button>
    </div>
  </div>

  {#if !vaultStore.cwd}
    <div
      class="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground"
      role="status"
    >
      Select a session to manage credentials for its project or worktree.
    </div>
  {:else}
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          bind:value={query}
          class="h-8 pl-8 text-xs"
          placeholder="Search sites, usernames, or labels…"
          aria-label="Search Vault credentials"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="shrink-0"
        disabled={vaultStore.projectLoading}
        onclick={() => void vaultStore.refreshProject()}
      >
        <RefreshCw class={`size-3.5 ${vaultStore.projectLoading ? 'animate-spin' : ''}`} />
        Refresh
      </Button>
    </div>

    {#if vaultStore.projectError}
      <div
        class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        role="alert"
      >
        {vaultStore.projectError}
      </div>
    {/if}

    {#if vaultStore.projectLoading && vaultStore.projectScopedEntries.length === 0}
      <div
        class="rounded-md border border-border bg-muted/20 px-4 py-8 text-center text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        Loading credentials…
      </div>
    {:else if groups.length === 0}
      <div
        class="rounded-md border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground"
        role="status"
      >
        {query.trim() ? 'No credentials match this search.' : 'No credentials saved yet.'}
      </div>
    {:else}
      <div class="flex flex-col gap-3" aria-live="polite">
        {#each groups as group (group.origin)}
          <section class="overflow-hidden rounded-md border border-border bg-muted/10">
            <header class="flex items-center gap-2 border-b border-border/70 px-3 py-2">
              <Globe2 class="size-3.5 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <h3 class="m-0 truncate text-xs font-medium">{group.label}</h3>
                <p class="m-0 truncate text-[10px] text-muted-foreground">{group.origin}</p>
              </div>
              <span class="text-[10px] text-muted-foreground">{group.entries.length}</span>
            </header>
            <ul class="m-0 divide-y divide-border/60 p-0">
              {#each group.entries as item (entryKey(item))}
                {@const key = entryKey(item)}
                <li class="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center">
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                      <KeyRound class="size-3.5 shrink-0 text-muted-foreground" />
                      <span class="truncate text-xs font-medium">{item.entry.username}</span>
                      <span
                        class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground"
                        title={item.vaultCwd}
                      >
                        {scopeLabel(item.vaultCwd)}
                      </span>
                    </div>
                    {#if item.entry.label}
                      <div class="mt-0.5 truncate pl-5.5 text-[10px] text-muted-foreground">
                        {item.entry.label}
                      </div>
                    {/if}
                    {#if revealed?.key === key}
                      <div
                        class="mt-2 break-all rounded border border-warning/30 bg-warning/5 px-2 py-1.5 font-mono text-[11px]"
                        role="status"
                        aria-live="polite"
                      >
                        {revealed.password}
                      </div>
                    {/if}
                  </div>
                  <div class="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={revealingKey === key}
                      aria-label={revealed?.key === key
                        ? `Hide password for ${item.entry.username}`
                        : `Reveal password for ${item.entry.username}`}
                      onclick={() => void toggleSecret(item)}
                    >
                      {#if revealed?.key === key}
                        <EyeOff class="size-3" />
                        Hide
                      {:else}
                        <Eye class="size-3" />
                        {revealingKey === key ? 'Loading…' : 'Reveal'}
                      {/if}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${item.entry.username}`}
                      onclick={() => beginEdit(item)}
                    >
                      <Pencil class="size-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      class="text-muted-foreground hover:text-destructive"
                      aria-label={`Delete ${item.entry.username}`}
                      onclick={() => void remove(item)}
                    >
                      <Trash2 class="size-3.5" />
                    </Button>
                  </div>
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}

    {#if formOpen}
      <form
        class="flex flex-col gap-3 rounded-md border border-primary/30 bg-primary/5 p-3"
        onsubmit={submit}
        aria-label={editing ? 'Edit Vault credential' : 'Add Vault credential'}
      >
        <div class="flex items-center justify-between gap-2">
          <div>
            <h3 class="m-0 text-xs font-medium">
              {editing ? 'Edit credential' : 'Add credential'}
            </h3>
            <p class="m-0 text-[10px] text-muted-foreground">
              {editing
                ? 'Leave the password blank to keep the current secret.'
                : 'The password is encrypted by the backend before storage.'}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close credential form"
            onclick={closeForm}
          >
            <X class="size-3.5" />
          </Button>
        </div>

        {#if !editing}
          <fieldset class="grid gap-2 sm:grid-cols-2">
            <legend class="mb-1 text-[10px] font-medium text-muted-foreground">Save to</legend>
            <label
              class="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/70 p-2 text-xs transition-colors hover:bg-muted/50"
            >
              <input
                type="radio"
                name="vault-management-scope"
                value="project"
                bind:group={scope}
                class="mt-0.5"
              />
              <span>
                <span class="block font-medium">Project</span>
                <span class="block text-[10px] text-muted-foreground">
                  Available to known project worktrees
                </span>
              </span>
            </label>
            <label
              class="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background/70 p-2 text-xs transition-colors hover:bg-muted/50"
            >
              <input
                type="radio"
                name="vault-management-scope"
                value="worktree"
                bind:group={scope}
                class="mt-0.5"
              />
              <span>
                <span class="block font-medium">Current worktree</span>
                <span class="block text-[10px] text-muted-foreground">
                  Isolated to the selected checkout
                </span>
              </span>
            </label>
          </fieldset>
        {/if}

        <div class="grid gap-3 sm:grid-cols-2">
          <div class="flex flex-col gap-1">
            <Label for="vault-management-origin" class="text-[10px]">Site origin</Label>
            <Input
              id="vault-management-origin"
              bind:value={origin}
              type="url"
              placeholder="https://example.com"
              spellcheck={false}
              disabled={editing !== null}
              required
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="vault-management-username" class="text-[10px]">Username</Label>
            <Input
              id="vault-management-username"
              bind:value={username}
              autocomplete="off"
              required
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="vault-management-label" class="text-[10px]">Label</Label>
            <Input
              id="vault-management-label"
              bind:value={label}
              placeholder="Optional"
              autocomplete="off"
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label for="vault-management-password" class="text-[10px]">Password</Label>
            <div class="relative">
              <Input
                id="vault-management-password"
                bind:value={password}
                type={showPassword ? 'text' : 'password'}
                class="pr-9"
                autocomplete="new-password"
                required={!editing}
              />
              <button
                type="button"
                class="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-label={showPassword ? 'Hide form password' : 'Show form password'}
                onclick={() => (showPassword = !showPassword)}
              >
                {#if showPassword}
                  <EyeOff class="size-3.5" />
                {:else}
                  <Eye class="size-3.5" />
                {/if}
              </button>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onclick={closeForm}>Cancel</Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save credential'}
          </Button>
        </div>
      </form>
    {/if}
  {/if}
</section>
