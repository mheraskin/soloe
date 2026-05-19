<img src="./build/icon.svg" alt="Soloe" width="96" />

# Soloe

A Windows + WSL Agent Development Environment for the **Claude Code** and **Codex CLI** sessions you already run.

[![CI](https://github.com/mheraskin/soloe/actions/workflows/ci.yml/badge.svg)](https://github.com/mheraskin/soloe/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

> **Public alpha.** Windows + WSL. Local-only. No telemetry. Unsigned installer — SmartScreen will warn the first time.

![Soloe screenshot](./docs/media/hero.png)

[**Download for Windows**](https://github.com/mheraskin/soloe/releases)

## Why

I run two or three feature worktrees at a time with long-lived `claude` and `codex` sessions in WSL. I wanted one place to see them all, review the *feature* across a stack of commits (not just the working-tree diff), leave line comments, and tag an agent to fix them.

Other tools didn't run out of the box on Windows + WSL, and most lead with a GUI chat in front of the agent or route through the Agent SDK / `claude -p`. Soloe drives the real binaries in interactive CLI mode — same subscription, same harness, same hooks as if you'd typed `claude` yourself.

## What it does

- **Project → worktree → session.** Long-lived terminal, Claude Code, or Codex sessions per worktree. Resume across app restarts.
- **Multi-commit diff review.** Pick a range of commits and review the whole feature. Line-level commit attribution.
- **Tag agents from line comments.** A local MCP bridge delivers comments to the session. Agent reads, fixes, marks resolved.

## Install

1. Grab the latest `.exe` from [Releases](https://github.com/mheraskin/soloe/releases).
2. Run it. SmartScreen → "More info" → "Run anyway."
3. Add a Git repo (Windows or WSL path) and launch a session.

You need WSL with a Linux distro and either `claude` or `codex` installed (in WSL or Windows). No API key — Soloe uses whichever CLI you already have set up.

## Contributing

Issues welcome — especially Windows + WSL edge cases. Please file before opening large PRs; the surface area is still in flux. Worktree-per-feature today; per-session is on the roadmap.

## License

[Apache-2.0](./LICENSE). The Soloe name and logo are not granted under the code license.
