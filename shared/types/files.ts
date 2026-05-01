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
