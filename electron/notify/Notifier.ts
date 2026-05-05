import type { BrowserWindow } from 'electron';
import type { ObservedAgentSnapshot, ObserverEvent } from '@shared/types/agents.js';
import { IpcChannels, type ToastNotification } from '@shared/types/ipc.js';
import type { AgentObservedState, Session, SessionId } from '@shared/types/sessions.js';
import type { AgentObserverManager } from '../agents/AgentObserverManager.js';
import type { SessionStore } from '../sessions/SessionStore.js';

export interface NotifierOptions {
  getWindows: () => BrowserWindow[];
  nativeFactory?: (notification: NativeNotificationOptions) => NativeNotificationHandle;
  isNativeSupported?: () => boolean;
  shouldShowNative?: () => boolean;
  focusApp?: () => void;
  log?: (message: string, detail?: unknown) => void;
}

export interface NativeNotificationOptions {
  title: string;
  body?: string;
  silent?: boolean;
}

export interface NativeNotificationHandle {
  show(): void;
  on?(event: 'click' | 'close' | 'failed', listener: () => void): unknown;
}

type NativeNotifyState = Extract<
  AgentObservedState,
  'waiting_for_input' | 'waiting_for_approval' | 'usage_limited' | 'completed' | 'failed'
>;

export class Notifier {
  private readonly lastObservedStates = new Map<string, AgentObservedState>();
  private readonly activeNativeNotifications = new Set<NativeNotificationHandle>();

  constructor(private readonly opts: NotifierOptions) {}

  toast(notification: ToastNotification): void {
    for (const win of this.opts.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.notify.toast, notification);
      }
    }
  }

  native(notification: NativeNotificationOptions, onClick?: () => void): void {
    if (!this.opts.nativeFactory) return;
    if (this.opts.isNativeSupported && !this.opts.isNativeSupported()) return;
    if (this.opts.shouldShowNative && !this.opts.shouldShowNative()) return;
    let native: NativeNotificationHandle | null = null;
    try {
      native = this.opts.nativeFactory(notification);
      const retained = native;
      this.activeNativeNotifications.add(retained);
      const release = () => this.activeNativeNotifications.delete(retained);
      native.on?.('click', () => {
        release();
        this.focusFirstWindow();
        onClick?.();
      });
      native.on?.('close', release);
      native.on?.('failed', release);
      native.show();
    } catch (err) {
      if (native) this.activeNativeNotifications.delete(native);
      this.opts.log?.('failed to show native notification', err);
    }
  }

  attachAgentObserver(observer: AgentObserverManager, sessions: SessionStore): () => void {
    for (const snapshot of observer.listSnapshots()) {
      this.lastObservedStates.set(snapshot.id, snapshot.state);
    }

    const onEvent = (event: ObserverEvent) => {
      const previous = this.lastObservedStates.get(event.subjectId);
      this.lastObservedStates.set(event.subjectId, event.state);
      if (!isNativeNotifyState(event.state) || previous === event.state) return;
      const state = event.state;

      const snapshot = observer.getSnapshot(event.subjectId);
      const sessionId = rowSessionIdFor(snapshot, event);
      if (!sessionId) return;

      void sessions
        .get(sessionId)
        .then((session) => {
          if (!session) return;
          this.native(
            nativeAgentNotification(session, state, event.summary, event.detail),
            () => this.activateSession(session.id)
          );
        })
        .catch((err) => this.opts.log?.('failed to resolve notification session', err));
    };

    observer.on('event', onEvent);
    return () => observer.off('event', onEvent);
  }

  private focusFirstWindow(): void {
    const win = this.opts.getWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) return;
    if (win.isMinimized()) win.restore();
    this.opts.focusApp?.();
    win.show();
    win.focus();
  }

  private activateSession(sessionId: SessionId): void {
    for (const win of this.opts.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IpcChannels.notify.activateSession, sessionId);
      }
    }
  }
}

function isNativeNotifyState(state: AgentObservedState): state is NativeNotifyState {
  return (
    state === 'waiting_for_input'
    || state === 'waiting_for_approval'
    || state === 'usage_limited'
    || state === 'completed'
    || state === 'failed'
  );
}

function rowSessionIdFor(
  snapshot: ObservedAgentSnapshot | null,
  event: ObserverEvent
): SessionId | null {
  if (snapshot?.subjectKind === 'worker') {
    return snapshot.originSessionId ?? snapshot.sessionId ?? null;
  }
  return snapshot?.sessionId ?? event.subjectId;
}

function nativeAgentNotification(
  session: Session,
  state: NativeNotifyState,
  summary: string,
  detail?: string
): NativeNotificationOptions {
  const sessionName = session.name || '(unnamed)';
  const body = shortBody(detail ?? summary);
  switch (state) {
    case 'waiting_for_approval':
      return { title: `${sessionName}: approval needed`, body };
    case 'waiting_for_input':
      return { title: `${sessionName}: input needed`, body };
    case 'usage_limited':
      return { title: `${sessionName}: usage limit reached`, body };
    case 'completed':
      return { title: `${sessionName}: done`, body };
    case 'failed':
      return { title: `${sessionName}: failed`, body };
  }
}

function shortBody(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}
