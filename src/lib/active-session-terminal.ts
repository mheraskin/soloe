import type { TerminalRef } from '@shared/types/devices.js';
import type { AgentRuntimeProvider, Session } from '@shared/types/sessions.js';
import { worktreeScope, type WorktreeScope } from '@shared/worktree-identity.js';
import { deviceSessions } from '../stores/device-sessions.svelte';
import { sessions } from '../stores/sessions.svelte';
import { sendBracketedPaste, sendBracketedPasteWithInput } from './terminal-paste';

export interface ActiveSessionTerminal {
  session: Session;
  worktree: WorktreeScope;
  send(text: string, submit: boolean): Promise<void>;
}

function providerFor(session: Session): AgentRuntimeProvider | null {
  return session.currentAgentRuntime?.provider
    ?? (session.launch.type === 'agent' ? session.launch.provider : null);
}

export function activeSessionTerminal(): ActiveSessionTerminal | null {
  const projection = deviceSessions.selectedProjection;
  if (projection) {
    const terminalId = projection.runtime?.terminalId;
    if (!terminalId) return null;
    const terminalRef: TerminalRef = {
      deviceId: projection.ref.deviceId,
      terminalId
    };
    const session = projection.session;
    return {
      session,
      worktree: worktreeScope(session.cwd, {
        runMode: session.runMode,
        ...(session.wslDistro ? { wslDistro: session.wslDistro } : {}),
        deviceId: projection.ref.deviceId
      }),
      send: (text, submit) =>
        sendBracketedPasteWithInput(
          (data) => deviceSessions.terminalInput(terminalRef, data),
          text,
          submit,
          providerFor(session)
        )
    };
  }

  const session = sessions.selected;
  if (!session) return null;
  const terminalId = sessions.terminalIdFor(session.id);
  if (!terminalId) return null;
  return {
    session,
    worktree: worktreeScope(session.cwd, {
      runMode: session.runMode,
      ...(session.wslDistro ? { wslDistro: session.wslDistro } : {})
    }),
    send: (text, submit) =>
      sendBracketedPaste(terminalId, text, submit, sessions.providerFor(session.id))
  };
}
