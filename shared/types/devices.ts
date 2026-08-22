import type { SupportedHostPlatform } from '../platform.js';

export type DeviceId = string;
export type ServerEpoch = string;

export interface DeviceRef {
  deviceId: DeviceId;
}

export interface SessionRef extends DeviceRef {
  sessionId: string;
}

export interface TerminalRef extends DeviceRef {
  terminalId: string;
}

export interface DevicePortForwardResult {
  deviceId: DeviceId;
  state:
    | 'ready'
    | 'unavailable'
    | 'not-running'
    | 'setup-required'
    | 'conflict'
    | 'error';
  dnsName: string | null;
  /** IPv4 address used to preserve virtual-host subdomains through wildcard DNS. */
  ipAddress?: string | null;
  /** Original development-server port when `port` is a Soloe proxy listener. */
  targetPort?: number;
  /** Host header restored by a Soloe browser-route proxy. */
  virtualHostname?: string;
  port: number;
  forwarded: boolean;
  message: string | null;
  setupUrl: string | null;
}

export interface RepositoryRef extends DeviceRef {
  repositoryId: string;
}

export interface CheckoutRef extends DeviceRef {
  checkoutId: string;
}

export interface DeviceProtocolRange {
  current: number;
  minimum: number;
  maximum: number;
}

export interface DeviceCapabilitySnapshot {
  revision: string;
  features: string[];
}

export interface DeviceDescriptor {
  schemaVersion: 1;
  deviceId: DeviceId;
  name: string;
  platform: SupportedHostPlatform;
  serverEpoch: ServerEpoch;
  service: {
    name: 'soloe-server';
    version: string;
  };
  protocol: DeviceProtocolRange;
  capabilities: DeviceCapabilitySnapshot;
}

export interface DeviceEventEnvelope<T = unknown> {
  event: string;
  deviceId: DeviceId;
  serverEpoch: ServerEpoch;
  sequence: number;
  entityRef?: string;
  entityVersion?: number;
  commandId?: string;
  observedAt: string;
  payload: T;
}

export interface DeviceSnapshot<T = unknown> {
  deviceId: DeviceId;
  serverEpoch: ServerEpoch;
  capturedAt: string;
  eventCursor: {
    serverEpoch: ServerEpoch;
    sequence: number;
  };
  value: T;
}

export const SOLOE_DEVICE_PROTOCOL = Object.freeze({
  current: 1,
  minimum: 1,
  maximum: 1
} satisfies DeviceProtocolRange);

export const SOLOE_EVENT_FORMAT_V1 = 'envelope-v1' as const;
export const MAX_DEVICE_DESCRIPTOR_BYTES = 32 * 1024;

export type DeviceProtocolCompatibility =
  | {
      status: 'compatible';
      negotiatedVersion: number;
    }
  | {
      status: 'device-upgrade-required';
      negotiatedVersion: null;
    }
  | {
      status: 'client-upgrade-required';
      negotiatedVersion: null;
    };

export function negotiateDeviceProtocol(
  device: DeviceProtocolRange,
  client: DeviceProtocolRange = SOLOE_DEVICE_PROTOCOL
): DeviceProtocolCompatibility {
  assertProtocolRange(device, 'Device');
  assertProtocolRange(client, 'Client');
  if (device.maximum < client.minimum) {
    return { status: 'device-upgrade-required', negotiatedVersion: null };
  }
  if (device.minimum > client.maximum) {
    return { status: 'client-upgrade-required', negotiatedVersion: null };
  }
  return {
    status: 'compatible',
    negotiatedVersion: Math.min(device.maximum, client.maximum)
  };
}

export function parseDeviceDescriptor(value: unknown): DeviceDescriptor {
  if (!isRecord(value) || value['schemaVersion'] !== 1) {
    throw new Error('Device descriptor has an unsupported schema version.');
  }
  const deviceId = requiredUuid(value['deviceId'], 'deviceId');
  const name = requiredBoundedString(value['name'], 'name', 128);
  const platform = value['platform'];
  if (platform !== 'windows' && platform !== 'linux' && platform !== 'macos') {
    throw new Error('Device descriptor platform is invalid.');
  }
  const serverEpoch = requiredUuid(value['serverEpoch'], 'serverEpoch');

  const serviceValue = value['service'];
  if (!isRecord(serviceValue) || serviceValue['name'] !== 'soloe-server') {
    throw new Error('Device descriptor service is invalid.');
  }
  const serviceVersion = requiredBoundedString(serviceValue['version'], 'service.version', 64);

  const protocolValue = value['protocol'];
  if (!isRecord(protocolValue)) throw new Error('Device descriptor protocol is invalid.');
  const protocol: DeviceProtocolRange = {
    current: requiredProtocolVersion(protocolValue['current'], 'protocol.current'),
    minimum: requiredProtocolVersion(protocolValue['minimum'], 'protocol.minimum'),
    maximum: requiredProtocolVersion(protocolValue['maximum'], 'protocol.maximum')
  };
  assertProtocolRange(protocol, 'Device');

  const capabilitiesValue = value['capabilities'];
  if (!isRecord(capabilitiesValue)) {
    throw new Error('Device descriptor capabilities are invalid.');
  }
  const revision = requiredBoundedString(
    capabilitiesValue['revision'],
    'capabilities.revision',
    128
  );
  if (!/^[a-zA-Z0-9._:-]+$/u.test(revision)) {
    throw new Error('Device descriptor capability revision is invalid.');
  }
  if (!Array.isArray(capabilitiesValue['features']) || capabilitiesValue['features'].length > 128) {
    throw new Error('Device descriptor capability features are invalid.');
  }
  const features = capabilitiesValue['features'].map((feature, index) => {
    const parsed = requiredBoundedString(feature, `capabilities.features[${index}]`, 128);
    if (!/^[a-z][a-z0-9.-]*$/u.test(parsed)) {
      throw new Error(`Device descriptor capability feature ${index} is invalid.`);
    }
    return parsed;
  });
  if (new Set(features).size !== features.length) {
    throw new Error('Device descriptor capability features must be unique.');
  }

  return {
    schemaVersion: 1,
    deviceId,
    name,
    platform,
    serverEpoch,
    service: { name: 'soloe-server', version: serviceVersion },
    protocol,
    capabilities: { revision, features }
  };
}

export function parseDeviceEventEnvelope(value: unknown): DeviceEventEnvelope {
  if (!isRecord(value)) throw new Error('Device event envelope is invalid.');
  const event = requiredBoundedString(value['event'], 'event.event', 128);
  if (!/^[a-z][a-zA-Z0-9.-]*$/u.test(event)) {
    throw new Error('Device event envelope event is invalid.');
  }
  const deviceId = requiredUuid(value['deviceId'], 'event.deviceId');
  const serverEpoch = requiredUuid(value['serverEpoch'], 'event.serverEpoch');
  const sequence = value['sequence'];
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new Error('Device event envelope sequence is invalid.');
  }
  const observedAt = value['observedAt'];
  if (
    typeof observedAt !== 'string'
    || !observedAt.trim()
    || !Number.isFinite(Date.parse(observedAt))
  ) {
    throw new Error('Device event envelope observedAt is invalid.');
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'payload')) {
    throw new Error('Device event envelope payload is missing.');
  }
  const entityRef = optionalBoundedString(value['entityRef'], 'event.entityRef', 512);
  const entityVersion = value['entityVersion'];
  if (
    entityVersion !== undefined
    && (!Number.isSafeInteger(entityVersion) || (entityVersion as number) < 0)
  ) {
    throw new Error('Device event envelope entityVersion is invalid.');
  }
  const commandId = optionalBoundedString(value['commandId'], 'event.commandId', 128);
  return {
    event,
    deviceId,
    serverEpoch,
    sequence: sequence as number,
    ...(entityRef ? { entityRef } : {}),
    ...(entityVersion !== undefined ? { entityVersion: entityVersion as number } : {}),
    ...(commandId ? { commandId } : {}),
    observedAt,
    payload: value['payload']
  };
}

export function isDeviceId(value: unknown): value is DeviceId {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function requiredUuid(value: unknown, field: string): string {
  if (!isDeviceId(value)) throw new Error(`Device descriptor ${field} is invalid.`);
  return value;
}

function requiredBoundedString(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new Error(`Device descriptor ${field} is invalid.`);
  const result = value.trim();
  if (!result || result.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new Error(`Device descriptor ${field} is invalid.`);
  }
  return result;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maximumLength: number
): string | undefined {
  if (value === undefined) return undefined;
  return requiredBoundedString(value, field, maximumLength);
}

function requiredProtocolVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new Error(`Device descriptor ${field} is invalid.`);
  }
  return value as number;
}

function assertProtocolRange(range: DeviceProtocolRange, owner: string): void {
  for (const value of [range.minimum, range.current, range.maximum]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`${owner} protocol range is invalid.`);
    }
  }
  if (range.minimum > range.current || range.current > range.maximum) {
    throw new Error(`${owner} protocol range is invalid.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
