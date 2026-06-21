import type { ProjectId } from './projects.js';

export interface NoteSummary {
  filename: string;
  size: number;
  updatedAt: number;
}

export interface NoteContent {
  filename: string;
  content: string;
  updatedAt: number;
}

export interface NotesChangeEvent {
  projectId: ProjectId;
  notes: NoteSummary[];
}

export interface NoteImage {
  filename: string;
  absolutePath: string;
  mimeType: string;
}

export interface NoteImagePayload {
  mimeType: string;
  dataBase64: string;
}

export interface NoteImageData {
  mimeType: string;
  dataBase64: string;
}
