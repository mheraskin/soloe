<script lang="ts">
  import type { ProjectId } from '@shared/types/projects.js';
  import { projects } from '../stores/projects.svelte';
  import { Label } from '$lib/components/ui/label';
  import * as Select from '$lib/components/ui/select';

  let {
    value,
    onchange
  }: {
    value: ProjectId | null;
    onchange: (id: ProjectId | null) => void;
  } = $props();

  let current = $derived(value ?? '__none__');
  let triggerLabel = $derived.by(() => {
    if (!value) return 'Unassigned';
    return projects.get(value)?.name ?? 'Unassigned';
  });

  function handleChange(next: string): void {
    onchange(next === '__none__' ? null : (next as ProjectId));
  }
</script>

<div class="flex flex-col gap-1.5">
  <Label class="text-xs text-muted-foreground">Project</Label>
  <Select.Root type="single" value={current} onValueChange={handleChange}>
    <Select.Trigger class="w-full">
      {triggerLabel}
    </Select.Trigger>
    <Select.Content>
      <Select.Item value="__none__" label="Unassigned">Unassigned</Select.Item>
      {#each projects.recents as p (p.id)}
        <Select.Item value={p.id} label={p.name}>{p.name}</Select.Item>
      {/each}
    </Select.Content>
  </Select.Root>
</div>
