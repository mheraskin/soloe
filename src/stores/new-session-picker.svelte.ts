import type { ProjectId } from '@shared/types/projects.js';

export interface NewSessionPickerContext {
  projectId?: ProjectId | null;
  cwd?: string;
  branch?: string;
}

class NewSessionPickerStore {
  isOpen = $state(false);
  context = $state<NewSessionPickerContext>({});

  open(ctx: NewSessionPickerContext = {}): void {
    this.context = ctx;
    this.isOpen = true;
  }

  close(): void {
    this.isOpen = false;
    this.context = {};
  }
}

export const newSessionPicker = new NewSessionPickerStore();
