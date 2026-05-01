<script lang="ts">
  import type {
    CodexSession,
    CodexResumeMode,
    CodexReasoningEffort,
    SessionDraft
  } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';

  let draft = $derived(modal.draft as Extract<SessionDraft, { kind: 'codex' }>);

  function update<K extends keyof CodexSession>(key: K, value: CodexSession[K]) {
    modal.draft = { ...draft, [key]: value } as SessionDraft;
  }

  const resumeModes: { value: CodexResumeMode; label: string }[] = [
    { value: 'new', label: 'New session' },
    { value: 'resume_last', label: 'Resume last' },
    { value: 'resume_by_id', label: 'Resume by id' }
  ];

  const efforts: CodexReasoningEffort[] = ['low', 'medium', 'high'];
</script>

<label>
  Resume mode
  <select
    value={draft.resumeMode}
    onchange={(e) =>
      update('resumeMode', (e.currentTarget as HTMLSelectElement).value as CodexResumeMode)}
  >
    {#each resumeModes as m}
      <option value={m.value}>{m.label}</option>
    {/each}
  </select>
</label>

{#if draft.resumeMode === 'resume_by_id'}
  <label>
    Session id
    <input
      type="text"
      value={draft.codexSessionId ?? ''}
      oninput={(e) => update('codexSessionId', (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
{/if}

<label>
  Model (optional)
  <input
    type="text"
    placeholder="gpt-5"
    value={draft.model ?? ''}
    oninput={(e) => {
      const v = (e.currentTarget as HTMLInputElement).value.trim();
      update('model', v ? v : undefined);
    }}
  />
</label>

<label>
  Reasoning effort
  <select
    value={draft.reasoningEffort ?? ''}
    onchange={(e) => {
      const v = (e.currentTarget as HTMLSelectElement).value as CodexReasoningEffort | '';
      update('reasoningEffort', v === '' ? undefined : v);
    }}
  >
    <option value="">(default)</option>
    {#each efforts as eff}
      <option value={eff}>{eff}</option>
    {/each}
  </select>
</label>
