<script lang="ts">
  import type { AgentLaunch, CursorMode, CursorResumeMode, SessionDraft } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import * as Select from '$lib/components/ui/select';

  let draft = $derived(modal.draft.launch as AgentLaunch);
  function update<K extends keyof AgentLaunch>(key: K, value: AgentLaunch[K]) {
    modal.draft = { ...modal.draft, launch: { ...draft, [key]: value } } as SessionDraft;
  }
  const resumeModes: { value: CursorResumeMode; label: string }[] = [
    { value: 'new', label: 'New chat' },
    { value: 'resume_last', label: 'Resume last chat' },
    { value: 'resume_by_id', label: 'Resume by chat id' }
  ];
  const modes: CursorMode[] = ['agent', 'plan', 'ask'];
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Resume mode</Label>
  <Select.Root type="single" value={draft.resumeMode} onValueChange={(v) => update('resumeMode', v as CursorResumeMode)}>
    <Select.Trigger class="w-full">{resumeModes.find((m) => m.value === draft.resumeMode)?.label}</Select.Trigger>
    <Select.Content>{#each resumeModes as item (item.value)}<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>{/each}</Select.Content>
  </Select.Root>
</div>
{#if draft.resumeMode === 'resume_by_id'}
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="cursor-session-id">Cursor chat id</Label>
    <Input id="cursor-session-id" value={draft.cursorSessionId ?? ''} oninput={(e) => update('cursorSessionId', e.currentTarget.value)} />
  </div>
{/if}
<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Mode</Label>
  <Select.Root type="single" value={draft.cursorMode ?? 'agent'} onValueChange={(v) => update('cursorMode', v as CursorMode)}>
    <Select.Trigger class="w-full">{draft.cursorMode ?? 'agent'}</Select.Trigger>
    <Select.Content>{#each modes as mode (mode)}<Select.Item value={mode} label={mode}>{mode}</Select.Item>{/each}</Select.Content>
  </Select.Root>
</div>
<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground" for="cursor-model">Model (optional)</Label>
  <Input id="cursor-model" placeholder="auto" value={draft.model ?? ''} oninput={(e) => update('model', e.currentTarget.value.trim() || undefined)} />
</div>
