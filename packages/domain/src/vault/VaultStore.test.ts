import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "./VaultStore.js";

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratch.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("VaultStore", () => {
  it("keeps metadata secret-free and encrypts secrets at rest", async () => {
    const root = await fixtureRoot();
    const store = new VaultStore(root);
    const changeEvents: unknown[] = [];
    store.onChange((event) => changeEvents.push(event));

    const saved = await store.save("/repo", {
      origin: "https://Example.test/login",
      username: "ada@example.test",
      password: "correct horse battery staple",
      label: "work",
    });

    expect(saved).toMatchObject({
      origin: "https://example.test",
      username: "ada@example.test",
      label: "work",
    });
    expect(saved).not.toHaveProperty("password");
    await expect(store.list("/repo")).resolves.toEqual([saved]);
    await expect(store.getSecret("/repo", saved.id)).resolves.toEqual({
      username: "ada@example.test",
      password: "correct horse battery staple",
    });

    const stored = await storedVaultText(root);
    expect(stored).toContain("v2:");
    expect(stored).not.toMatch(
      /correct horse battery staple|ada@example\.test.*correct/u,
    );
    expect(JSON.stringify(changeEvents)).not.toContain(
      "correct horse battery staple",
    );
    expect(changeEvents).toEqual([
      expect.objectContaining({
        cwd: "/repo",
        entries: [saved],
        changedAt: expect.any(String),
      }),
    ]);

    if (process.platform !== "win32") {
      expect((await stat(path.join(root, ".vault-key"))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("serializes concurrent mutations without dropping entries", async () => {
    const root = await fixtureRoot();
    const store = new VaultStore(root);

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.save("/repo", {
          origin: `https://service-${index}.example.test`,
          username: `user-${index}`,
          password: `password-${index}`,
        }),
      ),
    );

    const entries = await store.list("/repo");
    expect(entries).toHaveLength(20);
    await expect(
      store.getSecret("/repo", entries[12]!.id),
    ).resolves.toMatchObject({
      password: expect.stringMatching(/^password-/u),
    });
  });

  it("updates and deletes only the selected scoped entry", async () => {
    const root = await fixtureRoot();
    const store = new VaultStore(root);
    const first = await store.save("/repo", {
      origin: "https://one.example.test",
      username: "first",
      password: "old",
    });
    await store.save("/other", {
      origin: "https://two.example.test",
      username: "second",
      password: "untouched",
    });

    const updated = await store.update("/repo", first.id, {
      username: "renamed",
      password: "new",
      label: "primary",
    });
    expect(updated).toMatchObject({
      id: first.id,
      username: "renamed",
      label: "primary",
    });
    await expect(store.getSecret("/repo", first.id)).resolves.toEqual({
      username: "renamed",
      password: "new",
    });

    await store.delete("/repo", first.id);
    await expect(store.list("/repo")).resolves.toEqual([]);
    await expect(store.list("/other")).resolves.toHaveLength(1);
  });

  it("migrates legacy plaintext secrets after explicit retrieval", async () => {
    const root = await fixtureRoot();
    const cwd = "/legacy";
    const filePath = path.join(root, `${scopeHash(cwd)}.json`);
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        encryption: "plain",
        entries: [
          {
            id: "0123456789abcdef",
            origin: "https://legacy.example.test",
            username: "legacy",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            secretEnc: `plain:${Buffer.from(
              JSON.stringify({ username: "legacy", password: "migrate-me" }),
              "utf8",
            ).toString("base64")}`,
          },
        ],
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    const store = new VaultStore(root);

    await expect(
      store.getSecret(cwd, "0123456789abcdef"),
    ).resolves.toEqual({
      username: "legacy",
      password: "migrate-me",
    });

    const migrated = await readFile(filePath, "utf8");
    expect(migrated).toContain("v2:");
    expect(migrated).not.toContain("plain:");
    expect(migrated).not.toContain("migrate-me");
  });

  it("rejects arbitrary scopes, invalid origins, and unknown entries", async () => {
    const root = await fixtureRoot();
    const store = new VaultStore(root);

    await expect(store.list("../relative")).rejects.toMatchObject({
      code: "invalid_vault_request",
    });
    await expect(
      store.save("/repo", {
        origin: "javascript:alert(1)",
        username: "user",
        password: "secret",
      }),
    ).rejects.toMatchObject({ code: "invalid_vault_request" });
    await expect(
      store.getSecret("/repo", "0123456789abcdef"),
    ).rejects.toMatchObject({ code: "vault_entry_not_found" });
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "soloe-vault-"));
  scratch.push(root);
  return root;
}

async function storedVaultText(root: string): Promise<string> {
  const fileName = (await readdir(root)).find((entry) => entry.endsWith(".json"));
  if (!fileName) throw new Error("Vault fixture was not written");
  return readFile(path.join(root, fileName), "utf8");
}

function scopeHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}
