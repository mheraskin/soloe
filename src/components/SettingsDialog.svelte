<script lang="ts">
  import { settings } from '../stores/settings.svelte';
  import * as Dialog from '$lib/components/ui/dialog';

  const preferencesForm = import('./forms/PreferencesForm.svelte');

  function onOpenChange(next: boolean) {
    if (!next) settings.closeDialog();
  }
</script>

<Dialog.Root open={settings.dialogOpen} {onOpenChange}>
  <Dialog.Content
    class="settings-dialog flex h-[min(640px,calc(100vh-4rem))] w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
  >
    <Dialog.Header class="flex-shrink-0 border-b border-border px-4 py-3">
      <Dialog.Title class="text-sm font-medium">Settings</Dialog.Title>
      <Dialog.Description class="sr-only">Application preferences and defaults.</Dialog.Description>
    </Dialog.Header>
    {#await preferencesForm}
      <div
        class="flex min-h-0 flex-1 overflow-hidden"
        role="status"
        aria-live="polite"
        aria-label="Loading settings"
      >
        <div
          class="hidden w-44 shrink-0 flex-col gap-2 border-r border-border bg-muted/30 p-2 sm:flex"
          aria-hidden="true"
        >
          {#each Array(9) as _, i}
            <div
              class={`h-7 rounded-md bg-muted motion-safe:animate-pulse ${i === 0 ? 'opacity-100' : 'opacity-60'}`}
            ></div>
          {/each}
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-4 p-5" aria-hidden="true">
          <div class="h-4 w-36 rounded bg-muted motion-safe:animate-pulse"></div>
          <div class="h-9 w-full rounded-md bg-muted/80 motion-safe:animate-pulse"></div>
          <div class="h-3 w-4/5 rounded bg-muted/70 motion-safe:animate-pulse"></div>
          <div class="mt-2 h-4 w-28 rounded bg-muted motion-safe:animate-pulse"></div>
          <div class="h-9 w-full rounded-md bg-muted/80 motion-safe:animate-pulse"></div>
          <div class="h-16 w-full rounded-md border border-border bg-muted/40 motion-safe:animate-pulse"></div>
        </div>
        <span class="sr-only">Loading settings…</span>
      </div>
    {:then module}
      {@const PreferencesForm = module.default}
      <PreferencesForm />
    {:catch error}
      <div class="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
        <div class="max-w-sm">
          <p class="m-0 text-sm font-medium">Settings could not be loaded</p>
          <p class="mt-1 text-xs text-muted-foreground">{error.message}</p>
        </div>
      </div>
    {/await}
  </Dialog.Content>
</Dialog.Root>
