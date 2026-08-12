import type { DeviceId } from './devices.js';

export type CommandId = string;
export type CockpitId = string;
export type PlanId = string;
export type OperationId = string;

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
  cockpitId: CockpitId;
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
  cockpitId: CockpitId;
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

export interface CockpitPlan<TIntent = unknown, TPreview = unknown> {
  schemaVersion: 1;
  planId: PlanId;
  kind: string;
  intent: TIntent;
  preview: TPreview;
  acknowledgements: Array<{ id: string; label: string; required: boolean }>;
  executable: boolean;
  blockers: string[];
  warnings: string[];
  createdAt: string;
  expiresAt: string;
}

export interface CockpitOperation<TResult = unknown> {
  schemaVersion: 1;
  operationId: OperationId;
  planId: PlanId;
  kind: string;
  state: OperationState;
  phase: string;
  progress: number;
  message: string;
  childCommands: Array<{ deviceId: DeviceId; commandId: CommandId }>;
  createdAt: string;
  updatedAt: string;
  result?: TResult;
}
