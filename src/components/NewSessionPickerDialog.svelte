<script lang="ts">
  import { tick } from 'svelte';
  import type {
    AgentRuntimeProvider,
    SessionLaunch,
    SessionLaunchKind
  } from '@shared/types/sessions.js';
  import type { MultiDeviceSessionCreationPlan } from '@shared/types/multi-device-sessions.js';
  import { newSessionPicker } from '../stores/new-session-picker.svelte';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import KindIcon from './KindIcon.svelte';

  let terminalButton: HTMLButtonElement | null = $state(null);
  let claudeButton: HTMLButtonElement | null = $state(null);
  let codexButton: HTMLButtonElement | null = $state(null);
  let kind = $state<SessionLaunchKind>('terminal');
  let workspaceKey = $state('');
  let deviceId = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let plan = $state<MultiDeviceSessionCreationPlan | null>(null);
  let wasOpen = false;

  let workspaceChoices = $derived(
    deviceSessions.state.projects.flatMap((project) =>
      project.workspaces.map((workspace) => ({ project, workspace }))
    )
  );
  let selectedChoice = $derived(
    workspaceChoices.find((choice) => choice.workspace.key === workspaceKey) ?? null
  );
  let selectedDevice = $derived(
    deviceSessions.state.devices.find((device) => device.deviceId === deviceId) ?? null
  );
  let selectedLocation = $derived(
    selectedChoice?.workspace.locations.find((location) => location.deviceId === deviceId) ?? null
  );
  let placementAvailable = $derived(
    deviceSessions.supported && deviceSessions.loaded && workspaceChoices.length > 0
  );

  function ctxOpts() {
    const context = newSessionPicker.context;
    return {
      ...(context.projectId ? { projectId: context.projectId } : {}),
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.branch ? { branch: context.branch } : {})
    };
  }

  function legacyTerminal(): void {
    newSessionPicker.close();
    void sessions.createWithDefaults(ctxOpts()).catch(reportError);
  }

  function legacyAgent(provider: AgentRuntimeProvider): void {
    newSessionPicker.close();
    void sessions.createAgentWithDefaults(provider, ctxOpts()).catch(reportError);
  }

  function buttonFor(value: SessionLaunchKind): HTMLButtonElement | null {
    if (value === 'terminal') return terminalButton;
    if (value === 'claude_code') return claudeButton;
    return codexButton;
  }

  function initializePlacement(): void {
    kind = settings.current.defaults.newSessionKind;
    const contextual = workspaceChoices.find((choice) =>
      choice.workspace.locations.some((location) =>
        location.projectId === newSessionPicker.context.projectId
        || location.path === newSessionPicker.context.cwd
      )
    );
    const choice = contextual ?? workspaceChoices[0] ?? null;
    workspaceKey = choice?.workspace.key ?? '';
    const preferredLocation = choice?.workspace.locations.find((location) => {
      const device = deviceSessions.device(location.deviceId);
      return device?.local && location.available;
    }) ?? choice?.workspace.locations.find((location) => location.available);
    deviceId = preferredLocation?.deviceId
      ?? deviceSessions.state.devices.find((device) => device.local && device.available)?.deviceId
      ?? deviceSessions.state.devices.find((device) => device.available)?.deviceId
      ?? '';
    busy = false;
    error = null;
    plan = null;
  }

  function launchFor(value: SessionLaunchKind): SessionLaunch {
    if (value === 'terminal') {
      return { type: 'terminal', shell: settings.current.defaults.shell };
    }
    return {
      type: 'agent',
      provider: value,
      resumeMode: 'new',
      ...(value === 'claude_code' ? { fullscreenTui: true } : {})
    };
  }

  function sessionName(value: SessionLaunchKind): string {
    if (value === 'claude_code') return 'Claude';
    if (value === 'codex') return 'Codex';
    return 'Terminal';
  }

  function resetPlan(): void {
    plan = null;
    error = null;
  }

  function creationRequest() {
    return {
      workspaceKey,
      targetDeviceId: deviceId,
      session: {
        name: sessionName(kind),
        launch: launchFor(kind)
      }
    };
  }

  async function preflight(): Promise<void> {
    if (!workspaceKey || !deviceId) return;
    busy = true;
    error = null;
    try {
      plan = await deviceSessions.planCreate(creationRequest());
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  async function execute(): Promise<void> {
    if (!plan) return;
    busy = true;
    error = null;
    try {
      await deviceSessions.executeCreate(plan.planId);
      newSessionPicker.close();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function onOpenChange(next: boolean): void {
    if (!next) newSessionPicker.close();
  }

  $effect(() => {
    const open = newSessionPicker.isOpen;
    if (open && !wasOpen) {
      initializePlacement();
      void tick().then(() => buttonFor(kind)?.focus());
    }
    wasOpen = open;
  });
</script>

<Dialog.Root open={newSessionPicker.isOpen} {onOpenChange}>
  <Dialog.Content class={placementAvailable ? 'sm:max-w-lg' : 'sm:max-w-sm'}>
    <Dialog.Header>
      <Dialog.Title>New session</Dialog.Title>
      <Dialog.Description>
        {placementAvailable
          ? 'Choose the Workspace and the device where this Session will run.'
          : 'Pick a session kind.'}
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid grid-cols-3 gap-2" aria-label="Session kind">
      <Button
        bind:ref={claudeButton}
        variant={kind === 'claude_code' ? 'secondary' : 'ghost'}
        class="h-20 flex-col gap-1.5 border border-border px-2 text-xs"
        onclick={() => {
          if (!placementAvailable) return legacyAgent('claude_code');
          kind = 'claude_code';
          resetPlan();
        }}
      >
        <KindIcon kind="claude_code" size={28} />
        <span class="leading-none">Claude</span>
      </Button>
      <Button
        bind:ref={codexButton}
        variant={kind === 'codex' ? 'secondary' : 'ghost'}
        class="h-20 flex-col gap-1.5 border border-border px-2 text-xs"
        onclick={() => {
          if (!placementAvailable) return legacyAgent('codex');
          kind = 'codex';
          resetPlan();
        }}
      >
        <KindIcon kind="codex" size={28} />
        <span class="leading-none">Codex</span>
      </Button>
      <Button
        bind:ref={terminalButton}
        variant={kind === 'terminal' ? 'secondary' : 'ghost'}
        class="h-20 flex-col gap-1.5 border border-border px-2 text-xs"
        onclick={() => {
          if (!placementAvailable) return legacyTerminal();
          kind = 'terminal';
          resetPlan();
        }}
      >
        <KindIcon kind="terminal" size={28} />
        <span class="leading-none">Terminal</span>
      </Button>
    </div>

    {#if placementAvailable}
      <div class="grid gap-3 pt-2">
        <label class="grid gap-1 text-xs font-medium" for="session-workspace">
          Workspace
          <select
            id="session-workspace"
            class="h-9 rounded-md border border-input bg-background px-2 font-normal"
            bind:value={workspaceKey}
            onchange={() => {
              resetPlan();
              const next = workspaceChoices.find((choice) => choice.workspace.key === workspaceKey);
              const existing = next?.workspace.locations.find((location) => location.deviceId === deviceId && location.available);
              if (!existing) {
                deviceId = next?.workspace.locations.find((location) => location.available)?.deviceId ?? deviceId;
              }
            }}
          >
            {#each workspaceChoices as choice (choice.workspace.key)}
              <option value={choice.workspace.key}>{choice.project.name} / {choice.workspace.name}</option>
            {/each}
          </select>
        </label>

        <label class="grid gap-1 text-xs font-medium" for="session-device">
          Run on
          <select
            id="session-device"
            class="h-9 rounded-md border border-input bg-background px-2 font-normal"
            bind:value={deviceId}
            onchange={resetPlan}
          >
            {#each deviceSessions.state.devices as device (device.deviceId)}
              {@const hasLocation = selectedChoice?.workspace.locations.some((location) => location.deviceId === device.deviceId)}
              <option value={device.deviceId} disabled={!device.available}>
                {device.name}{device.local ? ' · This device' : ''}{device.available ? '' : ' · Offline'}{hasLocation ? '' : ' · Needs project'}
              </option>
            {/each}
          </select>
        </label>

        <div class="rounded-md border border-border bg-muted/30 p-2 text-xs">
          {#if selectedLocation}
            <div class="font-medium">{selectedDevice?.name}</div>
            <div class="truncate font-mono text-muted-foreground" title={selectedLocation.path}>{selectedLocation.path}</div>
          {:else}
            <div class="font-medium">Project needs to be prepared on {selectedDevice?.name ?? 'this device'}</div>
            <div class="text-muted-foreground">
              Soloe will show the exact clone or Worktree path for review before creating anything.
            </div>
          {/if}
        </div>

        {#if error}
          <p class="m-0 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        {/if}

        {#if plan}
          <section class="grid gap-2 rounded-md border border-border p-3 text-xs" aria-label="Session creation review">
            <div class="flex items-center justify-between gap-2">
              <strong>
                {plan.action === 'use-existing-location'
                  ? 'Use existing Workspace Location'
                  : plan.action === 'clone-project'
                    ? 'Clone Project on this device'
                    : 'Create Workspace Location on this device'}
              </strong>
              <span>{plan.executable ? 'Ready' : 'Blocked'}</span>
            </div>
            {#if plan.targetPath}
              <div class="truncate font-mono text-muted-foreground" title={plan.targetPath}>{plan.targetPath}</div>
            {/if}
            {#each plan.warnings as warning (warning)}
              <p class="m-0 text-warning">{warning}</p>
            {/each}
            {#each plan.blockers as blocker (blocker)}
              <p class="m-0 text-destructive" role="alert">{blocker}</p>
            {/each}
          </section>
        {/if}

        <div class="flex justify-end gap-2">
          <Button variant="ghost" onclick={() => newSessionPicker.close()} disabled={busy}>Cancel</Button>
          {#if plan}
            <Button onclick={() => void execute()} disabled={busy || !plan.executable}>
              {busy ? 'Creating…' : 'Create session'}
            </Button>
          {:else}
            <Button onclick={() => void preflight()} disabled={busy || !selectedDevice?.available || !workspaceKey}>
              {busy ? 'Checking…' : 'Review'}
            </Button>
          {/if}
        </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
