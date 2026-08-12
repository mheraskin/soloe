import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SupportedHostPlatform } from '@shared/platform.js';
import {
  SOLOE_DEVICE_PROTOCOL,
  isDeviceId,
  parseDeviceDescriptor,
  type DeviceDescriptor,
  type DeviceId
} from '@shared/types/devices.js';

interface PersistedLegacyLocalIdentity {
  version: 1;
  deviceId: DeviceId;
  createdAt: string;
}

export async function loadLegacyLocalDeviceDescriptor(options: {
  dataDirectory: string;
  name: string;
  platform: SupportedHostPlatform;
  serviceVersion?: string;
}): Promise<DeviceDescriptor> {
  const identity = await loadOrCreateIdentity(options.dataDirectory);
  const features = [
    'cockpit.local-adapter.v1',
    'device.snapshot.v1',
    'events.envelope.v1',
    'runtime.sessions.v1',
    'runtime.terminal-input-lease.v1',
    'runtime.terminal-replay.v1',
    'workspace-device.v1',
    'workspace-placement-plan.v1',
    'workspace-alignment-plan.v1',
    'workspace-isolated-source-lifecycle.v1',
    'workspace-operation-receipts.v1',
    'git.remote-transport.v1',
    'github-provider-plan.v1'
  ];
  const version = options.serviceVersion ?? '0.1.0';
  const revision = createHash('sha256')
    .update(JSON.stringify({ features, platform: options.platform, version }))
    .digest('hex')
    .slice(0, 24);
  return parseDeviceDescriptor({
    schemaVersion: 1,
    deviceId: identity.deviceId,
    name: options.name,
    platform: options.platform,
    serverEpoch: randomUUID(),
    service: { name: 'soloe-server', version },
    protocol: SOLOE_DEVICE_PROTOCOL,
    capabilities: { revision, features }
  });
}

async function loadOrCreateIdentity(dataDirectory: string): Promise<PersistedLegacyLocalIdentity> {
  await fs.mkdir(dataDirectory, { recursive: true });
  const file = path.join(dataDirectory, 'device-identity.json');
  try {
    return parseIdentity(JSON.parse(await fs.readFile(file, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const identity: PersistedLegacyLocalIdentity = {
    version: 1,
    deviceId: randomUUID(),
    createdAt: new Date().toISOString()
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(identity, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return parseIdentity(JSON.parse(await fs.readFile(file, 'utf8')));
  }
}

function parseIdentity(value: unknown): PersistedLegacyLocalIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Legacy local Device identity is corrupt.');
  }
  const record = value as Record<string, unknown>;
  if (
    record['version'] !== 1
    || !isDeviceId(record['deviceId'])
    || typeof record['createdAt'] !== 'string'
    || !Number.isFinite(Date.parse(record['createdAt']))
  ) {
    throw new Error('Legacy local Device identity is corrupt.');
  }
  return {
    version: 1,
    deviceId: record['deviceId'],
    createdAt: record['createdAt']
  };
}
