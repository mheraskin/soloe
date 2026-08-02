/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from 'electron';
import { resolveElementInfo, type ElementInfo } from 'element-source';
import { resolveSvelteElementInfoInMainWorld } from './element-source-main-world';

// This preload is injected into the browser pane's <webview> guest. It
// forwards Soloe's app-level keyboard shortcuts back to the host renderer
// so they keep working even when the webview holds focus — Chromium would
// otherwise route Ctrl+P, Ctrl+K, etc. to the page (or print dialog) and
// the IDE's keymap would never see them.

interface ForwardedKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// Mirrors `isCtrlOrCmd` in src/lib/keymap.ts. A genuine modified press is
// the only thing we forward — bare letters belong to the page.
function isCtrlOrCmd(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

// Native clipboard / edit shortcuts the guest page must keep — forwarding
// (and thus preventDefault-ing) these would kill Chromium's built-in
// copy/paste/cut/select-all/undo/redo. None of these map to IDE actions in
// src/lib/keymap.ts, so letting the page have them loses nothing.
function isClipboardCombo(e: KeyboardEvent): boolean {
  if (e.altKey) return false;
  switch (e.key.toLowerCase()) {
    case 'c':
    case 'v':
    case 'x':
    case 'a':
    case 'z':
    case 'y':
      return true;
    default:
      return false;
  }
}

function shouldForward(e: KeyboardEvent): boolean {
  if (!isCtrlOrCmd(e)) return false;
  // Skip the modifier-only key events themselves.
  if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt') return false;
  if (isClipboardCombo(e)) return false;
  return true;
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!shouldForward(e)) return;
    // Stop the page (and the webview's default handler) from acting on the
    // shortcut before the host gets a chance. Without preventDefault Ctrl+P
    // opens the browser print dialog over our IDE.
    e.preventDefault();
    e.stopPropagation();
    const payload: ForwardedKey = {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey
    };
    ipcRenderer.sendToHost('soloe:webview-shortcut', payload);
  },
  true
);

// Pointer events inside a <webview> do not bubble into the host renderer.
// Mirror the interaction boundary so browser-scoped popovers can dismiss on
// the same click that the guest page receives.
document.addEventListener(
  'pointerdown',
  () => {
    ipcRenderer.sendToHost('soloe:webview-pointerdown');
  },
  true
);

// Element Source Inspector -------------------------------------------------
// The guest only resolves DOM metadata and coordinates. It never receives a
// filesystem bridge; the host validates paths and owns all source reads.

interface InspectorRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

interface InspectorFrame {
  filePath: string;
  lineNumber: number | null;
  columnNumber: number | null;
  componentName: string | null;
}

interface InspectorModeMessage {
  enabled?: boolean;
}

let inspectorEnabled = false;
let inspectorRoot: HTMLDivElement | null = null;
let inspectorHighlight: HTMLDivElement | null = null;
let inspectorCallout: HTMLDivElement | null = null;
let inspectorCalloutPath: HTMLSpanElement | null = null;
let inspectorCalloutLabel = 'Inspecting…';
let inspectorTarget: Element | null = null;
let inspectorResolvedTarget: Element | null = null;
let inspectorResolutionTimer: ReturnType<typeof setTimeout> | null = null;
let inspectorFrameHandle = 0;
let inspectorResolutionSequence = 0;
let inspectorLastFingerprint = '';
let inspectorLastPayloadFingerprint = '';
let inspectorElementIdSequence = 0;
let inspectorElementIds = new WeakMap<Element, number>();

function inspectorPageUrl(): string {
  try {
    return location.href;
  } catch {
    return '';
  }
}

function inspectorRect(element: Element): InspectorRect | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    viewportWidth: window.innerWidth || document.documentElement.clientWidth,
    viewportHeight: window.innerHeight || document.documentElement.clientHeight
  };
}

function inspectorFrame(frame: {
  filePath?: unknown;
  lineNumber?: unknown;
  columnNumber?: unknown;
  componentName?: unknown;
} | null | undefined): InspectorFrame | null {
  if (!frame || typeof frame.filePath !== 'string' || !frame.filePath.trim()) return null;
  return {
    filePath: frame.filePath,
    lineNumber: typeof frame.lineNumber === 'number' ? frame.lineNumber : null,
    columnNumber: typeof frame.columnNumber === 'number' ? frame.columnNumber : null,
    componentName: typeof frame.componentName === 'string' ? frame.componentName : null
  };
}

function inspectorInfoPayload(info: ElementInfo | null): {
  componentName: string | null;
  source: InspectorFrame | null;
  stack: InspectorFrame[];
} {
  const source = inspectorFrame(info?.source);
  const stack = (info?.stack ?? [])
    .map((frame) => inspectorFrame(frame))
    .filter((frame): frame is InspectorFrame => frame !== null)
    .slice(0, 16);
  return {
    componentName: typeof info?.componentName === 'string' ? info.componentName : null,
    source,
    stack
  };
}

function inspectorFingerprint(element: Element): string {
  let id = inspectorElementIds.get(element);
  if (id === undefined) {
    id = ++inspectorElementIdSequence;
    inspectorElementIds.set(element, id);
  }
  return `${element.tagName}:${id}`;
}

function inspectorCreateOverlay(): void {
  if (inspectorRoot) return;
  inspectorRoot = document.createElement('div');
  inspectorRoot.setAttribute('aria-hidden', 'true');
  inspectorRoot.style.cssText = [
    'all: initial',
    'position: fixed',
    'inset: 0',
    'z-index: 2147483646',
    'pointer-events: none',
    'contain: strict',
    'font-family: ui-monospace, SFMono-Regular, Menlo, monospace'
  ].join(';');
  const shadow = inspectorRoot.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .highlight { all: initial; position: fixed; box-sizing: border-box; border: 1px solid #22c55e;
      background: rgba(34, 197, 94, .08); box-shadow: 0 0 0 1px rgba(15, 23, 42, .65),
      0 0 0 4px rgba(34, 197, 94, .14); border-radius: 2px; transition: left 80ms ease-out,
      top 80ms ease-out, width 80ms ease-out, height 80ms ease-out; pointer-events: none; }
    .callout { all: initial; position: fixed; box-sizing: border-box; display: flex;
      flex-direction: column; align-items: flex-start; gap: 5px; max-width: calc(100vw - 20px);
      padding: 5px 8px; border: 1px solid rgba(148, 163, 184, .45); border-radius: 5px;
      background: #0f172a; color: #f8fafc; box-shadow: 0 5px 16px rgba(0,0,0,.28);
      pointer-events: none; }
    .path { all: initial; display: block; color: #f8fafc;
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: normal;
      overflow-wrap: anywhere; }
    .hint { all: initial; display: inline-flex; align-items: center; gap: 4px; box-sizing: border-box;
      padding: 2px 6px; border: 1px solid rgba(148, 163, 184, .45); border-radius: 999px;
      background: #1e293b; color: #cbd5e1;
      font: 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
    .hint strong { all: initial; color: #f8fafc;
      font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
  `;
  inspectorHighlight = document.createElement('div');
  inspectorHighlight.className = 'highlight';
  inspectorCallout = document.createElement('div');
  inspectorCallout.className = 'callout';
  inspectorCalloutPath = document.createElement('span');
  inspectorCalloutPath.className = 'path';
  inspectorCalloutPath.textContent = inspectorCalloutLabel;
  const hint = document.createElement('span');
  hint.className = 'hint';
  const shift = document.createElement('strong');
  shift.textContent = 'Shift';
  hint.append(shift, document.createTextNode('+ click to interact'));
  inspectorCallout.append(inspectorCalloutPath, hint);
  shadow.append(style, inspectorHighlight, inspectorCallout);
  document.documentElement.appendChild(inspectorRoot);
}

function inspectorDisplayPath(filePath: string | null): string {
  if (!filePath) return 'Source unavailable';
  const normalized = filePath.replaceAll('\\', '/');
  if (normalized.startsWith('/workspace/')) return normalized.slice('/workspace/'.length);
  const sourceRoot = Reflect.get(globalThis, Symbol.for('soloe.element-source.vite-root'));
  if (typeof sourceRoot === 'string') {
    const normalizedRoot = sourceRoot.replaceAll('\\', '/').replace(/\/+$/, '');
    if (normalized.startsWith(`${normalizedRoot}/`)) {
      return normalized.slice(normalizedRoot.length + 1);
    }
  }
  return normalized.replace(/^\.\//, '');
}

function inspectorSetCalloutLabel(label: string): void {
  inspectorCalloutLabel = label;
  if (inspectorCalloutPath) inspectorCalloutPath.textContent = label;
}

function inspectorRender(rect: InspectorRect | null, label: string): void {
  if (!inspectorHighlight || !inspectorCallout) return;
  if (!rect) {
    inspectorHighlight.style.display = 'none';
    inspectorCallout.style.display = 'none';
    return;
  }
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  inspectorHighlight.style.display = 'block';
  inspectorHighlight.style.left = `${left}px`;
  inspectorHighlight.style.top = `${top}px`;
  inspectorHighlight.style.width = `${Math.max(1, rect.width)}px`;
  inspectorHighlight.style.height = `${Math.max(1, rect.height)}px`;
  inspectorSetCalloutLabel(label);
  inspectorCallout.style.display = 'flex';
  inspectorCallout.style.left = `${Math.min(
    Math.max(8, left),
    Math.max(8, window.innerWidth - inspectorCallout.offsetWidth - 8)
  )}px`;
  const below = top + rect.height + 8;
  const calloutHeight = inspectorCallout.offsetHeight || 24;
  inspectorCallout.style.top = `${below + calloutHeight <= window.innerHeight - 8
    ? below
    : Math.max(8, top - calloutHeight - 8)}px`;
}

function inspectorSend(kind: 'hover' | 'leave' | 'select', info: ElementInfo | null, element: Element | null): void {
  const metadata = inspectorInfoPayload(info);
  const rect = element ? inspectorRect(element) : null;
  const path = metadata.source?.filePath ? inspectorDisplayPath(metadata.source.filePath) : null;
  const name = metadata.componentName || element?.tagName.toLowerCase() || 'Element';
  const line = metadata.source?.lineNumber ? `:${metadata.source.lineNumber}` : '';
  const payloadFingerprint = `${kind}:${path ?? ''}:${line}:${name}:${rect?.x ?? ''}:${rect?.y ?? ''}`;
  if (kind === 'hover' && payloadFingerprint === inspectorLastPayloadFingerprint) return;
  inspectorLastPayloadFingerprint = payloadFingerprint;
  ipcRenderer.sendToHost('soloe:webview-element-source', {
    kind,
    tagName: element?.tagName ?? 'ELEMENT',
    componentName: metadata.componentName,
    source: metadata.source,
    stack: metadata.stack,
    rect,
    label: path ? `${name} — ${path}${line}` : `${name} — Source unavailable`,
    pageUrl: inspectorPageUrl()
  });
}

async function inspectorResolveTarget(
  target: Element,
  select: boolean,
  clientX: number,
  clientY: number
): Promise<void> {
  const sequence = ++inspectorResolutionSequence;
  let info: ElementInfo | null = null;
  let resolvedTarget: Element = target;
  try {
    const mainWorldResolution = contextBridge.executeInMainWorld({
      func: resolveSvelteElementInfoInMainWorld,
      args: [clientX, clientY]
    });
    if (mainWorldResolution?.info) {
      info = mainWorldResolution.info;
      let ownerDepth = Number(mainWorldResolution.ownerDepth) || 0;
      while (ownerDepth > 0 && resolvedTarget.parentElement) {
        resolvedTarget = resolvedTarget.parentElement;
        ownerDepth -= 1;
      }
    }
  } catch {
    // Older Electron builds and non-isolated test environments fall back to
    // the regular resolver below.
  }
  let current: Element | null = target;
  // Prefer the most-specific element with a useful source frame, while still
  // allowing a nested child to inherit its nearest component metadata.
  for (let depth = 0; !info && current && depth < 6; depth += 1) {
    try {
      const candidate = await resolveElementInfo(current);
      if (candidate.source || candidate.stack.length > 0 || candidate.componentName) {
        info = candidate;
        resolvedTarget = current;
        break;
      }
    } catch {
      // A page can remove a node while resolution is in flight. The next
      // pointer target remains authoritative; this is intentionally silent.
    }
    current = current.parentElement;
  }
  if (sequence !== inspectorResolutionSequence || !inspectorEnabled) return;
  inspectorResolvedTarget = resolvedTarget;
  const rect = inspectorRect(resolvedTarget);
  const metadata = inspectorInfoPayload(info);
  const path = metadata.source?.filePath ? inspectorDisplayPath(metadata.source.filePath) : null;
  const name = metadata.componentName || resolvedTarget.tagName.toLowerCase();
  const line = metadata.source?.lineNumber ? `:${metadata.source.lineNumber}` : '';
  inspectorRender(rect, path ? `${name} — ${path}${line}` : `${name} — Source unavailable`);
  inspectorSend(select ? 'select' : 'hover', info, resolvedTarget);
}

function inspectorScheduleResolve(
  target: Element,
  select = false,
  clientX = 0,
  clientY = 0
): void {
  if (!inspectorEnabled) return;
  inspectorTarget = target;
  inspectorCreateOverlay();
  const fingerprint = inspectorFingerprint(target);
  if (!select && fingerprint === inspectorLastFingerprint) {
    inspectorRender(inspectorRect(inspectorResolvedTarget ?? target), inspectorCalloutLabel);
    return;
  }
  inspectorLastFingerprint = fingerprint;
  if (inspectorResolutionTimer !== null) clearTimeout(inspectorResolutionTimer);
  inspectorSetCalloutLabel('Inspecting…');
  inspectorResolutionTimer = setTimeout(() => {
    inspectorResolutionTimer = null;
    void inspectorResolveTarget(target, select, clientX, clientY);
  }, select ? 0 : 70);
}

function inspectorRefreshPosition(): void {
  if (!inspectorEnabled) return;
  const target = inspectorResolvedTarget ?? inspectorTarget;
  if (!target || !target.isConnected) return;
  const rect = inspectorRect(target);
  if (!rect) return;
  inspectorRender(rect, inspectorCalloutLabel);
}

function inspectorOnPointerMove(event: PointerEvent): void {
  if (!inspectorEnabled) return;
  const target = event.target;
  if (!(target instanceof Element) || inspectorRoot?.contains(target)) return;
  if (inspectorFrameHandle) return;
  inspectorFrameHandle = requestAnimationFrame(() => {
    inspectorFrameHandle = 0;
    inspectorScheduleResolve(target, false, event.clientX, event.clientY);
  });
}

function inspectorOnPointerDown(event: PointerEvent): void {
  if (!inspectorEnabled || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof Element) || inspectorRoot?.contains(target)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  inspectorScheduleResolve(target, true, event.clientX, event.clientY);
}

function inspectorOnPointerUp(event: PointerEvent): void {
  inspectorBlockActivation(event);
}

function inspectorOnClick(event: MouseEvent): void {
  inspectorBlockActivation(event);
}

function inspectorBlockActivation(event: MouseEvent): void {
  if (!inspectorEnabled || event.shiftKey) return;
  const target = event.target;
  if (!(target instanceof Element) || inspectorRoot?.contains(target)) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function inspectorOnPointerLeave(): void {
  if (!inspectorEnabled) return;
  inspectorLastPayloadFingerprint = '';
  ipcRenderer.sendToHost('soloe:webview-element-source', { kind: 'leave', pageUrl: inspectorPageUrl() });
}

function inspectorOnKeyDown(event: KeyboardEvent): void {
  if (!inspectorEnabled || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.sendToHost('soloe:webview-element-source-exit');
}

function inspectorAttach(): void {
  inspectorCreateOverlay();
  document.addEventListener('pointermove', inspectorOnPointerMove, true);
  document.addEventListener('pointerdown', inspectorOnPointerDown, true);
  document.addEventListener('pointerup', inspectorOnPointerUp, true);
  document.addEventListener('click', inspectorOnClick, true);
  document.addEventListener('auxclick', inspectorOnClick, true);
  document.addEventListener('dblclick', inspectorOnClick, true);
  document.addEventListener('mouseleave', inspectorOnPointerLeave, true);
  document.addEventListener('keydown', inspectorOnKeyDown, true);
  window.addEventListener('scroll', inspectorRefreshPosition, true);
  window.addEventListener('resize', inspectorRefreshPosition);
}

function inspectorDetach(): void {
  if (inspectorResolutionTimer !== null) clearTimeout(inspectorResolutionTimer);
  inspectorResolutionTimer = null;
  if (inspectorFrameHandle) cancelAnimationFrame(inspectorFrameHandle);
  inspectorFrameHandle = 0;
  inspectorResolutionSequence += 1;
  document.removeEventListener('pointermove', inspectorOnPointerMove, true);
  document.removeEventListener('pointerdown', inspectorOnPointerDown, true);
  document.removeEventListener('pointerup', inspectorOnPointerUp, true);
  document.removeEventListener('click', inspectorOnClick, true);
  document.removeEventListener('auxclick', inspectorOnClick, true);
  document.removeEventListener('dblclick', inspectorOnClick, true);
  document.removeEventListener('mouseleave', inspectorOnPointerLeave, true);
  document.removeEventListener('keydown', inspectorOnKeyDown, true);
  window.removeEventListener('scroll', inspectorRefreshPosition, true);
  window.removeEventListener('resize', inspectorRefreshPosition);
  inspectorTarget = null;
  inspectorResolvedTarget = null;
  inspectorLastFingerprint = '';
  inspectorLastPayloadFingerprint = '';
  inspectorElementIds = new WeakMap<Element, number>();
  inspectorElementIdSequence = 0;
  inspectorHighlight?.remove();
  inspectorCallout?.remove();
  inspectorRoot?.remove();
  inspectorRoot = null;
  inspectorHighlight = null;
  inspectorCallout = null;
  inspectorCalloutPath = null;
  inspectorCalloutLabel = 'Inspecting…';
}

if (typeof ipcRenderer.on === 'function') {
  ipcRenderer.on('soloe:webview-element-source-mode', (_event, message: InspectorModeMessage) => {
    const enabled = message?.enabled === true;
    if (enabled === inspectorEnabled) return;
    inspectorEnabled = enabled;
    if (enabled) inspectorAttach();
    else inspectorDetach();
  });
}

// Credential field telemetry: tell the host when a username/password input
// gains focus so it can pop up a fill prompt, and forward the
// username/password pair on submit so it can prompt to save. The host owns
// the popover UI; this side just observes and reports.

function pageOrigin(): string {
  try {
    return new URL(location.href).origin;
  } catch {
    return location.href;
  }
}

function detectUsername(passwordEl: HTMLInputElement): string | null {
  const scope: ParentNode = passwordEl.closest('form') || document;
  const candidates = scope.querySelectorAll<HTMLInputElement>(
    'input[type="email"]:not([disabled]):not([readonly]),' +
      'input[type="tel"]:not([disabled]):not([readonly]),' +
      'input[type="text"]:not([disabled]):not([readonly]),' +
      'input[name*="user" i]:not([disabled]):not([readonly]),' +
      'input[name*="email" i]:not([disabled]):not([readonly]),' +
      'input[name*="login" i]:not([disabled]):not([readonly]),' +
      'input[id*="user" i]:not([disabled]):not([readonly]),' +
      'input[id*="email" i]:not([disabled]):not([readonly]),' +
      'input[autocomplete*="username" i]:not([disabled]):not([readonly]),' +
      'input[autocomplete*="email" i]:not([disabled]):not([readonly])'
  );
  for (const c of candidates) {
    if (c === passwordEl) continue;
    if (c.type === 'password') continue;
    const value = c.value?.trim();
    if (!value) continue;
    return value;
  }
  return null;
}

function credentialFieldSelector(): string {
  return (
    'input[type="email"]:not([disabled]):not([readonly]),' +
    'input[type="tel"]:not([disabled]):not([readonly]),' +
    'input[name*="user" i]:not([disabled]):not([readonly]),' +
    'input[name*="email" i]:not([disabled]):not([readonly]),' +
    'input[name*="login" i]:not([disabled]):not([readonly]),' +
    'input[id*="user" i]:not([disabled]):not([readonly]),' +
    'input[id*="email" i]:not([disabled]):not([readonly]),' +
    'input[autocomplete*="username" i]:not([disabled]):not([readonly]),' +
    'input[autocomplete*="email" i]:not([disabled]):not([readonly])'
  );
}

function passwordFieldSelector(): string {
  return 'input[type="password"]:not([disabled]):not([readonly])';
}

function hasRelatedPassword(input: HTMLInputElement): boolean {
  const scope: ParentNode = input.closest('form') || document;
  return !!scope.querySelector<HTMLInputElement>(passwordFieldSelector());
}

function isCredentialFocusTarget(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false;
  if (input.type === 'password') return true;
  if (!hasRelatedPassword(input)) return false;
  return input.matches(credentialFieldSelector());
}

// Track the currently-focused credential field so we can keep its host-side
// popover anchored as the page scrolls or the layout shifts. Cleared on
// focusout/navigation; the host's popover dismissal is independent.
let focusedCredentialField: HTMLInputElement | null = null;

interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}

function readRect(el: HTMLElement): FieldRect | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return {
    x: r.left,
    y: r.top,
    width: r.width,
    height: r.height,
    viewportWidth: window.innerWidth || document.documentElement.clientWidth,
    viewportHeight: window.innerHeight || document.documentElement.clientHeight
  };
}

document.addEventListener(
  'focusin',
  (e) => {
    const target = e.target as Element | null;
    if (!target || !(target instanceof HTMLInputElement)) return;
    if (!isCredentialFocusTarget(target)) return;
    focusedCredentialField = target;
    // Fresh focus → host may (re-)show the popover even if previously
    // dismissed for this origin.
    ipcRenderer.sendToHost('soloe:webview-password-focus', {
      origin: pageOrigin(),
      rect: readRect(target)
    });
  },
  true
);

document.addEventListener(
  'focusout',
  (e) => {
    const target = e.target as Element | null;
    if (target && target === focusedCredentialField) {
      focusedCredentialField = null;
    }
  },
  true
);

// Scroll/resize updates use a separate channel so the host can keep an open
// popover anchored without re-opening one the user already dismissed.
let scrollEmitScheduled = false;
function scheduleRectUpdate(): void {
  if (scrollEmitScheduled) return;
  scrollEmitScheduled = true;
  requestAnimationFrame(() => {
    scrollEmitScheduled = false;
    const el = focusedCredentialField;
    if (!el || !el.isConnected) return;
    ipcRenderer.sendToHost('soloe:webview-password-rect', {
      origin: pageOrigin(),
      rect: readRect(el)
    });
  });
}

window.addEventListener('scroll', scheduleRectUpdate, true);
window.addEventListener('resize', scheduleRectUpdate, true);

// Listen at capture so we see the submit even if the page later calls
// stopPropagation. We can't preventDefault here — the form must actually
// submit; we're just snapshotting the credentials on the way out.
document.addEventListener(
  'submit',
  (e) => {
    const form = e.target as Element | null;
    if (!form || !(form instanceof HTMLFormElement)) return;
    const pwd = form.querySelector<HTMLInputElement>(
      'input[type="password"]:not([disabled]):not([readonly])'
    );
    if (!pwd) return;
    const password = pwd.value;
    if (!password) return;
    const username = detectUsername(pwd);
    if (!username) return;
    ipcRenderer.sendToHost('soloe:webview-form-submit', {
      origin: pageOrigin(),
      username,
      password
    });
  },
  true
);
