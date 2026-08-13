import type { DeviceId } from './devices.js';
import type { DeviceOperationReceipt } from './commands.js';

export type GitHubRepositoryVisibility = 'private' | 'public';

export interface GitHubProviderStatus {
  available: boolean;
  authenticated: boolean;
  login?: string;
  error?: string;
}

export interface GitHubOwner {
  login: string;
  kind: 'user' | 'organization';
}

export interface CreateGitHubRepositoryIntent {
  kind: 'create-github-repository';
  owner: string;
  name: string;
  visibility: GitHubRepositoryVisibility;
  description?: string;
}

export interface GitHubRepositoryPlan {
  schemaVersion: 1;
  planId: string;
  planToken: string;
  targetDeviceId: DeviceId;
  capabilityRevision: string;
  intent: CreateGitHubRepositoryIntent;
  executable: boolean;
  blockers: string[];
  warnings: string[];
  preview: {
    owner: string;
    name: string;
    visibility: GitHubRepositoryVisibility;
    url: string;
  };
  createdAt: string;
  expiresAt: string;
}

export interface CreatedGitHubRepository {
  provider: 'github';
  providerRepositoryId: string;
  owner: string;
  name: string;
  visibility: GitHubRepositoryVisibility;
  url: string;
  sshUrl: string;
}

export type GitHubRepositoryOperationReceipt = DeviceOperationReceipt<CreatedGitHubRepository>;
