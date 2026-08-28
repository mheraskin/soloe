export type SessionHookProvider =
  | 'claude_code'
  | 'codex'
  | 'cursor'
  | 'opencode'
  | 'grok_build';

interface SessionHookTraceBase {
  id: string;
  requestId: string;
  timestamp: string;
  provider: SessionHookProvider;
  sessionId: string | null;
  hookName: string | null;
  integrationVersion: string | null;
}

export type SessionHookTraceEvent =
  | SessionHookTraceBase & {
      kind: 'hook_received';
      rawBody: string;
      payload: unknown;
      dispatchable: boolean;
    }
  | SessionHookTraceBase & {
      kind: 'hook_rejected';
      reason: 'unauthorized' | 'missing_session_id' | 'invalid_json';
      rawBody: string | null;
    }
  | SessionHookTraceBase & {
      kind: 'hook_dispatch_started' | 'hook_dispatch_completed';
    }
  | SessionHookTraceBase & {
      kind: 'hook_dispatch_failed';
      error: string;
    };

export interface ListSessionHookTraceRequest {
  limit?: number;
}
