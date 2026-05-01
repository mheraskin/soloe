import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CrashLogSummary, DiagnosticItem } from '@shared/types/diagnostics.js';
import type { GitService } from '../git/GitService.js';
import type { ProjectStore } from '../projects/ProjectStore.js';
import type { SettingsStore } from '../settings/SettingsStore.js';

export interface DiagnosticsServiceOptions {
  settings: SettingsStore;
  projects: ProjectStore;
  git: GitService;
  crashDir: string;
}

export class DiagnosticsService {
  constructor(private readonly opts: DiagnosticsServiceOptions) {}

  async list(): Promise<DiagnosticItem[]> {
    const [binaryIssues, projectIssues, crashes] = await Promise.all([
      this.binaryDiagnostics(),
      this.projectDiagnostics(),
      this.crashLogs()
    ]);
    const crashIssue: DiagnosticItem[] = crashes.length > 0
      ? [{
          id: 'crashes.recent',
          severity: 'warn',
          message: `${crashes.length} crash log${crashes.length === 1 ? '' : 's'} available`,
          detail: crashes[0]?.fileName,
          action: 'project'
        }]
      : [];
    return [...binaryIssues, ...projectIssues, ...crashIssue];
  }

  async crashLogs(): Promise<CrashLogSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.opts.crashDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const logs: CrashLogSummary[] = [];
    for (const fileName of entries.filter((entry) => entry.endsWith('.log'))) {
      const fullPath = path.join(this.opts.crashDir, fileName);
      try {
        const stat = await fs.stat(fullPath);
        logs.push({
          fileName,
          path: fullPath,
          createdAt: stat.mtime.toISOString()
        });
      } catch {
        // Ignore deleted files during scan.
      }
    }
    return logs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async binaryDiagnostics(): Promise<DiagnosticItem[]> {
    const settings = await this.opts.settings.get();
    const out: DiagnosticItem[] = [];
    for (const [name, configuredPath] of Object.entries(settings.binaries)) {
      if (!configuredPath) continue;
      try {
        await fs.access(configuredPath);
      } catch {
        out.push({
          id: `binary.${name}`,
          severity: 'error',
          message: `Configured ${name} binary is missing`,
          detail: configuredPath,
          action: 'settings'
        });
      }
    }
    return out;
  }

  private async projectDiagnostics(): Promise<DiagnosticItem[]> {
    const projects = await this.opts.projects.list();
    const out: DiagnosticItem[] = [];
    for (const project of projects) {
      const dirty = await this.opts.git.getDirty(project.path);
      if (!dirty.isRepo) continue;
      if (dirty.dirty) {
        out.push({
          id: `project.${project.id}.dirty`,
          severity: 'warn',
          message: `${project.name} has uncommitted changes`,
          detail: `${dirty.staged} staged, ${dirty.unstaged} unstaged, ${dirty.untracked} untracked`,
          action: 'project'
        });
      }
    }
    return out;
  }
}
