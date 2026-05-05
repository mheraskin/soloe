<script lang="ts">
  import type {
    AgentLaunch,
    CodexResumeMode,
    CodexReasoningEffort,
    SessionDraft
  } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select';

  let draft = $derived(modal.draft.launch as AgentLaunch);

  function update<K extends keyof AgentLaunch>(key: K, value: AgentLaunch[K]) {
    modal.draft = {
      ...modal.draft,
      launch: { ...draft, [key]: value }
    } as SessionDraft;
  }

  const resumeModes: { value: CodexResumeMode; label: string }[] = [
    { value: 'new', label: 'New session' },
    { value: 'resume_last', label: 'Resume last' },
    { value: 'resume_by_id', label: 'Resume by id' }
  ];

  const efforts: CodexReasoningEffort[] = ['low', 'medium', 'high'];

  let currentResumeLabel = $derived(
    resumeModes.find((m) => m.value === draft.resumeMode)?.label ?? draft.resumeMode
  );
  let currentEffortLabel = $derived(draft.reasoningEffort ?? '(default)');
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Resume mode</Label>
  <Select.Root
    type="single"
    value={draft.resumeMode}
    onValueChange={(v) => update('resumeMode', v as CodexResumeMode)}
  >
    <Select.Trigger class="w-full">{currentResumeLabel}</Select.Trigger>
    <Select.Content>
      {#each resumeModes as m (m.value)}
        <Select.Item value={m.value} label={m.label}>{m.label}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>

{#if draft.resumeMode === 'resume_by_id'}
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="codex-session-id">Session id</Label>
    <Input
      id="codex-session-id"
      type="text"
      value={draft.codexSessionId ?? ''}
      oninput={(e) => update('codexSessionId', (e.currentTarget as HTMLInputElement).value)}
    />
  </div>
{/if}

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground" for="codex-model">Model (optional)</Label>
  <Input
    id="codex-model"
    type="text"
    placeholder="gpt-5"
    value={draft.model ?? ''}
    oninput={(e) => {
      const v = (e.currentTarget as HTMLInputElement).value.trim();
      update('model', v ? v : undefined);
    }}
  />
</div>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Reasoning effort</Label>
  <Select.Root
    type="single"
    value={draft.reasoningEffort ?? '__default__'}
    onValueChange={(v) => update('reasoningEffort', v === '__default__' ? undefined : (v as CodexReasoningEffort))}
  >
    <Select.Trigger class="w-full">{currentEffortLabel}</Select.Trigger>
    <Select.Content>
      <Select.Item value="__default__" label="(default)">(default)</Select.Item>
      {#each efforts as eff (eff)}
        <Select.Item value={eff} label={eff}>{eff}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>
