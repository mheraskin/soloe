import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { DeviceCommandEnvelope, DeviceOperationReceipt } from '@shared/types/commands.js';
import { isDeviceId, type DeviceId } from '@shared/types/devices.js';
import type {
  CreatedGitHubRepository,
  CreateGitHubRepositoryIntent,
  GitHubOwner,
  GitHubProviderStatus,
  GitHubRepositoryPlan
} from '@shared/types/providers.js';
import type { DeviceOperationStore } from '../../workspaces/DeviceOperationStore.js';

const DEFAULT_PLAN_TTL_MS = 5 * 60_000;

export interface GitHubProviderAdapter {
  status(): Promise<GitHubProviderStatus>;
  listOwners(): Promise<GitHubOwner[]>;
  repositoryExists(owner: string, name: string): Promise<boolean>;
  createRepository(intent: CreateGitHubRepositoryIntent): Promise<CreatedGitHubRepository>;
}

export interface GitHubProviderServiceOptions {
  deviceId: DeviceId;
  capabilityRevision: string;
  operations: DeviceOperationStore;
  adapter: GitHubProviderAdapter;
  now?: () => Date;
  planTtlMs?: number;
}

export class GitHubProviderService {
  private readonly plans = new Map<string, GitHubRepositoryPlan>();
  private readonly now: () => Date;
  private readonly planTtlMs: number;

  constructor(private readonly options: GitHubProviderServiceOptions) {
    if (!isDeviceId(options.deviceId)) throw new Error('GitHub Provider Device ID is invalid.');
    if (!options.capabilityRevision.trim()) throw new Error('GitHub Provider capability revision is required.');
    this.now = options.now ?? (() => new Date());
    this.planTtlMs = options.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
  }

  async plan(intent: CreateGitHubRepositoryIntent): Promise<GitHubRepositoryPlan> {
    const normalized = normalizeIntent(intent);
    const [status, owners] = await Promise.all([
      this.options.adapter.status(),
      this.options.adapter.listOwners().catch(() => [])
    ]);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (!status.available) blockers.push(status.error ?? 'GitHub CLI is unavailable on this Device.');
    else if (!status.authenticated) blockers.push(status.error ?? 'GitHub authentication is required on this Device.');
    if (!owners.some((owner) => owner.login.toLowerCase() === normalized.owner.toLowerCase())) {
      blockers.push(`GitHub owner ${normalized.owner} is not available to this Device identity.`);
    }
    if (status.authenticated && await this.options.adapter.repositoryExists(
      normalized.owner,
      normalized.name
    )) blockers.push(`GitHub repository ${normalized.owner}/${normalized.name} already exists.`);
    if (normalized.visibility === 'public') {
      warnings.push('This repository will be publicly visible on GitHub.');
    }
    const createdAt = this.now();
    const planId = randomUUID();
    const plan: GitHubRepositoryPlan = {
      schemaVersion: 1,
      planId,
      planToken: `${planId}.${randomBytes(24).toString('base64url')}`,
      targetDeviceId: this.options.deviceId,
      capabilityRevision: this.options.capabilityRevision,
      intent: normalized,
      executable: blockers.length === 0,
      blockers,
      warnings,
      preview: {
        owner: normalized.owner,
        name: normalized.name,
        visibility: normalized.visibility,
        url: `https://github.com/${encodeURIComponent(normalized.owner)}/${encodeURIComponent(normalized.name)}`
      },
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.planTtlMs).toISOString()
    };
    this.remember(plan);
    return structuredClone(plan);
  }

  status(): Promise<GitHubProviderStatus> {
    return this.options.adapter.status();
  }

  listOwners(): Promise<GitHubOwner[]> {
    return this.options.adapter.listOwners();
  }

  getCommand(clientId: string, commandId: string): DeviceOperationReceipt | null {
    return this.options.operations.get(clientId, commandId);
  }

  async execute(
    command: DeviceCommandEnvelope<CreateGitHubRepositoryIntent>
  ): Promise<DeviceOperationReceipt<CreatedGitHubRepository>> {
    const prior = this.options.operations.get(command.clientId, command.commandId);
    if (prior) {
      return this.options.operations.execute(
        command,
        command.intent.kind,
        async () => { throw new Error('A recorded provider command must not repeat effects.'); }
      ) as Promise<DeviceOperationReceipt<CreatedGitHubRepository>>;
    }
    const plan = this.plans.get(command.planToken);
    if (!plan) throw new Error('GitHub repository plan is unknown or expired.');
    if (this.now().getTime() > Date.parse(plan.expiresAt)) {
      this.plans.delete(command.planToken);
      throw new Error('GitHub repository plan expired; run preflight again.');
    }
    if (!plan.executable) throw new Error(plan.blockers.join(' '));
    if (
      command.targetDeviceId !== plan.targetDeviceId
      || command.capabilityRevision !== plan.capabilityRevision
      || command.planExpiresAt !== plan.expiresAt
      || !isDeepStrictEqual(command.intent, plan.intent)
    ) throw new Error('GitHub command does not match its immutable plan.');
    const receipt = await this.options.operations.execute(
      command,
      command.intent.kind,
      () => this.options.adapter.createRepository(structuredClone(command.intent))
    );
    this.plans.delete(plan.planToken);
    return receipt;
  }

  private remember(plan: GitHubRepositoryPlan): void {
    for (const [token, previous] of this.plans) {
      if (this.now().getTime() > Date.parse(previous.expiresAt)) this.plans.delete(token);
    }
    if (this.plans.size >= 1_000) {
      const oldest = [...this.plans.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (oldest) this.plans.delete(oldest.planToken);
    }
    this.plans.set(plan.planToken, structuredClone(plan));
  }
}

function normalizeIntent(intent: CreateGitHubRepositoryIntent): CreateGitHubRepositoryIntent {
  const owner = intent?.owner?.trim();
  const name = intent?.name?.trim();
  const description = intent?.description?.trim();
  if (
    intent?.kind !== 'create-github-repository'
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(owner)
    || !/^[A-Za-z0-9_.-]{1,100}$/u.test(name)
    || !['private', 'public'].includes(intent.visibility)
    || (description?.length ?? 0) > 350
  ) throw new Error('GitHub repository intent is invalid.');
  return {
    kind: 'create-github-repository',
    owner,
    name,
    visibility: intent.visibility,
    ...(description ? { description } : {})
  };
}
