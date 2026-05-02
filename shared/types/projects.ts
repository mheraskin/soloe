import type { RunMode } from './sessions.js';

export type ProjectId = string;

export interface Project {
  id: ProjectId;
  name: string;
  path: string;
  defaultRunMode?: RunMode;
  defaultWslDistro?: string;
  accentColor?: string;
  createdAt: string;
  lastOpenedAt: string;
}

export interface ProjectDraft {
  name: string;
  path: string;
  defaultRunMode?: RunMode;
  defaultWslDistro?: string;
  accentColor?: string;
}

export interface ProjectOpenRequest {
  path: string;
  defaultRunMode?: RunMode;
  defaultWslDistro?: string;
  accentColor?: string;
}

export type ProjectUpdate = Partial<Omit<Project, 'id' | 'createdAt'>>;

export interface ProjectDetectResult {
  path: string;
  suggestedName: string;
  matchedProjectId: ProjectId | null;
}

export interface ProjectPathSuggestion {
  path: string;
  name: string;
  source: 'known' | 'directory';
  projectId?: ProjectId;
}
