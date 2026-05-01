<script lang="ts">
  import type { RunMode, SessionDraft, SessionKind } from '@shared/types/sessions.js';
  import { modal } from '../stores/modal.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { kindLabel, validateDraft } from '../lib/sessions-helpers';
  import StandardForm from './forms/StandardForm.svelte';
  import ClaudeForm from './forms/ClaudeForm.svelte';
  import CodexForm from './forms/CodexForm.svelte';
  import KindIcon from './KindIcon.svelte';

  const kinds: SessionKind[] = ['standard_terminal', 'claude_code', 'codex'];
  let submitting = $state(false);

  function setKind(k: SessionKind) {
    modal.setKind(k);
  }

  function setBase<K extends 'name' | 'cwd' | 'runMode' | 'wslDistro'>(
    key: K,
    value: SessionDraft[K]
  ) {
    modal.draft = { ...modal.draft, [key]: value } as SessionDraft;
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (submitting) return;
    const err = validateDraft(modal.draft);
    if (err) {
      modal.error = err.message;
      return;
    }
    submitting = true;
    modal.error = null;
    try {
      if (modal.mode === 'new') {
        await sessions.create(modal.draft);
      } else if (modal.editingId) {
        await sessions.update(modal.editingId, modal.draft);
      }
      modal.close();
    } catch (e2) {
      modal.error = e2 instanceof Error ? e2.message : String(e2);
      reportError(e2);
    } finally {
      submitting = false;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (modal.open && e.key === 'Escape') modal.close();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if modal.open}
  <div class="backdrop" onclick={() => modal.close()} role="presentation"></div>
  <div class="modal" role="dialog" aria-modal="true" aria-label="Session details">
    <header>
      <h2>{modal.mode === 'new' ? 'New session' : 'Edit session'}</h2>
      <button class="close" onclick={() => modal.close()} aria-label="Close">×</button>
    </header>

    <form onsubmit={submit}>
      {#if modal.mode === 'new'}
        <fieldset class="kinds">
          <legend>Kind</legend>
          <div class="kind-row">
            {#each kinds as k (k)}
              <button
                type="button"
                class:active={modal.draft.kind === k}
                onclick={() => setKind(k)}
              >
                <KindIcon kind={k} size={18} />
                <span>{kindLabel(k)}</span>
              </button>
            {/each}
          </div>
        </fieldset>
      {/if}

      <label>
        Name
        <input
          type="text"
          required
          value={modal.draft.name}
          oninput={(e) => setBase('name', (e.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <label>
        Working directory
        <input
          type="text"
          required
          placeholder={modal.draft.runMode === 'wsl' ? '/home/you/project' : 'C:\\Users\\you\\project'}
          value={modal.draft.cwd}
          oninput={(e) => setBase('cwd', (e.currentTarget as HTMLInputElement).value)}
        />
      </label>

      <div class="row">
        <label>
          Run mode
          <select
            value={modal.draft.runMode}
            onchange={(e) =>
              setBase('runMode', (e.currentTarget as HTMLSelectElement).value as RunMode)}
          >
            <option value="windows">Windows / native</option>
            <option value="wsl">WSL</option>
          </select>
        </label>
        {#if modal.draft.runMode === 'wsl'}
          <label>
            WSL distro
            <input
              type="text"
              required
              placeholder="Ubuntu"
              value={modal.draft.wslDistro ?? ''}
              oninput={(e) => setBase('wslDistro', (e.currentTarget as HTMLInputElement).value)}
            />
          </label>
        {/if}
      </div>

      <hr />

      {#if modal.draft.kind === 'standard_terminal'}
        <StandardForm />
      {:else if modal.draft.kind === 'claude_code'}
        <ClaudeForm />
      {:else if modal.draft.kind === 'codex'}
        <CodexForm />
      {/if}

      {#if modal.error}
        <p class="error">{modal.error}</p>
      {/if}

      <footer>
        <button type="button" onclick={() => modal.close()}>Cancel</button>
        <button type="submit" class="primary" disabled={submitting}>
          {modal.mode === 'new' ? 'Create' : 'Save'}
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
    z-index: 100;
  }
  .modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 101;
    width: 480px;
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
    font-size: 20px;
    line-height: 1;
    padding: 0 4px;
    cursor: pointer;
  }
  .close:hover { color: var(--fg); }

  form {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 4px 0;
  }
  .row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .kinds {
    border: none;
    padding: 0;
    margin: 0;
  }
  .kinds legend {
    font-size: 12px;
    color: var(--muted);
    padding: 0 0 4px;
  }
  .kind-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .kind-row button {
    padding: 10px;
    background: var(--bg-elev-2);
    border: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }
  .kind-row button.active {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--bg-elev-3);
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
