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
    });

    await api.terminal.input({ terminalId: "terminal-1", data: "hello" });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      namespace: "terminal",
      method: "input",
      args: ["terminal-1", "hello"],
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
      "ws://127.0.0.1:4317/api/runtime/events?token=secret",
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
    expect(api.transport?.supports("git", "status")).toBe(false);
    await expect(api.git.status({ cwd: "/repo" } as never)).resolves.toEqual({
      ok: false,
      error: "RPC git.status is unavailable over browser",
      code: "rpc_not_supported",
    });
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
