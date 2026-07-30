// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { UI_STARTUP_RPCS } from "@shared/api-contract.js";
import { createBrowserApi } from "./browser-api.js";

describe("browser API", () => {
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

    await api.terminal.input({ terminalId: "terminal-1", data: "hello" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      namespace: "terminal",
      method: "input",
      args: ["terminal-1", "hello"],
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

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      namespace: "files",
      method: "listTree",
      args: [{ cwd: "/repo", runMode: "linux" }],
      clientId: "browser-test",
    });
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
      "ws://127.0.0.1:4317/api/runtime/events?token=secret&clientId=browser-test",
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
    expect(api.transport?.supports("files", "openInEditor")).toBe(false);
    expect(api.transport?.supports("git", "status")).toBe(true);
    expect(api.transport?.supports("notes", "list")).toBe(true);
    expect(api.transport?.supports("notes", "saveImage")).toBe(true);
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
