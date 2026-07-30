<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { ModeWatcher, setMode } from 'mode-watcher';
  import {
    Check,
    ChevronDown,
    FolderGit2,
    FolderOpen,
    Maximize2,
    Minus,
    PanelLeftOpen,
    Plus,
    RotateCcw,
    Settings,
    TriangleAlert,
    X
  } from '@lucide/svelte';
  import type { ProjectId } from '@shared/types/projects.js';
  import type {
    AgentObservedState,
    Session,
    SessionLaunchKind,
    SessionStatus
  } from '@shared/types/sessions.js';
  import { sessions } from './stores/sessions.svelte';
  import { settings } from './stores/settings.svelte';
  import { platform } from './stores/platform.svelte';
  import { projects } from './stores/projects.svelte';
  import { notes } from './stores/notes.svelte';
  import { git } from './stores/git.svelte';
  import { workingDiff } from './stores/working-diff.svelte';
  import { nav, type WorktreeIndexTarget } from './stores/nav.svelte';
  import { commandPalette } from './stores/command-palette.svelte';
  import { filePalette } from './stores/file-palette.svelte';
  import { agentNotifications } from './stores/agent-notifications.svelte';
  import { newSessionPicker } from './stores/new-session-picker.svelte';
  import { rightRail } from './stores/right-rail.svelte';
  import { sessionContextMenus } from './stores/session-context-menus.svelte';
  import { sidebar } from './stores/sidebar.svelte';
  import { browserStore } from './stores/browser.svelte';
  import { vaultStore } from './stores/vault.svelte';
  import { reportError } from './stores/toast.svelte';
  import { ipc } from './lib/ipc';
  import { confirmDeleteSession } from './lib/session-delete-confirmation';
  import { agentIntegrationSetup } from './stores/agent-integration-setup.svelte';
  import { modal } from './stores/modal.svelte';
  import { projectModal } from './stores/project-modal.svelte';
  import { sessionHandoff } from './stores/session-handoff.svelte';
  import { confirmStore } from './stores/confirm.svelte';
  import {
    Keymap,
    shouldIgnoreInTextInput,
    tabIndexFromEvent,
    worktreeIndexFromEvent
  } from './lib/keymap';
  import { toggleRailTabAndFocus } from './lib/rail-focus';
  import { buildWorktreeGroups } from './lib/worktree-groups';
  import { sameWorktreePath, worktreeBasename, worktreeLabel } from './lib/worktree-path';
  import { worktreeScope } from '@shared/worktree-identity.js';
  import { sessionRefreshIntents } from './lib/worktree-polling-policy';
  import { displaySessionKind } from './lib/session-agent';
  import {
    displayedAgentState as resolveDisplayedAgentState,
    displayedAgentSummary
  } from './lib/session-display-state';
  import { kbdHints } from './stores/kbd-hints.svelte';
  import { dnd, DND_MIME, type DropPosition } from './stores/dnd.svelte';
  import { toast } from 'svelte-sonner';
  import { Button } from '$lib/components/ui/button';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import { Toaster } from '$lib/components/ui/sonner';
  import Sidebar from './components/Sidebar.svelte';
  import TerminalArea from './components/TerminalArea.svelte';
  import RightRail from './components/RightRail.svelte';
  import LazyOverlay from './components/LazyOverlay.svelte';
  import AgentLaunchPopover from './components/AgentLaunchPopover.svelte';
  import SessionContextMenu from './components/SessionContextMenu.svelte';
  import KindIcon from './components/KindIcon.svelte';
  import AppSkeleton from './components/AppSkeleton.svelte';
  import appIconUrl from '../build/favicon.svg';

  const loadNewSessionModal = () => import('./components/NewSessionModal.svelte');
  const loadConfirmDialog = () => import('./components/ConfirmDialog.svelte');
  const loadSettingsDialog = () => import('./components/SettingsDialog.svelte');
  const loadProjectModal = () => import('./components/ProjectModal.svelte');
  const loadCommandPalette = () => import('./components/CommandPalette.svelte');
  const loadFilePalette = () => import('./components/FilePalette.svelte');
  const loadNewSessionPicker = () => import('./components/NewSessionPickerDialog.svelte');
  const loadSessionHandoff = () => import('./components/SessionHandoffDialog.svelte');
  const loadAgentIntegrationSetup = () => import('./components/AgentIntegrationSetupDialog.svelte');
  const loadAgentNotificationToasts = () => import('./components/AgentNotificationToasts.svelte');

  let appliedTheme: string | null = null;
  let suppressCollapsedDropdownSelect = false;
  let initialLoadState = $state<'loading' | 'ready' | 'error'>('loading');
  let initialLoadError = $state<string | null>(null);

  onMount(() => {
    sessions.attachListeners();
    settings.attachListeners();
    projects.attachListeners();
    notes.attachListeners();
    git.attachListeners();
    workingDiff.attachListeners();
    const detachToast = ipc.notify.onToast((t) => {
      const opts = t.description ? { description: t.description } : undefined;
      if (t.severity === 'error') toast.error(t.message, opts);
      else if (t.severity === 'success') toast.success(t.message, opts);
      else if (t.severity === 'warning') toast.warning(t.message, opts);
      else toast(t.message, opts);
    });
    void loadInitialState();
    const detachKbdHints = kbdHints.attach();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onClearPaneRing, true);
    window.addEventListener('beforeunload', flushRendererPersistence);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onClearPaneRing, true);
      window.removeEventListener('beforeunload', flushRendererPersistence);
      flushRendererPersistence();
      detachKbdHints();
      detachToast();
      sessions.detach();
      settings.detach();
      projects.detach();
      notes.detach();
      workingDiff.detach();
      git.detach();
    };
  });

  function flushRendererPersistence(): void {
    browserStore.flushPersistence();
    notes.flushDraftPersistence();
  }

  // Clears the pane focus ring on the next real keystroke after a Ctrl+;
  // cycle. Ignores pure modifier presses and the cycle key itself so the
  // ring survives long enough for the user to see which pane landed.
  function onClearPaneRing(e: KeyboardEvent): void {
    if (rightRail.focusedPaneSlot === null) return;
    if (Keymap.toggleTerminalFocus.match(e)) return;
    if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
    rightRail.focusedPaneSlot = null;
  }

  async function loadInitialState(): Promise<void> {
    initialLoadState = 'loading';
    initialLoadError = null;
    try {
      await Promise.all([platform.load(), settings.load(), projects.load(), sessions.load()]);
      initialLoadState = 'ready';
      void promptForAgentIntegrationSetup().catch(reportError);
    } catch (err) {
      initialLoadError = err instanceof Error ? err.message : String(err);
      initialLoadState = 'error';
      reportError(err);
    }
  }

  async function promptForAgentIntegrationSetup(): Promise<void> {
    const status = await ipc.agentIntegration.status();
    const needsSetup = status.hosts.some(
      (h) => h.host.available && (!h.claude.current || !h.codex.current)
    );
    if (!needsSetup) return;
    agentIntegrationSetup.show(status);
  }

  $effect(() => {
    const theme = settings.current.appearance.theme;
    if (theme === appliedTheme) return;
    appliedTheme = theme;
    untrack(() => setMode(theme));
  });

  // Rail fullscreen takes over the main area: terminal hides, the rail
  // expands to fill the remaining space (sidebar stays put). Applies to
  // whichever tab is active (diff, notes, inspector).
  let railFullscreen = $derived(rightRail.open && rightRail.fullscreen);

  // Subtle "you are here" reminder shown in the title bar when the sidebar
  // is collapsed: project name, current worktree (branch when known, basename
  // otherwise), and a numbered row of every session in this worktree so the
  // user can see which Ctrl+N maps to what without re-opening the sidebar.
  type CollapsedProjectOption = {
    id: ProjectId;
    name: string;
    path: string;
    active: boolean;
    sessionCount: number;
  };
  type CollapsedWorktreeOption = {
    cwd: string;
    label: string;
    branch?: string;
    isMain: boolean;
    active: boolean;
    sessionCount: number;
    selectedSessionId: string | null;
    firstSessionId: string | null;
    shortcutIndex: number | null;
  };
  type CollapsedStatusTone = 'active' | 'done' | 'issue';
  type CollapsedStatusDot = {
    tone: CollapsedStatusTone;
    title: string;
  };
  type CollapsedNav = {
    projectId: ProjectId | null;
    project: string;
    worktree: string;
    cwd: string;
    branch: string | null;
    projects: CollapsedProjectOption[];
    worktrees: CollapsedWorktreeOption[];
    sessions: Array<{
      id: string;
      name: string;
      index: number | null;
      kind: SessionLaunchKind;
      statusDot: CollapsedStatusDot | null;
      active: boolean;
      session: Session;
    }>;
  };

  function collapsedStatusDotClass(tone: CollapsedStatusTone): string {
    const classes = {
      active: 'bg-warning',
      done: 'bg-success',
      issue: 'bg-destructive'
    } satisfies Record<CollapsedStatusTone, string>;
    return classes[tone];
  }

  function agentStateStatusTone(state: AgentObservedState): CollapsedStatusTone {
    if (state === 'completed' || state === 'exited') return 'done';
    if (state === 'failed' || state === 'waiting_for_approval') return 'issue';
    return 'active';
  }

  function runtimeStatusTone(status: SessionStatus): CollapsedStatusTone | null {
    if (status === 'running' || status === 'starting') return 'active';
    if (status === 'exited') return 'done';
    if (status === 'error') return 'issue';
    return null;
  }

  function statusTitle(label: string, summary: string | null): string {
    return summary ? `${label} · ${summary}` : label;
  }

  function stateLabel(state: AgentObservedState | SessionStatus): string {
    return state.replaceAll('_', ' ');
  }

  function buildCollapsedStatusDot(session: Session): CollapsedStatusDot | null {
    const status = sessions.statusFor(session.id);
    const observed = sessions.observationFor(session.id);
    const latestEvent = sessions.eventsFor(session.id)[0] ?? null;
    const observedSummary = latestEvent?.state === observed?.state
      ? latestEvent?.summary ?? null
      : observed?.resultSummary ?? observed?.promptSummary ?? null;
    if (observed?.state === 'completed' || observed?.state === 'exited') {
      return {
        tone: 'done',
        title: statusTitle(stateLabel(observed.state), observedSummary)
      };
    }
    if (observed?.state === 'failed' || observed?.state === 'waiting_for_approval') {
      return {
        tone: 'issue',
        title: statusTitle(stateLabel(observed.state), observedSummary)
      };
    }
    const displayedState = resolveDisplayedAgentState({
      observed,
      status,
      hasRuntime: sessions.runtime[session.id] !== undefined,
      hasNotificationMarker: agentNotifications.markerFor(session.id) !== null
    });

    if (displayedState) {
      const summary = displayedAgentSummary(observed, displayedState, observedSummary);
      return {
        tone: agentStateStatusTone(displayedState),
        title: statusTitle(stateLabel(displayedState), summary)
      };
    }

    const runtimeTone = runtimeStatusTone(status);
    if (!runtimeTone) return null;
    return {
      tone: runtimeTone,
      title: stateLabel(status)
    };
  }

  let collapsedNav = $derived.by<CollapsedNav | null>(() => {
    if (!sidebar.hidden) return null;
    const sel = sessions.selected;
    if (!sel) return null;
    const project = sel.projectId ? projects.get(sel.projectId) : null;
    const projectName = project?.name ?? null;
    const cwd = sel.cwd?.trim() ?? '';
    const branch = git.statusFor(cwd, {
      runMode: sel.runMode,
      ...(sel.wslDistro ? { wslDistro: sel.wslDistro } : {})
    })?.branch ?? sel.lastBranch ?? null;
    let worktree = branch;
    if (!worktree && project) {
      worktree = worktreeLabel(project.path, cwd, sel.runMode);
    }
    if (!worktree && cwd) {
      worktree = worktreeBasename(cwd);
    }
    // Order siblings the same way the sidebar does, but do not inherit the
    // sidebar's collapsed-worktree filtering. The top bar has its own visibility
    // contract when the sidebar is hidden.
    const ordered = nav.flat.filter(
      (s) =>
        (s.projectId ?? null) === (sel.projectId ?? null)
        && sameWorktreePath(s.cwd?.trim() ?? '', cwd, s.runMode)
    );
    const sessionList = ordered.map((s, i) => ({
      id: s.id,
      name: s.name,
      index: i < 9 ? i + 1 : null,
      kind: displaySessionKind(s, sessions.observationFor(s.id)),
      statusDot: buildCollapsedStatusDot(s),
      active: s.id === sel.id,
      session: s
    }));
    const projectOptions = projects.recents.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      active: p.id === sel.projectId,
      sessionCount: (sessions.byProject[p.id] ?? []).length
    }));
    const worktreeOptions: CollapsedWorktreeOption[] = [];
    if (project) {
      const gitWorktrees = git.worktreesFor(project.path, {
        ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
        ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {})
      }) ?? [];
      const groups = buildWorktreeGroups({
        projectPath: project.path,
        ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
        worktrees: gitWorktrees,
        items: sessions.byProject[project.id] ?? [],
        orderedPaths: project.worktreeOrder ?? []
      });
      for (const group of groups) {
        const firstId = group.items[0]?.id ?? null;
        worktreeOptions.push({
          cwd: group.cwd,
          label: group.label,
          ...(group.worktree?.branch ? { branch: group.worktree.branch } : {}),
          isMain: group.isMain,
          active: sameWorktreePath(group.cwd, cwd, sel.runMode),
          sessionCount: group.items.length,
          selectedSessionId:
            sessions.lastSelectedIdForWorktree({ projectId: project.id, cwd: group.cwd })
            ?? firstId,
          firstSessionId: firstId,
          shortcutIndex: worktreeOptions.length < 9 ? worktreeOptions.length + 1 : null
        });
      }
    }
    if (!projectName && !worktree && sessionList.length === 0) return null;
    return {
      projectId: sel.projectId ?? null,
      project: projectName ?? '',
      worktree: worktree ?? '',
      cwd,
      branch,
      projects: projectOptions,
      worktrees: worktreeOptions,
      sessions: sessionList
    };
  });

  // Keep the rail store's notion of the active worktree in sync with the
  // selected session, so its per-worktree open/fullscreen/tab state can be
  // recalled when bouncing between worktrees.
  $effect(() => {
    const selected = sessions.selected;
    const cwd = selected?.cwd ?? null;
    const project = selected?.projectId ? projects.get(selected.projectId) : null;
    const projectSessions = selected?.projectId
      ? sessions.byProject[selected.projectId] ?? []
      : [];
    rightRail.setActiveCwd(cwd);
    browserStore.setActiveScope(selected ? worktreeScope(selected.cwd, selected) : null);
    vaultStore.setActiveContext({
      cwd,
      projectCwd: project?.path ?? cwd,
      projectScopeCwds: projectSessions.flatMap((session) => {
        const repoPath = git.statusFor(session.cwd, session)?.repoPath;
        return repoPath ? [session.cwd, repoPath] : [session.cwd];
      })
    });
  });

  // Reconcile Worktree Inventory for every known Project. Inventory does not
  // create recurring Working Tree Snapshots; Session demand owns those via
  // the next effect.
  $effect(() => {
    const list = projects.projects;
    const selectedProjectId = sessions.selected?.projectId ?? null;
    const intents = list.map((p) => ({
      repoPath: p.path,
      cadence: p.id === selectedProjectId ? 'foreground' as const : 'background' as const,
      ...(p.defaultRunMode ? { runMode: p.defaultRunMode } : {}),
      ...(p.defaultWslDistro ? { wslDistro: p.defaultWslDistro } : {})
    }));
    void git.refreshProjectWorktrees(intents);
  });

  // Session presence registers a Worktree for observation, but only the
  // selected Worktree expresses foreground observation demand. A normal shell
  // is "running" for its whole lifetime and must not cause permanent 5s WSL
  // Git process churn merely because its terminal remains open in the
  // background.
  $effect(() => {
    git.setWorktreePolling(sessionRefreshIntents(sessions.sessions, sessions.selectedId));
  });

  function consume(e: KeyboardEvent): void {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function isTerminalKeyTarget(e: KeyboardEvent): boolean {
    const target = e.target as HTMLElement | null;
    return Boolean(target?.closest('.xterm'));
  }

  // Ctrl+/-/0 should drive the rail browser's zoom whenever the browser tab
  // is the active rail surface — independent of focus, since the URL bar and
  // toolbar buttons live in the IDE chrome and aren't seen by the webview's
  // own before-input-event hook.
  function isBrowserTabActive(): boolean {
    return rightRail.open && rightRail.activeTab === 'browser';
  }

  function dispatchBrowserZoom(direction: 'in' | 'out' | 'reset'): void {
    window.dispatchEvent(new CustomEvent('soloe:browser-zoom', { detail: { direction } }));
  }

  // Ctrl+; cycles focus: terminal → pane slot 0 → pane slot 1 (if open) →
  // terminal. With one pane open it's a two-way toggle. We probe
  // document.activeElement at keypress time rather than tracking focus in a
  // store because the latter would need to wire into every focusable child.
  // While cycling, rightRail.focusedPaneSlot drives an accent ring on the
  // active pane; a one-shot keydown listener clears it on the next real
  // keystroke so the ring doesn't linger while typing.
  async function toggleTerminalFocus(): Promise<void> {
    const active = document.activeElement as HTMLElement | null;
    const inRail = Boolean(active?.closest('aside[aria-label="Session rail"]'));
    const openTabs = rightRail.openTabs;

    if (!rightRail.open) {
      rightRail.focusedPaneSlot = null;
      window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
      return;
    }

    if (!inRail) {
      await focusPaneSlot(0);
      return;
    }

    // Currently in the rail — figure out which pane. Walk up to the
    // nearest pane wrapper (each has a data-pane-slot attribute) so we
    // honour the user's actual focus, not just whatever the last Ctrl+;
    // set in the store. Fall back to the store if the DOM lookup fails.
    const paneEl = active?.closest<HTMLElement>('[data-pane-slot]');
    const domSlot = paneEl?.dataset.paneSlot;
    const currentSlot: 0 | 1 | null =
      domSlot === '0' ? 0 : domSlot === '1' ? 1 : rightRail.focusedPaneSlot;
    if (currentSlot === 0 && openTabs.length === 2) {
      await focusPaneSlot(1);
      return;
    }

    // From slot 1, or slot 0 with only one pane open — back to terminal.
    rightRail.focusedPaneSlot = null;
    if (rightRail.fullscreen) {
      rightRail.fullscreen = false;
      await tick();
    }
    window.dispatchEvent(new CustomEvent('soloe:refocus-terminal'));
  }

  async function focusPaneSlot(slot: 0 | 1): Promise<void> {
    const tabs = rightRail.openTabs;
    const tabId = tabs[slot];
    if (!tabId) return;
    // In fullscreen the non-fullscreened slot isn't mounted, so promote
    // it first and wait for the layout to flush so its onMount-registered
    // soloe:focus-pane listener exists by the time we dispatch.
    if (rightRail.fullscreen && rightRail.fullscreenTab !== tabId) {
      rightRail.setFullscreenTab(tabId);
      await tick();
    }
    rightRail.focusedPaneSlot = slot;
    window.dispatchEvent(new CustomEvent('soloe:focus-pane', { detail: { tabId } }));
  }

  function selectedSessionContext(): { projectId?: string; cwd?: string; branch?: string } {
    const sel = sessions.selected;
    return {
      ...(sel?.projectId ? { projectId: sel.projectId } : {}),
      ...(sel?.cwd ? { cwd: sel.cwd } : {}),
      ...(sel?.lastBranch ? { branch: sel.lastBranch } : {})
    };
  }

  function selectCollapsedProject(projectId: ProjectId): void {
    const project = projects.get(projectId);
    if (!project) return;
    const before = sessions.selectedId;
    nav.focusProject(projectId);
    if (sessions.selectedId !== before || sessions.selected?.projectId === projectId) return;
    newSessionPicker.open({ projectId, cwd: project.path });
  }

  function selectCollapsedWorktree(option: CollapsedWorktreeOption): void {
    if (option.selectedSessionId) {
      sessions.select(option.selectedSessionId);
      return;
    }
    newSessionPicker.open({
      ...(collapsedNav?.projectId ? { projectId: collapsedNav.projectId } : {}),
      cwd: option.cwd,
      ...(option.branch ? { branch: option.branch } : {})
    });
  }

  function onCollapsedProjectSelect(e: Event, projectId: ProjectId): void {
    if (suppressCollapsedDropdownSelect) {
      e.preventDefault();
      return;
    }
    selectCollapsedProject(projectId);
  }

  function onCollapsedWorktreeSelect(e: Event, worktree: CollapsedWorktreeOption): void {
    if (suppressCollapsedDropdownSelect) {
      e.preventDefault();
      return;
    }
    selectCollapsedWorktree(worktree);
  }

  function selectWorktreeTarget(target: WorktreeIndexTarget): void {
    rightRail.fullscreen = false;
    if (target.selectedSessionId) {
      sessions.select(target.selectedSessionId);
      return;
    }
    newSessionPicker.open({
      projectId: target.projectId,
      cwd: target.cwd,
      ...(target.branch ? { branch: target.branch } : {})
    });
  }

  async function closeCollapsedSession(session: Session): Promise<void> {
    const ok = await confirmDeleteSession(session);
    if (!ok) return;
    try {
      await sessions.remove(session.id);
    } catch (err) {
      reportError(err);
    }
  }

  function onCollapsedSessionPointerDown(e: PointerEvent): void {
    if (e.button !== 1) return;
    e.preventDefault();
  }

  function onCollapsedSessionAuxClick(e: MouseEvent, session: Session): void {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    void closeCollapsedSession(session);
  }

  function selectCollapsedSession(id: string): void {
    rightRail.fullscreen = false;
    sessions.select(id);
  }

  function closeMenusFromTitleBar(node: HTMLElement): { destroy(): void } {
    function onPointerDown(e: PointerEvent): void {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-session-context-trigger]')) return;
      sessionContextMenus.closeAll();
    }
    node.addEventListener('pointerdown', onPointerDown);
    return {
      destroy() {
        node.removeEventListener('pointerdown', onPointerDown);
      }
    };
  }

  function sameOrder(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  function horizontalDropPositionFromEvent(event: DragEvent, el: HTMLElement): DropPosition {
    const rect = el.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    return offsetX < rect.width / 2 ? 'before' : 'after';
  }

  function verticalDropPositionFromEvent(event: DragEvent, el: HTMLElement): DropPosition {
    const rect = el.getBoundingClientRect();
    const offsetY = event.clientY - rect.top;
    return offsetY < rect.height / 2 ? 'before' : 'after';
  }

  function reorderCollapsedProject(args: {
    draggedId: string;
    targetId: string;
    position: DropPosition;
  }): void {
    const ids = collapsedNav?.projects.map((p) => p.id) ?? [];
    if (!ids.includes(args.draggedId) || !ids.includes(args.targetId)) return;
    const without = ids.filter((id) => id !== args.draggedId);
    let insertAt = without.indexOf(args.targetId);
    if (insertAt < 0) insertAt = without.length;
    if (args.position === 'after') insertAt += 1;
    const next = [...without.slice(0, insertAt), args.draggedId, ...without.slice(insertAt)];
    if (sameOrder(ids, next)) return;
    void projects.reorder(next).catch(reportError);
  }

  function onCollapsedProjectDragStart(e: DragEvent, project: CollapsedProjectOption): void {
    if (!e.dataTransfer) return;
    suppressCollapsedDropdownSelect = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DND_MIME.project, project.id);
    dnd.begin({ kind: 'project', id: project.id, projectId: project.id, worktreeCwd: null });
  }

  function onCollapsedProjectDragOver(
    e: DragEvent,
    project: CollapsedProjectOption,
    el: HTMLElement
  ): void {
    if (dnd.drag?.kind !== 'project') return;
    if (dnd.drag.id === project.id) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const position = verticalDropPositionFromEvent(e, el);
    if (
      dnd.target?.kind !== 'project'
      || dnd.target.id !== project.id
      || dnd.target.position !== position
    ) {
      dnd.setTarget({ kind: 'project', id: project.id, position });
    }
  }

  function onCollapsedProjectDrop(e: DragEvent, project: CollapsedProjectOption): void {
    if (dnd.drag?.kind !== 'project') return;
    const draggedId = dnd.drag.id;
    if (draggedId === project.id) return;
    e.preventDefault();
    const position = dnd.target?.kind === 'project' && dnd.target.id === project.id
      ? dnd.target.position
      : 'after';
    reorderCollapsedProject({ draggedId, targetId: project.id, position });
    dnd.end();
  }

  function onCollapsedProjectDragEnd(): void {
    dnd.end();
    setTimeout(() => {
      suppressCollapsedDropdownSelect = false;
    }, 0);
  }

  function collapsedProjectDropPosition(id: string): DropPosition | null {
    const target = dnd.target;
    if (!target || target.kind !== 'project' || target.id !== id) return null;
    if (dnd.drag?.id === id) return null;
    return target.position;
  }

  function isDraggingCollapsedProject(id: string): boolean {
    return dnd.drag?.kind === 'project' && dnd.drag.id === id;
  }

  function reorderCollapsedWorktree(args: {
    draggedCwd: string;
    targetCwd: string;
    position: DropPosition;
  }): void {
    const current = collapsedNav;
    if (!current?.projectId) return;
    const ids = current.worktrees.map((w) => w.cwd);
    if (!ids.includes(args.draggedCwd) || !ids.includes(args.targetCwd)) return;
    const without = ids.filter((id) => id !== args.draggedCwd);
    let insertAt = without.indexOf(args.targetCwd);
    if (insertAt < 0) insertAt = without.length;
    if (args.position === 'after') insertAt += 1;
    const next = [...without.slice(0, insertAt), args.draggedCwd, ...without.slice(insertAt)];
    if (sameOrder(ids, next)) return;
    void projects.update(current.projectId, { worktreeOrder: next }).catch(reportError);
  }

  function onCollapsedWorktreeDragStart(e: DragEvent, worktree: CollapsedWorktreeOption): void {
    const current = collapsedNav;
    if (!current?.projectId || !e.dataTransfer) return;
    suppressCollapsedDropdownSelect = true;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DND_MIME.worktree, worktree.cwd);
    dnd.begin({
      kind: 'worktree',
      id: worktree.cwd,
      projectId: current.projectId,
      worktreeCwd: worktree.cwd
    });
  }

  function onCollapsedWorktreeDragOver(
    e: DragEvent,
    worktree: CollapsedWorktreeOption,
    el: HTMLElement
  ): void {
    const current = collapsedNav;
    if (!current?.projectId) return;
    if (dnd.drag?.kind !== 'worktree') return;
    if (dnd.drag.projectId !== current.projectId) return;
    if (dnd.drag.id === worktree.cwd) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const position = verticalDropPositionFromEvent(e, el);
    if (
      dnd.target?.kind !== 'worktree'
      || dnd.target.id !== worktree.cwd
      || dnd.target.position !== position
    ) {
      dnd.setTarget({ kind: 'worktree', id: worktree.cwd, position });
    }
  }

  function onCollapsedWorktreeDrop(e: DragEvent, worktree: CollapsedWorktreeOption): void {
    const current = collapsedNav;
    if (!current?.projectId) return;
    if (dnd.drag?.kind !== 'worktree') return;
    if (dnd.drag.projectId !== current.projectId) return;
    const draggedCwd = dnd.drag.id;
    if (draggedCwd === worktree.cwd) return;
    e.preventDefault();
    const position = dnd.target?.kind === 'worktree' && dnd.target.id === worktree.cwd
      ? dnd.target.position
      : 'after';
    reorderCollapsedWorktree({ draggedCwd, targetCwd: worktree.cwd, position });
    dnd.end();
  }

  function onCollapsedWorktreeDragEnd(): void {
    dnd.end();
    setTimeout(() => {
      suppressCollapsedDropdownSelect = false;
    }, 0);
  }

  function collapsedWorktreeDropPosition(cwd: string): DropPosition | null {
    const target = dnd.target;
    if (!target || target.kind !== 'worktree' || target.id !== cwd) return null;
    if (dnd.drag?.id === cwd) return null;
    return target.position;
  }

  function isDraggingCollapsedWorktree(cwd: string): boolean {
    return dnd.drag?.kind === 'worktree' && dnd.drag.id === cwd;
  }

  function reorderCollapsedSession(args: {
    draggedId: string;
    targetId: string;
    position: DropPosition;
  }): void {
    const list = collapsedNav?.sessions.map((s) => s.session) ?? [];
    const ids = list.map((s) => s.id);
    if (!ids.includes(args.draggedId) || !ids.includes(args.targetId)) return;
    const without = ids.filter((id) => id !== args.draggedId);
    let insertAt = without.indexOf(args.targetId);
    if (insertAt < 0) insertAt = without.length;
    if (args.position === 'after') insertAt += 1;
    const newSubset = [
      ...without.slice(0, insertAt),
      args.draggedId,
      ...without.slice(insertAt)
    ];
    if (sameOrder(ids, newSubset)) return;
    const subsetSet = new Set(ids);
    const queue = [...newSubset];
    const allIds = sessions.sessions.map((s) => {
      if (subsetSet.has(s.id)) return queue.shift() ?? s.id;
      return s.id;
    });
    void sessions.reorder(allIds).catch(reportError);
  }

  function onCollapsedSessionDragStart(e: DragEvent, session: Session): void {
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DND_MIME.session, session.id);
    dnd.begin({
      kind: 'session',
      id: session.id,
      projectId: session.projectId ?? null,
      worktreeCwd: session.cwd
    });
    sessionContextMenus.closeAll();
  }

  function onCollapsedSessionDragOver(e: DragEvent, session: Session, el: HTMLElement): void {
    if (dnd.drag?.kind !== 'session') return;
    const current = collapsedNav;
    if (!current) return;
    if (dnd.drag.id === session.id) return;
    if ((dnd.drag.projectId ?? null) !== (session.projectId ?? null)) return;
    if (!sameWorktreePath(dnd.drag.worktreeCwd ?? '', session.cwd, session.runMode)) return;
    if (!sameWorktreePath(session.cwd, current.cwd, session.runMode)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const position = horizontalDropPositionFromEvent(e, el);
    if (
      dnd.target?.kind !== 'session'
      || dnd.target.id !== session.id
      || dnd.target.position !== position
    ) {
      dnd.setTarget({ kind: 'session', id: session.id, position });
    }
  }

  function onCollapsedSessionDrop(e: DragEvent, session: Session): void {
    if (dnd.drag?.kind !== 'session') return;
    const draggedId = dnd.drag.id;
    if (draggedId === session.id) return;
    e.preventDefault();
    const position = dnd.target?.kind === 'session' && dnd.target.id === session.id
      ? dnd.target.position
      : 'after';
    reorderCollapsedSession({ draggedId, targetId: session.id, position });
    dnd.end();
  }

  function onCollapsedSessionDragEnd(): void {
    dnd.end();
  }

  function collapsedSessionDropPosition(id: string): DropPosition | null {
    const target = dnd.target;
    if (!target || target.kind !== 'session' || target.id !== id) return null;
    if (dnd.drag?.id === id) return null;
    return target.position;
  }

  function isDraggingCollapsedSession(id: string): boolean {
    return dnd.drag?.kind === 'session' && dnd.drag.id === id;
  }

  function onKey(e: KeyboardEvent) {
    if (Keymap.commandPalette.match(e)) {
      consume(e);
      commandPalette.toggle();
      return;
    }
    if (Keymap.filePalette.match(e)) {
      consume(e);
      filePalette.toggle();
      return;
    }
    if (Keymap.openSettings.match(e)) {
      consume(e);
      settings.toggleDialog();
      return;
    }
    if (Keymap.openProject.match(e)) {
      consume(e);
      commandPalette.open('open-project');
      return;
    }
    if (Keymap.newSession.match(e)) {
      consume(e);
      void sessions
        .createPreferredWithDefaults(selectedSessionContext())
        .catch(reportError);
      return;
    }
    if (Keymap.newSessionPicker.match(e)) {
      consume(e);
      void sessions
        .createPreferredWithDefaults(selectedSessionContext())
        .catch(reportError);
      return;
    }
    if (Keymap.terminalFind.match(e)) {
      consume(e);
      window.dispatchEvent(new CustomEvent('soloe:terminal-find'));
      return;
    }
    if (Keymap.zoomIn.match(e)) {
      consume(e);
      if (isBrowserTabActive()) {
        dispatchBrowserZoom('in');
      } else {
        void ipc.window.zoomIn().catch(reportError);
      }
      return;
    }
    if (Keymap.zoomOut.match(e)) {
      consume(e);
      if (isBrowserTabActive()) {
        dispatchBrowserZoom('out');
      } else {
        void ipc.window.zoomOut().catch(reportError);
      }
      return;
    }
    if (Keymap.zoomReset.match(e)) {
      consume(e);
      if (isBrowserTabActive()) {
        dispatchBrowserZoom('reset');
      }
      // No global "reset zoom" action — only forwarded when the browser is
      // active, since the IDE chrome doesn't currently expose a reset.
      return;
    }
    if (Keymap.toggleNotesRail.match(e)) {
      consume(e);
      void toggleRailTabAndFocus('notes');
      return;
    }
    if (Keymap.toggleDiffRail.match(e)) {
      consume(e);
      void toggleRailTabAndFocus('diff');
      return;
    }
    if (Keymap.toggleFilesRail.match(e)) {
      consume(e);
      void toggleRailTabAndFocus('files');
      return;
    }
    if (Keymap.toggleFeatureRail.match(e)) {
      consume(e);
      void toggleRailTabAndFocus('feature');
      return;
    }
    if (Keymap.toggleBrowserRail.match(e)) {
      consume(e);
      void toggleRailTabAndFocus('browser');
      return;
    }
    if (Keymap.toggleSidebar.match(e)) {
      consume(e);
      sidebar.toggle();
      return;
    }
    if (Keymap.toggleRailFullscreen.match(e)) {
      consume(e);
      // Toggle fullscreen on whichever tab is currently active. If the rail
      // is closed, the store opens it before flipping the flag so the user
      // sees the result instead of toggling invisibly.
      rightRail.toggleFullscreen();
      return;
    }
    if (Keymap.toggleTerminalFocus.match(e)) {
      consume(e);
      void toggleTerminalFocus();
      return;
    }
    if (commandPalette.isOpen || filePalette.open) return;
    if (
      Keymap.splitTerminal.match(e)
      && (!shouldIgnoreInTextInput(e) || isTerminalKeyTarget(e))
    ) {
      consume(e);
      void sessions.splitNewTerminal().catch(reportError);
      return;
    }
    if (
      Keymap.deleteSelectedSession.match(e)
      && (!shouldIgnoreInTextInput(e) || isTerminalKeyTarget(e))
    ) {
      consume(e);
      void nav.closeActive();
      return;
    }
    const worktreeIdx = worktreeIndexFromEvent(e);
    if (worktreeIdx !== null) {
      consume(e);
      const target = nav.worktreeByIndex(worktreeIdx);
      if (target) selectWorktreeTarget(target);
      return;
    }
    const idx = tabIndexFromEvent(e);
    if (idx !== null) {
      consume(e);
      if (sidebar.hidden && collapsedNav?.sessions[idx]) {
        selectCollapsedSession(collapsedNav.sessions[idx].id);
      } else {
        nav.selectByIndex(idx);
      }
      return;
    }
    if (Keymap.cycleNext.match(e)) {
      consume(e);
      nav.cycleNext();
      return;
    }
    if (Keymap.cyclePrev.match(e)) {
      consume(e);
      nav.cyclePrev();
      return;
    }
  }
</script>

<ModeWatcher defaultMode="dark" />

{#if initialLoadState === 'loading'}
  <AppSkeleton label="Loading workspace" />
{:else if initialLoadState === 'error'}
  <div class="flex h-full flex-col overflow-hidden bg-background text-foreground">
    <header
      class="flex h-7 shrink-0 items-center border-b border-border bg-card select-none"
      style="-webkit-app-region: drag"
    >
      <img src={appIconUrl} alt="" class="mr-1.5 ml-3 size-3.5 flex-none" draggable="false" />
      <span class="text-[11px] tracking-wider text-muted-foreground">Soloe</span>
    </header>
    <main class="flex min-h-0 flex-1 items-center justify-center p-6">
      <div class="flex max-w-md flex-col items-center text-center">
        <span
          class="mb-4 flex size-11 items-center justify-center rounded-xl border border-destructive/30 bg-destructive/10 text-destructive"
        >
          <TriangleAlert class="size-5" />
        </span>
        <h1 class="text-base font-semibold">Soloe could not finish loading</h1>
        <p class="mt-1.5 text-sm text-muted-foreground">
          {initialLoadError ?? 'The application backend did not respond.'}
        </p>
        <Button class="mt-5 gap-2" onclick={() => void loadInitialState()}>
          <RotateCcw class="size-3.5" />
          Retry
        </Button>
      </div>
    </main>
  </div>
{:else}
<div class="flex h-full flex-col overflow-hidden">
  <header
    use:closeMenusFromTitleBar
    class="flex h-7 flex-shrink-0 items-center border-b border-border bg-card select-none"
    style="-webkit-app-region: drag"
  >
    <img src={appIconUrl} alt="" class="mr-1.5 ml-3 size-3.5 flex-none" draggable="false" />
    <span class="text-[11px] tracking-wider text-muted-foreground">Soloe</span>
    {#if sidebar.hidden}
      <div class="ml-1 flex self-stretch" style="-webkit-app-region: no-drag">
        <Button
          variant="ghost"
          class="h-full w-[28px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
          onclick={() => sidebar.show()}
          aria-label="Show sidebar"
          title="Show sidebar (Ctrl+B)"
        >
          <PanelLeftOpen class="size-3.5" />
        </Button>
      </div>
      {#if collapsedNav}
        <div
          class="ml-1 flex min-w-0 shrink items-center gap-0.5"
          style="-webkit-app-region: no-drag"
        >
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="ghost"
                  size="xs"
                  class="h-5 min-w-0 max-w-[180px] justify-start gap-1 rounded-sm px-1.5 text-[11px] font-normal text-muted-foreground/70"
                  title={collapsedNav.project || 'Choose project'}
                  aria-label="Choose project"
                >
                  <FolderOpen class="size-3" />
                  <span class="min-w-0 truncate">{collapsedNav.project || 'No project'}</span>
                  <ChevronDown class="size-3 opacity-60" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="w-72">
              <DropdownMenu.Label>Project</DropdownMenu.Label>
              {#each collapsedNav.projects as project (project.id)}
                <DropdownMenu.Item
                  class={`relative ${isDraggingCollapsedProject(project.id) ? 'opacity-40' : ''}`}
                  draggable="true"
                  onSelect={(e) => onCollapsedProjectSelect(e, project.id)}
                  ondragstart={(e) => onCollapsedProjectDragStart(e, project)}
                  ondragover={(e) =>
                    onCollapsedProjectDragOver(e, project, e.currentTarget as HTMLElement)}
                  ondrop={(e) => onCollapsedProjectDrop(e, project)}
                  ondragend={onCollapsedProjectDragEnd}
                >
                  {#if collapsedProjectDropPosition(project.id) === 'before'}
                    <span
                      class="pointer-events-none absolute top-0 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"
                      aria-hidden="true"
                    ></span>
                  {/if}
                  {#if collapsedProjectDropPosition(project.id) === 'after'}
                    <span
                      class="pointer-events-none absolute right-1 bottom-0 left-1 z-10 h-0.5 rounded-full bg-primary"
                      aria-hidden="true"
                    ></span>
                  {/if}
                  <FolderOpen />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">{project.name}</span>
                    <span class="truncate font-mono text-[11px] text-muted-foreground">
                      {project.path}
                    </span>
                  </span>
                  {#if project.sessionCount > 0}
                    <span class="ml-auto text-[11px] text-muted-foreground">{project.sessionCount}</span>
                  {/if}
                  {#if project.active}
                    <Check class="ml-1 size-3" />
                  {/if}
                </DropdownMenu.Item>
              {/each}
              <DropdownMenu.Separator />
              <DropdownMenu.Item onSelect={() => commandPalette.open('open-project')}>
                <Plus /> <span>Open project...</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <span class="text-muted-foreground/35" aria-hidden="true">·</span>

          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              {#snippet child({ props })}
                <Button
                  {...props}
                  variant="ghost"
                  size="xs"
                  class="h-5 min-w-0 max-w-[200px] justify-start gap-1 rounded-sm px-1.5 text-[11px] font-normal text-muted-foreground/90"
                  title={collapsedNav.cwd || collapsedNav.worktree || 'Choose worktree'}
                  aria-label="Choose worktree"
                  disabled={collapsedNav.worktrees.length === 0}
                >
                  <FolderGit2 class="size-3" />
                  <span class="min-w-0 truncate">{collapsedNav.worktree || worktreeBasename(collapsedNav.cwd)}</span>
                  <ChevronDown class="size-3 opacity-60" />
                </Button>
              {/snippet}
            </DropdownMenu.Trigger>
            <DropdownMenu.Content align="start" class="w-72">
              <DropdownMenu.Label>Worktree</DropdownMenu.Label>
              {#each collapsedNav.worktrees as worktree (worktree.cwd)}
                <DropdownMenu.Item
                  class={`relative ${isDraggingCollapsedWorktree(worktree.cwd) ? 'opacity-40' : ''}`}
                  draggable="true"
                  onSelect={(e) => onCollapsedWorktreeSelect(e, worktree)}
                  ondragstart={(e) => onCollapsedWorktreeDragStart(e, worktree)}
                  ondragover={(e) =>
                    onCollapsedWorktreeDragOver(e, worktree, e.currentTarget as HTMLElement)}
                  ondrop={(e) => onCollapsedWorktreeDrop(e, worktree)}
                  ondragend={onCollapsedWorktreeDragEnd}
                >
                  {#if collapsedWorktreeDropPosition(worktree.cwd) === 'before'}
                    <span
                      class="pointer-events-none absolute top-0 right-1 left-1 z-10 h-0.5 rounded-full bg-primary"
                      aria-hidden="true"
                    ></span>
                  {/if}
                  {#if collapsedWorktreeDropPosition(worktree.cwd) === 'after'}
                    <span
                      class="pointer-events-none absolute right-1 bottom-0 left-1 z-10 h-0.5 rounded-full bg-primary"
                      aria-hidden="true"
                    ></span>
                  {/if}
                  {#if worktree.shortcutIndex !== null}
                    <span
                      class="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border/60 bg-background/40 px-0.5 font-mono text-[9px] leading-none text-muted-foreground"
                      title={`Ctrl+Shift+${worktree.shortcutIndex}`}
                      aria-label={`Ctrl+Shift+${worktree.shortcutIndex}`}
                    >
                      {worktree.shortcutIndex}
                    </span>
                  {/if}
                  <FolderGit2 />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate">
                      {worktree.label}{#if worktree.isMain} · main{/if}
                    </span>
                    <span class="truncate font-mono text-[11px] text-muted-foreground">
                      {worktree.cwd}
                    </span>
                  </span>
                  {#if worktree.sessionCount > 0}
                    <span class="ml-auto text-[11px] text-muted-foreground">{worktree.sessionCount}</span>
                  {/if}
                  {#if worktree.active}
                    <Check class="ml-1 size-3" />
                  {/if}
                </DropdownMenu.Item>
              {/each}
            </DropdownMenu.Content>
          </DropdownMenu.Root>

          <AgentLaunchPopover
            projectId={collapsedNav.projectId}
            cwd={collapsedNav.cwd}
            branch={collapsedNav.branch ?? undefined}
            side="bottom"
            align="start"
            class="h-5 w-5 rounded-sm text-muted-foreground hover:text-foreground"
            title="New session"
            ariaLabel="New session"
          />
        </div>
        {#if collapsedNav.sessions.length > 0}
          <span class="mx-1.5 shrink-0 text-muted-foreground/25" aria-hidden="true">·</span>
          <div
            class="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto no-scrollbar"
            style="-webkit-app-region: no-drag"
            role="tablist"
            aria-label="Sessions in this worktree"
          >
            {#each collapsedNav.sessions as s (s.id)}
              <SessionContextMenu session={s.session}>
                {#snippet trigger({ props })}
                  <button
                    {...props}
                    type="button"
                    role="tab"
                    aria-selected={s.active}
                    data-session-context-trigger="true"
                    data-chip-color={s.session.color ?? undefined}
                    data-chip-active={s.active ? 'true' : undefined}
                    style={s.session.color
                      ? `--chip-color: var(--session-${s.session.color});`
                      : undefined}
                    class={`collapsed-session-chip relative inline-flex h-5 max-w-[160px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] leading-none transition-colors ${
                      s.active
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground'
                    } ${isDraggingCollapsedSession(s.id) ? 'opacity-40' : ''}`}
                    title={s.index !== null ? `${s.name} (Ctrl+${s.index})` : s.name}
                    draggable="true"
                    onclick={() => selectCollapsedSession(s.id)}
                    onpointerdown={onCollapsedSessionPointerDown}
                    onauxclick={(e) => onCollapsedSessionAuxClick(e, s.session)}
                    ondragstart={(e) => onCollapsedSessionDragStart(e, s.session)}
                    ondragover={(e) =>
                      onCollapsedSessionDragOver(e, s.session, e.currentTarget as HTMLElement)}
                    ondrop={(e) => onCollapsedSessionDrop(e, s.session)}
                    ondragend={onCollapsedSessionDragEnd}
                  >
                    {#if collapsedSessionDropPosition(s.id) === 'before'}
                      <span
                        class="pointer-events-none absolute top-0 bottom-0 left-0 z-10 w-0.5 rounded-full bg-primary"
                        aria-hidden="true"
                      ></span>
                    {/if}
                    {#if collapsedSessionDropPosition(s.id) === 'after'}
                      <span
                        class="pointer-events-none absolute top-0 right-0 bottom-0 z-10 w-0.5 rounded-full bg-primary"
                        aria-hidden="true"
                      ></span>
                    {/if}
                    {#if s.index !== null}
                      <span
                        class="inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center rounded-[3px] border border-border/60 bg-background/40 px-0.5 font-mono text-[9px] leading-none text-muted-foreground"
                        aria-hidden="true"
                      >
                        {s.index}
                      </span>
                    {/if}
                    <KindIcon kind={s.kind} size={12} />
                    {#if s.statusDot}
                      <span
                        class={`size-1.5 shrink-0 rounded-full ${collapsedStatusDotClass(s.statusDot.tone)}`}
                        title={s.statusDot.title}
                        aria-label={s.statusDot.title}
                      ></span>
                    {/if}
                    <span class="min-w-0 truncate">{s.name}</span>
                  </button>
                {/snippet}
              </SessionContextMenu>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}
    <div class="flex-1 self-stretch" aria-hidden="true"></div>
    <div class="flex shrink-0 self-stretch" style="-webkit-app-region: no-drag">
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => settings.openDialog()}
        aria-label="Settings"
        title="Settings (Ctrl+,)"
      >
        <Settings class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => ipc.window.minimize()}
        aria-label="Minimize"
        title="Minimize"
      >
        <Minus class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-muted hover:text-foreground"
        onclick={() => ipc.window.toggleMaximize()}
        aria-label="Maximize"
        title="Maximize"
      >
        <Maximize2 class="size-3" />
      </Button>
      <Button
        variant="ghost"
        class="h-full w-[42px] rounded-none text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        onclick={() => ipc.window.close()}
        aria-label="Close"
        title="Close"
      >
        <X class="size-3.5" />
      </Button>
    </div>
  </header>
  <div class="relative flex min-h-0 flex-1">
    {#if !sidebar.hidden}
      <Sidebar />
    {/if}
    <!-- Stays mounted across fullscreen toggles so xterm doesn't re-attach. -->
    <div class={railFullscreen ? 'hidden' : 'contents'}>
      <TerminalArea />
    </div>
    <RightRail fullscreen={railFullscreen} />
  </div>
  {#if modal.open}
    <LazyOverlay label="session editor" load={loadNewSessionModal} />
  {/if}
  {#if projectModal.open}
    <LazyOverlay label="project editor" load={loadProjectModal} />
  {/if}
  {#if commandPalette.isOpen}
    <LazyOverlay label="command palette" load={loadCommandPalette} />
  {/if}
  {#if filePalette.open}
    <LazyOverlay label="file palette" load={loadFilePalette} />
  {/if}
  {#if newSessionPicker.isOpen}
    <LazyOverlay label="new session picker" load={loadNewSessionPicker} />
  {/if}
  {#if sessionHandoff.isOpen}
    <LazyOverlay label="session handoff" load={loadSessionHandoff} />
  {/if}
  {#if confirmStore.open}
    <LazyOverlay label="confirmation dialog" load={loadConfirmDialog} />
  {/if}
  {#if agentIntegrationSetup.open}
    <LazyOverlay label="agent integration setup" load={loadAgentIntegrationSetup} />
  {/if}
  {#if settings.dialogOpen}
    <LazyOverlay label="settings" load={loadSettingsDialog} />
  {/if}
  {#if agentNotifications.toasts.length > 0}
    <LazyOverlay label="agent notifications" load={loadAgentNotificationToasts} />
  {/if}
</div>
{/if}

<Toaster richColors closeButton />

<style>
  .collapsed-session-chip[data-chip-color] {
    background-color: color-mix(in oklab, var(--chip-color) 10%, transparent);
    color: var(--foreground);
  }
  .collapsed-session-chip[data-chip-color]:hover {
    background-color: color-mix(in oklab, var(--chip-color) 18%, transparent);
  }
  .collapsed-session-chip[data-chip-color][data-chip-active='true'] {
    background-color: color-mix(in oklab, var(--chip-color) 24%, transparent);
  }
</style>
