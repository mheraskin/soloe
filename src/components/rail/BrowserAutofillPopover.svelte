<script lang="ts">
  import { onMount } from 'svelte';
  import { KeyRound, Trash2, Save, Eye, EyeOff } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Separator } from '$lib/components/ui/separator';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import { toast } from 'svelte-sonner';
  import { vaultStore, vaultNormalizeOrigin } from '../../stores/vault.svelte';
  import { reportError } from '../../stores/toast.svelte';
  import type { VaultEntry } from '../../../shared/types/vault';

  interface Props {
    currentUrl: string;
    onFill: (username: string, password: string) => Promise<{ filledUser: boolean }>;
    onClose: () => void;
  }

  let { currentUrl, onFill, onClose }: Props = $props();

  let currentOrigin = $derived(vaultNormalizeOrigin(currentUrl));
  let matches = $derived(vaultStore.matchesForOrigin(currentUrl));
  let others = $derived(
    vaultStore.entries.filter((e) => !currentOrigin || e.origin !== currentOrigin)
  );

  let saving = $state(false);
  let formUsername = $state('');
  let formPassword = $state('');
  let formLabel = $state('');
  let showFormPassword = $state(false);
  let formOriginOverride = $state('');
  let useCustomOrigin = $state(false);

  onMount(() => {
    void vaultStore.ensureLoaded();
  });

  let effectiveOrigin = $derived(
    useCustomOrigin && formOriginOverride.trim() ? formOriginOverride.trim() : currentOrigin
  );

  let canSubmit = $derived(
    !!effectiveOrigin && formUsername.trim().length > 0 && formPassword.length > 0 && !saving
  );

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    saving = true;
    try {
      await vaultStore.save({
        origin: effectiveOrigin,
        username: formUsername.trim(),
        password: formPassword,
        label: formLabel.trim() || undefined
      });
      formUsername = '';
      formPassword = '';
      formLabel = '';
      showFormPassword = false;
      toast.success('Saved');
    } catch (err) {
      reportError(err, 'Failed to save credential');
    } finally {
      saving = false;
    }
  }

  async function fillEntry(entry: VaultEntry) {
    try {
      const secret = await vaultStore.getSecret(entry.id);
      const result = await onFill(secret.username, secret.password);
      if (!result.filledUser) {
        toast.success('Filled password (no username field detected)');
      } else {
        toast.success('Filled');
      }
      onClose();
    } catch (err) {
      reportError(err, 'Autofill failed');
    }
  }

  async function removeEntry(entry: VaultEntry) {
    if (!confirm(`Delete ${entry.username} at ${entry.origin}?`)) return;
    try {
      await vaultStore.delete(entry.id);
      toast.success('Deleted');
    } catch (err) {
      reportError(err, 'Failed to delete');
    }
  }

  function originLabel(origin: string): string {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  }
</script>

<div class="flex max-h-[480px] w-[340px] flex-col">
  <div class="flex items-center gap-2 border-b border-border px-3 py-2">
    <KeyRound class="size-4 text-muted-foreground" />
    <span class="text-xs font-medium">Autofill</span>
    {#if currentOrigin}
      <span class="ml-auto truncate text-[10px] text-muted-foreground" title={currentOrigin}>
        {originLabel(currentOrigin)}
      </span>
    {/if}
  </div>

  <ScrollArea class="min-h-0 flex-1">
    <div class="flex flex-col gap-3 p-3">
      {#if vaultStore.error}
        <div class="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          {vaultStore.error}
        </div>
      {/if}

      {#if currentOrigin}
        <section class="flex flex-col gap-1">
          <div class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            For this site
          </div>
          {#if matches.length === 0}
            <div class="text-[11px] text-muted-foreground">No saved entries.</div>
          {:else}
            {#each matches as entry (entry.id)}
              <div class="flex items-center gap-2 rounded border border-border bg-muted/20 px-2 py-1.5">
                <div class="min-w-0 flex-1">
                  <div class="truncate text-xs">{entry.username}</div>
                  {#if entry.label}
                    <div class="truncate text-[10px] text-muted-foreground">{entry.label}</div>
                  {/if}
                </div>
                <Button
                  type="button"
                  variant="default"
                  size="xs"
                  class="h-6"
                  onclick={() => fillEntry(entry)}
                >
                  Fill
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="size-6"
                  aria-label="Delete entry"
                  onclick={() => removeEntry(entry)}
                >
                  <Trash2 class="size-3" />
                </Button>
              </div>
            {/each}
          {/if}
        </section>
      {/if}

      <Separator />

      <section class="flex flex-col gap-2">
        <div class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Save credential
        </div>
        <form class="flex flex-col gap-2" onsubmit={submit}>
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
            <button
              type="button"
              class="text-left text-[10px] text-muted-foreground hover:text-foreground"
              onclick={() => (useCustomOrigin = true)}
            >
              Site: <span class="font-mono">{originLabel(currentOrigin)}</span> · change
            </button>
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
            <span class="ml-1">{saving ? 'Saving…' : 'Save'}</span>
          </Button>
        </form>
      </section>

      {#if others.length > 0}
        <Separator />
        <section class="flex flex-col gap-1">
          <div class="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Other saved sites
          </div>
          {#each others as entry (entry.id)}
            <div class="flex items-center gap-2 rounded border border-border/60 px-2 py-1">
              <div class="min-w-0 flex-1">
                <div class="truncate text-[11px]">{entry.username}</div>
                <div class="truncate font-mono text-[10px] text-muted-foreground">
                  {originLabel(entry.origin)}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="size-6"
                aria-label="Delete entry"
                onclick={() => removeEntry(entry)}
              >
                <Trash2 class="size-3" />
              </Button>
            </div>
          {/each}
        </section>
      {/if}
    </div>
  </ScrollArea>
</div>
