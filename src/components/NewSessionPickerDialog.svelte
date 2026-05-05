<script lang="ts">
  import { tick } from 'svelte';
  import type { AgentRuntimeProvider } from '@shared/types/sessions.js';
  import type { SessionLaunchKind } from '@shared/types/sessions.js';
  import { newSessionPicker } from '../stores/new-session-picker.svelte';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import KindIcon from './KindIcon.svelte';

  let terminalButton: HTMLButtonElement | null = $state(null);
  let claudeButton: HTMLButtonElement | null = $state(null);
  let codexButton: HTMLButtonElement | null = $state(null);

  function ctxOpts() {
    const c = newSessionPicker.context;
    return {
      ...(c.projectId ? { projectId: c.projectId } : {}),
      ...(c.cwd ? { cwd: c.cwd } : {}),
      ...(c.branch ? { branch: c.branch } : {})
    };
  }

  function launchTerminal(): void {
    newSessionPicker.close();
    void sessions.createWithDefaults(ctxOpts()).catch(reportError);
  }

  function launchAgent(kind: AgentRuntimeProvider): void {
    newSessionPicker.close();
    void sessions.createAgentWithDefaults(kind, ctxOpts()).catch(reportError);
  }

  function onOpenChange(next: boolean): void {
    if (!next) newSessionPicker.close();
  }

  function buttonFor(kind: SessionLaunchKind): HTMLButtonElement | null {
    switch (kind) {
      case 'terminal':
        return terminalButton;
      case 'claude_code':
        return claudeButton;
      case 'codex':
        return codexButton;
    }
  }

  $effect(() => {
    if (!newSessionPicker.isOpen) return;
    const kind = settings.current.defaults.newSessionKind;
    void tick().then(() => {
      if (!newSessionPicker.isOpen) return;
      buttonFor(kind)?.focus();
    });
  });
</script>

<Dialog.Root open={newSessionPicker.isOpen} {onOpenChange}>
  <Dialog.Content class="sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>New session</Dialog.Title>
      <Dialog.Description class="sr-only">Pick a session kind.</Dialog.Description>
    </Dialog.Header>
    <div class="grid grid-cols-3 gap-2">
      <Button
        bind:ref={claudeButton}
        variant="ghost"
        class="h-20 flex-col gap-1.5 border border-border px-2 text-xs"
        onclick={() => launchAgent('claude_code')}
      >
        <KindIcon kind="claude_code" size={28} />
        <span class="leading-none">Claude</span>
      </Button>
      <Button
        bind:ref={codexButton}
        variant="ghost"
        class="h-20 flex-col gap-1.5 border border-border px-2 text-xs"
        onclick={() => launchAgent('codex')}
      >
        <KindIcon kind="codex" size={28} />
        <span class="leading-none">Codex</span>
      </Button>
      <Button
        bind:ref={terminalButton}
        variant="ghost"
        class="h-20 flex-col gap-1.5 border border-border px-2 text-xs"
        onclick={launchTerminal}
      >
        <KindIcon kind="terminal" size={28} />
        <span class="leading-none">Terminal</span>
      </Button>
    </div>
  </Dialog.Content>
</Dialog.Root>
