import type { RunMode } from './sessions.js';
import type { TerminalId } from './terminal.js';

export interface FileSearchRequest {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  query: string;
  limit?: number;
}

export interface FileSearchResult {
  rootPath: string;
  path: string;
  absolutePath: string;
}

export interface FileOpenRequest {
  absolutePath: string;
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
}

export interface FilePasteRequest {
  terminalId: TerminalId;
  path: string;
  generation: number;
  /** Bound to the authenticated caller by the backend adapter. */
  controllerClientId?: string;
}

export interface ClipboardImagePayload {
  mimeType: string;
  dataBase64: string;
  name?: string;
}

export interface ImagePasteRequest {
  terminalId: TerminalId;
  sessionId: string;
  images: ClipboardImagePayload[];
  generation: number;
  /** Bound to the authenticated caller by the backend adapter. */
  controllerClientId?: string;
}

export interface ImagePasteResult {
  paths: string[];
  insertedText: string;
}

export interface FileTreeRequest {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
  revision?: string;
  force?: boolean;
}

export interface FileTreeResult {
  cwd: string;
  paths: string[];
  truncated: boolean;
  isRepo: boolean;
}

export interface FileReadRequest {
  cwd: string;
  relativePath: string;
  runMode: RunMode;
  wslDistro?: string;
  revision?: string;
}

export interface FileReadResult {
  relativePath: string;
  content: string;
  binary: boolean;
  truncated: boolean;
  oversized: boolean;
  unavailable: boolean;
  unavailableReason?: string;
  size: number;
  maxBytes?: number;
}

export interface FileWriteRequest {
  cwd: string;
  relativePath: string;
  content: string;
  runMode: RunMode;
  wslDistro?: string;
}
