import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FeatureArtifactObservation, HookInstaller } from "@soloe/domain";
import { TerminalInputLeaseManager } from "@soloe/runtime";
import { hostPlatform } from "../../../shared/platform.js";
import { SERVER_RPC_METHODS } from "../../../shared/api-contract.js";
import { terminalControlProof, type TerminalInputLease } from "../../../shared/types/terminal.js";
import type { WorktreeOverview } from "../../../shared/types/overview.js";
import { SoloeDomain } from "./SoloeDomain.js";

describe("SoloeDomain", () => {
  it("applies the configured Terminal replay retention to Runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-replay-retention-"));
    const setReplayUnbounded = vi.fn(async () => true);
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime: {
        start: vi.fn(),
        listRunning: vi.fn(async () => []),
        replay: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        stop: vi.fn(),
        setReplayUnbounded,
      },
    });

    try {
      await domain.init();
      expect(setReplayUnbounded).toHaveBeenLastCalledWith(true);
      setReplayUnbounded.mockClear();

      await domain.invoke({
        namespace: "settings",
        method: "update",
        args: [{ terminal: { keepFullHistory: false } }],
      });

      expect(setReplayUnbounded).toHaveBeenCalledWith(false);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes a Device localhost port through the network RPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-network-"));
    const ensure = vi.fn(async (port: number) => ({
      state: "ready" as const,
      message: null,
      setupUrl: null,
      dnsName: "xps.tailnet.ts.net",
      port,
      forwarded: true,
    }));
    const domain = new SoloeDomain({
      dataDirectory: directory,
      deviceId: "11111111-1111-4111-8111-111111111111",
      runtime: {
        start: vi.fn(),
        listRunning: vi.fn(async () => []),
        replay: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        stop: vi.fn(),
      },
      tailscalePorts: { ensure },
    });

    try {
      await domain.init();
      await expect(domain.invoke({
        namespace: "network",
        method: "ensureTailscalePort",
        args: [3000],
      })).resolves.toEqual({
        deviceId: "11111111-1111-4111-8111-111111111111",
        state: "ready",
        message: null,
        setupUrl: null,
        dnsName: "xps.tailnet.ts.net",
        port: 3000,
        forwarded: true,
      });
      expect(ensure).toHaveBeenCalledWith(3000);
      await expect(domain.invoke({
        namespace: "network",
        method: "ensureTailscalePort",
        args: [0],
      })).rejects.toMatchObject({ code: "invalid_network_port" });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("arbitrates terminal input by authenticated client and supports explicit takeover", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-terminal-lease-"));
    let leaseSequence = 0;
    const leases = new TerminalInputLeaseManager({
      leaseId: () => `lease-${++leaseSequence}`,
    });
    const acceptedInput: string[] = [];
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      screenSnapshot: vi.fn(async (terminalId: string) => ({
        kind: "xterm-vt-state-v1" as const,
        terminalId,
        sessionId: "session-1",
        cols: 100,
        rows: 30,
        toSeq: 7,
        data: "restored",
      })),
      acquireInputLease: vi.fn(async (
        terminalId: string,
        ownerId: string,
        takeover = false,
        controller: { deviceId: string; deviceName: string; ownerDeviceId: string } = {
          deviceId: ownerId,
          deviceName: ownerId,
          ownerDeviceId: ownerId,
        },
      ) => leases.acquire(terminalId, ownerId, {
        takeover,
        sessionId: "session-1",
        ownerDeviceId: controller.ownerDeviceId,
        controllerDeviceId: controller.deviceId,
        controllerDeviceName: controller.deviceName,
        cols: 100,
        rows: 30,
      })),
      currentInputLease: vi.fn(async (terminalId: string) => leases.current(terminalId)),
      releaseInputLease: vi.fn(async (
        terminalId: string,
        control: import("../../../shared/types/terminal.js").TerminalControlProof,
      ) => leases.release(terminalId, control)),
      parkInputLease: vi.fn(async (
        terminalId: string,
        control: import("../../../shared/types/terminal.js").TerminalControlProof,
      ) => leases.park(terminalId, control)),
      releaseInputLeases: vi.fn(async (ownerId: string) =>
        leases.releaseTransportClient(ownerId)),
      write: vi.fn(async (
        terminalId: string,
        data: string,
        control: import("../../../shared/types/terminal.js").TerminalControlProof,
      ) => {
        leases.authorizeControl(terminalId, control, "input");
        acceptedInput.push(data);
      }),
      resize: vi.fn(async (
        terminalId: string,
        cols: number,
        rows: number,
        control: import("../../../shared/types/terminal.js").TerminalControlProof,
      ) => leases.resize(terminalId, control, cols, rows)),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      deviceId: "11111111-1111-4111-8111-111111111111",
    });

    try {
      await domain.init();
      const firstLease = await domain.invoke({
        namespace: "terminal",
        method: "acquireInputLease",
        args: ["terminal-1", false, { deviceId: "device-a", deviceName: "MacBook Pro" }],
        clientId: "client-a",
      }) as TerminalInputLease;
      await expect(domain.invoke({
        namespace: "terminal",
        method: "input",
        args: ["terminal-1", "first", terminalControlProof(firstLease)],
        clientId: "client-a",
      })).resolves.toBe(true);
      await expect(domain.invoke({
        namespace: "terminal",
        method: "input",
        args: ["terminal-1", "racing", {
          ...terminalControlProof(firstLease),
          controllerDeviceId: "device-b",
        }],
        clientId: "client-b",
      })).rejects.toMatchObject({ code: "terminal_control_lease_stale" });
      await expect(domain.invoke({
        namespace: "terminal",
        method: "resize",
        args: ["terminal-1", 80, 24, {
          ...terminalControlProof(firstLease),
          controllerDeviceId: "device-b",
        }],
        clientId: "client-b",
      })).rejects.toMatchObject({ code: "terminal_control_lease_stale" });

      const secondLease = await domain.invoke({
        namespace: "terminal",
        method: "acquireInputLease",
        args: ["terminal-1", true, { deviceId: "device-b", deviceName: "iPad" }],
        clientId: "client-b",
      }) as TerminalInputLease;
      expect(secondLease).toMatchObject({ controllerDeviceId: "device-b" });
      await expect(domain.invoke({
        namespace: "terminal",
        method: "input",
        args: ["terminal-1", "second", terminalControlProof(secondLease)],
        clientId: "client-b",
      })).resolves.toBe(true);
      await expect(domain.invoke({
        namespace: "terminal",
        method: "resize",
        args: ["terminal-1", 90, 28, terminalControlProof(secondLease)],
        clientId: "client-b",
      })).resolves.toBe(true);
      await expect(domain.invoke({
        namespace: "terminal",
        method: "currentInputLease",
        args: ["terminal-1"],
      })).resolves.toMatchObject({ controllerDeviceId: "device-b" });

      await expect(domain.invoke({
        namespace: "terminal",
        method: "screenSnapshot",
        args: ["terminal-1"],
        clientId: "spectator-client",
      })).resolves.toMatchObject({ toSeq: 7, data: "restored" });
      await expect(domain.invoke({
        namespace: "terminal",
        method: "parkInputLease",
        args: ["terminal-1", terminalControlProof(secondLease)],
        clientId: "client-b",
      })).resolves.toBe(true);
      expect(leases.current("terminal-1")).toBeNull();

      domain.releaseClient("client-b");
      expect(leases.current("terminal-1")).toBeNull();
      expect(acceptedInput).toEqual(["first", "second"]);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates a preallocated placed Session idempotently through the server contract", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-placed-session-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    const request = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      draft: {
        name: "Placed",
        cwd: directory,
        runMode: hostPlatform(),
        launch: { type: "terminal", shell: "auto" },
      },
    };
    try {
      await domain.init();
      const first = await domain.invoke({
        namespace: "sessions",
        method: "createPlaced",
        args: [request],
      });
      const retried = await domain.invoke({
        namespace: "sessions",
        method: "createPlaced",
        args: [request],
      });

      expect(retried).toEqual(first);
      await expect(domain.invoke({
        namespace: "sessions",
        method: "createPlaced",
        args: [{ ...request, draft: { ...request.draft, name: "Different" } }],
      })).rejects.toThrow("different placement intent");
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts the remote wire representation for clearing a Session color", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-session-color-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });

    try {
      await domain.init();
      const created = await domain.invoke({
        namespace: "sessions",
        method: "create",
        args: [{
          name: "Colored",
          cwd: directory,
          runMode: hostPlatform(),
          launch: { type: "terminal", shell: "auto" },
          color: "violet",
        }],
      }) as { id: string };

      const updated = await domain.invoke({
        namespace: "sessions",
        method: "update",
        args: [created.id, { color: null }],
      }) as { color?: string };

      expect(updated.color).toBeUndefined();
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("adopts legacy Projects and Sessions into its Device Workspace registry", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-workspaces-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const legacy = new SoloeDomain({ dataDirectory: directory, runtime });

    try {
      await legacy.init();
      const project = (await legacy.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Compiler", path: directory }],
      })) as { id: string };
      const session = (await legacy.invoke({
        namespace: "sessions",
        method: "create",
        args: [{
          name: "Main shell",
          cwd: directory,
          runMode: hostPlatform(),
          projectId: project.id,
          launch: { type: "terminal", shell: "auto" },
        }],
      })) as { id: string };
      await legacy.dispose();

      const deviceId = "11111111-1111-4111-8111-111111111111";
      const deviceDomain = new SoloeDomain({ dataDirectory: directory, runtime, deviceId });
      try {
        await deviceDomain.init();
        const snapshot = await deviceDomain.invoke({
          namespace: "workspaceDevice",
          method: "snapshot",
          args: [],
        });
        expect(snapshot).toEqual(expect.objectContaining({
          deviceId,
          repositories: [expect.objectContaining({ legacyProjectId: project.id })],
          checkouts: [expect.objectContaining({ path: directory, role: "main" })],
        }));
        await expect(deviceDomain.invoke({
          namespace: "sessions",
          method: "get",
          args: [session.id],
        })).resolves.toEqual(expect.objectContaining({
          version: 2,
          source: expect.objectContaining({
            kind: "existing-checkout",
            adopted: true,
          }),
        }));

        const later = (await deviceDomain.invoke({
          namespace: "sessions",
          method: "create",
          args: [{
            name: "Later worktree",
            cwd: path.join(directory, "later"),
            runMode: hostPlatform(),
            projectId: project.id,
            launch: { type: "terminal", shell: "auto" },
          }],
        })) as { id: string; source?: unknown };
        expect(later.source).toEqual(expect.objectContaining({
          kind: "existing-checkout",
          adopted: true,
        }));
        await expect(deviceDomain.invoke({
          namespace: "workspaceDevice",
          method: "snapshot",
          args: [],
        })).resolves.toEqual(expect.objectContaining({
          checkouts: expect.arrayContaining([
            expect.objectContaining({ path: path.join(directory, "later") }),
          ]),
        }));
      } finally {
        await deviceDomain.dispose();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("implements every RPC required during shared UI startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-startup-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };

    const integrationStatus = {
      hosts: [
        {
          host: {
            kind: "linux" as const,
            label: "Backend",
            available: true,
          },
          claude: { installed: false, current: false },
          codex: { installed: false, current: false },
        },
      ],
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      modelCatalog: { getCatalog: vi.fn(async () => []) },
      integrationInstaller: {
        status: vi.fn(async () => integrationStatus),
        installClaude: vi.fn(),
        uninstallClaude: vi.fn(),
        installCodex: vi.fn(),
        uninstallCodex: vi.fn(),
      },
    });
    try {
      await domain.init();

      await expect(
        Promise.all([
          domain.invoke({ namespace: "system", method: "platform", args: [] }),
          domain.invoke({ namespace: "settings", method: "get", args: [] }),
          domain.invoke({ namespace: "settings", method: "modelCatalog", args: [] }),
          domain.invoke({ namespace: "projects", method: "list", args: [] }),
          domain.invoke({ namespace: "sessions", method: "list", args: [] }),
          domain.invoke({ namespace: "sessions", method: "listArchived", args: [] }),
          domain.invoke({ namespace: "terminal", method: "listRunning", args: [] }),
          domain.invoke({ namespace: "observer", method: "list", args: [] }),
          domain.invoke({ namespace: "agentIntegration", method: "status", args: [] }),
        ]),
      ).resolves.toEqual([
        expect.any(Object),
        expect.any(Object),
        [],
        [],
        [],
        [],
        [],
        [],
        integrationStatus,
      ]);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("has a real handler for every advertised application-server RPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-contract-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      modelCatalog: { getCatalog: vi.fn(async () => []) },
      integrationInstaller: {
        status: vi.fn(async () => ({ hosts: [] })),
        installClaude: vi.fn(),
        uninstallClaude: vi.fn(),
        installCodex: vi.fn(),
        uninstallCodex: vi.fn(),
      },
      pathService: { openSessionPath: vi.fn(async () => true as const) },
      fileEditorLauncher: vi.fn(async () => {}),
    });

    try {
      await domain.init();
      for (const key of SERVER_RPC_METHODS) {
        const [namespace, method] = key.split(".");
        try {
          await domain.invoke({
            namespace: namespace!,
            method: method!,
            args: [],
            clientId: "contract-client",
          });
        } catch (error) {
          expect(error, key).not.toMatchObject({ code: "rpc_not_supported" });
        }
      }
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("strictly validates comments and diff renderer responses", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-bridge-"));
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime: {
        start: vi.fn(),
        listRunning: vi.fn(async () => []),
        replay: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        stop: vi.fn(),
      },
      integrationInstaller: {
        status: vi.fn(async () => ({ hosts: [] })),
        installClaude: vi.fn(),
        uninstallClaude: vi.fn(),
        installCodex: vi.fn(),
        uninstallCodex: vi.fn(),
      },
    });
    const requestId = "123e4567-e89b-42d3-a456-426614174000";

    try {
      await domain.init();
      await expect(
        domain.invoke({
          namespace: "comments",
          method: "sendRpcResponse",
          args: [{ requestId, result: { ok: true } }],
        }),
      ).resolves.toBe(true);
      await expect(
        domain.invoke({
          namespace: "diff",
          method: "sendRpcResponse",
          args: [
            {
              requestId,
              result: {
                ok: true,
                sessionId: "session-1",
                cwd: "/repo",
                base: "base",
                head: "head",
                commitCount: 1,
              },
            },
          ],
        }),
      ).resolves.toBe(true);

      await expect(
        domain.invoke({
          namespace: "comments",
          method: "sendRpcResponse",
          args: [
            {
              requestId,
              result: { ok: true, injected: "unexpected" },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_bridge_response" });
      await expect(
        domain.invoke({
          namespace: "diff",
          method: "sendRpcResponse",
          args: [
            {
              requestId,
              result: {
                ok: true,
                sessionId: "session-1",
                cwd: "/repo",
                base: "base",
                head: "head",
                commitCount: -1,
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_bridge_response" });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("manages backend agent integrations and publishes sanitized status", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-integrations-"));
    const homeDirectory = path.join(directory, "backend-home");
    await mkdir(path.join(homeDirectory, ".claude"), { recursive: true });
    await mkdir(path.join(homeDirectory, ".codex"), { recursive: true });
    await writeFile(
      path.join(homeDirectory, ".claude", "settings.json"),
      JSON.stringify({ env: { USER_SETTING: "preserved" } }),
      "utf8",
    );
    await writeFile(
      path.join(homeDirectory, ".codex", "config.toml"),
      'model = "user-choice"\n',
      "utf8",
    );
    const installer = new HookInstaller({
      hosts: [
        {
          kind: "linux",
          label: "Backend",
          homeDir: homeDirectory,
          available: true,
        },
      ],
    });
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      integrationInstaller: installer,
      cursorDiscovery: {
        detect: vi.fn(async () => ({
          available: true,
          binary: "agent",
          version: "test-version",
        })),
      },
    });
    const changes: unknown[] = [];
    domain.on("event", (name, payload) => {
      if (name === "agentIntegration.change") changes.push(payload);
    });

    try {
      await domain.init();
      const request = { host: { kind: "linux" as const } };
      const afterClaude = await domain.invoke({
        namespace: "agentIntegration",
        method: "installClaude",
        args: [request],
      });
      expect(afterClaude).toMatchObject({
        hosts: [
          {
            host: { kind: "linux", label: "Backend", available: true },
            claude: { installed: true, current: true },
            cursor: {
              installed: false,
              current: false,
              cli: {
                available: true,
                binary: "agent",
                version: "test-version",
              },
            },
          },
        ],
      });
      expect(JSON.stringify(afterClaude)).not.toContain(homeDirectory);
      expect(JSON.stringify(changes)).not.toContain(homeDirectory);

      await domain.invoke({
        namespace: "agentIntegration",
        method: "installCodex",
        args: [request],
      });
      expect(
        JSON.parse(
          await readFile(
            path.join(homeDirectory, ".claude", "settings.json"),
            "utf8",
          ),
        ).env,
      ).toEqual({ USER_SETTING: "preserved" });
      expect(
        await readFile(path.join(homeDirectory, ".codex", "config.toml"), "utf8"),
      ).toContain('model = "user-choice"');
      expect(changes).toHaveLength(2);

      await domain.invoke({
        namespace: "agentIntegration",
        method: "uninstallClaude",
        args: [request],
      });
      const finalStatus = await domain.invoke({
        namespace: "agentIntegration",
        method: "uninstallCodex",
        args: [request],
      });
      expect(finalStatus).toMatchObject({
        hosts: [
          {
            claude: { installed: false, current: false },
            codex: { installed: false, current: false },
          },
        ],
      });
      expect(changes).toHaveLength(4);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed and non-backend agent integration targets", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-integrations-"));
    const homeDirectory = path.join(directory, "backend-home");
    const installer = new HookInstaller({
      hosts: [
        {
          kind: "linux",
          label: "Backend",
          homeDir: homeDirectory,
          available: true,
        },
      ],
    });
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      integrationInstaller: installer,
    });

    try {
      await domain.init();
      for (const args of [
        [],
        [{ host: { kind: "linux" }, injected: true }],
        [{ host: { kind: "linux", distro: "Ubuntu" } }],
        [{ host: { kind: "wsl", distro: "../Ubuntu" } }],
      ]) {
        await expect(
          domain.invoke({
            namespace: "agentIntegration",
            method: "installClaude",
            args,
          }),
        ).rejects.toMatchObject({ code: "invalid_integration_request" });
      }
      await expect(
        domain.invoke({
          namespace: "agentIntegration",
          method: "installClaude",
          args: [{ host: { kind: "windows" } }],
        }),
      ).rejects.toMatchObject({ code: "integration_host_not_found" });
      await expect(
        domain.invoke({
          namespace: "agentIntegration",
          method: "status",
          args: [{}],
        }),
      ).rejects.toMatchObject({ code: "invalid_integration_request" });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates and returns backend process usage through system RPC", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-usage-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const usageObservation = {
      observe: vi.fn(async () => ({
        scope: "backend" as const,
        availability: "available" as const,
        backendPlacement: "native" as const,
        cpuPercent: 3,
        memoryBytes: 1024,
        processCount: 2,
        electronProcessCount: null,
        childProcessCount: 1,
        components: [],
        wslActive: false,
        wsl: null,
        sampledAt: "2026-07-31T12:00:00.000Z",
      })),
      reset: vi.fn(),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      usageObservation,
    });
    try {
      await domain.init();
      await expect(
        domain.invoke({
          namespace: "system",
          method: "usage",
          args: [{ detail: "summary" }],
        }),
      ).resolves.toMatchObject({
        scope: "backend",
        availability: "available",
        electronProcessCount: null,
      });
      expect(usageObservation.observe).toHaveBeenCalledWith({
        detail: "summary",
      });

      await expect(
        domain.invoke({
          namespace: "system",
          method: "usage",
          args: [{ detail: "browser-processes" }],
        }),
      ).rejects.toMatchObject({ code: "invalid_system_usage_request" });
      await expect(
        domain.invoke({
          namespace: "system",
          method: "usage",
          args: [{ detail: "summary", injected: true }],
        }),
      ).rejects.toMatchObject({ code: "invalid_system_usage_request" });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens only session-owned backend paths and reports available WSL hosts", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-system-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const pathService = {
      openSessionPath: vi.fn(async () => true as const),
    };
    const wslHostDetector = {
      detect: vi.fn(async () => [
        {
          distro: "Ubuntu",
          homeUnc: "\\\\wsl.localhost\\Ubuntu\\home\\user",
          homeLinux: "/home/user",
          available: true,
        },
        {
          distro: "Unavailable",
          homeUnc: null,
          homeLinux: null,
          available: false,
          reason: "offline",
        },
      ]),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      pathService,
      wslHostDetector,
    });

    try {
      await domain.init();
      await expect(
        domain.invoke({
          namespace: "system",
          method: "openPath",
          args: ["session-1"],
        }),
      ).resolves.toBe(true);
      expect(pathService.openSessionPath).toHaveBeenCalledWith("session-1");
      await expect(
        domain.invoke({
          namespace: "system",
          method: "listWslDistros",
          args: [],
        }),
      ).resolves.toEqual(
        process.env.WSL_DISTRO_NAME?.trim()
          ? [process.env.WSL_DISTRO_NAME.trim()]
          : ["Ubuntu"],
      );

      for (const args of [[], ["/arbitrary/path"], ["bad\0id"], ["session-1", "extra"]]) {
        await expect(
          domain.invoke({
            namespace: "system",
            method: "openPath",
            args,
          }),
        ).rejects.toMatchObject({
          code:
            args.length === 1
              ? "invalid_system_path_request"
              : "invalid_rpc_arguments",
        });
      }
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serves bounded redacted diagnostics without exposing host paths", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-diagnostics-"));
    const crashDirectory = path.join(directory, "crashes");
    await mkdir(crashDirectory);
    await writeFile(
      path.join(directory, "server.log"),
      `request complete token=server-secret\n${"x".repeat(80)}`,
      "utf8",
    );
    await writeFile(
      path.join(crashDirectory, "server-crash.log"),
      "Authorization: Bearer crash-secret\n",
      "utf8",
    );
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });

    try {
      await domain.init();

      await expect(
        domain.invoke({
          namespace: "diagnostics",
          method: "list",
          args: [],
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          id: "crashes.recent",
          severity: "warn",
        }),
      ]);

      const logs = await domain.invoke({
        namespace: "diagnostics",
        method: "crashLogs",
        args: [{ tailBytes: 48 }],
      });
      expect(logs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            fileName: "server.log",
            service: "server",
            truncated: true,
          }),
          expect.objectContaining({
            fileName: "server-crash.log",
            service: "crash",
            severity: "error",
          }),
        ]),
      );
      expect(JSON.stringify(logs)).not.toContain(directory);
      expect(JSON.stringify(logs)).not.toMatch(/server-secret|crash-secret/u);

      for (const request of [{ tailBytes: 65_537 }, { path: "/etc/passwd" }]) {
        await expect(
          domain.invoke({
            namespace: "diagnostics",
            method: "crashLogs",
            args: [request],
          }),
        ).rejects.toMatchObject({ code: "invalid_diagnostics_request" });
      }
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns encrypted Vault CRUD and publishes secret-free metadata changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-vault-"));
    const outside = await mkdtemp(path.join(tmpdir(), "soloe-domain-vault-outside-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    const published: Array<{ event: string; payload: unknown }> = [];
    domain.on("event", (event, payload) => published.push({ event, payload }));

    try {
      await domain.init();
      await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Vault project", path: directory }],
      });

      const saved = (await domain.invoke({
        namespace: "vault",
        method: "save",
        args: [{
          cwd: directory,
          draft: {
            origin: "https://example.test/sign-in",
            username: "ada",
            password: "vault-secret",
            label: "primary",
          },
        }],
      })) as { id: string };

      const listed = await domain.invoke({
        namespace: "vault",
        method: "list",
        args: [{ cwd: directory }],
      });
      expect(listed).toEqual([
        expect.objectContaining({
          id: saved.id,
          origin: "https://example.test",
          username: "ada",
          label: "primary",
        }),
      ]);
      expect(JSON.stringify(listed)).not.toContain("vault-secret");

      await expect(
        domain.invoke({
          namespace: "vault",
          method: "getSecret",
          args: [{ cwd: directory, id: saved.id }],
        }),
      ).resolves.toEqual({ username: "ada", password: "vault-secret" });

      await expect(
        domain.invoke({
          namespace: "vault",
          method: "update",
          args: [{
            cwd: directory,
            id: saved.id,
            patch: { username: "grace", password: "replacement-secret" },
          }],
        }),
      ).resolves.toMatchObject({ username: "grace" });
      await expect(
        domain.invoke({
          namespace: "vault",
          method: "delete",
          args: [{ cwd: directory, id: saved.id }],
        }),
      ).resolves.toBe(true);

      expect(published.filter(({ event }) => event === "vault.change")).toHaveLength(3);
      expect(JSON.stringify(published)).not.toMatch(
        /vault-secret|replacement-secret/u,
      );
      const vaultFile = (await readdir(path.join(directory, "vault"))).find(
        (entry) => entry.endsWith(".json"),
      );
      expect(vaultFile).toBeTruthy();
      expect(
        await readFile(path.join(directory, "vault", vaultFile!), "utf8"),
      ).not.toMatch(/vault-secret|replacement-secret/u);

      await expect(
        domain.invoke({
          namespace: "vault",
          method: "list",
          args: [{ cwd: outside }],
        }),
      ).rejects.toMatchObject({ code: "vault_scope_not_authorized" });
      for (const request of [
        { cwd: "../relative" },
        { cwd: directory, arbitraryPath: "/etc/passwd" },
      ]) {
        await expect(
          domain.invoke({
            namespace: "vault",
            method: "list",
            args: [request],
          }),
        ).rejects.toMatchObject({ code: "invalid_vault_request" });
      }
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("serves authorized Overview reads and client-scoped stream chunks", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-overview-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const overview = overviewFixture(directory);
    const overviewService = {
      getOverview: vi.fn(async () => overview),
      regenerate: vi.fn(async () => ({ ...overview, status: "fresh" as const })),
      streamFollowUp: vi.fn(async function* () {
        yield { type: "delta" as const, text: "answer" };
        yield { type: "done" as const };
      }),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      overviewService,
    });
    const targeted: Array<{
      clientId: string;
      event: string;
      payload: unknown;
    }> = [];
    domain.on("targeted-event", (clientId, event, payload) => {
      targeted.push({ clientId, event, payload });
    });

    try {
      await domain.init();
      await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Overview project", path: directory }],
      });
      const request = {
        worktreeCwd: directory,
        runMode: hostPlatform(),
        sessions: [],
      };

      await expect(
        domain.invoke({
          namespace: "overview",
          method: "get",
          args: [request],
        }),
      ).resolves.toMatchObject({ status: "cached" });
      const started = (await domain.invoke({
        namespace: "overview",
        method: "askStart",
        args: [{ ...request, message: "What changed?", history: [] }],
        clientId: "overview-client",
      })) as { requestId: string };

      await vi.waitFor(() => expect(targeted).toHaveLength(2));
      expect(targeted).toEqual([
        {
          clientId: "overview-client",
          event: "overview.chunk",
          payload: {
            requestId: started.requestId,
            type: "delta",
            text: "answer",
          },
        },
        {
          clientId: "overview-client",
          event: "overview.chunk",
          payload: { requestId: started.requestId, type: "done" },
        },
      ]);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("cancels an interrupted Overview stream and rejects unsafe requests", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-overview-"));
    const outside = await mkdtemp(path.join(tmpdir(), "soloe-domain-outside-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    let aborted = false;
    const overviewService = {
      getOverview: vi.fn(async () => overviewFixture(directory)),
      regenerate: vi.fn(async () => overviewFixture(directory)),
      streamFollowUp: vi.fn(async function* (
        _request: unknown,
        signal?: AbortSignal,
      ) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }, { once: true });
        });
      }),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      overviewService,
    });
    const targeted = vi.fn();
    domain.on("targeted-event", targeted);

    try {
      await domain.init();
      await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Overview project", path: directory }],
      });
      const request = {
        worktreeCwd: directory,
        runMode: hostPlatform(),
        sessions: [],
        message: "Continue",
        history: [],
      };
      const started = (await domain.invoke({
        namespace: "overview",
        method: "askStart",
        args: [request],
        clientId: "stream-owner",
      })) as { requestId: string };

      await domain.invoke({
        namespace: "overview",
        method: "askCancel",
        args: [started.requestId],
        clientId: "different-client",
      });
      expect(aborted).toBe(false);

      domain.recoverClient("stream-owner");
      await vi.waitFor(() => expect(aborted).toBe(true));
      expect(targeted).toHaveBeenCalledWith(
        "stream-owner",
        "overview.chunk",
        expect.objectContaining({
          requestId: started.requestId,
          type: "error",
        }),
      );

      await expect(
        domain.invoke({
          namespace: "overview",
          method: "get",
          args: [{ worktreeCwd: outside, runMode: hostPlatform() }],
        }),
      ).rejects.toMatchObject({ code: "worktree_not_authorized" });
      await expect(
        domain.invoke({
          namespace: "overview",
          method: "get",
          args: [{
            worktreeCwd: directory,
            runMode: hostPlatform(),
            sessions: [{
              transcriptPath: "../secret.jsonl",
              name: "Traversal",
            }],
          }],
        }),
      ).rejects.toMatchObject({ code: "invalid_overview_request" });
      await expect(
        domain.invoke({
          namespace: "overview",
          method: "askStart",
          args: [{ ...request, message: "x".repeat(32_769) }],
          clientId: "stream-owner",
        }),
      ).rejects.toMatchObject({ code: "invalid_overview_request" });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("persists a Session and starts it through the independent runtime", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-"));
    const runtime = {
      start: vi.fn(async (input) => ({
        terminalId: "domain-terminal",
        sessionId: input.sessionId,
        pid: 7001,
        status: "running" as const,
        startedAt: "2026-07-30T10:00:00.000Z",
        spec: input.spec,
        cols: input.cols,
        rows: input.rows,
      })),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };

    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    try {
      await domain.init();
      const project = (await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Browser project", path: directory }],
      })) as { id: string };
      expect(
        await domain.invoke({ namespace: "projects", method: "list", args: [] }),
      ).toEqual([expect.objectContaining({ id: project.id, name: "Browser project" })]);

      const session = (await domain.invoke({
        namespace: "sessions",
        method: "create",
        args: [
          {
            name: "Browser terminal",
            cwd: directory,
            runMode: hostPlatform(),
            launch: { type: "terminal", shell: "auto" },
          },
        ],
      })) as { id: string };

      const started = await domain.invoke({
        namespace: "terminal",
        method: "start",
        args: [{ sessionId: session.id, cols: 100, rows: 30 }],
      });

      expect(started).toEqual(
        expect.objectContaining({
          terminalId: "domain-terminal",
          sessionId: session.id,
          pid: 7001,
        }),
      );
      expect(runtime.start).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          spec: expect.objectContaining({
            file: expect.any(String),
            cwd: directory,
          }),
          cols: 100,
          rows: 30,
        }),
      );
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("projects a Cursor terminal approval prompt into the observer state", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-cursor-approval-"));
    const runtime = Object.assign(new EventEmitter(), {
      start: vi.fn(async (input) => ({
        terminalId: "cursor-terminal",
        sessionId: input.sessionId,
        pid: 7002,
        status: "running" as const,
        startedAt: "2026-08-17T10:00:00.000Z",
        spec: input.spec,
        cols: input.cols,
        rows: input.rows,
      })),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    });
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      cursorDiscovery: {
        detect: vi.fn(async () => ({
          available: true,
          binary: "agent",
          version: "2026.08.11",
        })),
      },
    });

    try {
      await domain.init();
      const session = (await domain.invoke({
        namespace: "sessions",
        method: "create",
        args: [{
          name: "Cursor",
          cwd: directory,
          runMode: hostPlatform(),
          launch: { type: "agent", provider: "cursor", resumeMode: "new" },
        }],
      })) as { id: string };
      await domain.invoke({
        namespace: "terminal",
        method: "start",
        args: [{ sessionId: session.id, cols: 100, rows: 30 }],
      });

      runtime.emit("output", {
        terminalId: "cursor-terminal",
        sessionId: session.id,
        seq: 1,
        data: "\u001b[35mRun this command?\u001b[0m\nNot in allowlist: head",
      });

      expect(
        await domain.invoke({ namespace: "observer", method: "list", args: [] }),
      ).toEqual([
        expect.objectContaining({
          id: session.id,
          state: "waiting_for_approval",
        }),
      ]);

      await domain.invoke({
        namespace: "terminal",
        method: "input",
        args: ["cursor-terminal", "\r", {
          sessionId: session.id,
          ownerDeviceId: "device-xps",
          controllerDeviceId: "device-local",
          leaseId: "lease-1",
        }],
        clientId: "client-local",
      });
      expect(
        await domain.invoke({ namespace: "observer", method: "list", args: [] }),
      ).toEqual([
        expect.objectContaining({
          id: session.id,
          state: "working",
        }),
      ]);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a remote Claude working state when its terminal renders the idle prompt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-claude-idle-"));
    const runtime = Object.assign(new EventEmitter(), {
      start: vi.fn(async (input) => ({
        terminalId: "claude-terminal",
        sessionId: input.sessionId,
        pid: 7003,
        status: "running" as const,
        startedAt: "2026-08-17T10:00:00.000Z",
        spec: input.spec,
        cols: input.cols,
        rows: input.rows,
      })),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    });
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });

    try {
      await domain.init();
      const session = (await domain.invoke({
        namespace: "sessions",
        method: "create",
        args: [{
          name: "Claude",
          cwd: directory,
          runMode: hostPlatform(),
          launch: { type: "agent", provider: "claude_code", resumeMode: "new" },
        }],
      })) as { id: string };
      await domain.invoke({
        namespace: "terminal",
        method: "start",
        args: [{ sessionId: session.id, cols: 100, rows: 30 }],
      });
      const observer = (domain as unknown as {
        observer: { setTuiObservedState(id: string, state: "working", summary: string): void };
      }).observer;
      observer.setTuiObservedState(session.id, "working", "thinking");
      expect(
        await domain.invoke({ namespace: "observer", method: "list", args: [] }),
      ).toEqual([
        expect.objectContaining({ id: session.id, state: "working" }),
      ]);

      runtime.emit("output", {
        terminalId: "claude-terminal",
        sessionId: session.id,
        seq: 1,
        data: "\u001b[2K\r❯ ",
      });

      expect(
        await domain.invoke({ namespace: "observer", method: "list", args: [] }),
      ).toEqual([
        expect.objectContaining({ id: session.id, state: "idle" }),
      ]);
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns observer snapshots, events, and worker operations in the server domain", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-observer-"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    const published: Array<{ event: string; payload: unknown }> = [];
    domain.on("event", (event, payload) => published.push({ event, payload }));

    try {
      await domain.init();
      const session = (await domain.invoke({
        namespace: "sessions",
        method: "create",
        args: [
          {
            name: "Observed terminal",
            cwd: directory,
            runMode: hostPlatform(),
            launch: { type: "terminal", shell: "auto" },
          },
        ],
      })) as { id: string };

      expect(
        await domain.invoke({ namespace: "observer", method: "list", args: [] }),
      ).toEqual([
        expect.objectContaining({
          id: session.id,
          subjectKind: "session",
          runtimeMode: "tui",
        }),
      ]);

      const worker = (await domain.invoke({
        namespace: "observer",
        method: "createWorkerSession",
        args: [
          {
            originSessionId: session.id,
            provider: "codex",
            promptSummary: "Review the change",
          },
        ],
      })) as { workerId: string };
      expect(
        await domain.invoke({
          namespace: "observer",
          method: "getWorkerStatus",
          args: [worker.workerId],
        }),
      ).toEqual({
        snapshot: expect.objectContaining({
          workerId: worker.workerId,
          originSessionId: session.id,
        }),
      });
      expect(
        await domain.invoke({
          namespace: "observer",
          method: "listEvents",
          args: [{ subjectId: worker.workerId }],
        }),
      ).toEqual([
        expect.objectContaining({
          subjectId: worker.workerId,
          summary: "worker registered",
        }),
      ]);
      expect(published).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "observer.snapshot" }),
          expect.objectContaining({ event: "observer.event" }),
        ]),
      );
      for (const call of [
        {
          namespace: "observer",
          method: "listEvents",
          args: [{ limit: 1_001 }],
        },
        {
          namespace: "observer",
          method: "listEvents",
          args: [{ subjectId: worker.workerId, unexpected: true }],
        },
        {
          namespace: "observer",
          method: "createWorkerSession",
          args: [{ originSessionId: session.id, provider: "unknown" }],
        },
        {
          namespace: "observer",
          method: "sendWorkerPrompt",
          args: [{ workerId: worker.workerId, prompt: "x".repeat(131_073) }],
        },
      ]) {
        await expect(domain.invoke(call)).rejects.toMatchObject({
          code: "invalid_observer_request",
        });
      }
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns file tree, search, read, write, and terminal paste operations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-files-"));
    const worktree = path.join(directory, "worktree");
    const outside = path.join(directory, "outside");
    await mkdir(path.join(worktree, "src"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(worktree, "src", "app.ts"), "export const app = true;\n");
    await writeFile(path.join(outside, "secret.txt"), "outside\n");
    await symlink(outside, path.join(worktree, "escape"));

    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => [
        {
          terminalId: "files-terminal",
          sessionId: "files-session",
          pid: 7002,
          status: "running" as const,
          startedAt: "2026-07-31T00:00:00.000Z",
          spec: { file: "shell", args: [], cwd: worktree, env: {} },
          cols: 100,
          rows: 30,
        },
      ]),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const fileEditorLauncher = vi.fn(async () => {});
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      fileEditorLauncher,
    });

    try {
      await domain.init();
      await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Files project", path: worktree }],
      });

      const scope = { cwd: worktree, runMode: hostPlatform() };
      await expect(
        domain.invoke({ namespace: "files", method: "listTree", args: [scope] }),
      ).resolves.toEqual(
        expect.objectContaining({
          cwd: worktree,
          paths: expect.arrayContaining(["src/app.ts"]),
          truncated: false,
        }),
      );
      await expect(
        domain.invoke({
          namespace: "files",
          method: "search",
          args: [{ ...scope, query: "app", limit: 20 }],
        }),
      ).resolves.toEqual([
        expect.objectContaining({ rootPath: worktree, path: "src/app.ts" }),
      ]);
      await expect(
        domain.invoke({
          namespace: "files",
          method: "openInEditor",
          args: [
            {
              ...scope,
              absolutePath: path.join(worktree, "src", "app.ts"),
            },
          ],
        }),
      ).resolves.toBe(true);
      expect(fileEditorLauncher).toHaveBeenCalledWith(
        expect.any(String),
        await realpath(path.join(worktree, "src", "app.ts")),
      );
      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, relativePath: "src/app.ts" }],
        }),
      ).resolves.toEqual({
        relativePath: "src/app.ts",
        content: "export const app = true;\n",
        binary: false,
        truncated: false,
        oversized: false,
        unavailable: false,
        size: 25,
      });

      await domain.invoke({
        namespace: "files",
        method: "writeFile",
        args: [{ ...scope, relativePath: "src/app.ts", content: "saved\n" }],
      });
      expect(await readFile(path.join(worktree, "src", "app.ts"), "utf8")).toBe(
        "saved\n",
      );

      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, relativePath: "../outside/secret.txt" }],
        }),
      ).rejects.toMatchObject({ code: "path_traversal" });
      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, relativePath: "escape/secret.txt" }],
        }),
      ).rejects.toMatchObject({ code: "path_symlink_escape" });
      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{ ...scope, cwd: outside, relativePath: "secret.txt" }],
        }),
      ).rejects.toMatchObject({ code: "worktree_not_authorized" });
      await expect(
        domain.invoke({
          namespace: "files",
          method: "openInEditor",
          args: [
            {
              ...scope,
              absolutePath: path.join(outside, "secret.txt"),
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "path_not_authorized" });
      await expect(
        domain.invoke({
          namespace: "files",
          method: "openInEditor",
          args: [
            {
              ...scope,
              absolutePath: path.join(worktree, "src", "app.ts"),
              command: "arbitrary-shell",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_file_request" });

      await expect(
        domain.invoke({
          namespace: "files",
          method: "pasteIntoTerminal",
          args: [{
            terminalId: "files-terminal",
            path: "src/app.ts",
            control: {
              sessionId: "files-session",
              ownerDeviceId: "execution-device",
              controllerDeviceId: "controller-device",
              leaseId: "files-lease",
            },
          }],
          clientId: "files-client",
        }),
      ).resolves.toBe(true);
      expect(runtime.write).toHaveBeenCalledWith("files-terminal", "src/app.ts", {
        sessionId: "files-session",
        ownerDeviceId: "execution-device",
        controllerDeviceId: "controller-device",
        leaseId: "files-lease",
      });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns the complete Git read, mutation, history, remote, and event contract", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-git-"));
    const worktree = path.join(directory, "worktree");
    const nonRepo = path.join(directory, "non-repo");
    const remote = path.join(directory, "remote.git");
    const createdWorktree = path.join(directory, "worktree-created");
    await mkdir(worktree);
    await mkdir(nonRepo);
    git(directory, ["init", "--bare", remote]);
    git(worktree, ["init", "-b", "main"]);
    git(worktree, ["config", "user.email", "soloe@example.test"]);
    git(worktree, ["config", "user.name", "Soloe Test"]);
    git(worktree, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(worktree, "app.txt"), "one\n");
    git(worktree, ["add", "app.txt"]);
    git(worktree, ["commit", "-m", "initial"]);
    git(worktree, ["branch", "feature/checkout"]);
    git(worktree, ["remote", "add", "origin", remote]);
    const initial = git(worktree, ["rev-parse", "HEAD"]);
    const canonicalWorktree = await realpath(worktree);
    const canonicalCreatedWorktree = path.join(await realpath(directory), "worktree-created");

    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    const published: Array<{ event: string; payload: unknown }> = [];
    domain.on("event", (event, payload) => published.push({ event, payload }));

    try {
      await domain.init();
      for (const [name, projectPath] of [
        ["Git project", worktree],
        ["Non-repository project", nonRepo],
      ]) {
        await domain.invoke({
          namespace: "projects",
          method: "create",
          args: [{ name, path: projectPath }],
        });
      }
      const scope = { runMode: hostPlatform() };

      await expect(
        domain.invoke({
          namespace: "git",
          method: "status",
          args: [{ cwd: worktree, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          repoPath: canonicalWorktree,
          branch: "main",
          dirty: false,
        }),
      );
      for (const method of ["aheadBehind", "shortstat", "dirty"]) {
        await expect(
          domain.invoke({
            namespace: "git",
            method,
            args: [{ repoPath: worktree, force: true, ...scope }],
          }),
        ).resolves.toEqual(expect.objectContaining({ repoPath: canonicalWorktree, isRepo: true }));
      }
      await expect(
        domain.invoke({
          namespace: "git",
          method: "worktrees",
          args: [{ repoPath: worktree, ...scope }],
        }),
      ).resolves.toEqual([
        expect.objectContaining({ path: canonicalWorktree, branch: "main", isMain: true }),
      ]);
      await expect(
        domain.invoke({
          namespace: "git",
          method: "branches",
          args: [{ repoPath: worktree, ...scope }],
        }),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "main", current: true }),
        ]),
      );
      for (const method of ["recentCommits", "refHistory"]) {
        await expect(
          domain.invoke({
            namespace: "git",
            method,
            args: [{ repoPath: worktree, limit: 20, ...scope }],
          }),
        ).resolves.toEqual([
          expect.objectContaining({ hash: initial, subject: "initial" }),
        ]);
      }
      await expect(
        domain.invoke({
          namespace: "git",
          method: "resolveRefs",
          args: [{ cwd: worktree, refs: ["HEAD", "missing"], ...scope }],
        }),
      ).resolves.toEqual({ resolved: [initial, null] });
      await expect(
        domain.invoke({
          namespace: "files",
          method: "listTree",
          args: [{ cwd: worktree, revision: "feature/checkout", ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({ paths: ["app.txt"], isRepo: true }),
      );
      await expect(
        domain.invoke({
          namespace: "files",
          method: "readFile",
          args: [{
            cwd: worktree,
            revision: "feature/checkout",
            relativePath: "app.txt",
            ...scope,
          }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({ content: "one\n", unavailable: false }),
      );

      await writeFile(path.join(worktree, "app.txt"), "one\ntwo\n");
      await writeFile(path.join(worktree, "new.txt"), "new\n");
      await expect(
        domain.invoke({
          namespace: "git",
          method: "checkout",
          args: [{ repoPath: worktree, ref: "feature/checkout", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "dirty_checkout" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "workingTreeSnapshot",
          args: [{ cwd: worktree, force: true, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          status: expect.objectContaining({ dirty: true, unstaged: 1, untracked: 1 }),
          workingChanges: expect.objectContaining({
            changes: expect.arrayContaining([
              expect.objectContaining({ path: "app.txt", kind: "modified" }),
              expect.objectContaining({ path: "new.txt", kind: "untracked" }),
            ]),
          }),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "workingChanges",
          args: [{ cwd: worktree, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          changes: expect.arrayContaining([
            expect.objectContaining({ path: "app.txt" }),
          ]),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fileDiff",
          args: [{ cwd: worktree, path: "app.txt", ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          path: "app.txt",
          empty: false,
          hunks: expect.arrayContaining([expect.any(Object)]),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "reviewDiffs",
          args: [{ cwd: worktree, files: [{ path: "app.txt" }], ...scope }],
        }),
      ).resolves.toEqual([
        expect.objectContaining({ path: "app.txt", empty: false }),
      ]);

      await domain.invoke({
        namespace: "git",
        method: "stageFiles",
        args: [{ cwd: worktree, paths: ["app.txt", "new.txt"], ...scope }],
      });
      await domain.invoke({
        namespace: "git",
        method: "unstageFiles",
        args: [{ cwd: worktree, paths: ["app.txt", "new.txt"], ...scope }],
      });
      await domain.invoke({
        namespace: "git",
        method: "discardFiles",
        args: [
          {
            cwd: worktree,
            files: [
              { path: "app.txt", kind: "modified" },
              { path: "new.txt", kind: "untracked" },
            ],
            ...scope,
          },
        ],
      });
      expect(await readFile(path.join(worktree, "app.txt"), "utf8")).toBe("one\n");

      await writeFile(path.join(worktree, "app.txt"), "one\ntwo\n");
      const committed = (await domain.invoke({
        namespace: "git",
        method: "commit",
        args: [
          {
            cwd: worktree,
            message: "server git commit",
            stageAll: true,
            ...scope,
          },
        ],
      })) as { hash: string };
      expect(committed.hash).toMatch(/^[0-9a-f]{40}$/u);

      await expect(
        domain.invoke({
          namespace: "git",
          method: "commitsBetween",
          args: [{ cwd: worktree, base: initial, head: committed.hash, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          base: initial,
          head: committed.hash,
          commits: [expect.objectContaining({ hash: committed.hash })],
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "rangeChanges",
          args: [{ cwd: worktree, base: initial, head: committed.hash, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          changes: [expect.objectContaining({ path: "app.txt", insertions: 1 })],
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fileBlame",
          args: [{ cwd: worktree, path: "app.txt", head: committed.hash, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          head: committed.hash,
          lines: expect.arrayContaining([
            expect.objectContaining({ lineNo: 2, sha: committed.hash }),
          ]),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fileLines",
          args: [
            {
              cwd: worktree,
              path: "app.txt",
              revision: { kind: "commit", sha: committed.hash },
              startLine: 1,
              endLine: 2,
              ...scope,
            },
          ],
        }),
      ).resolves.toEqual({ lines: ["one", "two"], totalLines: 2 });

      await domain.invoke({
        namespace: "git",
        method: "push",
        args: [
          {
            cwd: worktree,
            remote: "origin",
            branch: "main",
            setUpstream: true,
            ...scope,
          },
        ],
      });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fetch",
          args: [{ cwd: worktree, remote: "origin", ...scope }],
        }),
      ).resolves.toEqual(expect.objectContaining({ stdout: expect.any(String) }));
      await expect(
        domain.invoke({
          namespace: "git",
          method: "pull",
          args: [{ cwd: worktree, remote: "origin", branch: "main", ...scope }],
        }),
      ).resolves.toEqual(expect.objectContaining({ stdout: expect.any(String) }));
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fetch",
          args: [{ cwd: worktree, remote: "missing", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "remote_failure" });

      await expect(
        domain.invoke({
          namespace: "git",
          method: "createWorktree",
          args: [
            {
              repoPath: worktree,
              path: createdWorktree,
              branch: "feature/server-worktree",
              baseRef: "main",
              ...scope,
            },
          ],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          path: canonicalCreatedWorktree,
          branch: "feature/server-worktree",
        }),
      );
      await writeFile(path.join(createdWorktree, "linked.txt"), "linked change\n");
      await expect(
        domain.invoke({
          namespace: "git",
          method: "status",
          args: [{ cwd: createdWorktree, force: true, ...scope }],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          repoPath: canonicalCreatedWorktree,
          branch: "feature/server-worktree",
          dirty: true,
          untracked: 1,
        }),
      );
      await expect(
        domain.invoke({
          namespace: "git",
          method: "checkout",
          args: [{ repoPath: worktree, ref: "feature/checkout", ...scope }],
        }),
      ).resolves.toEqual(expect.objectContaining({ branch: "feature/checkout" }));

      await expect(
        domain.invoke({
          namespace: "git",
          method: "rangeChanges",
          args: [{ cwd: worktree, base: "missing", head: "HEAD", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "invalid_revision" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "stageFiles",
          args: [{ cwd: worktree, paths: ["../outside"], ...scope }],
        }),
      ).rejects.toMatchObject({ code: "invalid_git_path" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "fetch",
          args: [{ cwd: worktree, remote: "--upload-pack=evil", ...scope }],
        }),
      ).rejects.toMatchObject({ code: "invalid_git_request" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "stageFiles",
          args: [{ cwd: nonRepo, paths: ["file.txt"], ...scope }],
        }),
      ).rejects.toMatchObject({ code: "repository_not_found" });
      await expect(
        domain.invoke({
          namespace: "git",
          method: "status",
          args: [{ cwd: directory, ...scope }],
        }),
      ).rejects.toMatchObject({ code: "worktree_not_authorized" });

      await domain.invoke({
        namespace: "git",
        method: "setObservationDemand",
        args: [
          {
            cwd: worktree,
            active: true,
            runMode: "wsl",
            wslDistro: "Ubuntu-Test",
          },
        ],
        clientId: "git-browser",
      });
      await domain.invoke({
        namespace: "git",
        method: "stageFiles",
        args: [
          {
            cwd: worktree,
            paths: ["app.txt"],
            runMode: "wsl",
            wslDistro: "Ubuntu-Test",
          },
        ],
      });
      await vi.waitFor(
        () => {
          expect(published).toContainEqual({
            event: "git.change",
            payload: {
              repoPath: canonicalWorktree,
              runMode: "wsl",
              wslDistro: "Ubuntu-Test",
            },
          });
        },
        { timeout: 1_000 },
      );
      domain.releaseClient("git-browser");
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("owns Notes CRUD, images, conflicts, authorization, and shared events", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-notes-"));
    const outside = path.join(directory, "outside.png");
    await writeFile(outside, Buffer.from(NOTE_PNG_BASE64, "base64"));
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({ dataDirectory: directory, runtime });
    const changes: unknown[] = [];
    domain.on("event", (event, payload) => {
      if (event === "notes.change") changes.push(payload);
    });

    try {
      await domain.init();
      const project = (await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Notes project", path: directory }],
      })) as { id: string };

      await expect(
        domain.invoke({
          namespace: "notes",
          method: "list",
          args: [project.id],
        }),
      ).resolves.toEqual([]);
      const created = (await domain.invoke({
        namespace: "notes",
        method: "write",
        args: [project.id, "shared.md", "first", null],
      })) as { revision: string };
      expect(created.revision).toMatch(/^[0-9a-f]{64}$/u);
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "read",
          args: [project.id, "shared.md"],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          filename: "shared.md",
          content: "first",
          revision: created.revision,
        }),
      );

      const updated = (await domain.invoke({
        namespace: "notes",
        method: "write",
        args: [project.id, "shared.md", "second", created.revision],
      })) as { revision: string };
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "write",
          args: [project.id, "shared.md", "stale", created.revision],
        }),
      ).rejects.toMatchObject({ code: "notes_conflict" });
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "read",
          args: [project.id, "shared.md"],
        }),
      ).resolves.toEqual(expect.objectContaining({ content: "second" }));

      const referenced = (await domain.invoke({
        namespace: "notes",
        method: "saveImage",
        args: [project.id, "image/png", NOTE_PNG_BASE64],
      })) as { filename: string; absolutePath: string };
      const unused = (await domain.invoke({
        namespace: "notes",
        method: "saveImage",
        args: [project.id, "image/png", NOTE_PNG_BASE64],
      })) as { absolutePath: string };
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "readImage",
          args: [referenced.absolutePath],
        }),
      ).resolves.toEqual({
        mimeType: "image/png",
        dataBase64: NOTE_PNG_BASE64,
      });
      await domain.invoke({
        namespace: "notes",
        method: "write",
        args: [
          project.id,
          "shared.md",
          `![image](${referenced.absolutePath})`,
          updated.revision,
        ],
      });
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "cleanupImages",
          args: [project.id, []],
        }),
      ).resolves.toEqual({ deleted: 1 });
      await expect(readFile(unused.absolutePath)).rejects.toMatchObject({
        code: "ENOENT",
      });

      const imageLink = path.join(
        directory,
        "notes",
        project.id,
        "images",
        "soloe-img-link.png",
      );
      await symlink(outside, imageLink);
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "readImage",
          args: [imageLink],
        }),
      ).rejects.toThrow(/escapes notes directory/iu);

      const renamed = (await domain.invoke({
        namespace: "notes",
        method: "rename",
        args: [project.id, "shared.md", "renamed.md"],
      })) as { filename: string };
      expect(renamed.filename).toBe("renamed.md");
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "delete",
          args: [project.id, "renamed.md"],
        }),
      ).resolves.toBe(true);

      expect(changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            projectId: project.id,
            notes: expect.any(Array),
          }),
        ]),
      );
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "write",
          args: [project.id, "../outside.md", "blocked"],
        }),
      ).rejects.toMatchObject({ code: "invalid_note_filename" });
      await expect(
        domain.invoke({
          namespace: "notes",
          method: "list",
          args: ["unregistered-project"],
        }),
      ).rejects.toMatchObject({ code: "project_not_found" });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("owns Feature Lab scans, mutations, subscriptions, and placement identity", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "soloe-domain-features-"));
    await mkdir(path.join(directory, "docs", "agents"), { recursive: true });
    await mkdir(path.join(directory, "docs", "grill", "alpha"), {
      recursive: true,
    });
    await mkdir(path.join(directory, "docs", "plans"), { recursive: true });
    await mkdir(path.join(directory, ".scratch", "alpha", "issues"), {
      recursive: true,
    });
    await Promise.all([
      writeFile(path.join(directory, "AGENTS.md"), "# Agent\n\n## Agent skills\n"),
      writeFile(
        path.join(directory, "docs", "agents", "issue-tracker.md"),
        "# Issue tracker\n\nUse local markdown in .scratch/.\n",
      ),
      writeFile(
        path.join(directory, "docs", "grill", "alpha", "coverage-map.md"),
        "# Coverage\n\n## Branches\n\n### 1. Core\n- [ ] 1A. First branch\n",
      ),
      writeFile(
        path.join(directory, "docs", "plans", "alpha-feature.md"),
        "# Alpha plan\n",
      ),
      writeFile(
        path.join(directory, ".scratch", "alpha", "issues", "01-first.md"),
        "# First issue\nStatus: open\n",
      ),
    ]);
    const artifacts = new FeatureArtifactObservation({
      intervalMs: 25,
      retireAfterMs: 0,
    });
    const runtime = {
      start: vi.fn(),
      listRunning: vi.fn(async () => []),
      replay: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      stop: vi.fn(),
    };
    const domain = new SoloeDomain({
      dataDirectory: directory,
      runtime,
      featureArtifacts: artifacts,
    });
    const events: unknown[] = [];
    domain.on("event", (event, payload) => {
      if (event === "features.change") events.push(payload);
    });

    try {
      await domain.init();
      await domain.invoke({
        namespace: "projects",
        method: "create",
        args: [{ name: "Feature project", path: directory }],
      });
      const scope = { cwd: directory, runMode: hostPlatform() };
      const snapshot = await domain.invoke({
        namespace: "features",
        method: "scan",
        args: [{ ...scope, slug: "alpha" }],
      });
      expect(snapshot).toEqual(
        expect.objectContaining({
          selectedSlug: "alpha",
          features: [
            expect.objectContaining({
              slug: "alpha",
              hasCoverage: true,
              hasIssues: true,
              hasPlans: true,
            }),
          ],
          setup: { hasAgentSkillsBlock: true, inFile: "AGENTS.md" },
          tracker: expect.objectContaining({ provider: "local-markdown" }),
          coverage: expect.objectContaining({
            counts: expect.objectContaining({ todo: 1 }),
          }),
          plans: [
            expect.objectContaining({
              relativePath: "docs/plans/alpha-feature.md",
            }),
          ],
          issues: [
            expect.objectContaining({
              relativePath: ".scratch/alpha/issues/01-first.md",
              status: "open",
            }),
          ],
        }),
      );

      await expect(
        domain.invoke({
          namespace: "features",
          method: "setBranchStatus",
          args: [
            {
              ...scope,
              slug: "alpha",
              branchId: "1A",
              status: "resolved",
            },
          ],
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          counts: expect.objectContaining({ resolved: 1 }),
        }),
      );
      await expect(
        domain.invoke({
          namespace: "features",
          method: "setIssueStatus",
          args: [
            {
              ...scope,
              relativePath: ".scratch/alpha/issues/01-first.md",
              status: "solved",
            },
          ],
        }),
      ).resolves.toEqual(expect.objectContaining({ status: "solved" }));
      await expect(
        domain.invoke({
          namespace: "features",
          method: "setIssueStatus",
          args: [
            {
              ...scope,
              relativePath: "../outside.md",
              status: "solved",
            },
          ],
        }),
      ).rejects.toMatchObject({ code: "invalid_feature_path" });
      await expect(
        domain.invoke({
          namespace: "features",
          method: "scan",
          args: [{ cwd: path.join(directory, "outside"), runMode: hostPlatform() }],
        }),
      ).rejects.toMatchObject({ code: "worktree_not_authorized" });

      for (const clientId of ["feature-client-a", "feature-client-b"]) {
        await domain.invoke({
          namespace: "features",
          method: "subscribe",
          args: [scope],
          clientId,
        });
      }
      await vi.waitFor(
        () => {
          expect(
            artifacts.current({ cwd: directory, runMode: hostPlatform() }),
          ).not.toBeNull();
        },
        { timeout: 1_000 },
      );
      domain.releaseClient("feature-client-a");
      await writeFile(
        path.join(directory, "docs", "plans", "alpha-second.md"),
        "# Another plan\n",
      );
      await vi.waitFor(
        () => {
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                cwd: directory,
                runMode: hostPlatform(),
                kind: "features",
              }),
            ]),
          );
        },
        { timeout: 1_000 },
      );
      domain.releaseClient("feature-client-b");
      await expect(
        domain.invoke({
          namespace: "features",
          method: "subscribe",
          args: [scope],
        }),
      ).rejects.toMatchObject({ code: "client_identity_required" });
    } finally {
      await domain.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function overviewFixture(worktreeCwd: string): WorktreeOverview {
  return {
    worktreeCwd,
    status: "cached",
    text: "Cached overview",
    generatedAt: "2026-07-31T12:00:00.000Z",
    generatedBy: { provider: "codex", model: "gpt-5.4-mini" },
    watermark: null,
    sources: {
      sessionCount: 0,
      totalTurns: 0,
      providers: [],
      approxInputTokens: 0,
    },
    facts: {
      cwd: worktreeCwd,
      branch: "main",
      head: "a".repeat(40),
      baseBranch: "main",
      baseOid: "a".repeat(40),
      commitsAhead: 0,
      commitsBehind: 0,
      commitsAheadShas: [],
      pushedAhead: true,
      mergedIntoBase: true,
      dirtyFiles: [],
      dirtyHash: "clean",
      evidenceFingerprint: "evidence",
      completeness: "complete",
      diagnostics: [],
      workingDiff: "",
      recentCommits: [],
    },
  };
}

const NOTE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}
