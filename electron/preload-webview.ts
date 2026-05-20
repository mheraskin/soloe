/// <reference lib="dom" />
import { ipcRenderer } from 'electron';

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

function shouldForward(e: KeyboardEvent): boolean {
  if (!isCtrlOrCmd(e)) return false;
  // Skip the modifier-only key events themselves.
  if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt') return false;
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

// Password field telemetry: tell the host when a password input gains
// focus so it can pop up a fill prompt, and forward the username/password
// pair on submit so it can prompt to save. The host owns the popover UI;
// this side just observes and reports.

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

// Track the currently-focused password field so we can keep its host-side
// popover anchored as the page scrolls or the layout shifts. Cleared on
// focusout/navigation; the host's popover dismissal is independent.
let focusedPassword: HTMLInputElement | null = null;

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
    if (target.type !== 'password') return;
    if (target.disabled || target.readOnly) return;
    focusedPassword = target;
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
    if (target && target === focusedPassword) {
      focusedPassword = null;
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
    const el = focusedPassword;
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
