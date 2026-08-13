<script lang="ts">
  import { tick } from 'svelte';
  import type {
    AgentRuntimeProvider,
    SessionLaunch,
    SessionLaunchKind
  } from '@shared/types/sessions.js';
  import type {
    CockpitPlaceSessionOperation,
    CockpitPlaceSessionPlan
  } from '@shared/types/workspaces.js';
  import { newSessionPicker } from '../stores/new-session-picker.svelte';
  import { settings } from '../stores/settings.svelte';
  import { sessions } from '../stores/sessions.svelte';
  import { cockpit } from '../stores/cockpit.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { devicePresentation } from '../lib/device-presentation.js';
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import KindIcon from './KindIcon.svelte';

  let terminalButton: HTMLButtonElement | null = $state(null);
  let claudeButton: HTMLButtonElement | null = $state(null);
  let codexButton: HTMLButtonElement | null = $state(null);
  let kind = $state<SessionLaunchKind>('terminal');
  let workspaceId = $state('');
  let deviceId = $state('');
  let sourceMode = $state<'shared' | 'isolated'>('shared');
  let plan = $state<CockpitPlaceSessionPlan | null>(null);
  let acknowledgements = $state<string[]>([]);
  let operation = $state<CockpitPlaceSessionOperation | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let wasOpen = false;

  let workspaces = $derived(
    (cockpit.snapshot.catalog?.workspaces ?? [])
      .filter((workspace) => !workspace.archivedAt)
      .sort((left, right) => left.order - right.order)
  );
  let devices = $derived(cockpit.snapshot.devices);
  let readyDevices = $derived(devices.filter((device) => devicePresentation(device).actionable));
  let placementAvailable = $derived(cockpit.supported && workspaces.length > 0);
  let selectedWorkspace = $derived(
    workspaces.find((workspace) => workspace.id === workspaceId) ?? null
  );
  let selectedProject = $derived(
    selectedWorkspace
      ? cockpit.snapshot.catalog?.projects.find((project) => project.id === selectedWorkspace?.projectId)
        ?? null
      : null
  );

  function ctxOpts() {
    const c = newSessionPicker.context;
    return {
      ...(c.projectId ? { projectId: c.projectId } : {}),
      ...(c.cwd ? { cwd: c.cwd } : {}),
      ...(c.branch ? { branch: c.branch } : {})
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
    switch (value) {
      case 'terminal': return terminalButton;
      case 'claude_code': return claudeButton;
      case 'codex': return codexButton;
    }
  }

  function initializePlacement(): void {
    kind = settings.current.defaults.newSessionKind;
    const legacyProjectId = newSessionPicker.context.projectId;
    const mappedProjectId = legacyProjectId
      ? cockpit.snapshot.catalog?.migrations
          .map((migration) => migration.projectMap[legacyProjectId])
          .find(Boolean)
      : undefined;
    workspaceId = workspaces.find((workspace) => workspace.projectId === mappedProjectId)?.id
      ?? workspaces[0]?.id
      ?? '';
    const preferred = devices.find((device) =>
      device.deviceId === cockpit.snapshot.defaultPlacementDeviceId
      && devicePresentation(device).actionable
    );
    deviceId = preferred?.deviceId ?? readyDevices[0]?.deviceId ?? '';
    sourceMode = 'shared';
    resetPlan();
  }

  function resetPlan(): void {
    plan = null;
    acknowledgements = [];
    operation = null;
    error = null;
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

  async function preflight(): Promise<void> {
    if (!workspaceId || !deviceId) return;
    busy = true;
    resetPlan();
    try {
      plan = await cockpit.planSessionPlacement({
        kind: 'place-session',
        workspaceId,
        targetDeviceId: deviceId,
        sourceMode,
        session: {
          name: sessionName(kind),
          launch: launchFor(kind)
        }
      });
      acknowledgements = plan.acknowledgements
        .filter((item) => !item.required)
        .map((item) => item.id);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
    }
  }

  function toggleAcknowledgement(id: string, checked: boolean): void {
    acknowledgements = checked
      ? [...new Set([...acknowledgements, id])]
      : acknowledgements.filter((candidate) => candidate !== id);
  }

  async function executePlacement(): Promise<void> {
    if (!plan) return;
    busy = true;
    error = null;
    try {
      operation = await cockpit.executeSessionPlacement(plan.planId, acknowledgements);
      if (operation.state === 'succeeded') newSessionPicker.close();
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
          ? 'Choose a Workspace, Device, and physical source before anything is created.'
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
        <label class="grid gap-1 text-xs font-medium" for="placement-workspace">
          Workspace
          <select
            id="placement-workspace"
            class="h-9 rounded-md border border-input bg-background px-2 font-normal"
            bind:value={workspaceId}
            onchange={resetPlan}
          >
            {#each workspaces as workspace (workspace.id)}
              {@const project = cockpit.snapshot.catalog?.projects.find((candidate) => candidate.id === workspace.projectId)}
              <option value={workspace.id}>{project?.name ?? 'Project'} / {workspace.name}</option>
            {/each}
          </select>
        </label>

        <label class="grid gap-1 text-xs font-medium" for="placement-device">
          Device
          <select
            id="placement-device"
            class="h-9 rounded-md border border-input bg-background px-2 font-normal"
            bind:value={deviceId}
            onchange={resetPlan}
          >
            {#each devices as device (device.deviceId)}
              {@const presentation = devicePresentation(device)}
              <option value={device.deviceId} disabled={!presentation.actionable}>
                {presentation.label}
              </option>
            {/each}
          </select>
        </label>

        <fieldset class="grid gap-1 text-xs">
          <legend class="font-medium">Source mode</legend>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex items-start gap-2 rounded-md border border-border p-2">
              <input
                type="radio"
                bind:group={sourceMode}
                value="shared"
                onchange={resetPlan}
              />
              <span><strong>Shared</strong><br /><span class="text-muted-foreground">Reuse or prepare the Workspace Location.</span></span>
            </label>
            <label class="flex items-start gap-2 rounded-md border border-border p-2">
              <input
                type="radio"
                bind:group={sourceMode}
                value="isolated"
                onchange={resetPlan}
              />
              <span><strong>Isolated</strong><br /><span class="text-muted-foreground">Session-owned Worktree with guarded cleanup.</span></span>
            </label>
          </div>
        </fieldset>

        <div class="rounded-md border border-border bg-muted/30 p-2 text-xs">
          <div class="font-medium">Placement</div>
          <div class="text-muted-foreground">
            {selectedProject?.name ?? 'Project'} / {selectedWorkspace?.name ?? 'Workspace'}
            on {devices.find((device) => device.deviceId === deviceId)?.name ?? 'Device'}
          </div>
        </div>

        {#if error}
          <p class="m-0 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        {/if}

        {#if plan}
          <section class="grid gap-2 rounded-md border border-border p-3 text-xs" aria-label="Placement preflight">
            <div class="flex items-center justify-between gap-2">
              <strong>{plan.preview.action.replaceAll('-', ' ')}</strong>
              <span>{plan.executable ? 'Ready' : 'Blocked'}</span>
            </div>
            <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-muted-foreground">
              <dt>Device</dt><dd>{plan.preview.deviceName}</dd>
              <dt>Source</dt><dd>{plan.preview.source.kind}</dd>
              <dt>Path</dt><dd class="truncate font-mono" title={plan.preview.targetPath}>{plan.preview.targetPath || 'Not available'}</dd>
            </dl>
            {#each plan.blockers as blocker (blocker)}
              <p class="m-0 text-destructive" role="alert">{blocker}</p>
            {/each}
            {#each plan.acknowledgements as acknowledgement (acknowledgement.id)}
              <label class="flex gap-2 rounded border border-warning/40 p-2">
                <input
                  type="checkbox"
                  checked={acknowledgements.includes(acknowledgement.id)}
                  onchange={(event) => toggleAcknowledgement(
                    acknowledgement.id,
                    event.currentTarget.checked
                  )}
                />
                <span>{acknowledgement.label}</span>
              </label>
            {/each}
          </section>
        {/if}

        {#if operation?.state === 'needs-attention'}
          <p class="m-0 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs" role="status">
            Session created safely, but it is stopped: {operation.result?.startError ?? operation.message}
          </p>
        {/if}

        <div class="flex justify-end gap-2">
          <Button variant="ghost" onclick={() => newSessionPicker.close()} disabled={busy}>Cancel</Button>
          {#if plan}
            <Button
              onclick={() => void executePlacement()}
              disabled={busy || !plan.executable || plan.acknowledgements.some(
                (item) => item.required && !acknowledgements.includes(item.id)
              )}
            >
              {busy ? 'Creating…' : 'Create session'}
            </Button>
          {:else}
            <Button onclick={() => void preflight()} disabled={busy || !workspaceId || !deviceId || readyDevices.length === 0}>
              {busy ? 'Checking…' : 'Review placement'}
            </Button>
          {/if}
        </div>
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
