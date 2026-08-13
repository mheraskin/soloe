import type { DeviceId } from './devices.js';

export type CommandId = string;
export type ClientId = string;

export type OperationState =
  | 'planned'
  | 'accepted'
  | 'running'
  | 'needs-attention'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface ExpectedCheckoutEvidence {
  checkoutId: string;
  generation: number;
  headOid: string | null;
  dirtyFingerprint: string;
}

export interface DeviceCommandEnvelope<TIntent = unknown> {
  schemaVersion: 1;
  clientId: ClientId;
  commandId: CommandId;
  targetDeviceId: DeviceId;
  actorClientId: string;
  expectedEntityVersions: Record<string, number>;
  expectedEvidence?: ExpectedCheckoutEvidence;
  capabilityRevision: string;
  planToken: string;
  planExpiresAt: string;
  intent: TIntent;
}

export interface DeviceOperationReceipt<TResult = unknown> {
  schemaVersion: 1;
  clientId: ClientId;
  commandId: CommandId;
  targetDeviceId: DeviceId;
  kind: string;
  intentDigest: string;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  result?: TResult;
  error?: { code: string; message: string };
}
