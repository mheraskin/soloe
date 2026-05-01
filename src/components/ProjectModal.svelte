<script lang="ts">
  import { X } from 'lucide-svelte';
  import { projectModal } from '../stores/project-modal.svelte';
  import { projects } from '../stores/projects.svelte';
  import { reportError } from '../stores/toast.svelte';
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
    const err = validate();
    if (err) {
      projectModal.error = err;
      return;
    }
    submitting = true;
    projectModal.error = null;
    try {
      if (projectModal.mode === 'new') {
        const created = await projects.create(projectModal.draft);
        projectModal.onCreated?.(created);
      } else if (projectModal.editingId) {
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

  function onKey(e: KeyboardEvent) {
    if (projectModal.open && e.key === 'Escape') projectModal.close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if projectModal.open}
  <div class="backdrop" onclick={() => projectModal.close()} role="presentation"></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Project details">
    <header>
      <h2>{projectModal.mode === 'new' ? 'New project' : 'Edit project'}</h2>
      <button class="close" onclick={() => projectModal.close()} aria-label="Close">
        <X size={16} />
      </button>
    </header>

    <form onsubmit={submit}>
      <ProjectForm />

      {#if projectModal.error}
        <p class="error">{projectModal.error}</p>
      {/if}

      <footer>
        <button type="button" onclick={() => projectModal.close()}>Cancel</button>
        <button type="submit" class="primary" disabled={submitting}>
          {projectModal.mode === 'new' ? 'Create' : 'Save'}
        </button>
      </footer>
    </form>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 110;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 111;
    width: 440px;
    max-width: 92vw;
    max-height: 86vh;
    background: var(--bg-elev-1);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius);
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  header h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 500;
  }
  .close {
    background: transparent;
    border: none;
    color: var(--muted);
    line-height: 1;
    padding: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .close:hover { color: var(--fg); }

  form {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }
  .error {
    color: var(--red);
    margin: 0;
    font-size: 12px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 4px;
  }
  .primary {
    background: var(--accent-strong);
    color: var(--bg);
    border-color: var(--accent-strong);
  }
  .primary:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
  }
</style>
