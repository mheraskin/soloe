<script lang="ts">
  import type {
    ClaudeCodeSession,
    ClaudeResumeMode,
    SessionDraft
  } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';

  let draft = $derived(modal.draft as Extract<SessionDraft, { kind: 'claude_code' }>);

  function update<K extends keyof ClaudeCodeSession>(key: K, value: ClaudeCodeSession[K]) {
    modal.draft = { ...draft, [key]: value } as SessionDraft;
  }

  const resumeModes: { value: ClaudeResumeMode; label: string }[] = [
    { value: 'new', label: 'New session' },
    { value: 'resume_last', label: 'Resume last (--continue)' },
    { value: 'resume_by_name', label: 'Resume by name' },
    { value: 'resume_by_id', label: 'Resume by id' }
  ];
</script>

<label>
  Resume mode
  <select
    value={draft.resumeMode}
    onchange={(e) =>
      update('resumeMode', (e.currentTarget as HTMLSelectElement).value as ClaudeResumeMode)}
  >
    {#each resumeModes as m}
      <option value={m.value}>{m.label}</option>
    {/each}
  </select>
</label>

{#if draft.resumeMode === 'resume_by_name'}
  <label>
    Session name
    <input
      type="text"
      value={draft.claudeSessionName ?? ''}
      oninput={(e) => update('claudeSessionName', (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
{/if}

{#if draft.resumeMode === 'resume_by_id'}
  <label>
    Session id
    <input
      type="text"
      value={draft.claudeSessionId ?? ''}
      oninput={(e) => update('claudeSessionId', (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
{/if}

<label class="check">
  <input
    type="checkbox"
    checked={draft.fullscreenTui ?? false}
    onchange={(e) => update('fullscreenTui', (e.currentTarget as HTMLInputElement).checked)}
  />
  Fullscreen TUI (sets CLAUDE_CODE_NO_FLICKER=1)
</label>

<style>
  .check {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    color: var(--fg);
  }
</style>
