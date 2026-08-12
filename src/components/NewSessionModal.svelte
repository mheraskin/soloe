<script lang="ts">
  import type { RunMode, SessionDraft } from '@shared/types/sessions.js';
  import { runModeLabel as labelForRunMode } from '@shared/platform.js';
  import type { ProjectId } from '@shared/types/projects.js';
  import { modal } from '../stores/modal.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { platform } from '../stores/platform.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { validateDraft } from '../lib/sessions-helpers';
  import { platformRunModeOptions, runModePathPlaceholder } from '../lib/platform-ui';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Separator } from '$lib/components/ui/separator';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Select from '$lib/components/ui/select';
  import StandardForm from './forms/StandardForm.svelte';
  import ClaudeForm from './forms/ClaudeForm.svelte';
  import CodexForm from './forms/CodexForm.svelte';
  import ProjectPicker from './ProjectPicker.svelte';

  let submitting = $state(false);

  function setBase<K extends 'name' | 'cwd' | 'runMode' | 'wslDistro' | 'projectId'>(
    key: K,
    value: SessionDraft[K]
  ) {
    const next = { ...modal.draft, [key]: value } as SessionDraft;
    if (key === 'projectId' && value === undefined) {
      delete (next as { projectId?: ProjectId }).projectId;
    }
    modal.draft = next;
  }

  function setProjectId(id: ProjectId | null) {
    setBase('projectId', id ?? undefined);
  }

  async function submit(e: Event) {
    e.preventDefault();
    if (submitting) return;
    if (!modal.editingId) return;
    const err = validateDraft(modal.draft);
    if (err) {
      modal.error = err.message;
      return;
    }
    submitting = true;
    modal.error = null;
    try {
      await sessions.update(modal.editingId, modal.draft);
      modal.close();
    } catch (e2) {
      modal.error = e2 instanceof Error ? e2.message : String(e2);
      reportError(e2);
    } finally {
      submitting = false;
    }
  }

  function onOpenChange(next: boolean) {
    if (!next) modal.close();
  }

  let runModeLabel = $derived(labelForRunMode(modal.draft.runMode));
  let runModeOptions = $derived(platformRunModeOptions(platform.current));
</script>

<Dialog.Root open={modal.open} {onOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Edit session</Dialog.Title>
      <Dialog.Description class="sr-only">Update session name, working directory, and runtime.</Dialog.Description>
    </Dialog.Header>

    <form class="flex flex-col gap-3" onsubmit={submit}>
      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground" for="ses-name">Name</Label>
        <Input
          id="ses-name"
          type="text"
          required
          value={modal.draft.name}
          oninput={(e) => setBase('name', (e.currentTarget as HTMLInputElement).value)}
        />
      </div>

      <ProjectPicker
        value={modal.draft.projectId ?? null}
        onchange={setProjectId}
      />

      <div class="flex flex-col gap-1.5">
        <Label class="text-xs text-muted-foreground" for="ses-cwd">Working directory</Label>
        <Input
          id="ses-cwd"
          type="text"
          required
          placeholder={runModePathPlaceholder(modal.draft.runMode)}
          value={modal.draft.cwd}
          oninput={(e) => setBase('cwd', (e.currentTarget as HTMLInputElement).value)}
        />
      </div>

      <div class="mobile-form-grid grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1.5">
          <Label class="text-xs text-muted-foreground">Run mode</Label>
          <Select.Root
            type="single"
            value={modal.draft.runMode}
            onValueChange={(v) => setBase('runMode', v as RunMode)}
          >
            <Select.Trigger class="w-full">{runModeLabel}</Select.Trigger>
            <Select.Content>
              {#each runModeOptions as option (option.value)}
                <Select.Item value={option.value} label={option.label}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
        {#if modal.draft.runMode === 'wsl'}
          <div class="flex flex-col gap-1.5">
            <Label class="text-xs text-muted-foreground" for="ses-wsl">WSL distro</Label>
            <Input
              id="ses-wsl"
              type="text"
              required
              placeholder="Ubuntu"
              value={modal.draft.wslDistro ?? ''}
              oninput={(e) => setBase('wslDistro', (e.currentTarget as HTMLInputElement).value)}
            />
          </div>
        {/if}
      </div>

      <Separator class="my-1" />

      {#if modal.draft.launch.type === 'terminal'}
        <StandardForm />
      {:else if modal.draft.launch.provider === 'claude_code'}
        <ClaudeForm />
      {:else}
        <CodexForm />
      {/if}

      {#if modal.error}
        <p class="m-0 text-xs text-destructive">{modal.error}</p>
      {/if}

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={() => modal.close()}>Cancel</Button>
        <Button type="submit" disabled={submitting}>Save</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
