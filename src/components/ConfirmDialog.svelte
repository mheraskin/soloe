<script lang="ts">
  import { AlertTriangle } from '@lucide/svelte';
  import { confirmStore } from '../stores/confirm.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';

  function onOpenChange(next: boolean): void {
    if (!next) confirmStore.cancel();
  }
</script>

<Dialog.Root open={confirmStore.open} {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2">
        {#if confirmStore.tone === 'danger'}
          <AlertTriangle class="size-4 text-destructive" />
        {/if}
        {confirmStore.title || 'Confirm'}
      </Dialog.Title>
      <Dialog.Description class="text-sm text-foreground">
        {confirmStore.message}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      {#if confirmStore.dontAskAgainLabel}
        <Button variant="ghost" onclick={() => confirmStore.dontAskAgain()}>
          {confirmStore.dontAskAgainLabel}
        </Button>
      {/if}
      <Button variant="outline" onclick={() => confirmStore.cancel()}>
        {confirmStore.cancelLabel}
      </Button>
      <Button
        variant={confirmStore.tone === 'danger' ? 'destructive' : 'default'}
        onclick={() => confirmStore.confirm()}
      >
        {confirmStore.confirmLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
