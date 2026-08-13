# Troubleshooting

## The tray or client cannot reach the backend

Start Soloe through `pnpm dev` so the tray can supervise the runtime and application server. When starting components manually, start the runtime before the server and then the client. Check the local Soloe logs in the configured data directory.

## WSL is unavailable

Confirm `wsl.exe --status` succeeds, the selected distribution appears in `wsl.exe --list --quiet`, and the distribution can start from a normal terminal. Install Claude Code or Codex CLI inside that distribution if the session uses the WSL backend.

## An agent command is not found

Soloe uses the `PATH` of the selected macOS, Windows, Linux, or WSL environment. A CLI installed on Windows is not automatically available inside WSL, and the reverse is also true. On macOS, verify the command is visible from the configured login shell (`$SHELL -lic 'command -v claude; command -v codex'`); GUI applications do not inherit an interactive terminal's environment directly.

## macOS blocks a local build

Developer-built applications may be unsigned or development-signed and are not equivalent to a notarized release. Prefer a signed release artifact. For a local build, inspect it with `codesign --verify --deep --strict --verbose=2 <app>` and do not bypass Gatekeeper for an application whose source or signature you do not trust.

## A repository path fails

Confirm the path exists in the same host where the session runs and that Git recognizes it as a repository or worktree. For Windows + WSL path behavior, see the [backend guide](./development/windows-backends.md). Include spaces and non-ASCII characters in bug reports when they are relevant to the failure.

## A Device is offline or needs an update

Refresh **Settings > Connections**. If Tailscale is not installed or signed in,
finish that setup and refresh; Soloe does not need to restart. Soloe configures
its own Serve route and discovers Devices automatically, so do not add an
endpoint URL or run a separate routine `tailscale serve` command. A Serve port
conflict is left untouched and reported in Connections.

An offline Device can leave cached logical Workspaces and Sessions visible, but
its Session rows and physical actions remain disabled until it reconnects. A
Device labeled **Update Soloe** must run a compatible Soloe version. Reinstalling
or resetting a backend creates a new backend-owned Device identity that is
discovered automatically; old logical references remain offline until regrouped
or recovered.

The **Sessions from** filter only changes what is shown. If a Session seems absent, clear
the filter and check its owning Device. Default placement applies only to new
Sessions and cannot reroute an existing one.

## A placement, publication, alignment, or cleanup was interrupted

Open the Workspace navigation **Recovery** section. Operations in
`interrupted` or `needs-attention` state retain their Device command IDs so the
outcome can be inspected before retrying. Do not manually repeat an ambiguous
Git/provider action first: a prepared Checkout or newly created remote may
already exist.

Copy the redacted operation report when filing a bug. It intentionally omits
paths, arguments, output, and credentials. A failed start can leave a valid
durable Session and Checkout; a failed publication can leave a valid private
GitHub repository. These are recoverable residues, not permission to force
delete or force push.

Cleanup of an isolated Worktree is expected to block when evidence is stale or
when staged, unstaged, untracked, ignored, unpublished, consumed, main-Checkout,
or ownership concerns exist. Refresh and resolve the named blocker. Soloe does
not offer a force-cleanup fallback.

## Terminal input is owned by another client

Reading output and replaying a terminal does not grant keyboard control. If
another authenticated client owns the Runtime input lease, Soloe reports
`terminal_input_owned` and shows **Take input control**. Taking control is
visible to both clients and invalidates the previous lease. Waiting for expiry
also permits a new owner; disconnecting or closing a presentation never stops
the terminal.

## Exporting or importing the Workspace catalog

Export creates a JSON bundle with a SHA-256 checksum. Import requires an
explicit replacement confirmation and the current catalog revision. A checksum
mismatch, unsupported schema, or stale revision leaves the current catalog
unchanged. Successful import first writes a timestamped `.pre-import-*.bak`
beside the catalog.

Import affects logical Projects, Workspaces, Locations, and Session Memberships
only. It does not clone, delete, stop, or clean Device-owned resources. Devices
that are not connected appear as offline references until their identities are
available again.

## Agent comments are not delivered

Check that the correct Claude Code or Codex integration is installed for the selected host, the MCP status is healthy, and the session is still running. WSL sessions require a Windows-host address reachable from the distribution. See [MCP security](./mcp-security.md) before changing bind or firewall settings.

## Preparing a bug report

Include the Soloe commit or version, operating system, backend mode, WSL distribution if applicable, repository location type, and the shortest reproduction steps. Review diagnostics before attaching them and remove private source, prompts, credentials, usernames, and paths that are not needed for the report.
