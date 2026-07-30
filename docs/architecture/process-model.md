# Process model

Soloe uses operating-system processes and local IPC rather than Docker
containers. The PNPM monorepo keeps source and shared types together; process
separation, not repository separation, provides lifecycle independence.

| Process | Owns | May be replaced without stopping agents? |
| --- | --- | --- |
| Environment Runtime (`apps/runtime`) | PTYs, input, resize, bounded replay, terminal identity | No; this is the agent lifetime boundary |
| Application Server (`apps/server`) | Domain state, authenticated HTTP/RPC/WebSocket | Yes |
| Tray Host (`apps/tray`) | Top-level ownership, start/stop, browser/Electron launch | No; exiting the tray stops everything |
| Electron client (`apps/desktop-electron`) | Native desktop window and renderer presentation | Yes |
| Windows Web Host (`apps/web`) | PWA assets, hot reload, authenticated API proxy | Yes while the tray remains |

On Windows, **Backend Placement** selects where the first two processes run:

- `windows`: the Application Server and Environment Runtime run as native
  Windows Node.js processes.
- `wsl`: the Application Server and Environment Runtime run inside one selected
  WSL distribution. The runtime socket stays on the WSL filesystem; Windows
  clients reach only the server's authenticated localhost HTTP/WebSocket API.

The Tray Host, Windows Web Host, Electron client, and ordinary browser always
remain on Windows.
Backend Placement is separate from a Session's shell/run-mode settings.

`apps/mobile/` is intentionally only a placeholder. Mobile access is currently
the responsive PWA produced by `apps/web`; a future native mobile application
can occupy the reserved directory without duplicating today's web build.

## Runtime boundary

The Environment Runtime listens on a per-user Unix socket or Windows named
pipe. It is the only process allowed to own an agent PTY. A client can start,
list, replay, write, resize, or explicitly stop a terminal through the versioned
protocol in `packages/protocol`.

Disconnect is not stop. Closing Electron, closing a browser, rebuilding either
client, or replacing the Application Server only removes a connection. Output
continues into the bounded replay tail and is recovered by sequence when a
client reconnects. Stopping or exiting the tray is different: the tray is the
top-level owner and intentionally shuts down the runtime and its PTYs.

## Server and clients

The Application Server connects to the Environment Runtime as a client. It
exposes domain RPC over HTTP and publishes runtime and domain events over
WebSocket. A per-install token protects both transports.

On Windows, the PWA is always hosted by the Windows Web Host regardless of
Backend Placement. The web host serves or hot-reloads assets and reverse
proxies `/api` HTTP/WebSocket traffic to the selected backend. Browser bootstrap
exchanges the tray-generated authenticated URL for an HttpOnly, SameSite cookie.
The Application Server never guesses an `out/web` directory from its checkout.

Electron and the browser share the Svelte renderer through separate Renderer
Backend Adapters. When opened by the tray, Electron is a server-backed client:
its remote preload uses the same HTTP/WebSocket API while retaining only native
Windows window and embedded-browser controls over local Electron IPC. The
browser uses the local HTTP/WebSocket API directly. Both replay visible
terminals after reconnect.

## Tray semantics

The Tauri tray is windowless and therefore remains small while Electron is
opened only on demand. Its menu has one dynamic backend action:
`Start (WSL/Windows)` or `Stop (WSL/Windows)`. During a transition the same
disabled action reads `Starting (WSL/Windows)…` or `Stopping (WSL/Windows)…`.
Backend Placement remains visible and configurable in Settings. The menu also
opens the authenticated browser URL, opens Electron, exposes logs, and quits
Soloe; there is no redundant backend-status row.

Every tray launch creates a unique owner identity. Service records include that
identity, and the tray refuses to kill a process based only on a stale PID.
Only one tray instance can hold the per-install supervisor lock.

Native Windows child trees are assigned to a Windows Job Object configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Closing, crashing, killing, or rebuilding
the owning tray closes the job and terminates native backend/client trees. A WSL
backend runs below a lightweight WSL supervisor. The tray refreshes a one-second
lease; if the lease disappears or becomes stale, the WSL supervisor stops the
Application Server first and the Environment Runtime second, then force-cleans
their process groups if necessary.

Graceful Quit stops tray-launched Electron processes, the Windows Web Host, the
Application Server, and finally the Environment Runtime. If the runtime may own
active terminals, the tray requires a second confirmation action. There is
currently no ownership-handoff/update mode: replacing the tray stops agents by
design instead of accidentally orphaning them.

The placement setting lives in the shared Windows Soloe data directory. For a
WSL backend, the tray translates that directory with `wslpath`, launches both
services through `wsl.exe`, and keeps the Unix runtime socket in the selected
distribution at `$HOME/.local/state/soloe/runtime.sock`. It records the active
placement separately, so changing Settings cannot cause Stop to target the
wrong operating system. A placement change applies only after an explicit Stop
then Start.

In repository development, `pnpm dev` launches the tray. The tray validates the
Windows and selected backend prerequisites, starts the backend, and starts the
Windows Web Host. Soloe does not bundle Node.js; a distributable must ship the
built application sources/assets and require a compatible system Node.js 22 or
newer.
That packaging choice is deliberately separate from the process architecture:
rewriting PTY ownership in Rust is not required.

## Development

Install and validate all workspaces:

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm --filter @soloe/protocol --filter @soloe/runtime --filter @soloe/server typecheck
pnpm test
pnpm --filter @soloe/desktop-electron build
pnpm --filter @soloe/web build
pnpm --filter @soloe/tray exec tauri build --no-bundle
cargo test -p soloe-tray
```

Everyday Windows development:

```bash
pnpm dev
```

Components remain independently runnable for focused work:

```bash
pnpm dev:runtime
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
pnpm dev:tray
```

The runtime command intentionally does not use watch mode. Source rebuilds
belong to the replaceable server and clients; automatically restarting the PTY
owner would violate terminal continuity.

See [API compatibility](./api-compatibility.md) for the local Electron,
remote-Electron, browser, server, and runtime method boundaries.

For the complete Windows setup and both Backend Placement launch paths, see
[Windows development with Windows or WSL backends](../development/windows-backends.md).
