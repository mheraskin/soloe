<img src="./build/icon.svg" alt="Soloe" width="96" />

# Soloe

A local-first agent development environment for solo developers who use CLI agents.

Soloe keeps projects, worktrees, terminals, plans, and code review in one place. It runs the
installed Claude Code, Codex CLI, and Cursor Agent CLI in interactive mode, with their normal
authentication and terminal behavior intact.

[![CI](https://github.com/mheraskin/soloe/actions/workflows/ci.yml/badge.svg)](https://github.com/mheraskin/soloe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **Public alpha.** Installable prerelease builds are available for Windows, Linux, macOS Intel,
> and macOS Apple silicon. The builds are unsigned and intended for early testing, so expect
> breaking changes. Soloe has no hosted cloud, analytics, or telemetry.

[Download v0.1.0-alpha.2](https://github.com/mheraskin/soloe/releases/tag/v0.1.0-alpha.2) ·
[Run from source](#run-from-source) · [Roadmap](./ROADMAP.md) ·
[Security](./SECURITY.md) · [Privacy](./PRIVACY.md) · [Contributing](./CONTRIBUTING.md)

## Why I built it

I started Soloe on Windows with my development environment inside WSL. The agent tools I could
find treated that setup as an edge case, and stitching together terminals, worktrees, plans, and
review took more effort than the work itself.

My normal setup has a few long-running feature worktrees. Each may have Claude Code, Codex, or
Cursor running in a real terminal. I want to see what is active, return to a session days later,
review the feature across its full commit history, and send a precise comment back to the agent.
Soloe grew around that loop.

Soloe is named for this way of working. Agents help me take on more, but I still decide what to
build and what is safe to ship.

## What works today

- **Interactive CLI agents.** Soloe runs installed `claude`, `codex`, and Cursor `agent` binaries
  on macOS, Linux, native Windows, or inside WSL.
- **Project and worktree organization.** Sessions stay attached to the checkout where their work
  belongs. A logical workspace can have independent checkouts on more than one device.
- **Long-lived terminals.** The Environment Runtime owns PTYs. Closing a client or restarting the
  Application Server does not kill the agents running inside them.
- **Desktop, browser, and mobile access.** The Electron client and locally hosted PWA use the same
  authenticated server. Tailscale can connect Soloe environments on trusted devices.
- **Multi-device control.** One client can browse projects and sessions on connected devices,
  prepare a checkout, start or resume work there, and take terminal input control when needed.
- **Ghostty terminal rendering.** The client uses Ghostty's VT core compiled to WebAssembly and a
  Canvas2D renderer. Terminal history can be replayed after a client or device reconnects.
- **Feature-level review.** Pick a commit range, inspect the combined diff, and see which commit
  last touched each line. Working-tree review is available too.
- **Comments agents can act on.** An authenticated MCP bridge lets running agents read and resolve
  line comments left in Soloe.
- **Repository-native planning.** Feature Lab reads Markdown plans, coverage maps, local issues,
  and agent setup files from the repository.
- **Worktree tools.** Files, notes, browser tabs, worktree summaries, agent notifications, and
  process diagnostics stay beside the active sessions.

## Multi-device work

Each Soloe Device owns its repositories, PTYs, credentials, and agent integrations. Soloe
publishes that device's project, worktree, and session inventory to authenticated clients. From
another connected device you can add, edit, or remove a project registration, prepare a workspace
location, and operate the sessions that run there.

Terminal control is explicit. Several clients may watch the same session, but only one controls
keyboard input at a time. Another client can take control without stopping the PTY.

The Browser rail can open a web server running on a selected device. Soloe routes localhost ports
and subdomains through Tailscale and can use short device hostnames once local DNS is configured.

Soloe does not copy working directories between machines. Checkouts remain independent and Git
alignment uses explicit push, fetch, and fast-forward operations with revision checks. Uncommitted
files do not move between devices. Continuing on another device creates a successor session
instead of moving the original PTY.

## Process model

Soloe separates process lifetime from UI lifetime:

- the **Environment Runtime** owns PTYs, replay history, and terminal control;
- the **Application Server** owns domain state and authenticated HTTP, RPC, and WebSocket
  transports;
- the **Tray Host** starts and stops the Runtime, Server, and clients;
- the **Electron client** and **browser/PWA client** can disconnect and reconnect without owning
  agent processes.

On Windows, the Runtime and Server can run natively or together inside one selected WSL
distribution. On macOS and Linux they run natively.

## Feature Lab

Feature Lab is an experimental view over planning files in a repository opened with Soloe. It
recognizes:

- `docs/plans/*.md` feature plans;
- `docs/grill/<feature>/coverage-map.md` planning coverage;
- `.scratch/<feature>/issues/*.md` local issues;
- `docs/agents/issue-tracker.md`, `AGENTS.md`, and `CLAUDE.md` setup metadata.

The workflow follows conventions from [Matt Pocock's Skills for Real
Engineers](https://github.com/mattpocock/skills). Soloe can browse these artifacts and update some
branch and local-issue state. It does not bundle the skills or provide the visual planning canvas
described in the [roadmap](./ROADMAP.md). Soloe is independent and is not endorsed by Matt Pocock.

## Platform status

| Platform or client | Current status |
| --- | --- |
| Windows + WSL | Unsigned prerelease installer available; clean-machine validation pending |
| Native Windows | Unsigned prerelease installer available; clean-machine validation pending |
| Native Linux | Prerelease AppImage and DEB available; clean-machine validation pending |
| macOS Intel | Ad-hoc-signed prerelease DMG available; local packaging verified |
| macOS Apple silicon | Ad-hoc-signed prerelease DMG available; physical clean-machine smoke pending |
| Electron client | Included in prerelease builds for desktop platforms |
| Browser/PWA client | Locally hosted; optional access through Tailscale |

## Current limitations

- Binary prereleases are available, but there is no stable channel or auto-update support.
- Windows and Linux installers have not completed clean-machine installation, upgrade, and
  uninstall tests.
- Intel macOS packages have been tested locally. Apple-silicon packages build in CI, but the
  physical clean-machine smoke test is still pending.
- macOS prerelease DMGs are ad-hoc signed rather than Developer ID signed or notarized. Windows
  prerelease installers are unsigned.
- The legacy Electron MCP path binds beyond loopback so WSL can reach it. Its Windows Firewall and
  network exposure still need focused validation.
- Electron uses an unsandboxed preload and a browser webview. Context isolation is enabled, but
  this boundary still needs an audit.
- Tailscale access is remote access. Tailnet membership and policy decide who can reach Soloe.
- Devices keep independent Git checkouts. Soloe does not transfer uncommitted files or move a
  running session between machines.
- GitHub is the only repository provider adapter. Creating a GitHub repository requires an
  authenticated `gh` installation on the device performing the operation.
- Physical iPhone and multi-computer Tailscale testing is incomplete.
- Feature Lab supports a narrow set of plans, coverage maps, local issues, and agent setup files.
- Logs and diagnostics can contain source paths, prompts, and other development context. Review
  them before sharing.

## Run from source

You need Node.js 22 or newer, Corepack, Git, a stable Rust toolchain, the platform dependencies for
Tauri, and at least one authenticated agent CLI.

```bash
git clone https://github.com/mheraskin/soloe.git
cd soloe
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm dev
```

On Ubuntu, run this once after installing dependencies. It installs `wl-clipboard` and configures
Electron's Chromium sandbox:

```bash
pnpm setup:linux
```

The tray starts the Runtime, Application Server, web client, and desktop client. To run them
individually:

```bash
pnpm dev:runtime
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
pnpm dev:tray
```

Start the Runtime before the Server when launching components manually.

## Agent integrations

Soloe uses each agent CLI's existing installation and authentication on the device that owns the
session. Integration setup can update:

- `~/.claude/settings.json` for Claude Code hooks;
- `~/.claude.json` for the Claude Code MCP entry;
- `~/.codex/config.toml` for Codex MCP configuration;
- `~/.cursor/mcp.json` for Cursor MCP configuration.

Soloe creates a timestamped `.soloe-backup-<timestamp>` copy before changing an existing file.
Setup writes files atomically and uses restrictive permissions where the platform supports them.
Remove integrations through Soloe when possible. Installing an integration on one device does not
install it elsewhere or copy provider credentials between devices.

## Troubleshooting

- Start Soloe with `pnpm dev` so the tray supervises the Runtime and Application Server. When
  starting components manually, start the Runtime first.
- If WSL is unavailable, check `wsl.exe --status` and `wsl.exe --list --quiet`. Install the agent
  CLI inside the selected distribution.
- Soloe resolves commands on the device and environment that owns the session. A CLI installed on
  Windows is not available inside WSL, and the reverse is also true.
- If a device is offline, refresh **Settings > Connections** and confirm that Tailscale is installed
  and signed in. A device marked **Update Soloe** needs a compatible version.
- If another client controls terminal input, use **Take input control**. Taking control does not
  stop the PTY.
- Before filing a bug, remove credentials, prompts, source text, usernames, and unrelated paths
  from logs and diagnostics.

## Contributing

Focused bug reports, platform reproductions, documentation, tests, and small UI improvements are
useful while the architecture is still changing. Open an issue before a large feature or
architectural change. See [Contributing](./CONTRIBUTING.md) for setup and checks.

## License

[MIT](./LICENSE). Third-party components keep their own licenses. See
[Third-Party Licenses](./THIRD_PARTY_LICENSES.md). The Soloe name and logo are not granted under
the code license.
