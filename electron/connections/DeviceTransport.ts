import { randomUUID } from 'node:crypto';

import {
  SOLOE_EVENT_FORMAT_V1,
  isDeviceId,
  parseDeviceEventEnvelope,
  type DeviceDescriptor,
  type DeviceEventEnvelope,
  type DeviceId,
  type DeviceProtocolCompatibility,
  type DeviceSnapshot
} from '@shared/types/devices.js';
import {
  describeSoloeEndpoint,
  type DescribeSoloeEndpointOptions,
  type FetchLike
} from './SoloeEndpointProbe.js';

const MAX_DEVICE_SNAPSHOT_BYTES = 4 * 1024 * 1024;

interface SocketLike {
  addEventListener(event: string, listener: (event: Event) => void): void;
  close(code?: number, reason?: string): void;
}

export type DeviceTransportRepairReason =
  | 'malformed-event'
  | 'identity-mismatch'
  | 'server-epoch-changed'
  | 'sequence-gap';

export interface DeviceTransportStatus {
  state: 'idle' | 'connecting' | 'connected' | 'disconnected' | 'disposed';
  connectionGeneration: number;
  descriptor: DeviceDescriptor | null;
  compatibility: DeviceProtocolCompatibility | null;
  lastSequence: number | null;
}

export interface AttributedDeviceEvent {
  connectionGeneration: number;
  envelope: DeviceEventEnvelope;
}

export interface DeviceTransportOptions {
  endpoint: string;
  fetchImpl: FetchLike;
  socketFactory?: (url: string) => SocketLike;
  token?: string;
  clientId?: string;
  expectedDeviceId?: DeviceId;
  bootstrapTailscale?: boolean;
}

export class DeviceTransport {
  private readonly endpoint: string;
  private readonly abortController = new AbortController();
  private readonly eventListeners = new Set<(event: AttributedDeviceEvent) => void>();
  private readonly statusListeners = new Set<(status: DeviceTransportStatus) => void>();
  private readonly repairListeners = new Set<(
    reason: DeviceTransportRepairReason,
    detail: string
  ) => void>();
  private socket: SocketLike | null = null;
  private state: DeviceTransportStatus['state'] = 'idle';
  private generation = 0;
  private descriptor: DeviceDescriptor | null = null;
  private compatibility: DeviceProtocolCompatibility | null = null;
  private lastSequence: number | null = null;

  constructor(private readonly options: DeviceTransportOptions) {
    this.endpoint = normalizeTransportEndpoint(options.endpoint);
  }

  get status(): DeviceTransportStatus {
    return this.statusSnapshot();
  }

  async connect(): Promise<DeviceTransportStatus> {
    this.assertActive();
    this.closeSocket();
    this.descriptor = null;
    this.compatibility = null;
    this.lastSequence = null;
    this.state = 'connecting';
    this.publishStatus();
    const describeOptions: DescribeSoloeEndpointOptions = {
      ...(this.options.token ? { token: this.options.token } : {}),
      ...(this.options.bootstrapTailscale ? { bootstrapTailscale: true } : {})
    };
    let described: Awaited<ReturnType<typeof describeSoloeEndpoint>>;
    try {
      described = await describeSoloeEndpoint(
        this.endpoint,
        (input, init) => this.options.fetchImpl(input, {
          ...init,
          signal: combineSignals(init?.signal, this.abortController.signal)
        }),
        describeOptions
      );
    } catch (error) {
      if (this.statusSnapshot().state !== 'disposed') {
        this.state = 'disconnected';
        this.publishStatus();
      }
      throw error;
    }
    this.assertActive();
    if (
      this.options.expectedDeviceId
      && described.descriptor.deviceId !== this.options.expectedDeviceId
    ) {
      this.state = 'disconnected';
      this.publishStatus();
      throw new DeviceTransportIdentityError(
        this.options.expectedDeviceId,
        described.descriptor.deviceId
      );
    }
    this.descriptor = described.descriptor;
    this.compatibility = described.compatibility;
    this.lastSequence = null;
    this.generation += 1;
    this.state = 'connected';
    if (described.compatibility.status === 'compatible') {
      this.openEventSocket();
    }
    this.publishStatus();
    return this.statusSnapshot();
  }

  async snapshot<T = unknown>(): Promise<DeviceSnapshot<T>> {
    this.assertActive();
    if (!this.descriptor) throw new Error('Connect the Device transport before requesting a snapshot.');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    const snapshotUrl = new URL('/api/device/snapshot', this.endpoint);
    if (this.options.clientId) snapshotUrl.searchParams.set('clientId', this.options.clientId);
    const response = await this.options.fetchImpl(
      snapshotUrl,
      {
        method: 'GET',
        cache: 'no-store',
        credentials: 'include',
        redirect: 'error',
        headers,
        signal: this.abortController.signal
      }
    );
    if (!response.ok) throw new Error(`Soloe Device snapshot returned HTTP ${response.status}.`);
    const text = await readBoundedResponse(response, MAX_DEVICE_SNAPSHOT_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('Soloe Device snapshot is not valid JSON.');
    }
    const snapshot = parseSnapshot<T>(value);
    if (snapshot.deviceId !== this.descriptor.deviceId) {
      throw new DeviceTransportIdentityError(this.descriptor.deviceId, snapshot.deviceId);
    }
    if (snapshot.serverEpoch !== this.descriptor.serverEpoch) {
      this.repair('server-epoch-changed', 'Snapshot server epoch differs from the handshake.');
      throw new Error('Soloe Device restarted during snapshot repair.');
    }
    this.lastSequence = snapshot.eventCursor.sequence;
    this.publishStatus();
    return snapshot;
  }

  onEvent(listener: (event: AttributedDeviceEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStatus(listener: (status: DeviceTransportStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onRepairRequired(
    listener: (reason: DeviceTransportRepairReason, detail: string) => void
  ): () => void {
    this.repairListeners.add(listener);
    return () => this.repairListeners.delete(listener);
  }

  disconnect(): void {
    if (this.state === 'disposed') return;
    this.closeSocket();
    this.state = 'disconnected';
    this.publishStatus();
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    this.abortController.abort();
    this.closeSocket();
    this.eventListeners.clear();
    this.repairListeners.clear();
    this.publishStatus();
    this.statusListeners.clear();
  }

  private openEventSocket(): void {
    const url = new URL('/api/runtime/events', this.endpoint);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('eventFormat', SOLOE_EVENT_FORMAT_V1);
    url.searchParams.set('clientId', this.options.clientId ?? `device-${randomUUID()}`);
    if (this.options.token) url.searchParams.set('token', this.options.token);
    const socket = (this.options.socketFactory ?? defaultSocketFactory)(url.toString());
    this.socket = socket;
    socket.addEventListener('message', (rawEvent) => {
      if (this.socket !== socket || this.state !== 'connected') return;
      this.receiveEvent(rawEvent as MessageEvent);
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket || this.state === 'disposed') return;
      this.socket = null;
      this.state = 'disconnected';
      this.publishStatus();
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.state === 'disposed') return;
      this.socket = null;
      this.state = 'disconnected';
      this.publishStatus();
    });
  }

  private receiveEvent(rawEvent: MessageEvent): void {
    let event: DeviceEventEnvelope;
    try {
      event = parseDeviceEventEnvelope(JSON.parse(String(rawEvent.data)));
    } catch (error) {
      this.repair(
        'malformed-event',
        error instanceof Error ? error.message : 'Device event could not be parsed.'
      );
      return;
    }
    if (!this.descriptor || event.deviceId !== this.descriptor.deviceId) {
      this.repair('identity-mismatch', 'Event Device identity differs from the handshake.');
      return;
    }
    if (event.serverEpoch !== this.descriptor.serverEpoch) {
      this.repair('server-epoch-changed', 'Event server epoch differs from the handshake.');
      return;
    }
    if (this.lastSequence !== null && event.sequence !== this.lastSequence + 1) {
      this.repair(
        'sequence-gap',
        `Expected Device event ${this.lastSequence + 1}, received ${event.sequence}.`
      );
      return;
    }
    this.lastSequence = event.sequence;
    this.publishStatus();
    const attributed = {
      connectionGeneration: this.generation,
      envelope: event
    };
    for (const listener of this.eventListeners) {
      try {
        listener(attributed);
      } catch {
        // One projection consumer must not block the others.
      }
    }
  }

  private repair(reason: DeviceTransportRepairReason, detail: string): void {
    for (const listener of this.repairListeners) {
      try {
        listener(reason, detail);
      } catch {
        // Repair remains observable to other consumers.
      }
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, 'device transport closed');
  }

  private publishStatus(): void {
    const status = this.statusSnapshot();
    for (const listener of this.statusListeners) {
      try {
        listener(status);
      } catch {
        // Status listener failures do not own transport lifecycle.
      }
    }
  }

  private statusSnapshot(): DeviceTransportStatus {
    return {
      state: this.state,
      connectionGeneration: this.generation,
      descriptor: this.descriptor ? structuredClone(this.descriptor) : null,
      compatibility: this.compatibility ? { ...this.compatibility } : null,
      lastSequence: this.lastSequence
    };
  }

  private assertActive(): void {
    if (this.state === 'disposed') throw new Error('Device transport is disposed.');
  }
}

export class DeviceTransportIdentityError extends Error {
  readonly code = 'device_identity_mismatch';

  constructor(
    readonly expectedDeviceId: DeviceId,
    readonly observedDeviceId: DeviceId
  ) {
    super(`Expected Device ${expectedDeviceId}, received ${observedDeviceId}.`);
    this.name = 'DeviceTransportIdentityError';
  }
}

function normalizeTransportEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:')
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('Device transport endpoint must be a trusted HTTP(S) root.');
  }
  if (
    url.protocol === 'http:'
    && url.hostname !== 'localhost'
    && url.hostname !== '127.0.0.1'
    && url.hostname !== '[::1]'
  ) {
    throw new Error('Unencrypted Device transport endpoints are limited to loopback.');
  }
  url.pathname = '';
  return url.origin;
}

function defaultSocketFactory(url: string): SocketLike {
  return new WebSocket(url);
}

function combineSignals(first: AbortSignal | null | undefined, second: AbortSignal): AbortSignal {
  return first ? AbortSignal.any([first, second]) : second;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error('Soloe Device snapshot is too large.');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function parseSnapshot<T>(value: unknown): DeviceSnapshot<T> {
  if (!isRecord(value) || !isRecord(value['eventCursor'])) {
    throw new Error('Soloe Device snapshot metadata is invalid.');
  }
  const deviceId = value['deviceId'];
  const serverEpoch = value['serverEpoch'];
  const capturedAt = value['capturedAt'];
  const cursorEpoch = value['eventCursor']['serverEpoch'];
  const sequence = value['eventCursor']['sequence'];
  if (
    !isDeviceId(deviceId)
    || !isDeviceId(serverEpoch)
    || typeof capturedAt !== 'string'
    || !Number.isFinite(Date.parse(capturedAt))
    || cursorEpoch !== serverEpoch
    || !Number.isSafeInteger(sequence)
    || (sequence as number) < 0
    || !Object.prototype.hasOwnProperty.call(value, 'value')
  ) {
    throw new Error('Soloe Device snapshot metadata is invalid.');
  }
  return {
    deviceId,
    serverEpoch,
    capturedAt,
    eventCursor: { serverEpoch, sequence: sequence as number },
    value: value['value'] as T
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
