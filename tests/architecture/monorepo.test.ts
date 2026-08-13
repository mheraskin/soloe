import { execFileSync } from "node:child_process";
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

  it("externalizes packaged Electron dependencies from the desktop workspace", () => {
    const external = resolvedElectronMainExternals();

    expect(external).toEqual(
      expect.arrayContaining(["electron", "node-pty", "smol-toml", "ws"]),
    );
    expect(external).not.toContain("@soloe/domain");
    expect(external).not.toContain("@soloe/protocol");
    expect(external).not.toContain("@soloe/runtime");
  });

  it("keeps the packaged renderer loaded while Device clients connect independently", async () => {
    const main = await readFile(path.join(root, "electron/main.ts"), "utf8");

    expect(main).not.toContain("await win.loadURL(remoteServerUrl)");
    expect(main).toContain("await win.loadFile(path.join(__dirname, '../renderer/index.html'))");
    expect(main).toContain("SOLOE_CLIENT_TAILSCALE_SESSION");
  });

  it("shows the application shell before loading deferred renderer modules", async () => {
    const main = await readFile(path.join(root, "src/main.ts"), "utf8");
    const skeletonMount = main.indexOf("mount(AppSkeleton");
    const deferredModules = main.indexOf("await Promise.all");

    expect(skeletonMount).toBeGreaterThan(-1);
    expect(deferredModules).toBeGreaterThan(skeletonMount);
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

function resolvedElectronMainExternals(): string[] {
  const configFile = path.join(root, "electron.vite.config.ts");
  const script = `
    import { resolveConfig as resolveElectronConfig } from "electron-vite";
    import { resolveConfig as resolveViteConfig } from "vite";

    const electron = await resolveElectronConfig(
      { configFile: ${JSON.stringify(configFile)} },
      "build",
    );
    if (!electron.config?.main) throw new Error("Electron main config is missing");
    const vite = await resolveViteConfig(electron.config.main, {
      command: "build",
      mode: "production",
    });
    process.stdout.write(JSON.stringify((vite.build.rollupOptions.external ?? []).map(String)));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.join(root, "apps/desktop-electron"),
    encoding: "utf8",
  });
  return JSON.parse(output) as string[];
}
