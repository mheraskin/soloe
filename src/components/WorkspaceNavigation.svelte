<script lang="ts">
  import {
    ArrowRight,
    ArrowUpFromLine,
    ClipboardCopy,
    Download,
    GitBranch,
    Monitor,
    Trash2,
    TriangleAlert,
    Upload,
    UploadCloud
  } from '@lucide/svelte';
  import type {
    CockpitProjectProjection,
    CockpitCatalogExportBundle,
    CockpitSessionProjection,
    CockpitWorkspaceProjection
  } from '@shared/types/cockpit.js';
  import type { SessionRef } from '@shared/types/devices.js';
  import { cockpit } from '../stores/cockpit.svelte';
  import { reportError } from '../stores/toast.svelte';
  import { confirmStore } from '../stores/confirm.svelte';

  let { filter = '' }: { filter?: string } = $props();
  let dragged = $state<SessionRef | null>(null);
  let publishingProjectId = $state<string | null>(null);
  let publicationWorkspaceId = $state('');
  let publicationDeviceId = $state('');
  let publicationOwner = $state('');
  let publicationName = $state('');
  let publicationVisibility = $state<'private' | 'public'>('private');
  let catalogImportInput: HTMLInputElement | undefined = $state();
  let importingCatalog = $state(false);

  let navigation = $derived(cockpit.snapshot.navigation);
  let archivedIsolated = $derived(cockpit.snapshot.archivedSessions.filter((session) =>
    session.session.source?.kind === 'isolated-worktree'
  ));
  let workspaces = $derived(
    navigation?.projects.flatMap((project) => project.workspaces.map((workspace) => ({
      project,
      workspace
    }))) ?? []
  );

  function visible(session: CockpitSessionProjection): boolean {
    const deviceFilter = cockpit.snapshot.filterDeviceIds;
    if (deviceFilter.length > 0 && !deviceFilter.includes(session.ref.deviceId)) return false;
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return true;
    return [session.session.name, session.session.cwd, session.deviceName, ...(session.session.tags ?? [])]
      .some((value) => value.toLocaleLowerCase().includes(query));
  }

  function workspaceSessions(workspace: CockpitWorkspaceProjection) {
    return workspace.sessions.filter(({ projection }) => visible(projection));
  }

  function projectVisible(project: CockpitProjectProjection): boolean {
    const query = filter.trim().toLocaleLowerCase();
    if (!query || project.project.name.toLocaleLowerCase().includes(query)) return true;
    return project.workspaces.some((workspace) =>
      workspace.workspace.name.toLocaleLowerCase().includes(query)
      || workspaceSessions(workspace).length > 0
    );
  }

  function sourceLabel(workspace: CockpitWorkspaceProjection): string {
    const source = workspace.workspace.source;
    if (source.kind === 'branch') return source.localRef.replace(/^refs\/heads\//u, '');
    if (source.kind === 'pull_request') return `PR #${source.number}`;
    return source.label?.trim() || source.oid.slice(0, 12);
  }

  async function regroup(sessionRef: SessionRef, workspaceId: string): Promise<void> {
    const catalog = cockpit.snapshot.catalog;
    if (!catalog) return;
    const previous = catalog.sessionMemberships.find((membership) =>
      membership.sessionRef.deviceId === sessionRef.deviceId
      && membership.sessionRef.sessionId === sessionRef.sessionId
    );
    const sourceWorkspace = previous
      ? catalog.workspaces.find((workspace) => workspace.id === previous.workspaceId)
      : null;
    const destinationWorkspace = catalog.workspaces.find((workspace) => workspace.id === workspaceId);
    if (
      sourceWorkspace
      && destinationWorkspace
      && sourceWorkspace.projectId !== destinationWorkspace.projectId
    ) {
      await createSuccessor(sessionRef, destinationWorkspace.id);
      return;
    }
    await cockpit.transactCatalog({
      expectedRevision: catalog.revision,
      mutations: [{ type: 'session.regroup', sessionRef, workspaceId }]
    });
  }

  async function createSuccessor(originRef: SessionRef, workspaceId: string): Promise<void> {
    const origin = cockpit.snapshot.sessions.find((candidate) =>
      candidate.ref.deviceId === originRef.deviceId
      && candidate.ref.sessionId === originRef.sessionId
    );
    if (!origin) throw new Error('Original Session is unavailable.');
    const targetDeviceId = cockpit.snapshot.defaultPlacementDeviceId ?? origin.ref.deviceId;
    const plan = await cockpit.planSessionPlacement({
      kind: 'place-session',
      workspaceId,
      targetDeviceId,
      sourceMode: 'shared',
      successorOf: origin.ref,
      session: {
        name: `${origin.session.name} successor`,
        launch: structuredClone(origin.session.launch),
        ...(origin.session.tags ? { tags: [...origin.session.tags] } : {}),
        ...(origin.session.pinned !== undefined ? { pinned: origin.session.pinned } : {}),
        ...(origin.session.color ? { color: origin.session.color } : {})
      }
    });
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Successor placement is blocked.');
    const confirmed = await confirmStore.ask({
      title: `Create successor for ${origin.session.name}`,
      message: [
        `Cross-Project regroup cannot move the running process or its files.`,
        `Create a new Session on ${plan.preview.deviceName} at ${plan.preview.targetPath}.`,
        `The original Session on ${origin.deviceName} remains untouched.`,
        ...plan.warnings
      ].join(' '),
      confirmLabel: 'Create successor',
      tone: 'default'
    });
    if (!confirmed) return;
    await cockpit.executeSessionPlacement(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );
  }

  function startDrag(event: DragEvent, ref: SessionRef): void {
    dragged = structuredClone(ref);
    event.dataTransfer?.setData('application/x-soloe-session-ref', JSON.stringify(ref));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function readDrop(event: DragEvent): SessionRef | null {
    if (dragged) return structuredClone(dragged);
    try {
      const value = JSON.parse(event.dataTransfer?.getData('application/x-soloe-session-ref') ?? 'null');
      return value && typeof value.deviceId === 'string' && typeof value.sessionId === 'string'
        ? value as SessionRef
        : null;
    } catch {
      return null;
    }
  }

  function dropOn(event: DragEvent, workspaceId: string): void {
    event.preventDefault();
    const ref = readDrop(event);
    dragged = null;
    if (ref) void regroup(ref, workspaceId).catch(reportError);
  }

  async function align(
    workspace: CockpitWorkspaceProjection,
    sourceDeviceId: string,
    targetDeviceId: string
  ): Promise<void> {
    const plan = await cockpit.planWorkspaceAlignment({
      kind: 'align-workspace',
      workspaceId: workspace.workspace.id,
      sourceDeviceId,
      targetDeviceId
    });
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Alignment is blocked.');
    const confirmed = await confirmStore.ask({
      title: `Align ${workspace.workspace.name}`,
      message: [
        `Push ${plan.preview.sourceOid.slice(0, 12)} from ${plan.preview.sourceDeviceName},`,
        `then fetch and fast-forward ${plan.preview.targetDeviceName} from ${plan.preview.targetOid.slice(0, 12)}.`,
        ...plan.warnings
      ].join(' '),
      confirmLabel: 'Push and fast-forward',
      tone: 'default'
    });
    if (!confirmed) return;
    await cockpit.executeWorkspaceAlignment(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );
  }

  function openPublication(project: CockpitProjectProjection): void {
    const workspace = project.workspaces.find((candidate) =>
      candidate.workspace.source.kind === 'branch'
      && candidate.locations.some((location) => location.availability === 'available')
    );
    if (!workspace) {
      reportError(new Error('Publication needs an available Branch Workspace Location.'));
      return;
    }
    const location = workspace.locations.find((candidate) => candidate.availability === 'available')!;
    publishingProjectId = project.project.id;
    publicationWorkspaceId = workspace.workspace.id;
    publicationDeviceId = location.location.checkout.deviceId;
    publicationOwner = '';
    publicationName = project.project.name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 100);
    publicationVisibility = 'private';
  }

  async function publish(project: CockpitProjectProjection): Promise<void> {
    const plan = await cockpit.planProjectPublication({
      kind: 'publish-project',
      workspaceId: publicationWorkspaceId,
      sourceDeviceId: publicationDeviceId,
      owner: publicationOwner,
      name: publicationName,
      visibility: publicationVisibility
    });
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Publication is blocked.');
    const confirmed = await confirmStore.ask({
      title: `Publish ${project.project.name}`,
      message: [
        `Create ${plan.preview.visibility} GitHub repository ${plan.preview.owner}/${plan.preview.name}.`,
        `Then add ${plan.preview.remote} on ${plan.preview.deviceName} and push`,
        `${plan.preview.branchRef} at ${plan.preview.localOid.slice(0, 12)}.`,
        ...plan.warnings
      ].join(' '),
      confirmLabel: plan.preview.visibility === 'public' ? 'Create public repository' : 'Create private repository',
      tone: 'default'
    });
    if (!confirmed) return;
    await cockpit.executeProjectPublication(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );
    publishingProjectId = null;
  }

  async function promote(session: CockpitSessionProjection): Promise<void> {
    const plan = await cockpit.planSessionSourceLifecycle({
      kind: 'promote-isolated-source',
      sessionRef: session.ref
    });
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Promotion is blocked.');
    const confirmed = await confirmStore.ask({
      title: `Promote ${session.session.name}`,
      message: [
        `Link ${plan.preview.checkoutPath} as this Workspace's ordinary Location on`,
        `${plan.preview.deviceName}, then clear isolated ownership and reclassify the Session Source.`,
        ...plan.warnings
      ].join(' '),
      confirmLabel: 'Promote source',
      tone: 'default'
    });
    if (!confirmed) return;
    await cockpit.executeSessionSourceLifecycle(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );
  }

  async function cleanup(session: CockpitSessionProjection): Promise<void> {
    const plan = await cockpit.planSessionSourceLifecycle({
      kind: 'cleanup-isolated-source',
      sessionRef: session.ref
    });
    if (!plan.executable) throw new Error(plan.blockers.join(' ') || 'Cleanup is blocked.');
    const confirmed = await confirmStore.ask({
      title: `Clean up ${session.session.name} source`,
      message: [
        `Fresh Device evidence found no staged, unstaged, untracked, ignored, unpublished,`,
        `or actively consumed work at ${plan.preview.checkoutPath}.`,
        `Remove the Worktree without force. The generated Branch will remain.`,
        ...plan.warnings
      ].join(' '),
      confirmLabel: 'Remove eligible Worktree',
      tone: 'danger'
    });
    if (!confirmed) return;
    await cockpit.executeSessionSourceLifecycle(
      plan.planId,
      plan.acknowledgements.map((item) => item.id)
    );
  }

  async function importCatalogFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) {
      throw new Error('Cockpit Catalog bundle exceeds the 32 MiB import limit.');
    }
    const bundle = JSON.parse(await file.text()) as CockpitCatalogExportBundle;
    const manifest = bundle?.manifest;
    if (!manifest || typeof manifest.cockpitId !== 'string') {
      throw new Error('This file is not a Soloe Cockpit Catalog export.');
    }
    const confirmed = await confirmStore.ask({
      title: 'Replace this Cockpit Catalog?',
      message: [
        `Import revision ${manifest.catalogRevision} exported ${new Date(manifest.exportedAt).toLocaleString()}`,
        `from Cockpit ${manifest.cockpitId.slice(0, 8)}.`,
        `This replaces this Cockpit's logical Projects, Workspaces, Locations, and memberships.`,
        `Device Sessions and physical Checkouts are not deleted. A local backup is created first.`
      ].join(' '),
      confirmLabel: 'Verify and replace catalog',
      tone: 'danger'
    });
    if (!confirmed) return;
    importingCatalog = true;
    try {
      await cockpit.importCatalog(bundle);
    } finally {
      importingCatalog = false;
    }
  }

  async function copyOperationReport(operation: (typeof cockpit.snapshot.recoverableOperations)[number]): Promise<void> {
    await navigator.clipboard.writeText(cockpit.redactedOperationReport(operation));
  }
</script>

{#if navigation}
  <div class="flex flex-col gap-1" aria-label="Projects and Workspaces">
    {#each navigation.projects.filter(projectVisible) as project (project.project.id)}
      <section class="flex flex-col gap-px" data-project-id={project.project.id}>
        <div class="flex items-center gap-1 px-2 pt-2 pb-1">
          <h2 class="m-0 min-w-0 flex-1 truncate text-[11px] font-semibold text-foreground">
            {project.project.name}
          </h2>
          {#if project.project.canonicalRepository?.kind !== 'git'}
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[9px] text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Publish ${project.project.name} to GitHub`}
              onclick={() => openPublication(project)}
            >
              <UploadCloud class="size-3" /> Publish
            </button>
          {/if}
        </div>
        {#if publishingProjectId === project.project.id}
          <form
            class="mx-1 mb-1 grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1.5"
            aria-label={`Publish ${project.project.name}`}
            onsubmit={(event) => {
              event.preventDefault();
              void publish(project).catch(reportError);
            }}
          >
            <label class="flex flex-col gap-0.5 text-[8px] text-muted-foreground">
              GitHub owner
              <input
                class="min-w-0 rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground"
                required
                maxlength="39"
                bind:value={publicationOwner}
              />
            </label>
            <label class="flex flex-col gap-0.5 text-[8px] text-muted-foreground">
              Repository name
              <input
                class="min-w-0 rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground"
                required
                maxlength="100"
                bind:value={publicationName}
              />
            </label>
            <label class="col-span-2 flex items-center gap-1 text-[9px] text-muted-foreground">
              Visibility
              <select
                class="rounded border border-border bg-background px-1 py-0.5 text-[10px] text-foreground"
                bind:value={publicationVisibility}
              >
                <option value="private">Private (recommended)</option>
                <option value="public">Public</option>
              </select>
            </label>
            <div class="col-span-2 flex justify-end gap-1">
              <button
                type="button"
                class="rounded px-1.5 py-0.5 text-[9px] text-muted-foreground hover:bg-muted"
                onclick={() => { publishingProjectId = null; }}
              >Cancel</button>
              <button
                type="submit"
                class="rounded bg-primary px-1.5 py-0.5 text-[9px] text-primary-foreground"
              >Review publication</button>
            </div>
          </form>
        {/if}
        {#each project.workspaces as workspace (workspace.workspace.id)}
          <div
            role="group"
            class="rounded-md border border-transparent px-1 py-1 hover:border-border"
            data-workspace-id={workspace.workspace.id}
            ondragover={(event) => {
              if (!readDrop(event)) return;
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            }}
            ondrop={(event) => dropOn(event, workspace.workspace.id)}
          >
            <div class="flex min-w-0 items-center gap-1.5 px-1 py-0.5">
              <GitBranch class="size-3 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate text-[11px] font-medium">
                {workspace.workspace.name}
              </span>
              <span class="truncate font-mono text-[9px] text-muted-foreground" title={sourceLabel(workspace)}>
                {sourceLabel(workspace)}
              </span>
            </div>
            {#if workspace.locations.length > 0}
              <div class="flex flex-wrap gap-1 px-1 pb-1" aria-label="Workspace locations">
                {#each workspace.locations as location (location.location.id)}
                  <span
                    class="rounded-full bg-muted px-1.5 py-0.5 text-[8px] text-muted-foreground"
                    title={`${location.device?.name ?? 'Unknown Device'} · ${location.availability}`}
                  >
                    {location.device?.name ?? 'Unknown'} · {location.availability}
                  </span>
                {/each}
              </div>
              {#if workspace.locations.length === 2}
                {@const left = workspace.locations[0]!}
                {@const right = workspace.locations[1]!}
                <div class="flex flex-wrap gap-1 px-1 pb-1" aria-label="Workspace alignment actions">
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[8px] text-muted-foreground hover:text-foreground"
                    onclick={() => void align(
                      workspace,
                      left.location.checkout.deviceId,
                      right.location.checkout.deviceId
                    ).catch(reportError)}
                  >
                    {left.device?.name ?? 'Left'} <ArrowRight class="size-2.5" /> {right.device?.name ?? 'Right'}
                  </button>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[8px] text-muted-foreground hover:text-foreground"
                    onclick={() => void align(
                      workspace,
                      right.location.checkout.deviceId,
                      left.location.checkout.deviceId
                    ).catch(reportError)}
                  >
                    {right.device?.name ?? 'Right'} <ArrowRight class="size-2.5" /> {left.device?.name ?? 'Left'}
                  </button>
                </div>
              {/if}
            {/if}
            <div class="flex flex-col gap-px">
              {#each workspaceSessions(workspace) as member (member.projection.key)}
                <div
                  role="listitem"
                  class="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-muted"
                  draggable="true"
                  ondragstart={(event) => startDrag(event, member.projection.ref)}
                  ondragend={() => { dragged = null; }}
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    aria-label={`Open ${member.projection.session.name} on ${member.projection.deviceName}`}
                    onclick={() => cockpit.selectSession(member.projection.key)}
                  >
                    <Monitor class="size-3 shrink-0 text-muted-foreground" />
                    <span class="min-w-0 flex-1 truncate text-[11px]">{member.projection.session.name}</span>
                    <span class="rounded-full bg-muted-foreground/10 px-1 py-0.5 text-[8px] text-muted-foreground">
                      {member.projection.deviceName} · {member.projection.runtime?.state.status ?? 'stopped'}
                    </span>
                    {#if member.sourceConformance === 'mismatch'}
                      <TriangleAlert class="size-3 shrink-0 text-warning" aria-label="Session source differs from Workspace" />
                    {/if}
                  </button>
                  {#if member.projection.session.source?.kind === 'isolated-worktree'}
                    <button
                      type="button"
                      class="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground group-focus-within:opacity-100 group-hover:opacity-100"
                      aria-label={`Promote isolated source for ${member.projection.session.name}`}
                      title="Promote isolated source"
                      onclick={() => void promote(member.projection).catch(reportError)}
                    >
                      <ArrowUpFromLine class="size-2.5" /> Promote
                    </button>
                  {/if}
                  <select
                    class="max-w-20 bg-transparent text-[9px] text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                    aria-label={`Move ${member.projection.session.name} to Workspace`}
                    value={workspace.workspace.id}
                    onchange={(event) => {
                      const target = event.currentTarget.value;
                      if (target !== workspace.workspace.id) {
                        void regroup(member.projection.ref, target).catch(reportError);
                      }
                    }}
                  >
                    {#each workspaces as option (option.workspace.workspace.id)}
                      <option value={option.workspace.workspace.id}>
                        {option.project.project.name} / {option.workspace.workspace.name}
                      </option>
                    {/each}
                  </select>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </section>
    {/each}

    {#each navigation.unassigned as group (group.device?.deviceId ?? group.sessions[0]?.ref.deviceId)}
      {@const visibleSessions = group.sessions.filter(visible)}
      {#if visibleSessions.length > 0}
        <section class="mt-1 rounded-md border border-dashed border-border p-1" aria-label={`Unassigned Sessions on ${group.device?.name ?? 'unknown Device'}`}>
          <h2 class="m-0 px-1 py-1 text-[10px] font-medium text-muted-foreground">
            Unassigned · {group.device?.name ?? visibleSessions[0]?.deviceName ?? 'Unknown Device'}
            {#if group.device} · {group.device.state}{/if}
          </h2>
          {#each visibleSessions as projection (projection.key)}
            <div class="group flex items-center gap-1 rounded px-1.5 py-1 hover:bg-muted">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onclick={() => cockpit.selectSession(projection.key)}
              >
                <Monitor class="size-3 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate text-[11px]">{projection.session.name}</span>
              </button>
              {#if workspaces.length > 0}
                <select
                  class="max-w-24 bg-transparent text-[9px] text-muted-foreground"
                  aria-label={`Assign ${projection.session.name} to Workspace`}
                  value=""
                  onchange={(event) => {
                    if (event.currentTarget.value) {
                      void regroup(projection.ref, event.currentTarget.value).catch(reportError);
                    }
                  }}
                >
                  <option value="">Assign…</option>
                  {#each workspaces as option (option.workspace.workspace.id)}
                    <option value={option.workspace.workspace.id}>
                      {option.project.project.name} / {option.workspace.workspace.name}
                    </option>
                  {/each}
                </select>
              {/if}
            </div>
          {/each}
        </section>
      {/if}
    {/each}

    {#if archivedIsolated.length > 0}
      <section class="mt-1 rounded-md border border-dashed border-border p-1" aria-label="Archived isolated Session sources">
        <h2 class="m-0 px-1 py-1 text-[10px] font-medium text-muted-foreground">
          Archived isolated sources
        </h2>
        {#each archivedIsolated as session (session.key)}
          <div class="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-muted">
            <Monitor class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate text-[10px]">{session.session.name}</span>
            <span class="text-[8px] text-muted-foreground">{session.deviceName}</span>
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Clean up isolated source for ${session.session.name}`}
              onclick={() => void cleanup(session).catch(reportError)}
            >
              <Trash2 class="size-2.5" /> Check cleanup
            </button>
          </div>
        {/each}
      </section>
    {/if}

    {#if cockpit.snapshot.recoverableOperations.length > 0}
      <section class="mt-1 rounded-md border border-warning/40 bg-warning/5 p-1" aria-label="Operations needing recovery">
        <h2 class="m-0 px-1 py-1 text-[10px] font-medium text-foreground">
          Recovery · {cockpit.snapshot.recoverableOperations.length}
        </h2>
        {#each cockpit.snapshot.recoverableOperations as operation (operation.operationId)}
          <div class="flex items-start gap-1 rounded px-1.5 py-1 hover:bg-muted">
            <TriangleAlert class="mt-0.5 size-3 shrink-0 text-warning" />
            <div class="min-w-0 flex-1">
              <p class="m-0 truncate text-[10px] font-medium">{operation.kind} · {operation.phase}</p>
              <p class="m-0 line-clamp-2 text-[8px] text-muted-foreground">{operation.message}</p>
              <p class="m-0 font-mono text-[8px] text-muted-foreground">
                {operation.operationId.slice(0, 8)} · {operation.state}
              </p>
            </div>
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[8px] text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={`Copy redacted report for ${operation.kind}`}
              onclick={() => void copyOperationReport(operation).catch(reportError)}
            >
              <ClipboardCopy class="size-2.5" /> Report
            </button>
          </div>
        {/each}
      </section>
    {/if}

    <section class="mt-1 rounded-md border border-dashed border-border p-1" aria-label="Cockpit Catalog portability">
      <h2 class="m-0 px-1 py-1 text-[10px] font-medium text-muted-foreground">
        This Cockpit Catalog
      </h2>
      <p class="m-0 px-1 pb-1 text-[8px] text-muted-foreground">
        Export or restore logical organization. Device data and Git work are not included.
      </p>
      <div class="flex gap-1 px-1 pb-1">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[8px] text-muted-foreground hover:text-foreground"
          onclick={() => void cockpit.downloadCatalogExport().catch(reportError)}
        >
          <Download class="size-2.5" /> Export
        </button>
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[8px] text-muted-foreground hover:text-foreground disabled:opacity-50"
          disabled={importingCatalog}
          onclick={() => catalogImportInput?.click()}
        >
          <Upload class="size-2.5" /> {importingCatalog ? 'Importing…' : 'Import…'}
        </button>
        <input
          class="hidden"
          type="file"
          accept="application/json,.json"
          aria-label="Choose Cockpit Catalog export"
          bind:this={catalogImportInput}
          onchange={(event) => void importCatalogFile(event).catch(reportError)}
        />
      </div>
    </section>
  </div>
{/if}
