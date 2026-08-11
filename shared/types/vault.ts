export interface VaultEntry {
  id: string;
  origin: string;
  username: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultEntryDraft {
  origin: string;
  username: string;
  password: string;
  label?: string;
}

export interface VaultEntryUpdate {
  username?: string;
  password?: string;
  label?: string;
}

export interface VaultListRequest {
  cwd: string;
}

export interface VaultSaveRequest {
  cwd: string;
  draft: VaultEntryDraft;
}

export interface VaultUpdateRequest {
  cwd: string;
  id: string;
  patch: VaultEntryUpdate;
}

export interface VaultDeleteRequest {
  cwd: string;
  id: string;
}

export interface VaultGetSecretRequest {
  cwd: string;
  id: string;
}

export interface VaultSecret {
  username: string;
  password: string;
}

export interface VaultChangeEvent {
  cwd: string;
  entries: VaultEntry[];
  changedAt: string;
}
