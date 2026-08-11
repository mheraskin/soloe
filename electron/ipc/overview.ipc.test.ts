import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: never[]) => unknown>(),
  removeHandler: vi.fn()
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    }),
    removeHandler: electronMocks.removeHandler
  }
}));

import { IpcChannels } from '@shared/types/ipc.js';
import type { AskFollowUpRequest } from '@shared/types/overview.js';
import { OverviewIpc } from './overview.ipc.js';

const request: AskFollowUpRequest = {
  worktreeCwd: '/repo',
  runMode: 'windows',
  message: 'What changed?',
  history: []
};

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.removeHandler.mockClear();
});

describe('OverviewIpc stream ownership', () => {
  it('aborts the exact request when its renderer is destroyed', async () => {
    let signal: AbortSignal | undefined;
    const service = {
      streamFollowUp: vi.fn(async function* (
        _request: AskFollowUpRequest,
        requestSignal: AbortSignal
      ) {
        signal = requestSignal;
        await untilAborted(requestSignal);
      })
    };
    const ipc = new OverviewIpc({ service: service as never });
    ipc.register();
    const sender = new FakeSender();

    const started = await invoke(IpcChannels.overview.askStart, sender, request);
    expect(started).toMatchObject({ ok: true, value: { requestId: expect.any(String) } });
    await waitFor(() => signal !== undefined);

    sender.destroy();

    expect(signal!.aborted).toBe(true);
    await waitFor(() => sender.listenerCount('destroyed') === 0);
    ipc.dispose();
  });

  it('aborts an active request on cancel and aborts all owned requests on disposal', async () => {
    const signals: AbortSignal[] = [];
    const service = {
      streamFollowUp: vi.fn(async function* (
        _request: AskFollowUpRequest,
        signal: AbortSignal
      ) {
        signals.push(signal);
        await untilAborted(signal);
      })
    };
    const ipc = new OverviewIpc({ service: service as never });
    ipc.register();
    const firstSender = new FakeSender();
    const secondSender = new FakeSender();
    const first = await invoke(IpcChannels.overview.askStart, firstSender, request);
    const second = await invoke(IpcChannels.overview.askStart, secondSender, request);
    await waitFor(() => signals.length === 2);
    const firstRequestId = requestIdFrom(first);

    await invoke(IpcChannels.overview.askCancel, firstSender, firstRequestId);

    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);

    ipc.dispose();

    expect(signals[1]!.aborted).toBe(true);
    expect(firstSender.listenerCount('destroyed')).toBe(0);
    expect(secondSender.listenerCount('destroyed')).toBe(0);
  });
});

class FakeSender extends EventEmitter {
  destroy(): void {
    this.emit('destroyed');
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

async function invoke(channel: string, sender: FakeSender, payload: unknown): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler({ sender } as never, payload as never);
}

function requestIdFrom(result: unknown): string {
  if (!result || typeof result !== 'object' || !('value' in result)) {
    throw new Error('Missing IPC result value');
  }
  const value = result.value;
  if (!value || typeof value !== 'object' || !('requestId' in value)) {
    throw new Error('Missing request id');
  }
  return String(value.requestId);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('timed out waiting for predicate');
}
