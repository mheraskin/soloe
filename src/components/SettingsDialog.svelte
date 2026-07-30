<script lang="ts">
  import { settings } from '../stores/settings.svelte';
  import * as Dialog from '$lib/components/ui/dialog';
  import PreferencesForm from './forms/PreferencesForm.svelte';

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
    <PreferencesForm />
  </Dialog.Content>
</Dialog.Root>
