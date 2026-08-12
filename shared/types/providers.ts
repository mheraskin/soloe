import type { DeviceId } from './devices.js';
import type { CockpitOperation, CockpitPlan, DeviceOperationReceipt } from './commands.js';
import type { WorkspaceId } from './workspaces.js';

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

export interface CockpitPublishProjectIntent {
  kind: 'publish-project';
  workspaceId: WorkspaceId;
  sourceDeviceId: DeviceId;
  owner: string;
  name: string;
  visibility: GitHubRepositoryVisibility;
  description?: string;
  remote?: string;
}

export interface CockpitPublishProjectPreview {
  projectName: string;
  workspaceName: string;
  deviceName: string;
  branchRef: string;
  remote: string;
  localOid: string;
  owner: string;
  name: string;
  visibility: GitHubRepositoryVisibility;
  url: string;
}

export type CockpitPublishProjectPlan = CockpitPlan<
  CockpitPublishProjectIntent,
  CockpitPublishProjectPreview
> & {
  kind: 'publish-project';
  catalogRevision: number;
  projectVersion: number;
  providerPlan: GitHubRepositoryPlan;
  devicePlan: import('./workspaces.js').DeviceWorkspacePlan;
};

export interface CockpitPublishProjectResult {
  projectId: string;
  repository: CreatedGitHubRepository;
  providerReceipt: GitHubRepositoryOperationReceipt;
  pushReceipt: DeviceOperationReceipt | null;
  pushed: boolean;
}

export type CockpitPublishProjectOperation = CockpitOperation<CockpitPublishProjectResult>;
