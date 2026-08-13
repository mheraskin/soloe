<script lang="ts">
  import { GitBranch, Monitor } from '@lucide/svelte';
  import type {
    MultiDeviceSessionView,
    ProjectView,
    SessionDeviceView,
    WorkspaceView
  } from '@shared/types/multi-device-sessions.js';
  import { deviceSessions } from '../stores/device-sessions.svelte';
  import { sessions as localSessions } from '../stores/sessions.svelte';
  import { reportError } from '../stores/toast.svelte';

  let { filter = '' }: { filter?: string } = $props();

  function normalizedFilter(): string {
    return filter.trim().toLocaleLowerCase();
  }

  function deviceFor(deviceId: string): SessionDeviceView | null {
    return deviceSessions.device(deviceId);
  }

  function matchesSession(session: MultiDeviceSessionView, query: string): boolean {
    return [
      session.session.name,
      session.session.cwd,
      session.deviceName,
      ...(session.session.tags ?? [])
    ].some((value) => value.toLocaleLowerCase().includes(query));
  }

  function visibleSessions(workspace: WorkspaceView): MultiDeviceSessionView[] {
    const query = normalizedFilter();
    if (!query) return workspace.sessions;
    return workspace.sessions.filter((session) => matchesSession(session, query));
  }

  function visibleWorkspace(project: ProjectView, workspace: WorkspaceView): boolean {
    const query = normalizedFilter();
    if (!query) return true;
    return project.name.toLocaleLowerCase().includes(query)
      || workspace.name.toLocaleLowerCase().includes(query)
      || workspace.branch?.toLocaleLowerCase().includes(query)
      || workspace.locations.some((location) =>
        location.deviceName.toLocaleLowerCase().includes(query)
        || location.path.toLocaleLowerCase().includes(query)
      )
      || workspace.sessions.some((session) => matchesSession(session, query));
  }

  function visibleProject(project: ProjectView): boolean {
    const query = normalizedFilter();
    if (!query || project.name.toLocaleLowerCase().includes(query)) return true;
    return project.workspaces.some((workspace) => visibleWorkspace(project, workspace));
  }

  function selected(session: MultiDeviceSessionView): boolean {
    const device = deviceFor(session.ref.deviceId);
    return device?.local
      ? localSessions.selectedId === session.ref.sessionId && deviceSessions.selectedSessionKey === null
      : deviceSessions.selectedSessionKey === session.key;
  }

  function stateLabel(device: SessionDeviceView | null): string {
    if (!device) return 'Offline';
    if (device.state === 'ready') return 'Online';
    if (device.state === 'connecting') return 'Connecting';
    if (device.state === 'incompatible') return 'Update required';
    return 'Offline';
  }

  function statusDotClass(device: SessionDeviceView | null): string {
    if (device?.state === 'ready') return 'bg-success';
    if (device?.state === 'incompatible') return 'bg-warning';
    return 'bg-muted-foreground/35';
  }

  function openSession(session: MultiDeviceSessionView): void {
    if (!session.available) return;
    void deviceSessions.openSession(session.key).catch(reportError);
  }
</script>

<div class="flex flex-col gap-1" aria-label="Projects, Workspaces, and Sessions">
  {#each deviceSessions.state.projects.filter(visibleProject) as project (project.key)}
    <section class="flex flex-col gap-px" data-project-id={project.key}>
      <h2 class="m-0 truncate px-2 pt-2 pb-1 text-[11px] font-semibold text-foreground">
        {project.name}
      </h2>

      {#each project.workspaces.filter((workspace) => visibleWorkspace(project, workspace)) as workspace (workspace.key)}
        {@const sessions = visibleSessions(workspace)}
        <div class="rounded-md border border-transparent px-1 py-1 hover:border-border" data-workspace-id={workspace.key}>
          <div class="flex min-w-0 items-center gap-1.5 px-1 py-0.5">
            <GitBranch class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-[11px] font-medium">{workspace.name}</span>
            {#if workspace.branch && workspace.branch !== workspace.name}
              <span class="max-w-24 truncate font-mono text-[9px] text-muted-foreground" title={workspace.branch}>
                {workspace.branch}
              </span>
            {/if}
          </div>

          {#if workspace.locations.length > 0}
            <div class="flex flex-wrap gap-1 px-1 pb-1" aria-label="Workspace locations">
              {#each workspace.locations as location (location.key)}
                {@const device = deviceFor(location.deviceId)}
                <span
                  class="inline-flex min-w-0 items-center gap-1 rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[8px] text-muted-foreground"
                  class:opacity-50={!location.available}
                  title={location.path}
                >
                  <span class={'size-1.5 shrink-0 rounded-full ' + statusDotClass(device)} aria-hidden="true"></span>
                  <span class="max-w-28 truncate">{location.deviceName}</span>
                  {#if !location.available}
                    <span>· {stateLabel(device)}</span>
                  {/if}
                </span>
              {/each}
            </div>
          {/if}

          <div class="flex flex-col gap-px">
            {#each sessions as session (session.key)}
              {@const device = deviceFor(session.ref.deviceId)}
              <button
                type="button"
                class={'flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors '
                  + (selected(session) ? 'bg-primary/10 text-primary ' : '')
                  + (session.available && !selected(session) ? 'hover:bg-muted ' : '')
                  + (!session.available ? 'cursor-not-allowed opacity-40' : '')}
                disabled={!session.available}
                aria-label={session.available
                  ? 'Open ' + session.session.name + ' on ' + session.deviceName
                  : session.session.name + ' is unavailable because ' + session.deviceName + ' is ' + stateLabel(device)}
                onclick={() => openSession(session)}
              >
                <Monitor class="size-3 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate text-[11px]">{session.session.name}</span>
                <span class="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[8px] text-muted-foreground">
                  <span class={'size-1.5 shrink-0 rounded-full ' + statusDotClass(device)} aria-hidden="true"></span>
                  <span class="max-w-24 truncate">{session.deviceName}</span>
                  {#if !session.available}
                    <span>· {stateLabel(device)}</span>
                  {/if}
                </span>
                {#if session.runtime}
                  <span class="shrink-0 text-[8px] text-muted-foreground">{session.runtime.status}</span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </section>
  {/each}

  {#if deviceSessions.state.unassigned.length > 0}
    {@const query = normalizedFilter()}
    {@const unassigned = query
      ? deviceSessions.state.unassigned.filter((session) => matchesSession(session, query))
      : deviceSessions.state.unassigned}
    {#if unassigned.length > 0}
      <section class="mt-1 rounded-md border border-dashed border-border p-1" aria-label="Sessions outside a Workspace">
        <h2 class="m-0 px-1 py-1 text-[10px] font-medium text-muted-foreground">Other sessions</h2>
        {#each unassigned as session (session.key)}
          {@const device = deviceFor(session.ref.deviceId)}
          <button
            type="button"
            class={'flex w-full min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors '
              + (selected(session) ? 'bg-primary/10 text-primary ' : '')
              + (session.available && !selected(session) ? 'hover:bg-muted ' : '')
              + (!session.available ? 'cursor-not-allowed opacity-40' : '')}
            disabled={!session.available}
            onclick={() => openSession(session)}
          >
            <Monitor class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-[11px]">{session.session.name}</span>
            <span class="inline-flex min-w-0 items-center gap-1 rounded-full bg-muted/60 px-1.5 py-0.5 text-[8px] text-muted-foreground">
              <span class={'size-1.5 shrink-0 rounded-full ' + statusDotClass(device)} aria-hidden="true"></span>
              <span class="max-w-24 truncate">{session.deviceName}</span>
              {#if !session.available}<span>· {stateLabel(device)}</span>{/if}
            </span>
          </button>
        {/each}
      </section>
    {/if}
  {/if}
</div>
