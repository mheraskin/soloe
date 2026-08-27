// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  SOLOE_API_METHODS,
  UI_STARTUP_RPCS,
} from "@shared/api-contract.js";
import { createBrowserApi } from "./browser-api.js";

describe("browser API", () => {
  it("exposes short DNS setup and removal through the browser backend", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: { machines: [] } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "browser-test",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    expect(api.transport?.supports("connections", "setupShortDns")).toBe(true);
    expect(api.transport?.supports("connections", "removeShortDns")).toBe(true);

    await api.connections.setupShortDns?.("device:11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "connections",
      method: "setupShortDns",
      args: ["device:11111111-1111-4111-8111-111111111111"],
      clientId: "browser-test",
    });
  });

  it("exposes the Device Session contract in standalone web clients", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: { devices: [] } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "browser-test",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });
    const sessions = api.sessions as unknown as Record<string, unknown>;

    expect(sessions.deviceState).toEqual(expect.any(Function));
    expect(sessions.refreshDevices).toEqual(expect.any(Function));
    expect(sessions.createOnDevice).toEqual(expect.any(Function));
    expect(sessions.deviceTerminalHistory).toEqual(expect.any(Function));
    expect(api.transport?.supports("sessions", "deviceState")).toBe(true);

    await api.sessions.deviceState?.();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "sessions",
      method: "deviceState",
      args: [],
      clientId: "browser-test",
    });
  });

  it("maps preload-style calls onto authenticated same-origin RPC", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: [{ id: "session-1" }] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "browser-test",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    await expect(api.sessions.list()).resolves.toEqual({
      ok: true,
      value: [{ id: "session-1" }],
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "sessions",
      method: "list",
      args: [],
      clientId: "browser-test",
    });

    await api.terminal.acquireInputLease(
      "terminal-1",
      { deviceId: "browser-test", deviceName: "MacBook Pro" },
      false,
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      namespace: "terminal",
      method: "acquireInputLease",
      args: [
        "terminal-1",
        false,
        { deviceId: "browser-test", deviceName: "MacBook Pro" },
      ],
      clientId: "browser-test",
    });

    const control = {
      sessionId: "session-1",
      ownerDeviceId: "device-owner",
      controllerDeviceId: "browser-test",
      leaseId: "lease-1",
    };
    await api.terminal.input({ terminalId: "terminal-1", data: "hello", control });
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      namespace: "terminal",
      method: "input",
      args: ["terminal-1", "hello", control],
      clientId: "browser-test",
    });
    await api.terminal.resize({
      terminalId: "terminal-1",
      dimensions: { cols: 90, rows: 28 },
      control,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual({
      namespace: "terminal",
      method: "resize",
      args: ["terminal-1", 90, 28, control],
      clientId: "browser-test",
    });

    await api.terminal.setOutputDemand({ terminalId: "terminal-1", active: true });
    expect(JSON.parse(String(fetchImpl.mock.calls[4]?.[1]?.body))).toEqual({
      namespace: "terminal",
      method: "setOutputDemand",
      args: [{ terminalId: "terminal-1", active: true }],
      clientId: "browser-test",
    });
  });

  it("sends supported Files operations to the application server", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: { paths: [] } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "browser-test",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    await api.files.listTree({ cwd: "/repo", runMode: "linux" });
    await api.files.openInEditor({
      cwd: "/repo",
      runMode: "linux",
      absolutePath: "/repo/src/app.ts",
    });

    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      {
        namespace: "files",
        method: "listTree",
        args: [{ cwd: "/repo", runMode: "linux" }],
        clientId: "browser-test",
      },
      {
        namespace: "files",
        method: "openInEditor",
        args: [
          {
            cwd: "/repo",
            runMode: "linux",
            absolutePath: "/repo/src/app.ts",
          },
        ],
        clientId: "browser-test",
      },
    ]);
  });

  it("sends Git reads and observation demand with a stable client identity", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "git-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    await api.git.status({ cwd: "/repo", runMode: "linux" });
    await api.git.setObservationDemand({
      cwd: "/repo",
      runMode: "linux",
      active: true,
    });

    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      {
        namespace: "git",
        method: "status",
        args: [{ cwd: "/repo", runMode: "linux" }],
        clientId: "git-browser",
      },
      {
        namespace: "git",
        method: "setObservationDemand",
        args: [{ cwd: "/repo", runMode: "linux", active: true }],
        clientId: "git-browser",
      },
    ]);
  });

  it("sends revision-aware Notes writes to the application server", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "notes-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    await api.notes.write("project-1", "shared.md", "updated", "a".repeat(64));

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "notes",
      method: "write",
      args: ["project-1", "shared.md", "updated", "a".repeat(64)],
      clientId: "notes-browser",
    });
  });

  it("sends Feature Lab scans and subscriptions to the application server", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "features-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });
    const scope = { cwd: "/repo", runMode: "linux" as const };

    await api.features.scan({ ...scope, slug: "alpha" });
    await api.features.subscribe(scope);

    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      {
        namespace: "features",
        method: "scan",
        args: [{ ...scope, slug: "alpha" }],
        clientId: "features-browser",
      },
      {
        namespace: "features",
        method: "subscribe",
        args: [scope],
        clientId: "features-browser",
      },
    ]);
  });

  it("requests backend process usage without claiming browser process metrics", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: { scope: "backend" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "usage-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    await api.system.usage({ detail: "summary" });

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "system",
      method: "usage",
      args: [{ detail: "summary" }],
      clientId: "usage-browser",
    });
  });

  it("opens backend session paths through RPC and keeps browser exports client-native", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const saveTextClient = vi.fn();
    const openExternalClient = vi.fn();
    const api = createBrowserApi({
      clientId: "system-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
      saveTextClient,
      openExternalClient,
    });

    await api.system.openPath("session-1");
    await api.system.saveText({
      defaultPath: "session-1.log",
      content: "terminal transcript",
    });
    await api.system.openExternal("https://example.test/docs");

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "system",
      method: "openPath",
      args: ["session-1"],
      clientId: "system-browser",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(saveTextClient).toHaveBeenCalledWith({
      defaultPath: "session-1.log",
      content: "terminal transcript",
    });
    expect(openExternalClient).toHaveBeenCalledWith("https://example.test/docs");
  });

  it("rejects unsafe browser external-link protocols", async () => {
    const open = vi.spyOn(window, "open");
    const api = createBrowserApi({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    await expect(api.system.openExternal("javascript:alert(1)")).resolves.toEqual({
      ok: false,
      error: "External link must use http or https",
    });
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("requests bounded diagnostics from the application server", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: [] }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "diagnostics-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    await api.diagnostics.list();
    await api.diagnostics.crashLogs({ tailBytes: 4_096 });

    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      {
        namespace: "diagnostics",
        method: "list",
        args: [],
        clientId: "diagnostics-browser",
      },
      {
        namespace: "diagnostics",
        method: "crashLogs",
        args: [{ tailBytes: 4_096 }],
        clientId: "diagnostics-browser",
      },
    ]);
  });

  it("routes Vault CRUD and metadata events through the application server", async () => {
    const socket = new FakeSocket();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "vault-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => socket,
    });
    const change = vi.fn();
    api.vault.onChange(change);
    const draft = {
      origin: "https://example.test",
      username: "ada",
      password: "secret",
    };

    await api.vault.save({ cwd: "/repo", draft });
    await api.vault.getSecret({ cwd: "/repo", id: "0123456789abcdef" });
    socket.message({
      event: "vault.change",
      payload: {
        cwd: "/repo",
        entries: [],
        changedAt: "2026-07-31T12:00:00.000Z",
      },
    });

    expect(change).toHaveBeenCalledWith({
      cwd: "/repo",
      entries: [],
      changedAt: "2026-07-31T12:00:00.000Z",
    });
    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      {
        namespace: "vault",
        method: "save",
        args: [{ cwd: "/repo", draft }],
        clientId: "vault-browser",
      },
      {
        namespace: "vault",
        method: "getSecret",
        args: [{ cwd: "/repo", id: "0123456789abcdef" }],
        clientId: "vault-browser",
      },
    ]);
  });

  it("routes agent integration changes through the selected backend", async () => {
    const socket = new FakeSocket();
    const status = {
      hosts: [
        {
          host: { kind: "linux", label: "Backend", available: true },
          claude: { installed: true, current: true, version: 14 },
          codex: { installed: false, current: false },
        },
      ],
    };
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: status }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "integration-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => socket,
    });
    const change = vi.fn();
    api.agentIntegration.onChange(change);

    await api.agentIntegration.installClaude({ host: { kind: "linux" } });
    socket.message({ event: "agentIntegration.change", payload: status });

    expect(change).toHaveBeenCalledWith(status);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "agentIntegration",
      method: "installClaude",
      args: [{ host: { kind: "linux" } }],
      clientId: "integration-browser",
    });
  });

  it("routes Overview streams through RPC and WebSocket events", async () => {
    const socket = new FakeSocket();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ ok: true, value: { requestId: "overview-1" } }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const api = createBrowserApi({
      clientId: "overview-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => socket,
    });
    const chunk = vi.fn();
    api.overview.onChunk(chunk);
    const request = {
      worktreeCwd: "/repo",
      runMode: "linux" as const,
      sessions: [],
      message: "What changed?",
      history: [],
    };

    await api.overview.askStart(request);
    socket.message({
      event: "overview.chunk",
      payload: { requestId: "overview-1", type: "delta", text: "answer" },
    });
    await api.overview.askCancel("overview-1");

    expect(chunk).toHaveBeenCalledWith({
      requestId: "overview-1",
      type: "delta",
      text: "answer",
    });
    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      {
        namespace: "overview",
        method: "askStart",
        args: [request],
        clientId: "overview-browser",
      },
      {
        namespace: "overview",
        method: "askCancel",
        args: ["overview-1"],
        clientId: "overview-browser",
      },
    ]);
  });

  it("routes comments and diff renderer bridges through server events and RPC", async () => {
    const socket = new FakeSocket();
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: true }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const api = createBrowserApi({
      clientId: "bridge-browser",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: () => socket,
    });
    const commentRequest = vi.fn();
    const diffRequest = vi.fn();
    api.comments.onRpcRequest(commentRequest);
    api.diff.onRpcRequest(diffRequest);
    const requestId = "123e4567-e89b-42d3-a456-426614174000";

    socket.message({
      event: "comments.rpcRequest",
      payload: { requestId, op: "resolve", args: { id: "comment-1" } },
    });
    socket.message({
      event: "diff.rpcRequest",
      payload: {
        requestId,
        op: "open_for_commits",
        args: {
          target: {
            sessionId: "session-1",
            scope: { cwd: "/repo", runMode: "linux" },
          },
          base: "base",
          head: "head",
          commits: [],
          includeWorkingTree: false,
        },
      },
    });
    api.comments.sendRpcResponse({ requestId, result: { ok: true } });
    api.diff.sendRpcResponse({
      requestId,
      result: {
        ok: true,
        sessionId: "session-1",
        cwd: "/repo",
        base: "base",
        head: "head",
        commitCount: 1,
      },
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    expect(commentRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, op: "resolve" }),
    );
    expect(diffRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, op: "open_for_commits" }),
    );
    expect(
      fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]?.body))),
    ).toEqual([
      {
        namespace: "comments",
        method: "sendRpcResponse",
        args: [{ requestId, result: { ok: true } }],
        clientId: "bridge-browser",
      },
      {
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
        clientId: "bridge-browser",
      },
    ]);
  });

  it("supports an absolute server URL and bearer token for the Electron shell", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true, value: [] })),
    );
    let socketUrl = "";
    const api = createBrowserApi({
      baseUrl: "http://127.0.0.1:4317/?token=bootstrap",
      clientId: "browser-test",
      token: "secret",
      fetchImpl: fetchImpl as typeof fetch,
      socketFactory: (url) => {
        socketUrl = url;
        return new FakeSocket();
      },
    });

    await api.sessions.list();

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:4317/api/rpc");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer secret",
    });
    expect(socketUrl).toBe(
      "ws://127.0.0.1:4317/api/runtime/events?token=secret&clientId=browser-test&eventFormat=envelope-v1",
    );
  });

  it("publishes runtime WebSocket output through the preload subscription contract", () => {
    const socket = new FakeSocket();
    const api = createBrowserApi({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      socketFactory: () => socket,
    });
    const listener = vi.fn();
    const unsubscribe = api.terminal.onOutput(listener);

    socket.message({
      event: "output",
      payload: {
        terminalId: "terminal-1",
        sessionId: "session-1",
        data: "live output",
        seq: 1,
      },
    });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ data: "live output", seq: 1 }),
    );

    unsubscribe();
    socket.message({
      event: "output",
      payload: {
        terminalId: "terminal-1",
        sessionId: "session-1",
        data: "ignored",
        seq: 2,
      },
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("publishes session deletion events through the preload subscription contract", () => {
    const socket = new FakeSocket();
    const api = createBrowserApi({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      socketFactory: () => socket,
    });
    const listener = vi.fn();
    api.sessions.onDelete(listener);

    socket.message({
      event: "sessions.delete",
      payload: "session-1",
    });

    expect(listener).toHaveBeenCalledWith("session-1");
  });

  it("reconnects the event stream and announces replay recovery", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const api = createBrowserApi({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      reconnectDelayMs: 25,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const reconnect = vi.fn();
    (
      api.terminal as typeof api.terminal & {
        onReconnect(listener: () => void): () => void;
      }
    ).onReconnect(reconnect);

    sockets[0]?.open();
    sockets[0]?.close();
    await vi.advanceTimersByTimeAsync(25);
    sockets[1]?.open();

    expect(sockets).toHaveLength(2);
    expect(reconnect).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("advertises every startup RPC and rejects unsupported features before fetching", async () => {
    const fetchImpl = vi.fn();
    const api = createBrowserApi({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    for (const rpc of UI_STARTUP_RPCS) {
      const [namespace, method] = rpc.split(".");
      expect(api.transport?.supports(namespace!, method!)).toBe(true);
    }
    expect(api.transport?.supports("files", "listTree")).toBe(true);
    expect(api.transport?.supports("files", "readFile")).toBe(true);
    expect(api.transport?.supports("files", "writeFile")).toBe(true);
    expect(api.transport?.supports("files", "openInEditor")).toBe(true);
    expect(api.transport?.supports("git", "status")).toBe(true);
    expect(api.transport?.supports("notes", "list")).toBe(true);
    expect(api.transport?.supports("notes", "saveImage")).toBe(true);
    expect(api.transport?.supports("features", "scan")).toBe(true);
    expect(api.transport?.supports("features", "subscribe")).toBe(true);
    expect(api.transport?.supports("system", "usage")).toBe(true);
    expect(api.transport?.supports("system", "openPath")).toBe(true);
    expect(api.transport?.supports("system", "saveText")).toBe(true);
    expect(api.transport?.supports("system", "openExternal")).toBe(true);
    expect(api.transport?.supports("diagnostics", "list")).toBe(true);
    expect(api.transport?.supports("diagnostics", "crashLogs")).toBe(true);
    expect(api.transport?.supports("vault", "list")).toBe(true);
    expect(api.transport?.supports("vault", "getSecret")).toBe(true);
    expect(api.transport?.supports("overview", "regenerate")).toBe(true);
    expect(api.transport?.supports("overview", "askStart")).toBe(true);
    expect(api.transport?.supports("agentIntegration", "installClaude")).toBe(true);
    expect(api.transport?.supports("agentIntegration", "uninstallCodex")).toBe(true);
    expect(api.transport?.supports("comments", "onRpcRequest")).toBe(true);
    expect(api.transport?.supports("comments", "sendRpcResponse")).toBe(true);
    expect(api.transport?.supports("diff", "onRpcRequest")).toBe(true);
    expect(api.transport?.supports("diff", "sendRpcResponse")).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("materializes namespaces for the Electron context bridge", () => {
    const api = createBrowserApi({
      fetchImpl: vi.fn() as unknown as typeof fetch,
      socketFactory: () => new FakeSocket(),
    });

    for (const [namespace, value] of Object.entries(api)) {
      expect(
        Object.keys(value as object).length,
        `${namespace} must be a plain facade with own methods`,
      ).toBeGreaterThan(0);
    }
    expect(Object.hasOwn(api.sessions, "list")).toBe(true);
    expect(Object.hasOwn(api.observer, "onSnapshot")).toBe(true);
    for (const [namespace, methods] of Object.entries(SOLOE_API_METHODS)) {
      const facade = api[namespace as keyof typeof api] as object;
      for (const method of methods) {
        expect(
          Object.hasOwn(facade, method),
          `${namespace}.${method} must be materialized`,
        ).toBe(true);
      }
    }
  });
});

class FakeSocket {
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  addEventListener(event: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  message(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(value) } as MessageEvent);
    }
  }

  open(): void {
    for (const listener of this.listeners.get("open") ?? []) listener(new Event("open"));
  }

  close(): void {
    for (const listener of this.listeners.get("close") ?? []) listener(new Event("close"));
  }
}
