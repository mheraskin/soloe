<script lang="ts">
  import type {
    AgentLaunch,
    ClaudeResumeMode,
    SessionDraft
  } from '@shared/types/sessions.js';
  import { modal } from '../../stores/modal.svelte';
  import { Label } from '$lib/components/ui/label';
  import { Input } from '$lib/components/ui/input';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Select from '$lib/components/ui/select';

  let draft = $derived(modal.draft.launch as AgentLaunch);

  function update<K extends keyof AgentLaunch>(key: K, value: AgentLaunch[K]) {
    modal.draft = {
      ...modal.draft,
      launch: { ...draft, [key]: value }
    } as SessionDraft;
  }

  const resumeModes: { value: ClaudeResumeMode; label: string }[] = [
    { value: 'new', label: 'New session' },
    { value: 'resume_last', label: 'Resume last (--continue)' },
    { value: 'resume_by_name', label: 'Resume by name' },
    { value: 'resume_by_id', label: 'Resume by id' }
  ];

  let currentLabel = $derived(
    resumeModes.find((m) => m.value === draft.resumeMode)?.label ?? draft.resumeMode
  );
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Resume mode</Label>
  <Select.Root
    type="single"
    value={draft.resumeMode}
    onValueChange={(v) => update('resumeMode', v as ClaudeResumeMode)}
  >
    <Select.Trigger class="w-full">{currentLabel}</Select.Trigger>
    <Select.Content>
      {#each resumeModes as m (m.value)}
        <Select.Item value={m.value} label={m.label}>{m.label}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>

{#if draft.resumeMode === 'resume_by_name'}
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="claude-session-name">Session name</Label>
    <Input
      id="claude-session-name"
      type="text"
      value={draft.claudeSessionName ?? ''}
      oninput={(e) => update('claudeSessionName', (e.currentTarget as HTMLInputElement).value)}
    />
  </div>
{/if}

{#if draft.resumeMode === 'resume_by_id'}
  <div class="flex flex-col gap-1.5">
    <Label class="text-xs text-muted-foreground" for="claude-session-id">Session id</Label>
    <Input
      id="claude-session-id"
      type="text"
      value={draft.claudeSessionId ?? ''}
      oninput={(e) => update('claudeSessionId', (e.currentTarget as HTMLInputElement).value)}
    />
  </div>
{/if}

<div class="flex items-center gap-2">
  <Checkbox
    id="claude-fullscreen"
    checked={draft.fullscreenTui ?? true}
    onCheckedChange={(v) => update('fullscreenTui', v === true)}
  />
  <Label for="claude-fullscreen" class="text-sm text-foreground">
    Fullscreen TUI (sets CLAUDE_CODE_NO_FLICKER=1)
  </Label>
</div>
