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
