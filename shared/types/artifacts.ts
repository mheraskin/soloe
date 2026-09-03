import type { ProjectId } from './projects.js';

export const ARTIFACT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

export type ArtifactHomeOwnership = 'system' | 'user';

export interface ArtifactSummary {
  id: string;
  projectId: ProjectId;
  title: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  revision: string;
  isHome: boolean;
  homeOwnership: ArtifactHomeOwnership | null;
}

export interface ArtifactCatalogSnapshot {
  projectId: ProjectId;
  projectName: string;
  revision: string;
  homeArtifactId: string | null;
  artifacts: ArtifactSummary[];
}

export interface ArtifactDocument extends ArtifactSummary {
  html: string;
  catalogRevision: string;
}

export interface ArtifactProjectRef {
  id: ProjectId;
  name: string;
}

export interface PublishArtifactRequest {
  project: ArtifactProjectRef;
  title: string;
  description: string;
  html: string;
  requestedId?: string;
  asHome?: boolean;
}

export interface EditArtifactRequest {
  project: ArtifactProjectRef;
  artifactId: string;
  title?: string;
  description?: string;
  html: string;
}

export interface ArtifactMutationResult {
  project: ArtifactProjectRef;
  projectId: ProjectId;
  artifact: ArtifactSummary;
  revision: string;
  homeGenerated: boolean;
}

export interface ArtifactDeleteResult {
  projectId: ProjectId;
  artifactId: string;
  deleted: boolean;
  revision: string;
  restoredGeneratedHome: boolean;
}

export interface ArtifactsChangeEvent {
  projectId: ProjectId;
  snapshot: ArtifactCatalogSnapshot;
}
