export type DiagnosticSeverity = 'info' | 'warn' | 'error';

export interface DiagnosticItem {
  id: string;
  severity: DiagnosticSeverity;
  message: string;
  detail?: string;
  action?: 'settings' | 'project';
}

export interface CrashLogSummary {
  fileName: string;
  path: string;
  createdAt: string;
}
