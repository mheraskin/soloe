<img src="./build/icon.svg" alt="Soloe" width="96" />

# Soloe

A native Linux and Windows + WSL Agent Development Environment (ADE) for the CLI agents you already use.

Soloe drives your installed **Claude Code** and **Codex CLI** sessions directly in *interactive CLI mode* — same subscription, same harness, same hooks as running them yourself in a terminal. Not the Anthropic Agent SDK. Not `claude -p`. On top of that, it adds the workflow features the CLIs don't have on their own: multi-commit diff review, line comments you can tag agents into, and per-feature worktree management.

[![CI](https://github.com/mheraskin/soloe/actions/workflows/ci.yml/badge.svg)](https://github.com/mheraskin/soloe/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

> **Public alpha.** Native Linux and Windows + WSL. Local-only. No telemetry. Builds are currently unsigned.

![Soloe screenshot](./docs/media/hero.png)

[**Download for Windows or Linux**](https://github.com/mheraskin/soloe/releases) · [Why](#why-i-built-this) · [How it differs](#how-soloe-differs)

## Why I built this

I run two or three feature worktrees at a time in WSL, each with a long-lived Claude Code or Codex CLI session. I wanted one place to see what's running where, review the actual *feature* across a stack of commits (not just the working-tree diff), drop line comments, tag an agent to resolve them, and come back a week later and still remember what happened.

So I built Soloe. On Windows it drives existing WSL or Windows `claude` and `codex` installs; on Linux it drives the native Linux CLIs. Both builds use `node-pty` in interactive mode and add the workflow features those CLIs don't have on their own.

## What Soloe does

- **Wraps the CLIs you already use.** Shells out to installed `claude` and `codex` binaries in *interactive mode*—natively on Linux and Windows, or inside WSL on Windows.
- **Project → worktree → session.** Long-lived terminal, Claude Code, or Codex sessions per worktree. Resume across app restarts.
- **Multi-commit diff review.** Pick a range of commits and review the whole feature. Line-level commit attribution.
- **Tag agents from line comments.** A local MCP bridge (`127.0.0.1`, token-protected) delivers comments to the running session. The agent reads, fixes, marks resolved.
- **Local-only.** Stored in your Electron `userData` directory. No cloud sync. No telemetry.

## How Soloe differs

The gap I kept hitting in other tools: none of them ran out of the box on Windows + WSL, and most lead with a GUI chat in front of the agent. Chat-in-a-window is fine for ideation; the actual work belongs in the CLI.

The other split is *how* the agent gets driven. Many tools route through the **Anthropic Agent SDK** or **`claude -p`** programmatically — a different path from the interactive subscription you use when you type `claude` yourself. Soloe drives the real binaries in interactive CLI mode, so the harness, the hooks, and the subscription path stay the same. On top of that it adds the ADE-level workflow — diffs across a range of commits, line comments routed to agents, worktree-aware session memory.

## Install

### Windows

1. Grab the latest `.exe` from [Releases](https://github.com/mheraskin/soloe/releases).
2. Run it. SmartScreen may require "More info" → "Run anyway."
3. Add a Git repo (Windows or WSL path) and launch a session.

For WSL sessions, install `claude` or `codex` inside the selected distro. Native Windows sessions use Windows-side binaries. No API key is required—Soloe uses whichever CLI is already authenticated.

### Linux

Choose either the `.AppImage` or `.deb` from [Releases](https://github.com/mheraskin/soloe/releases):

```bash
# AppImage
chmod +x Soloe-*-linux-*.AppImage
./Soloe-*-linux-*.AppImage

# Debian/Ubuntu
sudo apt install ./Soloe-*-linux-*.deb
```

Install `git` and at least one of `claude` or `codex` on your normal Linux `PATH`. Soloe detects Linux automatically, uses native Linux paths and shells, and does not invoke WSL.

## Contributing

Issues welcome—especially Linux and Windows + WSL edge cases. Please file before opening large PRs; the surface area is still in flux. Worktree-per-feature today; per-session is on the roadmap.

## License

[Apache-2.0](./LICENSE). The Soloe name and logo are not granted under the code license.
