<script lang="ts">
  import { settings } from '../stores/settings.svelte';
  import * as Sheet from '$lib/components/ui/sheet';
  import { ScrollArea } from '$lib/components/ui/scroll-area';
  import PreferencesForm from './forms/PreferencesForm.svelte';

  function onOpenChange(next: boolean) {
    if (!next) settings.closeDrawer();
  }
</script>

<Sheet.Root open={settings.drawerOpen} {onOpenChange}>
  <Sheet.Content side="right" class="w-[400px] max-w-[92vw] gap-0 overflow-hidden p-0">
    <Sheet.Header class="border-b border-border">
      <Sheet.Title class="text-sm font-medium">Settings</Sheet.Title>
      <Sheet.Description class="sr-only">Application preferences and defaults.</Sheet.Description>
    </Sheet.Header>
    <ScrollArea class="min-h-0 flex-1">
      <div class="px-4 pb-4">
        <PreferencesForm />
      </div>
    </ScrollArea>
  </Sheet.Content>
</Sheet.Root>
