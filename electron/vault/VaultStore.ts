import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { safeStorage } from 'electron';
import type {
  VaultEntry,
  VaultEntryDraft,
  VaultEntryUpdate,
  VaultSecret
} from '@shared/types/vault.js';

interface StoredEntry {
  id: string;
  origin: string;
  username: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  secretEnc: string;
}

interface StoredFile {
  version: 1;
  encryption: 'safeStorage' | 'plain';
  entries: StoredEntry[];
}

const FILE_VERSION = 1;

export class VaultStore {
  private writeQueues = new Map<string, Promise<void>>();

  constructor(private readonly rootDir: string) {}

  async list(cwd: string): Promise<VaultEntry[]> {
    const file = await this.read(cwd);
    return file.entries
      .map((e) => this.toPublic(e))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  async save(cwd: string, draft: VaultEntryDraft): Promise<VaultEntry> {
    const origin = normalizeOrigin(draft.origin);
    const username = draft.username.trim();
    if (!username) throw new Error('username is required');
    if (!draft.password) throw new Error('password is required');
    if (!origin) throw new Error('origin is required');

    const file = await this.read(cwd);
    const now = new Date().toISOString();
    const existing = file.entries.find(
      (e) => e.origin === origin && e.username.toLowerCase() === username.toLowerCase()
    );

    let saved: StoredEntry;
    if (existing) {
      existing.username = username;
      existing.label = draft.label?.trim() || undefined;
      existing.updatedAt = now;
      existing.secretEnc = encryptSecret({ username, password: draft.password });
      saved = existing;
    } else {
      saved = {
        id: randomBytes(8).toString('hex'),
        origin,
        username,
        label: draft.label?.trim() || undefined,
        createdAt: now,
        updatedAt: now,
        secretEnc: encryptSecret({ username, password: draft.password })
      };
      file.entries.push(saved);
    }
    await this.write(cwd, file);
    return this.toPublic(saved);
  }

  async update(cwd: string, id: string, patch: VaultEntryUpdate): Promise<VaultEntry> {
    const file = await this.read(cwd);
    const entry = file.entries.find((e) => e.id === id);
    if (!entry) throw new Error('vault entry not found');
    const current = decryptSecret(entry.secretEnc);
    const nextUsername = patch.username?.trim() ?? entry.username;
    const nextPassword = patch.password ?? current.password;
    if (!nextUsername) throw new Error('username is required');
    if (!nextPassword) throw new Error('password is required');
    entry.username = nextUsername;
    if (patch.label !== undefined) {
      entry.label = patch.label?.trim() || undefined;
    }
    entry.updatedAt = new Date().toISOString();
    entry.secretEnc = encryptSecret({ username: nextUsername, password: nextPassword });
    await this.write(cwd, file);
    return this.toPublic(entry);
  }

  async delete(cwd: string, id: string): Promise<void> {
    const file = await this.read(cwd);
    const before = file.entries.length;
    file.entries = file.entries.filter((e) => e.id !== id);
    if (file.entries.length === before) return;
    await this.write(cwd, file);
  }

  async getSecret(cwd: string, id: string): Promise<VaultSecret> {
    const file = await this.read(cwd);
    const entry = file.entries.find((e) => e.id === id);
    if (!entry) throw new Error('vault entry not found');
    return decryptSecret(entry.secretEnc);
  }

  private toPublic(entry: StoredEntry): VaultEntry {
    return {
      id: entry.id,
      origin: entry.origin,
      username: entry.username,
      label: entry.label,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    };
  }

  private filePath(cwd: string): string {
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 16);
    return path.join(this.rootDir, `${hash}.json`);
  }

  private async read(cwd: string): Promise<StoredFile> {
    const filePath = this.filePath(cwd);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredFile>;
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.entries)) {
        return emptyFile();
      }
      return {
        version: FILE_VERSION,
        encryption: parsed.encryption === 'plain' ? 'plain' : 'safeStorage',
        entries: parsed.entries as StoredEntry[]
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
      throw err;
    }
  }

  private async write(cwd: string, file: StoredFile): Promise<void> {
    const filePath = this.filePath(cwd);
    file.encryption = safeStorage.isEncryptionAvailable() ? 'safeStorage' : 'plain';
    const task = async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
      await fs.rename(tmp, filePath);
    };
    const prev = this.writeQueues.get(filePath) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.writeQueues.set(
      filePath,
      next.finally(() => {
        if (this.writeQueues.get(filePath) === next) this.writeQueues.delete(filePath);
      })
    );
    await next;
  }
}

function emptyFile(): StoredFile {
  return {
    version: FILE_VERSION,
    encryption: safeStorage.isEncryptionAvailable() ? 'safeStorage' : 'plain',
    entries: []
  };
}

function encryptSecret(secret: VaultSecret): string {
  const payload = JSON.stringify(secret);
  if (safeStorage.isEncryptionAvailable()) {
    return 'enc:' + safeStorage.encryptString(payload).toString('base64');
  }
  return 'plain:' + Buffer.from(payload, 'utf8').toString('base64');
}

function decryptSecret(blob: string): VaultSecret {
  if (blob.startsWith('enc:')) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('vault is encrypted but OS keychain is unavailable');
    }
    const buf = Buffer.from(blob.slice('enc:'.length), 'base64');
    return JSON.parse(safeStorage.decryptString(buf)) as VaultSecret;
  }
  if (blob.startsWith('plain:')) {
    const buf = Buffer.from(blob.slice('plain:'.length), 'base64').toString('utf8');
    return JSON.parse(buf) as VaultSecret;
  }
  throw new Error('unknown vault secret format');
}

function normalizeOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}
