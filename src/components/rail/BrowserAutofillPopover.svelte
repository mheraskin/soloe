<script lang="ts">
  import { onMount } from 'svelte';
  import {
    ChevronDown,
    ExternalLink,
    Eye,
    EyeOff,
    FolderGit2,
    Globe2,
    KeyRound,
    Save,
    Search,
    Trash2
  } from '@lucide/svelte';
  import {
    filterCredentialGroups,
    groupCredentialsByOrigin,
    originLabel,
    type CredentialOriginGroup,
    type ScopedVaultEntry
  } from '../../lib/vault-groups';
  import { reportError } from '../../stores/toast.svelte';
  import { vaultNormalizeOrigin, vaultStore } from '../../stores/vault.svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { toast } from 'svelte-sonner';

  interface Props {
    currentUrl: string;
    onFill: (username: string, password: string) => Promise<{ filledUser: boolean }>;
    onNavigate: (url: string) => void;
    onClose: () => void;
  }

  type SectionId = 'site' | 'project' | 'other' | 'save';

  let { currentUrl, onFill, onNavigate, onClose }: Props = $props();
  let currentOrigin = $derived(vaultNormalizeOrigin(currentUrl));
  let activeSection = $state<SectionId>('site');
  let projectQuery = $state('');
  let otherQuery = $state('');
  let saving = $state(false);
  let formUsername = $state('');
  let formPassword = $state('');
  let formLabel = $state('');
  let showFormPassword = $state(false);
  let formOriginOverride = $state('');
  let useCustomOrigin = $state(false);
  let saveScope = $state<'project' | 'worktree'>('project');

  let siteEntries = $derived(
    vaultStore.projectScopedEntries.filter(
      ({ entry }) => !!currentOrigin && entry.origin === currentOrigin
    )
  );
  let otherEntries = $derived(
    vaultStore.currentScopedEntries.filter(
      ({ entry }) => !currentOrigin || entry.origin !== currentOrigin
    )
  );
  let projectGroups = $derived(
    filterCredentialGroups(groupCredentialsByOrigin(vaultStore.projectScopedEntries), projectQuery)
  );
  let otherGroups = $derived(
    filterCredentialGroups(groupCredentialsByOrigin(otherEntries), otherQuery)
  );
  let effectiveOrigin = $derived(
    useCustomOrigin && formOriginOverride.trim() ? formOriginOverride.trim() : currentOrigin
  );
  let canSubmit = $derived(
    !!effectiveOrigin && formUsername.trim().length > 0 && formPassword.length > 0 && !saving
  );

  onMount(() => {
    void vaultStore.ensureProjectLoaded();
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    saving = true;
    try {
      await vaultStore.save(
        {
          origin: effectiveOrigin,
          username: formUsername.trim(),
          password: formPassword,
          label: formLabel.trim() || undefined
        },
        vaultStore.saveTarget(saveScope)
      );
      formUsername = '';
      formPassword = '';
      formLabel = '';
      showFormPassword = false;
      toast.success(saveScope === 'project' ? 'Saved for this project' : 'Saved for this worktree');
      activeSection = 'site';
    } catch (err) {
      reportError(err, 'Failed to save credential');
    } finally {
      saving = false;
    }
  }

  async function fillItem(item: ScopedVaultEntry) {
    try {
      const secret = await vaultStore.getSecret(item.entry.id, item.vaultCwd);
      const result = await onFill(secret.username, secret.password);
      toast.success(result.filledUser ? 'Filled' : 'Filled password (no username field detected)');
      onClose();
    } catch (err) {
      reportError(err, 'Autofill failed');
    }
  }

  async function removeItem(item: ScopedVaultEntry) {
    if (!confirm(`Delete ${item.entry.username} at ${item.entry.origin}?`)) return;
    try {
      await vaultStore.delete(item.entry.id, item.vaultCwd);
      toast.success('Deleted');
    } catch (err) {
      reportError(err, 'Failed to delete');
    }
  }

  function navigateToOrigin(origin: string): void {
    onNavigate(origin);
    onClose();
  }

  function sectionLabel(section: SectionId): string {
    if (section === 'site') return 'This site';
    if (section === 'project') return 'Project';
    if (section === 'other') return 'Other sites';
    return 'Save';
  }

  function sectionCount(section: SectionId): number | null {
    if (section === 'site') return siteEntries.length;
    if (section === 'project') return vaultStore.projectScopedEntries.length;
    if (section === 'other') return otherEntries.length;
    return null;
  }
</script>

{#snippet credentialRow(item: ScopedVaultEntry)}
  <div class="flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-1.5">
    <div class="min-w-0 flex-1">
      <div class="truncate text-[11px] font-medium">{item.entry.username}</div>
      {#if item.entry.label}
        <div class="truncate text-[10px] text-muted-foreground">{item.entry.label}</div>
      {/if}
    </div>
    <Button
      type="button"
      variant="default"
      size="xs"
      class="h-6 shrink-0"
      onclick={() => fillItem(item)}
    >
      Fill
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      class="size-6 shrink-0"
      aria-label={`Delete ${item.entry.username}`}
      onclick={() => removeItem(item)}
    >
      <Trash2 class="size-3" />
    </Button>
  </div>
{/snippet}

{#snippet originGroups(groups: CredentialOriginGroup[], emptyMessage: string)}
  {#if groups.length === 0}
    <div class="px-1 py-6 text-center text-[11px] text-muted-foreground">{emptyMessage}</div>
  {:else}
    <div class="flex flex-col gap-2">
      {#each groups as group, index (group.origin)}
        <details
          class="group overflow-hidden rounded-md border border-border bg-muted/15"
          open={index === 0}
        >
          <summary class="flex cursor-pointer list-none items-center gap-2 px-2 py-2 text-[11px] hover:bg-muted/40">
            <ChevronDown class="size-3 shrink-0 transition-transform group-open:rotate-180" />
            <Globe2 class="size-3 shrink-0 text-muted-foreground" />
            <button
              type="button"
              class="flex min-w-0 flex-1 cursor-pointer items-center gap-1 truncate text-left font-medium underline decoration-transparent underline-offset-2 transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              title={`Open ${group.origin}`}
              onclick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                navigateToOrigin(group.origin);
              }}
            >
              <span class="min-w-0 truncate">{group.label}</span>
              <ExternalLink class="size-2.5 shrink-0" />
            </button>
            <span class="shrink-0 text-[10px] text-muted-foreground">{group.entries.length}</span>
          </summary>
          <div class="flex flex-col gap-1 border-t border-border/60 p-1.5">
            {#each group.entries as item (`${item.vaultCwd}:${item.entry.id}`)}
              {@render credentialRow(item)}
            {/each}
          </div>
        </details>
      {/each}
    </div>
  {/if}
{/snippet}

<div class="mobile-autofill flex h-[min(26rem,calc(100vh-3rem))] w-[min(22rem,calc(100vw-1rem))] min-h-0 overflow-hidden">
  <nav class="mobile-autofill-nav flex w-24 shrink-0 flex-col border-r border-border bg-muted/20 p-1" aria-label="Credential sections">
    <div class="flex items-center gap-1.5 px-1.5 py-2">
      <KeyRound class="size-3.5 text-muted-foreground" />
      <span class="text-[11px] font-medium">Autofill</span>
    </div>
    {#each ['site', 'project', 'other', 'save'] as section (section)}
      {@const id = section as SectionId}
      {@const count = sectionCount(id)}
      <button
        type="button"
        class={`flex items-center gap-1.5 rounded-md px-2 py-2 text-left text-[10px] transition-colors ${
          activeSection === id
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
        }`}
        aria-current={activeSection === id ? 'page' : undefined}
        onclick={() => (activeSection = id)}
      >
        {#if id === 'project'}
          <FolderGit2 class="size-3 shrink-0" />
        {:else if id === 'save'}
          <Save class="size-3 shrink-0" />
        {:else}
          <Globe2 class="size-3 shrink-0" />
        {/if}
        <span class="min-w-0 flex-1 truncate">{sectionLabel(id)}</span>
        {#if count !== null}
          <span class="shrink-0 font-mono text-[9px] opacity-70">{count}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <header class="flex min-h-10 shrink-0 items-center gap-2 border-b border-border px-2.5 py-1.5">
      <div class="min-w-0 flex-1">
        <div class="text-xs font-medium">{sectionLabel(activeSection)}</div>
        <div class="truncate text-[10px] text-muted-foreground">
          {#if activeSection === 'site'}
            {#if currentOrigin}
              <button
                type="button"
                class="inline-flex max-w-full cursor-pointer items-center gap-1 truncate underline decoration-transparent underline-offset-2 transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={`Open ${currentOrigin}`}
                onclick={() => navigateToOrigin(currentOrigin)}
              >
                <span class="truncate">{originLabel(currentOrigin)}</span>
                <ExternalLink class="size-2.5 shrink-0" />
              </button>
            {:else}
              No site selected
            {/if}
          {:else if activeSection === 'project'}
            Credentials shared across known worktrees
          {:else if activeSection === 'other'}
            Saved sites in this worktree
          {:else}
            Add a credential without exposing its secret
          {/if}
        </div>
      </div>
      {#if vaultStore.projectLoading}
        <span class="text-[10px] text-muted-foreground">Loading…</span>
      {/if}
    </header>

    {#if vaultStore.projectError}
      <div class="mx-3 mt-2 shrink-0 rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[10px] text-destructive">
        {vaultStore.projectError}
      </div>
    {/if}

    {#if activeSection === 'site'}
      <ScrollArea class="min-h-0 flex-1">
        <div class="flex flex-col gap-2 p-3">
          {#if siteEntries.length === 0}
            <div class="rounded-md border border-dashed border-border px-3 py-8 text-center text-[11px] text-muted-foreground">
              No saved credentials for this site
            </div>
          {:else}
            {#each siteEntries as item (`${item.vaultCwd}:${item.entry.id}`)}
              {@render credentialRow(item)}
            {/each}
          {/if}
          <button
            type="button"
            class="mt-1 text-left text-[10px] text-muted-foreground hover:text-foreground"
            onclick={() => (activeSection = 'project')}
          >
            Browse all credentials available to this project →
          </button>
        </div>
      </ScrollArea>
    {:else if activeSection === 'project'}
      <div class="shrink-0 border-b border-border p-2">
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            bind:value={projectQuery}
            class="h-7 pl-7 text-[11px]"
            placeholder="Search project credentials…"
            aria-label="Search project credentials"
          />
        </div>
      </div>
      <ScrollArea class="min-h-0 flex-1">
        <div class="p-3">
          {@render originGroups(projectGroups, 'No project credentials found')}
        </div>
      </ScrollArea>
    {:else if activeSection === 'other'}
      <div class="shrink-0 border-b border-border p-2">
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            bind:value={otherQuery}
            class="h-7 pl-7 text-[11px]"
            placeholder="Search other saved sites…"
            aria-label="Search other saved sites"
          />
        </div>
      </div>
      <ScrollArea class="min-h-0 flex-1">
        <div class="p-3">
          {@render originGroups(otherGroups, 'No other saved sites found')}
        </div>
      </ScrollArea>
    {:else}
      <ScrollArea class="min-h-0 flex-1">
        <form class="flex flex-col gap-3 p-3" onsubmit={submit}>
          <fieldset class="flex flex-col gap-1.5">
            <legend class="mb-1 text-[10px] font-medium text-muted-foreground">Save to</legend>
            <label class="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-[11px]">
              <input
                type="radio"
                name="vault-scope"
                value="project"
                bind:group={saveScope}
                class="mt-0.5"
              />
              <span>
                <span class="block font-medium">Project</span>
                <span class="block text-[10px] text-muted-foreground">
                  Available from this project's known worktrees
                </span>
              </span>
            </label>
            <label class="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-[11px]">
              <input
                type="radio"
                name="vault-scope"
                value="worktree"
                bind:group={saveScope}
                class="mt-0.5"
              />
              <span>
                <span class="block font-medium">Current worktree only</span>
                <span class="block text-[10px] text-muted-foreground">Keep it isolated to this checkout</span>
              </span>
            </label>
          </fieldset>

          {#if !currentOrigin || useCustomOrigin}
            <div class="flex flex-col gap-1">
              <Label class="text-[10px]" for="vault-origin">Site</Label>
              <Input
                id="vault-origin"
                bind:value={formOriginOverride}
                placeholder="https://example.com"
                class="h-7 text-[11px]"
                spellcheck={false}
              />
            </div>
          {:else}
            <div class="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
              <span>Site:</span>
              <button
                type="button"
                class="min-w-0 cursor-pointer truncate font-mono underline decoration-transparent underline-offset-2 transition-colors hover:text-foreground hover:decoration-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                title={`Open ${currentOrigin}`}
                onclick={() => navigateToOrigin(currentOrigin)}
              >
                {originLabel(currentOrigin)}
              </button>
              <span>·</span>
              <button
                type="button"
                class="cursor-pointer hover:text-foreground"
                onclick={() => (useCustomOrigin = true)}
              >change</button>
            </div>
          {/if}

          <div class="flex flex-col gap-1">
            <Label class="text-[10px]" for="vault-username">Username or email</Label>
            <Input
              id="vault-username"
              bind:value={formUsername}
              autocomplete="off"
              class="h-7 text-[11px]"
              spellcheck={false}
            />
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-[10px]" for="vault-password">Password</Label>
            <div class="relative">
              <Input
                id="vault-password"
                bind:value={formPassword}
                type={showFormPassword ? 'text' : 'password'}
                autocomplete="off"
                class="h-7 pr-7 text-[11px]"
                spellcheck={false}
              />
              <button
                type="button"
                class="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label={showFormPassword ? 'Hide password' : 'Show password'}
                onclick={() => (showFormPassword = !showFormPassword)}
              >
                {#if showFormPassword}
                  <EyeOff class="size-3" />
                {:else}
                  <Eye class="size-3" />
                {/if}
              </button>
            </div>
          </div>
          <div class="flex flex-col gap-1">
            <Label class="text-[10px]" for="vault-label">Label (optional)</Label>
            <Input
              id="vault-label"
              bind:value={formLabel}
              placeholder="e.g. work account"
              class="h-7 text-[11px]"
              spellcheck={false}
            />
          </div>
          <Button type="submit" variant="default" size="xs" class="h-7" disabled={!canSubmit}>
            <Save class="size-3" />
            <span class="ml-1">{saving ? 'Saving…' : 'Save credential'}</span>
          </Button>
        </form>
      </ScrollArea>
    {/if}
  </section>
</div>
