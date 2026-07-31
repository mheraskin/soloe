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
  service: 'tray' | 'server' | 'runtime' | 'web' | 'supervisor' | 'crash';
  severity: DiagnosticSeverity;
  createdAt: string;
  sizeBytes: number;
  tail: string;
  truncated: boolean;
}

export interface DiagnosticLogsRequest {
  tailBytes?: number;
}
