import type {
  IpcResult,
  SoloeApi,
  SystemApi,
  TerminalApi,
} from "@shared/types/ipc.js";
import type {
  TerminalExitEvent,
  TerminalLocationEvent,
  TerminalOutputEvent,
  TerminalStatusEvent,
} from "@shared/types/terminal.js";
import {
  SOLOE_API_METHODS,
  supportsRpc,
  type SoloeTransportKind,
} from "@shared/api-contract.js";

interface SocketLike {
  addEventListener(event: string, listener: (event: Event) => void): void;
}

export interface BrowserApiOptions {
  fetchImpl?: typeof fetch;
  socketFactory?: (url: string) => SocketLike;
  reconnectDelayMs?: number;
  baseUrl?: string;
  token?: string;
  clientId?: string;
  transport?: Extract<SoloeTransportKind, "browser" | "remote-electron">;
  saveTextClient?: (request: {
    defaultPath?: string;
    content: string;
  }) => void | Promise<void>;
  openExternalClient?: (url: string) => void | Promise<void>;
}

type Listener = (payload: never) => void;

export function createBrowserApi(options: BrowserApiOptions = {}): SoloeApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? window.location.href;
  const listeners = new Map<string, Set<Listener>>();
  const transport = options.transport ?? "browser";
  const clientId =
    options.clientId ??
    globalThis.crypto?.randomUUID?.() ??
    `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
        body: JSON.stringify({ namespace, method, args, clientId }),
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
  url.searchParams.set("clientId", clientId);
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

  const namespace = (name: string, methods: readonly string[]): object =>
    Object.fromEntries(
      methods.map((method) => {
        if (method.startsWith("on")) {
          if (!supportsRpc(transport, name, method)) {
            return [method, () => () => {}];
          }
          const eventName = `${name}.${method.slice(2, 3).toLowerCase()}${method.slice(3)}`;
          return [method, (listener: Listener) => subscribe(eventName, listener)];
        }
        if (!supportsRpc(transport, name, method)) {
          return [
            method,
            () =>
              Promise.resolve({
                ok: false,
                error: `RPC ${name}.${method} is unavailable over ${transport}`,
                code: "rpc_not_supported",
              }),
          ];
        }
        return [method, (...args: unknown[]) => rpc(name, method, args)];
      }),
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
  const clientResult = async (
    operation: () => void | Promise<void>,
  ): Promise<IpcResult<true>> => {
    try {
      await operation();
      return { ok: true, value: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  const system: SystemApi = {
    platform: () => rpc("system", "platform", []),
    openPath: (sessionId) => rpc("system", "openPath", [sessionId]),
    saveText: (request) =>
      clientResult(() =>
        (options.saveTextClient ?? downloadText)(request),
      ),
    openExternal: (externalUrl) =>
      clientResult(() =>
        (options.openExternalClient ?? openSafeExternal)(externalUrl),
      ),
    listWslDistros: () => rpc("system", "listWslDistros", []),
    usage: (request) =>
      rpc("system", "usage", request === undefined ? [] : [request]),
  };

  return {
    transport: {
      kind: transport,
      supports: (namespace: string, method: string) =>
        supportsRpc(transport, namespace, method),
    },
    sessions: namespace("sessions", SOLOE_API_METHODS.sessions),
    terminal,
    observer: namespace("observer", SOLOE_API_METHODS.observer),
    system,
    settings: namespace("settings", SOLOE_API_METHODS.settings),
    projects: namespace("projects", SOLOE_API_METHODS.projects),
    notes: namespace("notes", SOLOE_API_METHODS.notes),
    git: namespace("git", SOLOE_API_METHODS.git),
    files: namespace("files", SOLOE_API_METHODS.files),
    diagnostics: namespace("diagnostics", SOLOE_API_METHODS.diagnostics),
    window: namespace("window", SOLOE_API_METHODS.window),
    agentIntegration: namespace(
      "agentIntegration",
      SOLOE_API_METHODS.agentIntegration,
    ),
    notify: namespace("notify", SOLOE_API_METHODS.notify),
    overview: namespace("overview", SOLOE_API_METHODS.overview),
    comments: namespace("comments", SOLOE_API_METHODS.comments),
    diff: namespace("diff", SOLOE_API_METHODS.diff),
    features: namespace("features", SOLOE_API_METHODS.features),
    vault: namespace("vault", SOLOE_API_METHODS.vault),
    browser: namespace("browser", SOLOE_API_METHODS.browser),
    browserSessions: namespace("browserSessions", SOLOE_API_METHODS.browserSessions),
  } as SoloeApi;
}

export function installBrowserApi(): void {
  if (!window.soloe) {
    window.soloe = createBrowserApi();
  }
}

function downloadText(request: {
  defaultPath?: string;
  content: string;
}): void {
  if (typeof request.content !== "string") {
    throw new Error("Text download content must be a string");
  }
  const name = safeDownloadName(request.defaultPath);
  const objectUrl = URL.createObjectURL(
    new Blob([request.content], { type: "text/plain;charset=utf-8" }),
  );
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = name;
    anchor.rel = "noopener";
    anchor.click();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function safeDownloadName(value: string | undefined): string {
  const candidate = value?.split(/[\\/]/u).pop()?.trim() ?? "";
  const sanitized = candidate
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, 255);
  return sanitized || "soloe-export.txt";
}

function openSafeExternal(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("External link must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("External link must use http or https");
  }
  const opened = window.open(url.href, "_blank", "noopener,noreferrer");
  if (!opened) {
    throw new Error("The browser blocked the external link");
  }
  opened.opener = null;
}
