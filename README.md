<img src="./build/icon.svg" alt="Soloe" width="96" />

# Soloe

A local-first Agent Development Environment (ADE) for solo developers using the CLI agents they already trust.

Soloe helps one developer plan features, run long-lived agent sessions, manage serious worktrees, and review changes across many commits without giving up the terminal workflow. It drives installed **Claude Code** and **Codex CLI** binaries in interactive mode, then adds the planning, memory, review, and project-management surfaces that the CLIs do not provide by themselves.

[![CI](https://github.com/mheraskin/soloe/actions/workflows/ci.yml/badge.svg)](https://github.com/mheraskin/soloe/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **Pre-release development.** Soloe is preparing for its first public alpha on macOS, native Linux, and Windows + WSL. There is no Soloe-hosted cloud or telemetry. macOS release builds are configured for Developer ID signing and notarization.

_A clean public demo is being prepared. The previous development screenshot was removed from this page because it contained private project context._

[**Download for macOS, Windows, or Linux**](https://github.com/mheraskin/soloe/releases) · [Why Soloe](#why-i-built-this) · [Feature Lab](#feature-lab-experimental) · [Roadmap](./ROADMAP.md)

## Why I built this

Soloe started on a Windows machine running WSL, before the current wave of tools such as [T3 Code](https://github.com/pingdotgg/t3code) and [Orca](https://github.com/stablyai/orca) was publicly available. At the time, the agent-development environments I could find were Mac-focused, while Windows + WSL support felt incidental or required too much glue. I wanted the development environment itself to work the way I worked, so I built my own.

I usually have a few long-lived feature worktrees, each with Claude Code or Codex running in a real terminal. I need one place to see what is active, plan a feature, review the feature across a stack of commits, leave line comments for an agent, and return days later without reconstructing the whole story.

The name **Soloe** describes that operating model. It is not an argument against teams or collaboration. It is an environment optimized around the solo developer as the decision-maker and review bottleneck: agents extend what one person can plan and deliver, while that person keeps control of the work.

## What Soloe does today

- **Drives the CLIs you already use.** Runs installed `claude` and `codex` binaries in interactive mode—natively on macOS, Linux, and Windows, or inside WSL on Windows.
- **Organizes project → worktree → session.** Keeps terminal, Claude Code, and Codex sessions attached to the worktree where the work belongs.
- **Keeps agents alive outside the UI.** The Environment Runtime owns PTYs independently from the replaceable server, browser, and Electron clients.
- **Reviews whole features.** Select a commit range, inspect a multi-commit diff, and see line-level commit attribution instead of reviewing only uncommitted changes.
- **Routes review comments back to agents.** An authenticated MCP bridge lets running agents read and resolve line comments.
- **Supports repository-native planning.** Experimental Feature Lab reads plans, coverage maps, and issue artifacts stored as Markdown alongside the code.
- **Keeps working context together.** Files, persistent notes, worktree overviews, browser tooling, agent notifications, and process diagnostics live beside the sessions.
- **Runs on infrastructure you control.** There is no Soloe cloud or telemetry. Browser/PWA access is served locally and can optionally be exposed through infrastructure you configure, such as Tailscale Serve.

## Feature Lab (experimental)

Feature Lab is the beginning of Soloe's planning system. It discovers repository-scoped planning artifacts, connects them to a feature, and lets the developer move between plans, coverage, issues, files, worktrees, and active agents without moving project state into a proprietary cloud.

The current implementation recognizes:

- `docs/plans/*.md` feature plans;
- `docs/grill/<feature>/coverage-map.md` planning and decision coverage;
- `.scratch/<feature>/issues/*.md` local issue artifacts;
- `docs/agents/issue-tracker.md`, `AGENTS.md`, and `CLAUDE.md` setup metadata.

This workflow is inspired by and currently shaped around [Matt Pocock](https://www.mattpocock.com/)'s open-source [Skills for Real Engineers](https://github.com/mattpocock/skills), including the grilling, triage, issue-slicing, and repository-context conventions. Soloe is an independent project and is not affiliated with or endorsed by Matt Pocock.

Feature Lab is intentionally marked experimental: it can browse these artifacts and update branch or local-issue status today, but it is not yet the visual project-management system described in the [roadmap](./ROADMAP.md).

## How Soloe differs

Soloe is built around a **solo developer workflow**, not a pitch to replace a team and not an infinite swarm of disposable branches. The target is one person coordinating a manageable set of serious, long-lived worktrees and retaining enough evidence to review what the agents produced.

It is also terminal-first. Many products lead with a GUI chat or drive agents through a programmatic SDK path. Soloe drives the installed interactive CLIs, preserving their native harness, authentication, hooks, and terminal behavior, then builds planning and review around them.

Windows + WSL remains part of the product's foundation rather than a compatibility afterthought. Native Linux is also supported in the current alpha.

## Current platform support

| Platform or client | Status |
| --- | --- |
| Windows + WSL backend | Public alpha |
| Native Windows backend | Public alpha |
| Native Linux | Public alpha |
| Browser/PWA client | Public alpha, locally hosted |
| Electron client | Public alpha |
| macOS Intel (`x64`) | Public-alpha source build; locally verified |
| macOS Apple silicon (`arm64`) | Public-alpha native CI build; hardware smoke pending |

## Install

Soloe does not have a public binary release yet. Until the first alpha is published, contributors can run it from source using the setup below. The release links in the platform sections will become active with that alpha.

### Windows

1. When the first alpha is available, download the latest `.exe` from [Releases](https://github.com/mheraskin/soloe/releases).
2. Run it. SmartScreen may require **More info → Run anyway** while builds are unsigned.
3. Add a Git repository from Windows or WSL and launch a session.

For WSL sessions, install `claude` or `codex` inside the selected distribution. Native Windows sessions use Windows-side binaries. Soloe uses the CLI's existing authentication; it does not require a separate provider API key.

### Linux

When the first alpha is available, choose the `.AppImage` or `.deb` from [Releases](https://github.com/mheraskin/soloe/releases):

```bash
# AppImage
chmod +x Soloe-*-linux-*.AppImage
./Soloe-*-linux-*.AppImage

# Debian/Ubuntu
sudo apt install ./Soloe-*-linux-*.deb
```

Install `git` and at least one of `claude` or `codex` on the normal Linux `PATH`. Soloe uses native Linux paths and shells and does not invoke WSL on Linux.

### macOS

When the first alpha is available, download the DMG matching the Mac: `x64` for Intel or `arm64` for Apple silicon. Drag the single `Soloe.app` to Applications and launch it normally. Soloe then lives in the menu bar: its separate Runtime and Application Server remain available to **Open in browser** and the on-demand Electron/Svelte **Open Soloe** client. Closing Electron releases only that UI process; **Quit Soloe** stops the tray, server, runtime, clients, PTYs, and agents. There is no separately installed service application. Release artifacts require Developer ID signing and Apple notarization; unsigned local builds are for development only.

Install Git and at least one of `claude` or `codex`. Soloe resolves the user's macOS login-shell `PATH`, so Homebrew installations work for both Intel and Apple-silicon locations. See the [macOS development and release guide](./docs/development/macos.md).

## Roadmap

The next planning and review surfaces include a visual canvas generated from Markdown plans, a Kanban view of issues and tasks, Wayfinder support, broader Matt Pocock skills compatibility, and AI-assisted summaries for very large commit ranges. Multi-commit review already exists; the planned intelligence layer will help a developer understand which changes in a history of tens or hundreds of commits deserve attention.

See the full [product roadmap](./ROADMAP.md) and the evidence-based [public launch checklist](./docs/public-launch-checklist.md). Roadmap items describe direction, not promised dates.

## Contributing

Issues are welcome, especially for Linux and Windows + WSL edge cases. Please read [Contributing](./CONTRIBUTING.md) and open an issue before a large pull request while the architecture is still settling.

Soloe is a PNPM workspace monorepo. Install the pinned toolchain and dependencies with:

```bash
corepack enable
pnpm install
```

One command starts the tray, the selected native or Windows/WSL backend, and the locally hosted PWA development server:

```bash
pnpm dev
```

The long-lived runtime, replaceable server, browser/PWA, optional Electron client, and windowless tray host are also independently runnable:

```bash
pnpm dev:runtime
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
pnpm dev:tray
```

Start the runtime before the server when launching them manually. Rebuilding or stopping a client or the server does not stop runtime-owned agent PTYs. Exiting the tray does stop all owned clients, services, PTYs, and agents. See [the process architecture](./docs/architecture/process-model.md) and the [Windows/WSL backend guide](./docs/development/windows-backends.md).

## License

[MIT](./LICENSE). Third-party components retain their own terms; see [Third-Party Licenses](./THIRD_PARTY_LICENSES.md). The Soloe name and logo are not granted under the code license.
