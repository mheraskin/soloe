import type { IpcResult } from '@shared/types/ipc.js';
import type { SessionDraft, SessionId, SessionUpdate } from '@shared/types/sessions.js';
import type {
  TerminalExitEvent,
  TerminalId,
  TerminalOutputEvent,
  TerminalStartOptions,
  TerminalStatusEvent
} from '@shared/types/terminal.js';

function unwrap<T>(r: IpcResult<T>): T {
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const c = window.cockpit;

export const ipc = {
  sessions: {
    list: async () => unwrap(await c.sessions.list()),
    get: async (id: SessionId) => unwrap(await c.sessions.get(id)),
    create: async (draft: SessionDraft) => unwrap(await c.sessions.create(draft)),
    update: async (id: SessionId, patch: SessionUpdate) => unwrap(await c.sessions.update(id, patch)),
    delete: async (id: SessionId) => unwrap(await c.sessions.delete(id)),
    previewCommand: async (id: SessionId) => unwrap(await c.sessions.previewCommand(id))
  },
  terminal: {
    start: async (opts: TerminalStartOptions) => unwrap(await c.terminal.start(opts)),
    stop: async (terminalId: TerminalId) => unwrap(await c.terminal.stop(terminalId)),
    restart: async (sessionId: SessionId, opts?: { cols?: number; rows?: number }) =>
      unwrap(await c.terminal.restart(sessionId, opts)),
    input: async (terminalId: TerminalId, data: string) =>
      unwrap(await c.terminal.input({ terminalId, data })),
    resize: async (terminalId: TerminalId, cols: number, rows: number) =>
      unwrap(await c.terminal.resize({ terminalId, dimensions: { cols, rows } })),
    listRunning: async () => unwrap(await c.terminal.listRunning()),
    onOutput: (cb: (event: TerminalOutputEvent) => void) => c.terminal.onOutput(cb),
    onExit: (cb: (event: TerminalExitEvent) => void) => c.terminal.onExit(cb),
    onStatus: (cb: (event: TerminalStatusEvent) => void) => c.terminal.onStatus(cb)
  },
  system: {
    openPath: async (sessionId: SessionId) => unwrap(await c.system.openPath(sessionId))
  }
};
