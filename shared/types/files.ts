import type { RunMode } from './sessions.js';
import type { TerminalId } from './terminal.js';

export interface FileSearchRequest {
  rootPath: string;
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
}

export interface FilePasteRequest {
  terminalId: TerminalId;
  path: string;
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
}

export interface ImagePasteResult {
  paths: string[];
  insertedText: string;
}

export interface FileTreeRequest {
  cwd: string;
  runMode: RunMode;
  wslDistro?: string;
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
}

export interface FileReadResult {
  relativePath: string;
  content: string;
  binary: boolean;
  size: number;
}

export interface FileWriteRequest {
  cwd: string;
  relativePath: string;
  content: string;
  runMode: RunMode;
  wslDistro?: string;
}
