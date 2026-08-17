import type { AgentObservedState } from '@shared/types/sessions.js';

export type CursorEventKind =
  | 'lifecycle' | 'session_identity' | 'user' | 'assistant' | 'reasoning'
  | 'tool_call' | 'tool_result' | 'file_change' | 'command'
  | 'permission' | 'plan' | 'usage' | 'error' | 'completion' | 'interruption'
  | 'unknown';

export interface NormalizedCursorEvent {
  kind: CursorEventKind;
  state: AgentObservedState;
  sessionId?: string;
  toolCallId?: string;
  text?: string;
  raw: unknown;
}

export function normalizeCursorAcpMessage(raw: unknown): NormalizedCursorEvent {
  if (!isRecord(raw)) return event('unknown', 'working', raw);
  if (isRecord(raw.error)) {
    return event('error', 'failed', raw, { text: text(raw.error.message) ?? 'Cursor ACP error' });
  }
  const result = isRecord(raw.result) ? raw.result : null;
  const stopReason = result ? text(result.stopReason) : undefined;
  if (stopReason) {
    return stopReason === 'cancelled'
      ? event('interruption', 'idle', raw)
      : event(stopReason === 'end_turn' ? 'completion' : 'error', stopReason === 'end_turn' ? 'completed' : 'failed', raw, { text: stopReason });
  }
  if (raw.method === 'session/request_permission') {
    return event('permission', 'waiting_for_approval', raw, sessionFields(raw));
  }
  if (raw.method === 'cursor/ask_question') {
    return event('user', 'waiting_for_input', raw, sessionFields(raw));
  }
  if (raw.method === 'cursor/create_plan') return event('plan', 'waiting_for_input', raw, sessionFields(raw));
  if (raw.method === 'cursor/update_todos') return event('plan', 'working', raw, sessionFields(raw));
  if (raw.method === 'cursor/task') return event('tool_result', 'working', raw, sessionFields(raw));
  if (raw.method === 'cursor/generate_image') return event('file_change', 'working', raw, sessionFields(raw));
  if (raw.method !== 'session/update') return event('unknown', 'working', raw, sessionFields(raw));
  const params = isRecord(raw.params) ? raw.params : {};
  const update = isRecord(params.update) ? params.update : {};
  const base = { ...sessionFields(raw), text: contentText(update.content) };
  switch (update.sessionUpdate) {
    case 'user_message_chunk': return event('user', 'working', raw, base);
    case 'agent_message_chunk': return event('assistant', 'working', raw, base);
    case 'agent_thought_chunk': return event('reasoning', 'working', raw, base);
    case 'plan': return event('plan', 'working', raw, base);
    case 'available_commands_update': return event('command', 'working', raw, base);
    case 'current_mode_update':
    case 'config_option_update': return event('lifecycle', 'working', raw, base);
    case 'session_info_update': return event('session_identity', 'working', raw, base);
    case 'usage_update': return event('usage', 'working', raw, base);
    case 'tool_call': return toolEvent(update, raw, true, base);
    case 'tool_call_update': return toolEvent(update, raw, false, base);
    default: return event('unknown', 'working', raw, base);
  }
}

export function normalizeCursorStreamEvent(raw: unknown): NormalizedCursorEvent {
  if (!isRecord(raw)) return event('unknown', 'working', raw);
  const common = { sessionId: text(raw.session_id) };
  switch (raw.type) {
    case 'system': return event('session_identity', 'starting', raw, common);
    case 'user': return event('user', 'working', raw, { ...common, text: contentText(isRecord(raw.message) ? raw.message.content : undefined) });
    case 'assistant':
      if (raw.timestamp_ms === undefined || raw.model_call_id !== undefined) {
        return event('unknown', 'working', raw, common);
      }
      return event('assistant', 'working', raw, { ...common, text: contentText(isRecord(raw.message) ? raw.message.content : undefined) });
    case 'tool_call': {
      const completed = raw.subtype === 'completed';
      const serialized = JSON.stringify(raw.tool_call ?? '').toLowerCase();
      const fileChange = serialized.includes('writetoolcall');
      return event(fileChange ? 'file_change' : completed ? 'tool_result' : 'tool_call', completed ? 'working' : 'running_tool', raw, {
        ...common, toolCallId: text(raw.call_id)
      });
    }
    case 'result': return raw.is_error === true
      ? event('error', 'failed', raw, { ...common, text: text(raw.result) })
      : event('completion', 'completed', raw, { ...common, text: text(raw.result) });
    default: return event('unknown', 'working', raw);
  }
}

function toolEvent(update: Record<string, unknown>, raw: unknown, started: boolean, extra: Partial<NormalizedCursorEvent>): NormalizedCursorEvent {
  const status = text(update.status);
  const kind = text(update.kind);
  const terminal = status === 'completed' || status === 'failed';
  const operationKind: CursorEventKind = kind === 'edit' || kind === 'delete' || kind === 'move'
    ? 'file_change'
    : kind === 'execute' ? 'command'
      : 'tool_call';
  const normalizedKind: CursorEventKind = !started && terminal ? 'tool_result' : operationKind;
  return event(normalizedKind, terminal ? 'working' : 'running_tool', raw, {
    ...extra, toolCallId: text(update.toolCallId), text: text(update.title) ?? extra.text
  });
}

function sessionFields(raw: Record<string, unknown>): Partial<NormalizedCursorEvent> {
  const params = isRecord(raw.params) ? raw.params : {};
  return { sessionId: text(params.sessionId) };
}

function contentText(value: unknown): string | undefined {
  if (isRecord(value) && value.type === 'text') return text(value.text);
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('') || undefined;
  return undefined;
}

function event(kind: CursorEventKind, state: AgentObservedState, raw: unknown, extra: Partial<NormalizedCursorEvent> = {}): NormalizedCursorEvent {
  return { kind, state, raw, ...defined(extra) };
}

function defined(value: Partial<NormalizedCursorEvent>): Partial<NormalizedCursorEvent> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<NormalizedCursorEvent>;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
