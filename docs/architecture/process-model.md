# Process model

Soloe uses operating-system processes and local IPC rather than Docker
containers. The PNPM monorepo keeps source and shared types together; process
separation, not repository separation, provides lifecycle independence.

| Process | Owns | May be replaced without stopping agents? |
| --- | --- | --- |
| Environment Runtime (`apps/runtime`) | PTYs, input, resize, bounded replay, terminal identity | No; this is the agent lifetime boundary |
| Application Server (`apps/server`) | Domain state, authenticated HTTP/RPC/WebSocket, web/PWA assets | Yes |
| Tray Host (`apps/tray`) | Service discovery, explicit start/stop, browser/Electron launch | Yes, unless the user chooses Quit Soloe |
| Electron client (`apps/desktop-electron`) | Native desktop window and renderer presentation | Yes |
| Web/PWA (`apps/web`) | Browser renderer presentation | Yes |

On Windows, **Backend Placement** selects where the first two processes run:

- `windows`: the Application Server and Environment Runtime run as native
  Windows Node.js processes.
- `wsl`: the Application Server and Environment Runtime run inside one selected
  WSL distribution. The runtime socket stays on the WSL filesystem; Windows
  clients reach only the server's authenticated localhost HTTP/WebSocket API.

The Tray Host, Electron client, and ordinary browser always remain on Windows.
Backend Placement is separate from a Session's shell/run-mode settings.

`apps/mobile/` is intentionally only a placeholder. Mobile access is currently
the responsive PWA produced by `apps/web`; a future native mobile application
can occupy the reserved directory without duplicating today's web build.

## Runtime boundary

The Environment Runtime listens on a per-user Unix socket or Windows named
pipe. It is the only process allowed to own an agent PTY. A client can start,
list, replay, write, resize, or explicitly stop a terminal through the versioned
protocol in `packages/protocol`.

Disconnect is not stop. Closing Electron, closing a browser, rebuilding the
server, or restarting the tray only removes a connection. Output continues into
the bounded replay tail and is recovered by sequence when a client reconnects.
The runtime stops its PTYs only after an explicit terminal stop or runtime
shutdown.

## Server and clients

The Application Server connects to the Environment Runtime as a client. It
serves the web/PWA build, exposes domain RPC over HTTP, and publishes runtime
and domain events over WebSocket. A per-install token protects both transports;
browser bootstrap exchanges the token for an HttpOnly, SameSite cookie.

Electron and the browser share the Svelte renderer through separate Renderer
Backend Adapters. When opened by the tray, Electron is a server-backed client:
its remote preload uses the same HTTP/WebSocket API while retaining only native
Windows window and embedded-browser controls over local Electron IPC. The
browser uses the local HTTP/WebSocket API directly. Both replay visible
terminals after reconnect.

## Tray semantics

The Tauri tray is windowless and therefore remains small while Electron is
opened only on demand. Its menu reports backend state and placement, starts or
stops the runtime and server, opens the authenticated browser URL, opens
Electron, and quits Soloe. Ordinary tray rebuild or restart discovers existing
services from owner-PID-checked rendezvous records and does not adopt or kill
their PTYs.

The placement setting lives in the shared Windows Soloe data directory. For a
WSL backend, the tray translates that directory with `wslpath`, launches both
services through `wsl.exe`, and keeps the Unix runtime socket in the selected
distribution at `$HOME/.local/state/soloe/runtime.sock`. It records the active
placement separately, so changing Settings cannot cause Stop to target the
wrong operating system. A placement change applies only after an explicit Stop
then Start.

In repository development, the tray launches the pinned PNPM workspace
commands. Soloe does not bundle Node.js; a distributable must ship the built
runtime/server JavaScript and require a compatible system Node.js 22 or newer.
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

Run components independently:

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

For the complete Windows setup and both Backend Placement launch paths, see
[Windows development with Windows or WSL backends](../development/windows-backends.md).
