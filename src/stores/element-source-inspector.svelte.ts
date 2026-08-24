import type { RunMode } from '@shared/types/sessions.js';
import type { DeviceId } from '@shared/types/devices.js';
import {
  ELEMENT_SOURCE_INSPECTOR_VIEWER_GRACE,
  formatElementLabel,
  normalizeSourceFrame,
  placeInspectorViewer,
  resolveSourceFrame,
  type ElementSourceFrame,
  type ElementSourcePayload,
  type HostRect,
  type InspectorBounds,
  type InspectorPosition
} from '../lib/element-source-inspector';

export interface InspectorTabContext {
  tabId: string;
  scopeKey: string;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  deviceId?: DeviceId;
  projectRoot: string;
  worktreeRoots?: readonly string[];
  pageUrl: string;
}

export interface SourceHistoryEntry {
  frame: ElementSourceFrame | null;
  componentName: string | null;
  scrollTop: number | null;
}

export type SourceViewerStatus = 'loading' | 'ready' | 'error';

export interface ElementSourceViewer {
  id: string;
  tabId: string;
  scopeKey: string;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  deviceId?: DeviceId;
  projectRoot: string;
  pinned: boolean;
  tagName: string;
  label: string;
  pageUrl: string;
  targetRect: HostRect | null;
  position: InspectorPosition;
  zIndex: number;
  stack: ElementSourceFrame[];
  history: SourceHistoryEntry[];
  historyIndex: number;
  status: SourceViewerStatus;
  error: string | null;
  content: string | null;
  loadedPath: string | null;
}

export interface InspectorTabHover {
  tabId: string;
  payload: ElementSourcePayload;
  targetRect: HostRect | null;
}

type ViewerPatch = Partial<Omit<ElementSourceViewer, 'id'>>;

export class ElementSourceInspectorStore {
  modeByTab = $state<Record<string, boolean>>({});
  hoverByTab = $state<Record<string, InspectorTabHover | null>>({});
  transient = $state<ElementSourceViewer | null>(null);
  pinned = $state<ElementSourceViewer[]>([]);
  panelBounds = $state<InspectorBounds | null>(null);
  activeScopeKey = $state<string | null>(null);

  private contexts = new Map<string, InspectorTabContext>();
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private viewerPointerInside = new Set<string>();

  setActiveScope(scopeKey: string | null): void {
    if (scopeKey === this.activeScopeKey) return;
    this.activeScopeKey = scopeKey;
    this.clearAll();
    for (const key of this.contexts.keys()) {
      if (scopeKey === null || !key.startsWith(`${scopeKey}::`)) this.contexts.delete(key);
    }
  }

  registerContext(context: InspectorTabContext): void {
    this.contexts.set(this.contextKey(context.scopeKey, context.tabId), context);
  }

  removeContext(scopeKey: string, tabId: string): void {
    const key = this.contextKey(scopeKey, tabId);
    this.contexts.delete(key);
    delete this.modeByTab[key];
    delete this.hoverByTab[key];
    this.closeTabViewers(scopeKey, tabId);
  }

  isModeActive(scopeKey: string, tabId: string): boolean {
    return this.modeByTab[this.contextKey(scopeKey, tabId)] === true;
  }

  setMode(scopeKey: string, tabId: string, active: boolean): void {
    const key = this.contextKey(scopeKey, tabId);
    this.modeByTab = { ...this.modeByTab, [key]: active };
    if (!active) {
      this.hoverByTab = { ...this.hoverByTab, [key]: null };
      if (this.transient?.scopeKey === scopeKey && this.transient.tabId === tabId) {
        this.transient = null;
      }
    }
  }

  setPanelBounds(bounds: InspectorBounds | null): void {
    if (sameBounds(this.panelBounds, bounds)) return;
    this.panelBounds = bounds;
    if (!bounds) return;
    if (this.transient) {
      const position = placeInspectorViewer(
        this.transient.targetRect,
        bounds,
        this.transient.position.width,
        this.transient.position.height
      );
      if (!samePosition(this.transient.position, position)) {
        this.transient = { ...this.transient, position };
      }
    }
    if (this.pinned.length > 0) {
      let changed = false;
      const pinned = this.pinned.map((viewer) => {
        const position = placeInspectorViewer(
          viewer.targetRect,
          bounds,
          viewer.position.width,
          viewer.position.height
        );
        if (samePosition(viewer.position, position)) return viewer;
        changed = true;
        return { ...viewer, position };
      });
      if (changed) this.pinned = pinned;
    }
  }

  receive(scopeKey: string, tabId: string, payload: ElementSourcePayload, targetRect: HostRect | null): void {
    const key = this.contextKey(scopeKey, tabId);
    if (!this.isModeActive(scopeKey, tabId)) return;
    if (payload.kind === 'leave') {
      this.hoverByTab = { ...this.hoverByTab, [key]: null };
      this.scheduleTransientClose();
      return;
    }

    this.cancelTransientClose();
    const hover: InspectorTabHover = { tabId, payload, targetRect };
    this.hoverByTab = { ...this.hoverByTab, [key]: hover };
    if (payload.kind === 'hover') return;

    this.openViewer(scopeKey, tabId, payload, targetRect);
  }

  enterViewer(id: string): void {
    this.beginViewerInteraction(id);
  }

  beginViewerInteraction(id: string): void {
    if (!this.findViewer(id)) return;
    this.viewerPointerInside.add(id);
    this.cancelTransientClose();
  }

  leaveViewer(id: string): void {
    this.viewerPointerInside.delete(id);
    if (this.transient?.id === id) this.scheduleTransientClose();
  }

  pinViewer(id: string): void {
    if (!this.transient || this.transient.id !== id) return;
    const viewer = this.transient;
    this.transient = null;
    this.pinned = [...this.pinned, { ...viewer, pinned: true }];
    this.cancelTransientClose();
  }

  unpinViewer(id: string): void {
    const viewer = this.pinned.find((entry) => entry.id === id);
    if (!viewer) return;
    this.pinned = this.pinned.filter((entry) => entry.id !== id);
    this.transient = {
      ...viewer,
      pinned: false,
      zIndex: ++this.sequence
    };
  }

  closeViewer(id: string): void {
    if (this.transient?.id === id) {
      this.transient = null;
      this.cancelTransientClose();
      return;
    }
    this.pinned = this.pinned.filter((viewer) => viewer.id !== id);
    this.viewerPointerInside.delete(id);
  }

  focusViewer(id: string): void {
    const viewer = this.findViewer(id);
    if (!viewer) return;
    this.updateViewer(id, { zIndex: ++this.sequence });
  }

  updateViewer(id: string, patch: ViewerPatch): void {
    if (this.transient?.id === id) {
      this.transient = { ...this.transient, ...patch };
      return;
    }
    const index = this.pinned.findIndex((viewer) => viewer.id === id);
    if (index < 0) return;
    this.pinned = this.pinned.map((viewer, viewerIndex) =>
      viewerIndex === index ? { ...viewer, ...patch } : viewer
    );
  }

  updateViewerSnapshot(id: string, snapshot: { scrollTop: number | null }): void {
    const viewer = this.findViewer(id);
    if (!viewer) return;
    const history = viewer.history.slice();
    const current = history[viewer.historyIndex];
    if (!current) return;
    history[viewer.historyIndex] = { ...current, scrollTop: snapshot.scrollTop };
    this.updateViewer(id, { history });
  }

  openStackFrame(id: string, frame: ElementSourceFrame): void {
    const viewer = this.findViewer(id);
    if (!viewer) return;
    const normalized = normalizeSourceFrame(frame, viewer.projectRoot);
    if (!normalized) return;
    const current = viewer.history[viewer.historyIndex]?.frame;
    if (current && sameFrame(current, normalized)) return;
    const history = viewer.history.slice(0, viewer.historyIndex + 1);
    history.push({
      frame: normalized,
      componentName: normalized.componentName,
      scrollTop: null
    });
    this.updateViewer(id, {
      history,
      historyIndex: history.length - 1,
      status: 'loading',
      error: null,
      content: null,
      loadedPath: null
    });
  }

  canGoBack(id: string): boolean {
    const viewer = this.findViewer(id);
    return !!viewer && viewer.historyIndex > 0;
  }

  goBack(id: string): void {
    const viewer = this.findViewer(id);
    if (!viewer || viewer.historyIndex <= 0) return;
    this.updateViewer(id, {
      historyIndex: viewer.historyIndex - 1,
      status: 'loading',
      error: null,
      content: null,
      loadedPath: null
    });
  }

  clearAll(): void {
    this.cancelTransientClose();
    this.modeByTab = {};
    this.hoverByTab = {};
    this.transient = null;
    this.pinned = [];
    this.viewerPointerInside.clear();
  }

  private openViewer(
    scopeKey: string,
    tabId: string,
    payload: ElementSourcePayload,
    targetRect: HostRect | null
  ): void {
    const context = this.contexts.get(this.contextKey(scopeKey, tabId));
    if (!context) return;
    this.cancelTransientClose();
    const sourceResolution = resolveSourceFrame(
      payload.source,
      context.projectRoot,
      context.worktreeRoots
    );
    const source = sourceResolution?.frame ?? null;
    const normalizedStack = (payload.stack ?? []).flatMap((candidate) => {
      const resolution = resolveSourceFrame(
        candidate,
        context.projectRoot,
        context.worktreeRoots
      );
      return resolution ? [resolution] : [];
    });
    const stack = normalizedStack.map((entry) => entry.frame);
    const frames = source && !stack.some((frame) => sameFrame(frame, source))
      ? [source, ...stack]
      : stack;
    // The source frame is the element the user selected. Start there so a
    // component's render helper (for example, `{@render children?.()}`)
    // never replaces the highlighted element as the first preview.
    const initialFrame = source ?? frames[0] ?? null;
    const sourceWorktreeRoot = sourceResolution?.worktreeRoot
      ?? normalizedStack[0]?.worktreeRoot
      ?? context.cwd;
    const initialHistory: SourceHistoryEntry[] = [{
      frame: initialFrame,
      componentName: initialFrame?.componentName ?? cleanName(payload.componentName),
      scrollTop: null
    }];
    const existing = this.transient;
    const position = placeInspectorViewer(
      targetRect,
      this.panelBounds ?? fallbackBounds(),
      existing?.position.width ?? 430,
      existing?.position.height ?? 340
    );
    if (existing && sameViewerTarget(existing, context, initialFrame, payload)) {
      this.transient = {
        ...existing,
        cwd: sourceWorktreeRoot,
        projectRoot: sourceWorktreeRoot,
        targetRect,
        position,
        stack: frames,
        label: formatElementLabel(payload),
        tagName: payload.tagName?.toLowerCase() ?? existing.tagName
      };
      return;
    }
    const id = `element-source-${++this.sequence}`;
    this.transient = {
      id,
      tabId,
      scopeKey,
      cwd: sourceWorktreeRoot,
      runMode: context.runMode,
      ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
      ...(context.deviceId ? { deviceId: context.deviceId } : {}),
      projectRoot: sourceWorktreeRoot,
      pinned: false,
      tagName: payload.tagName?.toLowerCase() ?? 'element',
      label: formatElementLabel(payload),
      pageUrl: payload.pageUrl ?? context.pageUrl,
      targetRect,
      position,
      zIndex: this.sequence,
      stack: frames,
      history: initialHistory,
      historyIndex: 0,
      status: initialFrame ? 'loading' : 'error',
      error: initialFrame ? null : 'Source metadata is unavailable for this element.',
      content: null,
      loadedPath: null
    };
  }

  private scheduleTransientClose(): void {
    this.cancelTransientClose();
    const id = this.transient?.id;
    if (!id || this.viewerPointerInside.has(id)) return;
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!this.transient || this.viewerPointerInside.has(this.transient.id)) return;
      this.transient = null;
    }, ELEMENT_SOURCE_INSPECTOR_VIEWER_GRACE);
  }

  private cancelTransientClose(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  private closeTabViewers(scopeKey: string, tabId: string): void {
    if (this.transient?.scopeKey === scopeKey && this.transient.tabId === tabId) {
      this.transient = null;
    }
    this.pinned = this.pinned.filter(
      (viewer) => viewer.scopeKey !== scopeKey || viewer.tabId !== tabId
    );
  }

  private findViewer(id: string): ElementSourceViewer | null {
    if (this.transient?.id === id) return this.transient;
    return this.pinned.find((viewer) => viewer.id === id) ?? null;
  }

  private contextKey(scopeKey: string, tabId: string): string {
    return `${scopeKey}::${tabId}`;
  }

}

function sameFrame(a: ElementSourceFrame, b: ElementSourceFrame): boolean {
  return a.filePath === b.filePath
    && a.lineNumber === b.lineNumber
    && a.columnNumber === b.columnNumber;
}

function sameBounds(a: InspectorBounds | null, b: InspectorBounds | null): boolean {
  if (a === b) return true;
  return a !== null && b !== null
    && a.left === b.left
    && a.top === b.top
    && a.right === b.right
    && a.bottom === b.bottom;
}

function samePosition(a: InspectorPosition, b: InspectorPosition): boolean {
  return a.left === b.left
    && a.top === b.top
    && a.width === b.width
    && a.height === b.height;
}

function sameViewerTarget(
  viewer: ElementSourceViewer,
  context: InspectorTabContext,
  frame: ElementSourceFrame | null,
  payload: ElementSourcePayload
): boolean {
  const previous = viewer.history[viewer.historyIndex]?.frame;
  return viewer.scopeKey === context.scopeKey
    && viewer.tabId === context.tabId
    && (frame === null || (previous !== null && previous !== undefined && sameFrame(frame, previous)))
    && viewer.tagName === (payload.tagName?.toLowerCase() ?? viewer.tagName);
}

function cleanName(value: string | null | undefined): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  return name ? name : null;
}

function fallbackBounds(): InspectorBounds {
  const width = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const height = typeof window === 'undefined' ? 720 : window.innerHeight;
  return { left: 0, top: 0, right: width, bottom: height };
}

export const elementSourceInspector = new ElementSourceInspectorStore();
