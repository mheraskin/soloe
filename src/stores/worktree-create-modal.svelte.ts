import type { Project } from '@shared/types/projects.js';
import type { RunMode } from '@shared/types/sessions.js';

export interface WorktreeCreateDraft {
  projectId: string;
  projectName: string;
  repoPath: string;
  runMode?: RunMode;
  wslDistro?: string;
  baseRef: string;
  branch: string;
  path: string;
}

class WorktreeCreateModalStore {
  open = $state(false);
  draft = $state<WorktreeCreateDraft | null>(null);
  error = $state<string | null>(null);
  private pathEdited = false;

  openFor(project: Project, baseRef?: string | null): void {
    this.pathEdited = false;
    this.error = null;
    this.draft = {
      projectId: project.id,
      projectName: project.name,
      repoPath: project.path,
      ...(project.defaultRunMode ? { runMode: project.defaultRunMode } : {}),
      ...(project.defaultWslDistro ? { wslDistro: project.defaultWslDistro } : {}),
      baseRef: baseRef?.trim() || 'HEAD',
      branch: '',
      path: suggestedWorktreePath(project.path, '')
    };
    this.open = true;
  }

  setBaseRef(baseRef: string): void {
    if (this.draft) this.draft.baseRef = baseRef;
  }

  setBranch(branch: string): void {
    if (!this.draft) return;
    this.draft.branch = branch;
    if (!this.pathEdited) {
      this.draft.path = suggestedWorktreePath(this.draft.repoPath, branch);
    }
  }

  setPath(path: string): void {
    if (!this.draft) return;
    this.pathEdited = true;
    this.draft.path = path;
  }

  close(): void {
    this.open = false;
    this.error = null;
  }
}

export const worktreeCreateModal = new WorktreeCreateModalStore();

export function suggestedWorktreePath(repoPath: string, branch: string): string {
  const lastSlash = Math.max(repoPath.lastIndexOf('/'), repoPath.lastIndexOf('\\'));
  const separator = repoPath.includes('\\') && !repoPath.includes('/') ? '\\' : '/';
  const parent = lastSlash >= 0 ? repoPath.slice(0, lastSlash) : '.';
  const repoName = lastSlash >= 0 ? repoPath.slice(lastSlash + 1) : repoPath;
  const branchSlug = branch
    .trim()
    .replace(/^refs\/heads\//u, '')
    .replace(/[^a-z0-9._-]+/giu, '-')
    .replace(/^-+|-+$/gu, '');
  return `${parent}${separator}${repoName}-${branchSlug || 'worktree'}`;
}
