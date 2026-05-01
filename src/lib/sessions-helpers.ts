import type { Session, SessionDraft, SessionKind } from '@shared/types/sessions.js';

export function shortCwd(cwd: string): string {
  if (!cwd) return '';
  const trimmed = cwd.replace(/[/\\]+$/, '');
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || trimmed;
}

export function kindLabel(kind: SessionKind): string {
  switch (kind) {
    case 'standard_terminal': return 'Terminal';
    case 'claude_code': return 'Claude';
    case 'codex': return 'Codex';
  }
}

export function kindGlyph(kind: SessionKind): string {
  switch (kind) {
    case 'standard_terminal': return '$_';
    case 'claude_code': return 'C';
    case 'codex': return 'X';
  }
}

export function defaultDraft(kind: SessionKind): SessionDraft {
  const base = {
    name: '',
    cwd: '',
    runMode: 'wsl' as const,
    wslDistro: 'Ubuntu'
  };
  switch (kind) {
    case 'standard_terminal':
      return { ...base, kind: 'standard_terminal', shell: 'auto' };
    case 'claude_code':
      return { ...base, kind: 'claude_code', resumeMode: 'new', fullscreenTui: true };
    case 'codex':
      return { ...base, kind: 'codex', resumeMode: 'new' };
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
  switch (d.kind) {
    case 'standard_terminal':
      if (!d.shell) return { field: 'shell', message: 'Shell is required' };
      if (d.shell === 'custom' && !d.command?.trim()) {
        return { field: 'command', message: 'Command is required for custom shell' };
      }
      break;
    case 'claude_code':
      if (d.resumeMode === 'resume_by_name' && !d.claudeSessionName?.trim()) {
        return { field: 'claudeSessionName', message: 'Session name required' };
      }
      if (d.resumeMode === 'resume_by_id' && !d.claudeSessionId?.trim()) {
        return { field: 'claudeSessionId', message: 'Session id required' };
      }
      break;
    case 'codex':
      if (d.resumeMode === 'resume_by_id' && !d.codexSessionId?.trim()) {
        return { field: 'codexSessionId', message: 'Session id required' };
      }
      break;
  }
  return null;
}
