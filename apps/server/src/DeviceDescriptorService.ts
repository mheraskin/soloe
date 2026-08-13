import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { hostPlatform } from '@shared/platform.js';
import {
  SOLOE_DEVICE_PROTOCOL,
  parseDeviceDescriptor,
  type DeviceDescriptor,
  type DeviceId
} from '@shared/types/devices.js';

const BASE_CAPABILITIES = [
  'device.describe.v1',
  'device.snapshot.v1',
  'events.envelope.v1',
  'events.legacy.v1',
  'rpc.legacy.v1',
  'sessions.multi-device.v1',
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
] as const;

export interface DeviceDescriptorServiceOptions {
  deviceId: DeviceId;
  deviceName?: string;
  nodePlatform?: string;
  serviceVersion?: string;
  capabilities?: readonly string[];
  serverEpoch?: string;
}

export class DeviceDescriptorService {
  private readonly descriptor: DeviceDescriptor;

  constructor(options: DeviceDescriptorServiceOptions) {
    const features = [...new Set(options.capabilities ?? BASE_CAPABILITIES)].sort();
    const platform = hostPlatform(options.nodePlatform);
    const serviceVersion = options.serviceVersion?.trim() || '0.1.0';
    const capabilityRevision = createHash('sha256')
      .update(JSON.stringify({ features, platform, serviceVersion }))
      .digest('hex')
      .slice(0, 24);
    this.descriptor = parseDeviceDescriptor({
      schemaVersion: 1,
      deviceId: options.deviceId,
      name: options.deviceName?.trim() || hostname().trim() || 'Soloe Device',
      platform,
      serverEpoch: options.serverEpoch ?? randomUUID(),
      service: {
        name: 'soloe-server',
        version: serviceVersion
      },
      protocol: SOLOE_DEVICE_PROTOCOL,
      capabilities: {
        revision: capabilityRevision,
        features
      }
    });
  }

  describe(): DeviceDescriptor {
    return structuredClone(this.descriptor);
  }
}
