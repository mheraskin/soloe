import { constants, promises as fs } from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type {
  VaultChangeEvent,
  VaultEntry,
  VaultEntryDraft,
  VaultEntryUpdate,
  VaultSecret,
} from "../../../../shared/types/vault.js";

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
  encryption: "aes-256-gcm" | "safeStorage" | "plain";
  entries: StoredEntry[];
}

export interface VaultStoreOptions {
  legacySecretDecoder?: (blob: string) => VaultSecret;
  secretEncoder?: (secret: VaultSecret) => string | undefined;
  preferredEncryption?: "aes-256-gcm" | "safeStorage";
  now?: () => Date;
}

export class VaultStoreError extends Error {
  constructor(
    readonly code:
      | "invalid_vault_request"
      | "vault_corrupt"
      | "vault_entry_not_found"
      | "vault_key_unavailable"
      | "vault_limit_exceeded",
    message: string,
  ) {
    super(message);
    this.name = "VaultStoreError";
  }
}

const FILE_VERSION = 1;
const MAX_CWD_LENGTH = 16_384;
const MAX_ORIGIN_LENGTH = 4_096;
const MAX_USERNAME_LENGTH = 1_024;
const MAX_PASSWORD_LENGTH = 65_536;
const MAX_LABEL_LENGTH = 2_048;
const MAX_ENTRIES = 1_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILE = ".vault-key";
const ENCRYPTED_PREFIX = "v2:";
const CIPHER_ASSOCIATED_DATA = Buffer.from("soloe-vault-v2", "utf8");

export class VaultStore {
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(event: VaultChangeEvent) => void>();
  private keyPromise: Promise<Buffer> | null = null;

  constructor(
    private readonly rootDir: string,
    private readonly options: VaultStoreOptions = {},
  ) {}

  async list(cwd: string): Promise<VaultEntry[]> {
    const scope = requireCwd(cwd);
    const file = await this.read(scope);
    return publicEntries(file);
  }

  async save(cwd: string, draft: VaultEntryDraft): Promise<VaultEntry> {
    const scope = requireCwd(cwd);
    const validated = validateDraft(draft);
    return this.mutate(scope, async (file) => {
      const now = (this.options.now?.() ?? new Date()).toISOString();
      const existing = file.entries.find(
        (entry) =>
          entry.origin === validated.origin &&
          entry.username.toLowerCase() === validated.username.toLowerCase(),
      );
      const secretEnc = await this.encryptSecret({
        username: validated.username,
        password: validated.password,
      });
      if (existing) {
        existing.username = validated.username;
        existing.label = validated.label;
        existing.updatedAt = now;
        existing.secretEnc = secretEnc;
        return this.toPublic(existing);
      }
      if (file.entries.length >= MAX_ENTRIES) {
        throw new VaultStoreError(
          "vault_limit_exceeded",
          `A Vault may contain at most ${MAX_ENTRIES} entries`,
        );
      }
      const saved: StoredEntry = {
        id: randomBytes(8).toString("hex"),
        origin: validated.origin,
        username: validated.username,
        ...(validated.label ? { label: validated.label } : {}),
        createdAt: now,
        updatedAt: now,
        secretEnc,
      };
      file.entries.push(saved);
      return this.toPublic(saved);
    });
  }

  async update(
    cwd: string,
    id: string,
    patch: VaultEntryUpdate,
  ): Promise<VaultEntry> {
    const scope = requireCwd(cwd);
    const entryId = requireEntryId(id);
    const validated = validatePatch(patch);
    return this.mutate(scope, async (file) => {
      const entry = file.entries.find((candidate) => candidate.id === entryId);
      if (!entry) {
        throw new VaultStoreError(
          "vault_entry_not_found",
          "Vault entry not found",
        );
      }
      const current = await this.decryptSecret(entry.secretEnc);
      const username = validated.username ?? entry.username;
      const password = validated.password ?? current.secret.password;
      entry.username = username;
      if (validated.hasLabel) {
        entry.label = validated.label;
      }
      entry.updatedAt = (this.options.now?.() ?? new Date()).toISOString();
      entry.secretEnc = await this.encryptSecret({ username, password });
      return this.toPublic(entry);
    });
  }

  async delete(cwd: string, id: string): Promise<void> {
    const scope = requireCwd(cwd);
    const entryId = requireEntryId(id);
    await this.mutate(scope, async (file) => {
      const index = file.entries.findIndex((entry) => entry.id === entryId);
      if (index < 0) return;
      file.entries.splice(index, 1);
    });
  }

  async getSecret(cwd: string, id: string): Promise<VaultSecret> {
    const scope = requireCwd(cwd);
    const entryId = requireEntryId(id);
    return this.withMutationQueue(scope, async () => {
      const file = await this.read(scope);
      const entry = file.entries.find((candidate) => candidate.id === entryId);
      if (!entry) {
        throw new VaultStoreError(
          "vault_entry_not_found",
          "Vault entry not found",
        );
      }
      const decrypted = await this.decryptSecret(entry.secretEnc);
      if (decrypted.legacy) {
        entry.secretEnc = await this.encryptSecret(decrypted.secret);
        await this.write(scope, file);
      }
      return decrypted.secret;
    });
  }

  onChange(listener: (event: VaultChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async mutate<T>(
    cwd: string,
    operation: (file: StoredFile) => Promise<T>,
  ): Promise<T> {
    return this.withMutationQueue(cwd, async () => {
      const file = await this.read(cwd);
      const result = await operation(file);
      await this.write(cwd, file);
      const event: VaultChangeEvent = {
        cwd,
        entries: publicEntries(file),
        changedAt: (this.options.now?.() ?? new Date()).toISOString(),
      };
      for (const listener of this.listeners) listener(event);
      return result;
    });
  }

  private async withMutationQueue<T>(
    cwd: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const filePath = this.filePath(cwd);
    const previous = this.mutationQueues.get(filePath) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueues.set(filePath, tail);
    try {
      return await result;
    } finally {
      if (this.mutationQueues.get(filePath) === tail) {
        this.mutationQueues.delete(filePath);
      }
    }
  }

  private toPublic(entry: StoredEntry): VaultEntry {
    return {
      id: entry.id,
      origin: entry.origin,
      username: entry.username,
      ...(entry.label ? { label: entry.label } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  private filePath(cwd: string): string {
    const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
    return path.join(this.rootDir, `${hash}.json`);
  }

  private async read(cwd: string): Promise<StoredFile> {
    const filePath = this.filePath(cwd);
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      handle = await fs.open(filePath, constants.O_RDONLY | noFollow);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        throw new VaultStoreError(
          "vault_corrupt",
          "Vault storage is not a valid bounded file",
        );
      }
      const parsed = JSON.parse(
        await handle.readFile({ encoding: "utf8" }),
      ) as Partial<StoredFile>;
      return validateStoredFile(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
      if (error instanceof VaultStoreError) throw error;
      if (error instanceof SyntaxError) {
        throw new VaultStoreError("vault_corrupt", "Vault storage is invalid");
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }

  private async write(cwd: string, file: StoredFile): Promise<void> {
    const filePath = this.filePath(cwd);
    file.encryption = this.options.preferredEncryption ?? "aes-256-gcm";
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(file, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(temporaryPath, filePath);
    } finally {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async encryptSecret(secret: VaultSecret): Promise<string> {
    const encoded = this.options.secretEncoder?.(secret);
    if (encoded) return encoded;
    const key = await this.encryptionKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(CIPHER_ASSOCIATED_DATA);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secret), "utf8"),
      cipher.final(),
    ]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
    return `${ENCRYPTED_PREFIX}${payload.toString("base64")}`;
  }

  private async decryptSecret(
    blob: string,
  ): Promise<{ secret: VaultSecret; legacy: boolean }> {
    try {
      if (blob.startsWith(ENCRYPTED_PREFIX)) {
        const payload = Buffer.from(blob.slice(ENCRYPTED_PREFIX.length), "base64");
        if (payload.length <= IV_BYTES + TAG_BYTES) throw new Error("short payload");
        const iv = payload.subarray(0, IV_BYTES);
        const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv(
          "aes-256-gcm",
          await this.encryptionKey(),
          iv,
        );
        decipher.setAAD(CIPHER_ASSOCIATED_DATA);
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString("utf8");
        return { secret: validateSecret(JSON.parse(plaintext)), legacy: false };
      }
      if (blob.startsWith("plain:")) {
        const plaintext = Buffer.from(blob.slice("plain:".length), "base64").toString(
          "utf8",
        );
        return { secret: validateSecret(JSON.parse(plaintext)), legacy: true };
      }
      if (blob.startsWith("enc:") && this.options.legacySecretDecoder) {
        return {
          secret: validateSecret(this.options.legacySecretDecoder(blob)),
          legacy: true,
        };
      }
    } catch (error) {
      if (error instanceof VaultStoreError) throw error;
      throw new VaultStoreError(
        "vault_corrupt",
        "Vault secret could not be decrypted",
      );
    }
    throw new VaultStoreError(
      "vault_key_unavailable",
      "Vault secret uses encryption unavailable to this backend",
    );
  }

  private encryptionKey(): Promise<Buffer> {
    this.keyPromise ??= this.loadOrCreateEncryptionKey();
    return this.keyPromise;
  }

  private async loadOrCreateEncryptionKey(): Promise<Buffer> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const keyPath = path.join(this.rootDir, KEY_FILE);
    const generated = randomBytes(KEY_BYTES);
    try {
      await fs.writeFile(keyPath, generated, { mode: 0o600, flag: "wx" });
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new VaultStoreError(
          "vault_key_unavailable",
          "Vault encryption key could not be created",
        );
      }
    }
    let key: Buffer;
    try {
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const handle = await fs.open(keyPath, constants.O_RDONLY | noFollow);
      try {
        key = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch {
      throw new VaultStoreError(
        "vault_key_unavailable",
        "Vault encryption key could not be read",
      );
    }
    if (key.length !== KEY_BYTES) {
      throw new VaultStoreError(
        "vault_key_unavailable",
        "Vault encryption key is invalid",
      );
    }
    return key;
  }
}

function emptyFile(): StoredFile {
  return {
    version: FILE_VERSION,
    encryption: "aes-256-gcm",
    entries: [],
  };
}

function publicEntries(file: StoredFile): VaultEntry[] {
  return file.entries
    .map((entry) => ({
      id: entry.id,
      origin: entry.origin,
      username: entry.username,
      ...(entry.label ? { label: entry.label } : {}),
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }))
    .sort(
      (left, right) =>
        left.origin.localeCompare(right.origin) ||
        left.username.localeCompare(right.username),
    );
}

function validateStoredFile(value: Partial<StoredFile>): StoredFile {
  if (
    value.version !== FILE_VERSION ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_ENTRIES ||
    !value.entries.every(isStoredEntry)
  ) {
    throw new VaultStoreError("vault_corrupt", "Vault storage is invalid");
  }
  return {
    version: FILE_VERSION,
    encryption:
      value.encryption === "safeStorage" || value.encryption === "plain"
        ? value.encryption
        : "aes-256-gcm",
    entries: value.entries,
  };
}

function isStoredEntry(value: unknown): value is StoredEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === "string" &&
    /^[0-9a-f]{16}$/u.test(entry.id) &&
    typeof entry.origin === "string" &&
    entry.origin.length <= MAX_ORIGIN_LENGTH &&
    typeof entry.username === "string" &&
    entry.username.length <= MAX_USERNAME_LENGTH &&
    (entry.label === undefined ||
      (typeof entry.label === "string" &&
        entry.label.length <= MAX_LABEL_LENGTH)) &&
    typeof entry.createdAt === "string" &&
    typeof entry.updatedAt === "string" &&
    typeof entry.secretEnc === "string" &&
    entry.secretEnc.length <= MAX_PASSWORD_LENGTH * 2
  );
}

function requireCwd(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > MAX_CWD_LENGTH ||
    value.includes("\0") ||
    (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value))
  ) {
    throw new VaultStoreError(
      "invalid_vault_request",
      "cwd must be a bounded absolute path",
    );
  }
  return value;
}

function requireEntryId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/u.test(value)) {
    throw new VaultStoreError(
      "invalid_vault_request",
      "Vault entry id is invalid",
    );
  }
  return value;
}

function validateDraft(draft: VaultEntryDraft): {
  origin: string;
  username: string;
  password: string;
  label?: string;
} {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    throw new VaultStoreError(
      "invalid_vault_request",
      "Vault draft must be an object",
    );
  }
  const origin = normalizeOrigin(draft.origin);
  const username = boundedString(
    draft.username,
    "username",
    MAX_USERNAME_LENGTH,
  ).trim();
  if (!username) {
    throw new VaultStoreError(
      "invalid_vault_request",
      "username must be a bounded string",
    );
  }
  const password = boundedString(
    draft.password,
    "password",
    MAX_PASSWORD_LENGTH,
  );
  const label =
    draft.label === undefined
      ? undefined
      : boundedString(draft.label, "label", MAX_LABEL_LENGTH, true).trim() ||
        undefined;
  return {
    origin,
    username,
    password,
    ...(label ? { label } : {}),
  };
}

function validatePatch(patch: VaultEntryUpdate): {
  username?: string;
  password?: string;
  label?: string;
  hasLabel: boolean;
} {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new VaultStoreError(
      "invalid_vault_request",
      "Vault patch must be an object",
    );
  }
  const username =
    patch.username === undefined
      ? undefined
      : boundedString(
          patch.username,
          "username",
          MAX_USERNAME_LENGTH,
        ).trim();
  if (patch.username !== undefined && !username) {
    throw new VaultStoreError(
      "invalid_vault_request",
      "username must be a bounded string",
    );
  }
  const password =
    patch.password === undefined
      ? undefined
      : boundedString(patch.password, "password", MAX_PASSWORD_LENGTH);
  const label =
    patch.label === undefined
      ? undefined
      : boundedString(patch.label, "label", MAX_LABEL_LENGTH, true).trim() ||
        undefined;
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(label ? { label } : {}),
    hasLabel: patch.label !== undefined,
  };
}

function normalizeOrigin(input: unknown): string {
  const value = boundedString(input, "origin", MAX_ORIGIN_LENGTH).trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultStoreError(
      "invalid_vault_request",
      "origin must be an HTTP or HTTPS URL",
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new VaultStoreError(
      "invalid_vault_request",
      "origin must be an HTTP or HTTPS origin without credentials",
    );
  }
  return url.origin.toLowerCase();
}

function boundedString(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value) ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new VaultStoreError(
      "invalid_vault_request",
      `${name} must be a bounded string`,
    );
  }
  return value;
}

function validateSecret(value: unknown): VaultSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultStoreError("vault_corrupt", "Vault secret is invalid");
  }
  const secret = value as Record<string, unknown>;
  if (
    typeof secret.username !== "string" ||
    !secret.username ||
    secret.username.length > MAX_USERNAME_LENGTH ||
    typeof secret.password !== "string" ||
    !secret.password ||
    secret.password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new VaultStoreError("vault_corrupt", "Vault secret is invalid");
  }
  return { username: secret.username, password: secret.password };
}
