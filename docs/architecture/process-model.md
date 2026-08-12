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
| Tauri client (`apps/desktop-tauri`) | Experimental native desktop window, browser surfaces, and renderer presentation | Yes |
| Development Web Host (`apps/web`) | PWA assets, hot reload, authenticated API proxy | Yes while the tray remains |

**Backend Placement** selects where the first two processes run:

- `windows`: the Application Server and Environment Runtime run as native
  Windows Node.js processes.
- `macos`: the Application Server and Environment Runtime run as native macOS
  processes inside the packaged product's private Node/Electron payload.
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
client reconnects. Stopping the agent runtime or exiting the tray is different:
the tray is the top-level owner and intentionally shuts down the runtime and
its PTYs.

## Server and clients

The Application Server connects to the Environment Runtime as a client. It
exposes domain RPC over HTTP and publishes runtime and domain events over
WebSocket. A per-install token protects both transports.

In source development, the PWA is hosted by the Development Web Host. It serves
or hot-reloads assets and reverse proxies `/api` HTTP/WebSocket traffic to the
selected backend. In the packaged macOS product, the same production PWA build
is served directly by the separate Application Server from an explicit private
`SOLOE_WEB_ROOT`. Browser bootstrap exchanges the tray-generated authenticated
URL for an HttpOnly, SameSite cookie. The Application Server never guesses an
`out/web` directory from its checkout.

Electron, Tauri, and the browser share the Svelte renderer through separate
Renderer Backend Adapters. When opened by the tray, Electron is a server-backed client:
its remote preload uses the same HTTP/WebSocket API while retaining only native
Windows window and embedded-browser controls over local Electron IPC. The
browser uses the local HTTP/WebSocket API directly. The experimental Tauri
client loads that authenticated Web Host URL, keeps native window and browser
surface controls in its shell, and uses the same Application Server transport.
Its feature-gated Linux Native Terminal Host may also own a GTK presentation
surface backed by `libghostty-vt`, while its feature-gated macOS host may own a
full Ghostty AppKit/Metal surface in manual-I/O mode; bytes and resize intent still cross the same
Renderer Backend Interface, and the Environment Runtime still owns the PTY.
All three clients replay visible terminals after reconnect.

The Server composes platform-independent domain services; none import Electron
globals, `BrowserWindow`, `WebContents`, `ipcMain`, or renderer APIs:

| Service | Backend-owned responsibility |
| --- | --- |
| Files | scoped tree/search/read/write, binary and size metadata, terminal paste |
| Git | repository reads/mutations, review materialization, demand-based observation |
| Notes | revision-aware CRUD, images, cleanup, multi-client change events |
| Features | scans, branch/issue state, reference-counted artifact observation |
| Overview | worktree evidence, cache, streamed generation, task-scoped cancellation |
| Diagnostics | known-service metadata and bounded safe log tails |
| Vault | protected credential storage, metadata events, explicit secret retrieval |
| Agent integrations | placement-aware Claude/Codex configuration and status |
| System usage | Server, Runtime, agent/PTY, supervisor, and aggregate backend samples |

Backend placement is carried in the request scope. Native Windows operations
use Windows paths and processes. WSL operations use the selected distribution,
translate only at the boundary, and retain the distribution in worktree
identity and event keys.

Process Usage deliberately reports `scope: backend`. A PWA cannot inspect
arbitrary Chrome processes and does not fabricate client metrics. Electron may
augment the backend report with its own native metrics. Sampling is
demand-driven, bounded, and non-overlapping.

## Reconnect and event guarantees

Server events are advisory updates backed by authoritative snapshots. Sessions,
projects, settings, Notes, Git, Features, Vault, integrations, observers, and
Overview refresh after reconnect so a missed WebSocket message cannot leave a
client permanently stale. Subscription ownership uses stable client IDs and
disconnect cleanup removes only that client's demand.

The Runtime is unaffected by browser, Electron, or Server replacement. A
server-only restart reconnects to the existing Runtime; clients reconnect to
the Server, refresh shared state, and replay terminal output by sequence. An
explicit terminal stop, **Stop agent runtime**, or **Quit Soloe** is required
to end runtime-owned agents. **Stop Soloe server** leaves the Runtime and its
agents running so the replaceable Server can be rebuilt or restarted safely.

For WSL placement, the tray-owned supervisor treats an unexpected Server exit
as a replaceable-service failure. It restarts only the Application Server with
bounded backoff while preserving the existing Runtime process and socket. A
Runtime exit, expired tray lease, **Stop agent runtime**, or **Quit Soloe**
still tears down the complete backend in ownership order. A tray control record
lets the WSL supervisor distinguish an intentional server stop from a crash,
so it preserves the Runtime without immediately restarting the Server.

## Security and diagnostics boundary

Both RPC and event connections require the per-install token and bind to the
local boundary. The Server applies request/body and response limits before
dispatch, validates every namespace and method, and returns structured errors
without production stack traces. Worktree authorization prevents traversal,
symlink escape, arbitrary absolute-path access, invalid WSL distributions, and
mismatched placement identity.

RPC logs include start/end, elapsed time, safe payload sizes, outcome, and
structured failure code. Known service logs can be viewed through bounded
diagnostic tails. Tokens, cookies, terminal input, file and Note contents,
provider credentials, and Vault secrets are never diagnostic fields. The tray's
**Open Soloe logs** action remains the way to open the host log directory.

## Renderer responsiveness

The real-browser integration profile uses production PWA and Electron builds.
It records time to a loading state, completion time, RPC resource duration/body
size, and a 16 ms renderer heartbeat for Files, Working Diff, and Feature Lab
against normal and deliberately large repositories. Cold lazy-chunk startup is
reported separately from warmed large-data rendering.

The deterministic 160-change Diff case proved that DOM construction—not the
roughly 20 KB RPC payload—caused a long renderer task. Diff therefore mounts
the compact rows and review section shells in small animation-frame batches and
reports `Rendering n of n files…`; the test waits for the final batch and
enforces a 300 ms large-data event-loop-gap ceiling. The original Files freeze
did not reproduce with a 4,000-file tree, so Files did not receive speculative
streaming or pagination.

## Tray semantics

The Tauri tray is windowless and therefore remains small while Electron is
opened only on demand. Its menu has separate dynamic actions for the Soloe
Server and agent Runtime. Each changes between Start and Stop for the selected
Windows/WSL placement, and both are disabled while either transition runs.
Backend Placement remains visible and configurable in Settings. The menu also
opens the authenticated browser URL, opens Electron, launches the experimental
Tauri client, exposes logs, and quits Soloe; there are no redundant status rows.

The packaged macOS product is one installed `Soloe.app`, not an app plus a
second installed service application. The outer Tauri bundle is the menu-bar
owner and contains a private architecture-matched Electron payload. It runs
that embedded executable in Node mode as separate Environment Runtime and
Application Server processes, and in normal Electron mode for the Svelte UI.
Both the packaged PWA and Electron are clients of the persistent Application
Server. Closing the last supervised UI window exits only Electron; the tray,
Runtime, and Server stay available for **Open Soloe** or **Open in browser**
until **Quit Soloe** ends the complete owned tree.

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

Graceful Quit stops tray-launched Electron processes, the Development Web Host, the
Application Server, and finally the Environment Runtime. If the runtime may own
active terminals, the tray requires a second confirmation action. There is
currently no ownership-handoff/update mode: replacing the tray stops agents by
design instead of accidentally orphaning them.

The placement setting lives in the shared Windows Soloe data directory. For a
WSL backend, the tray translates that directory with `wslpath`, launches both
services through `wsl.exe`, and keeps the Unix runtime socket in the selected
distribution at
`$HOME/.local/state/soloe/runtime-<ownerId>.sock`. Owner-scoped socket names
let isolated tray data roots coexist without sharing a Runtime. The tray
records the active placement separately, so changing Settings cannot cause Stop
to target the wrong operating system. A placement change applies only after an
explicit Stop then Start.

In repository development, `pnpm dev` launches the tray. The tray validates the
native host and selected backend prerequisites, starts the Runtime and Server,
and starts the Development Web Host. Source and server deployments require a
compatible system Node.js 22 or newer. The packaged macOS application uses the
Node runtime embedded in its private Electron payload, so the installed app does
not require a separate Node installation.
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
pnpm test:browser-integration
pnpm --filter @soloe/desktop-electron build
pnpm --filter @soloe/desktop-tauri build
pnpm --filter @soloe/web build
pnpm --filter @soloe/tray exec tauri build --no-bundle
cargo test --workspace
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
pnpm dev:desktop:tauri
pnpm dev:tray
```

The runtime command intentionally does not use watch mode. Source rebuilds
belong to the replaceable server and clients; automatically restarting the PTY
owner would violate terminal continuity.

See [API compatibility](./api-compatibility.md) for the local Electron,
remote-Electron, browser, server, and runtime method boundaries.

For the complete Windows setup and both Backend Placement launch paths, see
[Windows development with Windows or WSL backends](../development/windows-backends.md).
