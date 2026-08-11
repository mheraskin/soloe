<script lang="ts">
  import { tick } from 'svelte';
  import { ArrowRight, Loader2, Plus } from '@lucide/svelte';
  import type { AgentRuntimeProvider, Session, SessionId } from '@shared/types/sessions.js';
  import { sessions } from '../stores/sessions.svelte';
  import { sessionHandoff } from '../stores/session-handoff.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { displaySessionKind } from '../lib/session-agent';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import { cn } from '$lib/utils';
  import KindIcon from './KindIcon.svelte';

  const NEW_TARGET = '__new__';
  const providers: AgentRuntimeProvider[] = ['claude_code', 'codex'];

  type TargetId = SessionId | typeof NEW_TARGET;

  let continueButton: HTMLButtonElement | null = $state(null);
  let selectedProvider = $state<AgentRuntimeProvider>('claude_code');
  let targetId = $state<TargetId>(NEW_TARGET);
  let busy = $state(false);
  let initializedFor = $state<SessionId | null>(null);

  let origin = $derived(
    sessionHandoff.originId
      ? sessions.sessions.find((session) => session.id === sessionHandoff.originId) ?? null
      : null
  );
  let originKind = $derived(
    origin ? displaySessionKind(origin, sessions.observationFor(origin.id)) : 'terminal'
  );
  let targets = $derived(
    origin ? sessions.handoffTargetsFor(origin.id, selectedProvider) : []
  );
  let selectedTarget = $derived(
    targetId === NEW_TARGET
      ? null
      : targets.find((session) => session.id === targetId) ?? null
  );
  let actionText = $derived(buildActionText(origin, selectedTarget, selectedProvider));

  $effect(() => {
    if (!sessionHandoff.isOpen) {
      initializedFor = null;
      return;
    }
    const id = sessionHandoff.originId;
    if (!id || initializedFor === id) return;
    initializedFor = id;
    selectedProvider = originKind === 'claude_code' ? 'codex' : 'claude_code';
    targetId = NEW_TARGET;
    void tick().then(() => {
      if (sessionHandoff.isOpen) continueButton?.focus();
    });
  });

  $effect(() => {
    if (targetId === NEW_TARGET) return;
    if (!targets.some((target) => target.id === targetId)) {
      targetId = NEW_TARGET;
    }
  });

  function onOpenChange(next: boolean): void {
    if (!next) sessionHandoff.close();
  }

  async function continueNow(): Promise<void> {
    if (!origin || busy) return;
    busy = true;
    try {
      const target = targetId === NEW_TARGET
        ? await sessions.continueWithAgent(origin.id, selectedProvider)
        : await sessions.continueInSession(origin.id, targetId);
      sessions.select(target.id);
      sessionHandoff.close();
    } catch (err) {
      reportError(err);
    } finally {
      busy = false;
    }
  }

  function providerLabel(provider: AgentRuntimeProvider): string {
    return provider === 'claude_code' ? 'Claude Code' : 'Codex';
  }

  function providerButtonClass(provider: AgentRuntimeProvider): string {
    return cn(
      'h-16 flex-1 flex-col gap-1.5 border border-border px-2 text-xs',
      selectedProvider === provider && 'border-primary bg-primary/10 text-primary'
    );
  }

  function targetButtonClass(selected: boolean): string {
    return cn(
      'flex w-full items-center gap-3 rounded-md border border-border bg-background px-3 py-2 text-left transition-colors hover:bg-muted',
      selected && 'border-primary bg-primary/10'
    );
  }

  function sessionMeta(session: Session): string {
    const status = sessions.statusFor(session.id);
    return `${status} · ${session.cwd}`;
  }

  function buildActionText(
    source: Session | null,
    target: Session | null,
    provider: AgentRuntimeProvider
  ): string {
    if (!source) return '';
    if (target) {
      return `Switch to ${target.name || 'the selected session'}, start it if needed, and paste a handoff prompt from ${source.name || 'this session'}.`;
    }
    return `Create a new ${providerLabel(provider)} session in this worktree and paste a handoff prompt from ${source.name || 'this session'}.`;
  }
</script>

<Dialog.Root open={sessionHandoff.isOpen} {onOpenChange}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Continue in another session</Dialog.Title>
      <Dialog.Description class="sr-only">
        Choose an agent and destination session for the handoff.
      </Dialog.Description>
    </Dialog.Header>

    {#if origin}
      <div class="grid gap-4">
        <div class="grid gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">Agent</span>
          <div class="flex gap-2">
            {#each providers as provider (provider)}
              <Button
                variant="ghost"
                class={providerButtonClass(provider)}
                aria-pressed={selectedProvider === provider}
                onclick={() => {
                  selectedProvider = provider;
                  targetId = NEW_TARGET;
                }}
              >
                <KindIcon kind={provider} size={24} />
                <span class="leading-none">{providerLabel(provider)}</span>
              </Button>
            {/each}
          </div>
        </div>

        <div class="grid gap-1.5">
          <span class="text-xs font-medium text-muted-foreground">Destination</span>
          <div class="grid max-h-64 gap-2 overflow-y-auto pr-1">
            <button
              type="button"
              class={targetButtonClass(targetId === NEW_TARGET)}
              aria-pressed={targetId === NEW_TARGET}
              onclick={() => {
                targetId = NEW_TARGET;
              }}
            >
              <span class="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                <Plus class="size-4" />
              </span>
              <span class="grid min-w-0 flex-1 gap-0.5">
                <span class="truncate text-sm font-medium">New {providerLabel(selectedProvider)} session</span>
                <span class="truncate text-xs text-muted-foreground">{origin.cwd}</span>
              </span>
            </button>

            {#each targets as target (target.id)}
              <button
                type="button"
                class={targetButtonClass(targetId === target.id)}
                aria-pressed={targetId === target.id}
                onclick={() => {
                  targetId = target.id;
                }}
              >
                <KindIcon kind={selectedProvider} size={22} />
                <span class="grid min-w-0 flex-1 gap-0.5">
                  <span class="truncate text-sm font-medium">{target.name || '(unnamed)'}</span>
                  <span class="truncate text-xs text-muted-foreground">{sessionMeta(target)}</span>
                </span>
              </button>
            {/each}
          </div>
        </div>

        <div class="rounded-md border border-border bg-muted/25 px-3 py-2 text-xs leading-5 text-muted-foreground">
          {actionText}
        </div>

        <Dialog.Footer>
          <Button variant="ghost" onclick={() => sessionHandoff.close()} disabled={busy}>
            Cancel
          </Button>
          <Button bind:ref={continueButton} onclick={() => void continueNow()} disabled={busy}>
            {#if busy}
              <Loader2 class="size-3.5 animate-spin" />
            {:else}
              <ArrowRight class="size-3.5" />
            {/if}
            <span>Continue</span>
          </Button>
        </Dialog.Footer>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
