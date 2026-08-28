import { describe, expect, it, vi } from 'vitest';
import type { SessionHookTraceEvent } from '@shared/types/session-debug.js';
import { SessionHookTraceBuffer } from './SessionHookTraceBuffer.js';

function received(id: string): SessionHookTraceEvent {
  return {
    kind: 'hook_received',
    id,
    requestId: `request-${id}`,
    timestamp: `2026-08-28T00:00:0${id}.000Z`,
    provider: 'codex',
    sessionId: 'session-1',
    hookName: 'PreCompact',
    integrationVersion: '19',
    rawBody: '{"hook_event_name":"PreCompact"}',
    payload: { hook_event_name: 'PreCompact' },
    dispatchable: true
  };
}

describe('SessionHookTraceBuffer', () => {
  it('records and publishes only while enabled', () => {
    const buffer = new SessionHookTraceBuffer();
    const listener = vi.fn();
    buffer.onEvent(listener);

    buffer.append(received('1'));
    buffer.setEnabled(true);
    buffer.append(received('2'));

    expect(buffer.list()).toEqual([received('2')]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('keeps a bounded chronological trace and clears it', () => {
    const buffer = new SessionHookTraceBuffer(2);
    buffer.setEnabled(true);
    buffer.append(received('1'));
    buffer.append(received('2'));
    buffer.append(received('3'));

    expect(buffer.list().map((event) => event.id)).toEqual(['2', '3']);
    expect(buffer.list(1).map((event) => event.id)).toEqual(['3']);

    buffer.clear();
    expect(buffer.list()).toEqual([]);
  });

  it('evicts old payloads when the byte budget is exhausted', () => {
    const first = received('1');
    const bytes = Buffer.byteLength(JSON.stringify(first), 'utf8');
    const buffer = new SessionHookTraceBuffer(10, bytes + 1);
    buffer.setEnabled(true);
    buffer.append(first);
    buffer.append(received('2'));

    expect(buffer.list().map((event) => event.id)).toEqual(['2']);
  });
});
