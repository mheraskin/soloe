import { safeStorage } from "electron";
import type { VaultSecret } from "../../shared/types/vault.js";
import {
  VaultStore as SharedVaultStore,
  type VaultStoreOptions,
} from "../../packages/domain/src/vault/VaultStore.js";

export * from "../../packages/domain/src/vault/VaultStore.js";

export class VaultStore extends SharedVaultStore {
  constructor(rootDir: string, options: VaultStoreOptions = {}) {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    super(rootDir, {
      ...options,
      legacySecretDecoder:
        options.legacySecretDecoder ?? decodeSafeStorageSecret,
      secretEncoder:
        options.secretEncoder ??
        (encryptionAvailable ? encodeSafeStorageSecret : undefined),
      preferredEncryption:
        options.preferredEncryption ??
        (encryptionAvailable ? "safeStorage" : "aes-256-gcm"),
    });
  }
}

function encodeSafeStorageSecret(secret: VaultSecret): string {
  const encrypted = safeStorage.encryptString(JSON.stringify(secret));
  return `enc:${encrypted.toString("base64")}`;
}

function decodeSafeStorageSecret(blob: string): VaultSecret {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain is unavailable");
  }
  const encrypted = Buffer.from(blob.slice("enc:".length), "base64");
  return JSON.parse(safeStorage.decryptString(encrypted)) as VaultSecret;
}
