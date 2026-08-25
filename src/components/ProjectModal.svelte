<script lang="ts">
  import { projectModal } from '../stores/project-modal.svelte';
  import { projects } from '../stores/projects.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import ProjectForm from './forms/ProjectForm.svelte';

  let submitting = $state(false);

  function validate(): string | null {
    const d = projectModal.draft;
    if (!d.name.trim()) return 'Name is required';
    if (!d.path.trim()) return 'Path is required';
    if (d.defaultRunMode === 'wsl' && d.defaultWslDistro !== undefined && !d.defaultWslDistro.trim()) {
      return 'WSL distro must be non-empty when set';
    }
    return null;
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (submitting) return;
    if (!projectModal.editingId) return;
    const err = validate();
    if (err) {
      projectModal.error = err;
      return;
    }
    submitting = true;
    projectModal.error = null;
    try {
      const target = projectModal.deviceTarget
        ? $state.snapshot(projectModal.deviceTarget)
        : null;
      if (target) {
        await deviceSessions.updateProjectOnDevice(target, $state.snapshot(projectModal.draft));
      } else {
        await projects.update(projectModal.editingId, projectModal.draft);
      }
      projectModal.close();
    } catch (err2) {
      projectModal.error = err2 instanceof Error ? err2.message : String(err2);
      reportError(err2);
    } finally {
      submitting = false;
    }
  }

  function onOpenChange(next: boolean) {
    if (!next) projectModal.close();
  }
</script>

<Dialog.Root open={projectModal.open} {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Edit project{projectModal.deviceName ? ` on ${projectModal.deviceName}` : ''}</Dialog.Title>
      <Dialog.Description class="sr-only">Update the project's name, path, and defaults.</Dialog.Description>
    </Dialog.Header>

    <form class="flex flex-col gap-3" onsubmit={submit}>
      <ProjectForm />

      {#if projectModal.error}
        <p class="m-0 text-xs text-destructive">{projectModal.error}</p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => projectModal.close()}>Cancel</Button>
        <Button type="submit" disabled={submitting}>{submitting ? 'Saving...' : 'Save'}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
