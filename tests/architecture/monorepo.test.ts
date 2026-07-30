import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  dependencies?: Record<string, string>;
  main?: string;
  name?: string;
  packageManager?: string;
  pnpm?: {
    onlyBuiltDependencies?: string[];
  };
  workspaces?: string[];
  scripts?: Record<string, string>;
}

const root = process.cwd();

describe("monorepo boundaries", () => {
  it("uses one pinned PNPM workspace and lockfile", async () => {
    const rootManifest = await manifest("package.json");
    expect(rootManifest.packageManager).toBe("pnpm@10.34.5");
    expect(rootManifest.pnpm?.onlyBuiltDependencies).toEqual([
      "electron",
      "electron-winstaller",
      "esbuild",
      "node-pty",
    ]);
    expect(await readFile(path.join(root, "pnpm-workspace.yaml"), "utf8")).toBe(
      "packages:\n  - 'apps/*'\n  - 'packages/*'\n",
    );
    await expect(access(path.join(root, "pnpm-lock.yaml"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "package-lock.json"))).rejects.toThrow();
  });

  it("declares independently runnable runtime, server, and client workspaces", async () => {
    const rootManifest = await manifest("package.json");
    expect(rootManifest.workspaces).toBeUndefined();

    const workspaceNames = await Promise.all(
      [
        "apps/runtime/package.json",
        "apps/server/package.json",
        "apps/desktop-electron/package.json",
        "apps/web/package.json",
        "apps/tray/package.json",
        "packages/protocol/package.json",
      ].map(async (file) => (await manifest(file)).name),
    );

    expect(workspaceNames).toEqual([
      "@soloe/runtime",
      "@soloe/server",
      "@soloe/desktop-electron",
      "@soloe/web",
      "@soloe/tray",
      "@soloe/protocol",
    ]);
  });

  it("reserves mobile for a future native application without a workspace package", async () => {
    expect(await readdir(path.join(root, "apps/mobile"))).toEqual([".gitkeep"]);
  });

  it("keeps development lifecycle commands independently addressable", async () => {
    const rootManifest = await manifest("package.json");
    expect(rootManifest.scripts).toEqual(
      expect.objectContaining({
        "dev:runtime": "pnpm --filter @soloe/runtime dev",
        "dev:server": "pnpm --filter @soloe/server dev",
        "dev:web": "pnpm --filter @soloe/web dev",
        "dev:desktop": "pnpm --filter @soloe/desktop-electron dev",
        "dev:tray": "pnpm --filter @soloe/tray dev",
      }),
    );
  });

  it("links internal packages only through the workspace protocol", async () => {
    const rootManifest = await manifest("package.json");
    const runtimeManifest = await manifest("apps/runtime/package.json");
    const serverManifest = await manifest("apps/server/package.json");
    const desktopManifest = await manifest("apps/desktop-electron/package.json");

    expect(rootManifest.dependencies?.["@soloe/runtime"]).toBe("workspace:*");
    expect(rootManifest.dependencies?.["@soloe/protocol"]).toBe("workspace:*");
    expect(rootManifest.dependencies?.["@lezer/highlight"]).toBe("^1.2.3");
    expect(rootManifest.dependencies?.["@codemirror/lang-html"]).toBe("^6.4.11");
    expect(runtimeManifest.dependencies?.["@soloe/protocol"]).toBe("workspace:*");
    expect(serverManifest.dependencies?.["@soloe/runtime"]).toBe("workspace:*");
    expect(serverManifest.dependencies?.["@soloe/protocol"]).toBe("workspace:*");
    expect(desktopManifest.dependencies?.["@soloe/runtime"]).toBe("workspace:*");
    expect(desktopManifest.main).toBe("../../out/main/main.js");

    for (const file of [
      "apps/server/src/SoloeServer.ts",
      "apps/server/src/SoloeServer.test.ts",
      "apps/server/src/main.ts",
      "electron/main.ts",
      "electron/terminal/RemoteRuntimePtyProcessFactory.ts",
      "electron/terminal/RemoteRuntimePtyProcessFactory.test.ts",
      "electron/terminal/TerminalReplayBuffer.ts",
    ]) {
      const source = await readFile(path.join(root, file), "utf8");
      expect(source, file).not.toMatch(/apps\/runtime\/src|\.\.\/\.\.\/runtime\/src/);
    }
  });

  it("bundles source-only runtime code into the Electron main process", async () => {
    const config = await readFile(path.join(root, "electron.vite.config.ts"), "utf8");

    expect(config).toContain(
      "externalizeDepsPlugin({ exclude: ['@soloe/runtime'] })",
    );
  });

  it("keeps tray, Tauri hooks, and benchmark tooling on PNPM", async () => {
    const integrationFiles = [
      "apps/tray/src-tauri/src/services.rs",
      "src-tauri/tauri.conf.json",
      "benchmarks/README.md",
      "scripts/benchmark-electron.mjs",
      "scripts/benchmark-tauri.mjs",
    ];

    for (const file of integrationFiles) {
      const source = await readFile(path.join(root, file), "utf8");
      expect(source, file).toContain("pnpm");
      expect(source, file).not.toMatch(/\bnpm(?:\.cmd)?\b/);
    }
  });
});

async function manifest(relativePath: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as PackageManifest;
}
