<script lang="ts">
  import type { AgentLaunch, GrokBuildResumeMode, SessionDraft } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select';
  import ProviderModelPicker from '../ProviderModelPicker.svelte';

  let draft = $derived(modal.draft.launch as AgentLaunch);

  function update<K extends keyof AgentLaunch>(key: K, value: AgentLaunch[K]) {
    modal.draft = { ...modal.draft, launch: { ...draft, [key]: value } } as SessionDraft;
  }

  const resumeModes: { value: GrokBuildResumeMode; label: string }[] = [
    { value: 'new', label: 'New session' },
    { value: 'resume_last', label: 'Resume last session' },
    { value: 'resume_by_id', label: 'Resume by session id' }
  ];
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Resume mode</Label>
  <Select.Root
    type="single"
    value={draft.resumeMode}
    onValueChange={(value) => update('resumeMode', value as GrokBuildResumeMode)}
  >
    <Select.Trigger class="w-full">
      {resumeModes.find((mode) => mode.value === draft.resumeMode)?.label}
    </Select.Trigger>
    <Select.Content>
      {#each resumeModes as item (item.value)}
        <Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>

{#if draft.resumeMode === 'resume_by_id'}
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="grok-session-id">Grok session id</Label>
    <Input
      id="grok-session-id"
      value={draft.grokSessionId ?? ''}
      oninput={(event) => update('grokSessionId', event.currentTarget.value)}
    />
  </div>
{/if}

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Model</Label>
  <ProviderModelPicker
    provider="grok_build"
    model={draft.model}
    providerLocked
    ariaLabel="Grok Build model"
    onchange={(_provider, model) => update('model', model)}
  />
</div>
