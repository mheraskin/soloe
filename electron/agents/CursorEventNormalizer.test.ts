import { describe, expect, it } from 'vitest';
import { normalizeCursorAcpMessage, normalizeCursorStreamEvent } from './CursorEventNormalizer.js';

describe('CursorEventNormalizer', () => {
  it.each([
    ['agent_message_chunk', 'assistant'],
    ['user_message_chunk', 'user'],
    ['agent_thought_chunk', 'reasoning'],
    ['plan', 'plan'],
    ['available_commands_update', 'command'],
    ['current_mode_update', 'lifecycle'],
    ['config_option_update', 'lifecycle'],
    ['session_info_update', 'session_identity'],
    ['usage_update', 'usage']
  ] as const)('normalizes ACP %s updates', (sessionUpdate, kind) => {
    expect(normalizeCursorAcpMessage({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'chat-1', update: { sessionUpdate, content: { type: 'text', text: 'hello' } } }
    })).toMatchObject({ kind, sessionId: 'chat-1' });
  });

  it.each([
    ['read', 'tool_call'],
    ['edit', 'file_change'],
    ['delete', 'file_change'],
    ['move', 'file_change'],
    ['execute', 'command']
  ] as const)('classifies ACP %s tool calls', (toolKind, kind) => {
    expect(normalizeCursorAcpMessage({
      jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: 'chat-1', update: {
        sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'work',
        kind: toolKind, status: 'in_progress'
      } }
    })).toMatchObject({ kind, state: 'running_tool', toolCallId: 'call-1' });
  });

  it('normalizes tool results, errors, permissions, completion, and interruption', () => {
    expect(normalizeCursorAcpMessage({ method: 'session/update', params: {
      sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' }
    } })).toMatchObject({ kind: 'tool_result', state: 'working' });
    expect(normalizeCursorAcpMessage({ id: 2, error: { code: -32603, message: 'boom' } }))
      .toMatchObject({ kind: 'error', state: 'failed', text: 'boom' });
    expect(normalizeCursorAcpMessage({ id: 3, method: 'session/request_permission', params: { sessionId: 's' } }))
      .toMatchObject({ kind: 'permission', state: 'waiting_for_approval' });
    expect(normalizeCursorAcpMessage({ id: 4, result: { stopReason: 'end_turn' } }))
      .toMatchObject({ kind: 'completion', state: 'completed' });
    expect(normalizeCursorAcpMessage({ id: 5, result: { stopReason: 'cancelled' } }))
      .toMatchObject({ kind: 'interruption', state: 'idle' });
  });

  it('keeps non-terminal ACP tool updates in the running-tool lifecycle', () => {
    expect(normalizeCursorAcpMessage({ method: 'session/update', params: {
      sessionId: 's', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'in_progress'
      }
    } })).toMatchObject({ kind: 'tool_call', state: 'running_tool' });
    expect(normalizeCursorAcpMessage({ method: 'session/update', params: {
      sessionId: 's', update: {
        sessionUpdate: 'tool_call_update', toolCallId: 'c', kind: 'edit', status: 'failed'
      }
    } })).toMatchObject({ kind: 'tool_result', state: 'working' });
  });

  it.each([
    [{ type: 'system', subtype: 'init', session_id: 's1' }, 'session_identity'],
    [{ type: 'user', session_id: 's1', message: { content: [{ type: 'text', text: 'hi' }] } }, 'user'],
    [{ type: 'assistant', timestamp_ms: 1, session_id: 's1', message: { content: [{ type: 'text', text: 'ok' }] } }, 'assistant'],
    [{ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: { readToolCall: {} } }, 'tool_call'],
    [{ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: { writeToolCall: {} } }, 'file_change'],
    [{ type: 'result', subtype: 'success', result: 'done', session_id: 's1' }, 'completion']
  ] as const)('normalizes documented stream-json event %#', (raw, kind) => {
    expect(normalizeCursorStreamEvent(raw)).toMatchObject({ kind });
  });

  it('preserves unknown forward-compatible events without guessing semantics', () => {
    const raw = { type: 'future', value: 1 };
    expect(normalizeCursorStreamEvent(raw)).toEqual({ kind: 'unknown', state: 'working', raw });
  });

  it('suppresses documented duplicate partial assistant flushes', () => {
    expect(normalizeCursorStreamEvent({
      type: 'assistant', timestamp_ms: 1, model_call_id: 'call', message: { content: [] }
    }).kind).toBe('unknown');
    expect(normalizeCursorStreamEvent({
      type: 'assistant', message: { content: [{ type: 'text', text: 'final duplicate' }] }
    }).kind).toBe('unknown');
  });
});
