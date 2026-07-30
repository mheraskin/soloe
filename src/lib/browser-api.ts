import type {
  IpcResult,
  SoloeApi,
  TerminalApi,
} from "@shared/types/ipc.js";
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStatusEvent,
} from "@shared/types/terminal.js";
import { supportsRpc, type SoloeTransportKind } from "@shared/api-contract.js";

interface SocketLike {
  addEventListener(event: string, listener: (event: Event) => void): void;
}

export interface BrowserApiOptions {
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
  reconnectDelayMs?: number;
  baseUrl?: string;
  token?: string;
  transport?: Extract<SoloeTransportKind, "browser" | "remote-electron">;
}

type Listener = (payload: never) => void;

export function createBrowserApi(options: BrowserApiOptions = {}): SoloeApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? window.location.href;
  const listeners = new Map<string, Set<Listener>>();
  const transport = options.transport ?? "browser";
  const rpc = async <T>(
    namespace: string,
    method: string,
    args: unknown[],
  ): Promise<IpcResult<T>> => {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      const response = await fetchImpl(new URL("/api/rpc", baseUrl), {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({ namespace, method, args }),
      });
      if (!response.ok) {
        return { ok: false, error: `Soloe server returned HTTP ${response.status}` };
      }
      return (await response.json()) as IpcResult<T>;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const subscribe = <T>(event: string, listener: (payload: T) => void): (() => void) => {
    const eventListeners = listeners.get(event) ?? new Set<Listener>();
    eventListeners.add(listener as Listener);
    listeners.set(event, eventListeners);
    return () => {
      eventListeners.delete(listener as Listener);
    };
  };

  const socketFactory =
    options.socketFactory ??
    ((url: string) => new WebSocket(url));
  const url = new URL("/api/runtime/events", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (options.token) url.searchParams.set("token", options.token);
  let openedConnections = 0;
  const connectEvents = () => {
    const socket = socketFactory(url.toString());
    socket.addEventListener("open", () => {
      openedConnections += 1;
      if (openedConnections > 1) {
        for (const listener of listeners.get("reconnect") ?? []) {
          listener(undefined as never);
        }
      }
    });
    socket.addEventListener("message", (rawEvent) => {
      try {
        const event = rawEvent as MessageEvent;
        const message = JSON.parse(String(event.data)) as {
          event: string;
          payload: never;
        };
        for (const listener of listeners.get(message.event) ?? []) {
          listener(message.payload);
        }
      } catch {
        // Ignore malformed messages; replay repairs any resulting output gap.
      }
    });
    socket.addEventListener("close", () => {
      setTimeout(connectEvents, options.reconnectDelayMs ?? 500);
    });
  };
  connectEvents();

  const namespace = (name: string): object =>
    new Proxy(
      {},
      {
        get(_target, property) {
          const method = String(property);
          if (method.startsWith("on")) {
            const eventName = `${name}.${method.slice(2, 3).toLowerCase()}${method.slice(3)}`;
            return (listener: Listener) => subscribe(eventName, listener);
          }
          if (!supportsRpc(transport, name, method)) {
            return () =>
              Promise.resolve({
                ok: false,
                error: `RPC ${name}.${method} is unavailable over ${transport}`,
                code: "rpc_not_supported",
              });
          }
          return (...args: unknown[]) => rpc(name, method, args);
        },
      },
    );

  const terminal: TerminalApi & { onReconnect(listener: () => void): () => void } = {
    start: (input) => rpc("terminal", "start", [input]),
    stop: (terminalId) => rpc("terminal", "stop", [terminalId]),
    restart: (sessionId, resize) => rpc("terminal", "restart", [sessionId, resize]),
    input: ({ terminalId, data }) => rpc("terminal", "input", [terminalId, data]),
    resize: ({ terminalId, dimensions }) =>
      rpc("terminal", "resize", [terminalId, dimensions.cols, dimensions.rows]),
    listRunning: () => rpc("terminal", "listRunning", []),
    replay: (terminalId, afterSeq) =>
      rpc("terminal", "replay", [terminalId, afterSeq]),
    setOutputDemand: () => Promise.resolve({ ok: true, value: true }),
    onOutput: (listener: (event: TerminalOutputEvent) => void) =>
      subscribe("output", listener),
    onExit: (listener: (event: TerminalExitEvent) => void) =>
      subscribe("exit", listener),
    onStatus: (listener: (event: TerminalStatusEvent) => void) =>
      subscribe("status", listener),
    onLocation: (listener: (event: TerminalLocationEvent) => void) =>
      subscribe("location", listener),
    onReconnect: (listener) => subscribe("reconnect", listener),
  };

  return {
    transport: {
      kind: transport,
      supports: (namespace: string, method: string) =>
        supportsRpc(transport, namespace, method),
    },
    sessions: namespace("sessions"),
    terminal,
    observer: namespace("observer"),
    system: namespace("system"),
    settings: namespace("settings"),
    projects: namespace("projects"),
    notes: namespace("notes"),
    git: namespace("git"),
    files: namespace("files"),
    diagnostics: namespace("diagnostics"),
    window: namespace("window"),
    agentIntegration: namespace("agentIntegration"),
    notify: namespace("notify"),
    overview: namespace("overview"),
    comments: namespace("comments"),
    diff: namespace("diff"),
    features: namespace("features"),
    vault: namespace("vault"),
    browser: namespace("browser"),
  } as SoloeApi;
}

export function installBrowserApi(): void {
  if (!window.soloe) {
    window.soloe = createBrowserApi();
  }
}
