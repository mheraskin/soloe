import { describe, expect, it, vi } from 'vitest';

import type { DeviceDescriptor, DeviceEventEnvelope } from '@shared/types/devices.js';
import {
  DeviceTransport,
  DeviceTransportIdentityError,
  type DeviceTransportRepairReason
} from './DeviceTransport.js';

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const SERVER_EPOCH = '33333333-3333-4333-8333-333333333333';

const DESCRIPTOR: DeviceDescriptor = {
  schemaVersion: 1,
  deviceId: DEVICE_ID,
  name: 'Alpha',
  platform: 'linux',
  serverEpoch: SERVER_EPOCH,
  service: { name: 'soloe-server', version: '0.1.0' },
  protocol: { current: 1, minimum: 1, maximum: 1 },
  capabilities: {
    revision: 'revision-1',
    features: ['device.describe.v1', 'device.snapshot.v1', 'events.envelope.v1']
  }
};

describe('DeviceTransport', () => {
  it('pins identity and accepts only attributable contiguous events', async () => {
    const socket = new FakeSocket();
    const socketFactory = vi.fn((_url: string) => socket);
    const transport = new DeviceTransport({
      endpoint: 'https://alpha.tail1234.ts.net',
      fetchImpl: descriptorFetch(DESCRIPTOR),
      socketFactory,
      expectedDeviceId: DEVICE_ID,
      clientId: 'test-client'
    });
    const events: DeviceEventEnvelope[] = [];
    const repairs: DeviceTransportRepairReason[] = [];
    transport.onEvent((event) => events.push(event.envelope));
    transport.onRepairRequired((reason) => repairs.push(reason));

    await expect(transport.connect()).resolves.toMatchObject({
      state: 'connected',
      connectionGeneration: 1,
      descriptor: DESCRIPTOR,
      compatibility: { status: 'compatible', negotiatedVersion: 1 }
    });
    expect(socketFactory).toHaveBeenCalledOnce();
    const socketUrl = new URL(socketFactory.mock.calls[0]![0]);
    expect(socketUrl.searchParams.get('eventFormat')).toBe('envelope-v1');
    expect(socketUrl.searchParams.get('clientId')).toBe('test-client');

    socket.message(envelope(1));
    socket.message(envelope(3));
    socket.message({ ...envelope(2), serverEpoch: OTHER_DEVICE_ID });

    expect(events).toEqual([envelope(1)]);
    expect(repairs).toEqual(['sequence-gap', 'server-epoch-changed']);
    expect(transport.status.lastSequence).toBe(1);
  });

  it('uses snapshot metadata as the event repair cursor', async () => {
    const socket = new FakeSocket();
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/device/describe') {
        return jsonResponse(DESCRIPTOR);
      }
      return jsonResponse({
        deviceId: DEVICE_ID,
        serverEpoch: SERVER_EPOCH,
        capturedAt: '2026-08-12T12:00:00.000Z',
        eventCursor: { serverEpoch: SERVER_EPOCH, sequence: 5 },
        value: { runningSessions: [] }
      });
    });
    const transport = new DeviceTransport({
      endpoint: 'https://alpha.tail1234.ts.net',
      fetchImpl,
      socketFactory: () => socket
    });
    const events: number[] = [];
    transport.onEvent((event) => events.push(event.envelope.sequence));

    await transport.connect();
    await expect(transport.snapshot<{ runningSessions: unknown[] }>()).resolves.toMatchObject({
      eventCursor: { sequence: 5 },
      value: { runningSessions: [] }
    });
    socket.message(envelope(6));

    expect(events).toEqual([6]);
    expect(transport.status.lastSequence).toBe(6);
  });

  it('rejects a changed pinned identity before opening an event socket', async () => {
    const socketFactory = vi.fn((_url: string) => new FakeSocket());
    const transport = new DeviceTransport({
      endpoint: 'https://alpha.tail1234.ts.net',
      fetchImpl: descriptorFetch({ ...DESCRIPTOR, deviceId: OTHER_DEVICE_ID }),
      socketFactory,
      expectedDeviceId: DEVICE_ID
    });

    await expect(transport.connect()).rejects.toBeInstanceOf(DeviceTransportIdentityError);
    expect(socketFactory).not.toHaveBeenCalled();
    expect(transport.status.state).toBe('disconnected');
  });

  it('disposes its socket and rejects later work', async () => {
    const socket = new FakeSocket();
    const transport = new DeviceTransport({
      endpoint: 'https://alpha.tail1234.ts.net',
      fetchImpl: descriptorFetch(DESCRIPTOR),
      socketFactory: () => socket
    });
    await transport.connect();

    transport.dispose();

    expect(socket.closed).toBe(true);
    expect(transport.status.state).toBe('disposed');
    await expect(transport.connect()).rejects.toThrow('disposed');
  });

  it('handles a socket error raised while closing a connecting event stream', async () => {
    const socket = new ErroringCloseSocket();
    const transport = new DeviceTransport({
      endpoint: 'https://alpha.tail1234.ts.net',
      fetchImpl: descriptorFetch(DESCRIPTOR),
      socketFactory: () => socket
    });
    await transport.connect();

    expect(() => transport.dispose()).not.toThrow();
    expect(transport.status.state).toBe('disposed');
  });
});

class ErroringCloseSocket {
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(event: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    const errorListeners = this.listeners.get('error') ?? [];
    if (errorListeners.length === 0) {
      throw new Error('WebSocket was closed before the connection was established');
    }
    for (const listener of errorListeners) listener({} as Event);
  }
}

class FakeSocket {
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();
  closed = false;

  addEventListener(event: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  close(): void {
    this.closed = true;
    this.emit('close', {} as Event);
  }

  message(value: unknown): void {
    this.emit('message', { data: JSON.stringify(value) } as MessageEvent);
  }

  private emit(event: string, value: Event): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function descriptorFetch(descriptor: DeviceDescriptor) {
  return async (): Promise<Response> => jsonResponse(descriptor);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

function envelope(sequence: number): DeviceEventEnvelope {
  return {
    event: 'sessions.changed',
    deviceId: DEVICE_ID,
    serverEpoch: SERVER_EPOCH,
    sequence,
    observedAt: '2026-08-12T12:00:00.000Z',
    payload: { revision: sequence }
  };
}
