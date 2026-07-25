import type { RunMode, Session, SessionDraft, SessionLaunchKind } from '@shared/types/sessions.js';
import { launchKind } from '@shared/types/sessions.js';
import type { SettingsDefaults } from '@shared/types/settings.js';

export function shortCwd(cwd: string): string {
  if (!cwd) return '';
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

export function kindLabel(kind: SessionLaunchKind): string {
  switch (kind) {
    case 'terminal': return 'Terminal';
    case 'claude_code': return 'Claude';
    case 'codex': return 'Codex';
  }
}

export function kindGlyph(kind: SessionLaunchKind): string {
  switch (kind) {
    case 'terminal': return '$_';
    case 'claude_code': return 'C';
    case 'codex': return 'X';
  }
}

export function defaultDraft(kind: SessionLaunchKind, defaults?: SettingsDefaults): SessionDraft {
  const runMode = defaults?.runMode ?? 'wsl';
  const base = {
    name: '',
    cwd: '',
    runMode,
    ...(runMode === 'wsl' ? { wslDistro: defaults?.wslDistro ?? 'Ubuntu' } : {})
  } as { name: string; cwd: string; runMode: RunMode; wslDistro?: string };
  const standardShell = defaults?.shell ?? 'auto';
  switch (kind) {
    case 'terminal':
      return { ...base, launch: { type: 'terminal', shell: standardShell } };
    case 'claude_code':
      return {
        ...base,
        launch: {
          type: 'agent',
          provider: 'claude_code',
          resumeMode: 'new',
          fullscreenTui: true
        }
      };
    case 'codex':
      return { ...base, launch: { type: 'agent', provider: 'codex', resumeMode: 'new' } };
  }
}

export function toDraft(s: Session): SessionDraft {
  const { id: _id, createdAt: _c, lastUsedAt: _l, ...rest } = s;
  return rest as SessionDraft;
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateDraft(d: SessionDraft): ValidationError | null {
  if (!d.name.trim()) return { field: 'name', message: 'Name is required' };
  if (!d.cwd.trim()) return { field: 'cwd', message: 'Working directory is required' };
  if (d.runMode === 'wsl' && !d.wslDistro?.trim()) {
    return { field: 'wslDistro', message: 'WSL distro is required' };
  }
  switch (d.launch.type) {
    case 'terminal':
      if (!d.launch.shell) return { field: 'shell', message: 'Shell is required' };
      if (d.launch.shell === 'custom' && !d.launch.command?.trim()) {
        return { field: 'command', message: 'Command is required for custom shell' };
      }
      break;
    case 'agent':
      if (d.launch.provider === 'claude_code') {
        if (d.launch.resumeMode === 'resume_by_name' && !d.launch.claudeSessionName?.trim()) {
          return { field: 'claudeSessionName', message: 'Session name required' };
        }
        if (d.launch.resumeMode === 'resume_by_id' && !d.launch.claudeSessionId?.trim()) {
          return { field: 'claudeSessionId', message: 'Session id required' };
        }
      }
      if (d.launch.provider === 'codex' && d.launch.resumeMode === 'resume_by_id' && !d.launch.codexSessionId?.trim()) {
        return { field: 'codexSessionId', message: 'Session id required' };
      }
      break;
  }
  return null;
}

export function draftLaunchKind(d: SessionDraft): SessionLaunchKind {
  return launchKind(d);
}
