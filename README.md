# Soloe

A Windows + WSL IDE for the CLI agents you already use.

Soloe drives your installed **Claude Code** and **Codex CLI** sessions directly — your subscription, your harness, your hooks. No API key. No agent SDK in between. On top of that, it adds the cockpit features the CLIs don't have on their own: multi-commit diff review, line comments you can tag agents into, and per-feature worktree management.

[![CI](https://github.com/mheraskin/soloe/actions/workflows/ci.yml/badge.svg)](https://github.com/mheraskin/soloe/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

> **Status: public beta, Windows + WSL.** Local-only. No telemetry. No cloud.

![Soloe screenshot](./docs/media/hero.png)

[**Download for Windows**](https://github.com/mheraskin/soloe/releases) · [Why I built this](#why-i-built-this) · [How Soloe differs](#how-soloe-differs)

---

## Why I built this

I work in WSL. I run two or three serious feature worktrees at a time, each with a long-lived Claude Code or Codex CLI session. Across those worktrees I want one place to:

- see what's running where,
- review the actual *feature* — not just the working-tree diff, but the whole stack of commits I've built up,
- drop line comments on those diffs and tag an agent to resolve them,
- come back a week later and remember what happened.

I tried the existing tools. Conductor was the only one that really clicked for me — but it's Mac-only. Superset, Paseo, T3 Code: none of them ran natively on Windows + WSL the way I work. And most of them re-implement the agent loop on top of an SDK, which means a different harness from the CLI I already use and trust, and a separate billing path for tokens.

So I built Soloe for myself. It runs on Windows, drives my existing WSL `claude` and `codex` installs through `node-pty`, and adds the workflow features those CLIs don't have on their own. I use it every day.

## What Soloe does

- **Wraps the CLIs you already use.** Soloe shells out to your installed `claude` and `codex` binaries — Windows-native or wrapped through WSL. Your subscription, your harness, your hooks. No separate API key. No agent SDK in between.
- **Project → worktree → session.** Add a repo, see its worktrees, launch Claude Code / Codex CLI / standard terminal sessions per worktree. Sessions persist across app restarts; resume them without re-typing session IDs.
- **Multi-commit diff review.** Don't just look at the working tree — pick a range of commits and review the whole feature. Line-level commit attribution so you can see which hunk came from you vs. which agent.
- **Tag agents from diff comments.** Drop a line comment, mention the agent that's running in that worktree, and Soloe's local MCP bridge delivers it to the session. The agent reads, fixes, marks resolved.
- **Local-only.** Everything is stored in your Electron `userData` directory. No cloud sync. No telemetry. Claude / Codex traffic goes wherever your CLIs already send it.

## How Soloe differs

There are several good tools in this space, and Soloe doesn't try to replace any of them. **Conductor** is excellent on Mac but doesn't run on Windows. **Superset** and **Paseo** are worktree-aware but didn't work out of the box for me on WSL. **T3 Code** is a minimal GUI over the CLIs; Soloe leans further into the IDE-cockpit direction — diffs across commits, line comments routed to agents, worktree-aware session memory. Most of these tools also drive agents through their own SDK; Soloe deliberately doesn't. It runs the real CLIs so you keep the same harness, the same hooks, and the same subscription you already pay for.

## Status & known limitations

- **Windows + WSL is the supported target.** macOS and Linux builds aren't published yet.
- **Unsigned beta.** Windows SmartScreen will warn the first time you run the installer. Click "More info" → "Run anyway."
- **No auto-update yet.** Watch the [Releases](https://github.com/mheraskin/soloe/releases) page for new versions.
- **Worktree per feature today; per-session worktrees are coming.**
- **Things will break.** This is a beta — please file issues.

## Requirements

- Windows 10 or 11
- WSL with at least one Linux distro (Ubuntu recommended)
- One or more of:
  - [Claude Code](https://docs.claude.com/en/docs/claude-code) installed in WSL or Windows
  - [Codex CLI](https://github.com/openai/codex) installed in WSL or Windows
- Git, in WSL or Windows

You don't need an API key — Soloe drives whatever CLI you already have set up.

## Install

1. Download the latest installer from the [Releases](https://github.com/mheraskin/soloe/releases) page.
2. Run it. If SmartScreen warns you, click "More info" → "Run anyway."
3. Launch Soloe.
4. Add your first project — point it at a Git repo (Windows or WSL path).

## Architecture

Electron + Svelte renderer + `node-pty` for terminals. JSON-file persistence in `userData/`. A small local MCP server (bound to `127.0.0.1`, token-protected) exposes diff-comment tools so Claude / Codex sessions can read and resolve comments through their normal MCP support. Codex 0.129+ hook entries are pre-trusted on install so the integration stays seamless.

## Roadmap

Direction, not promises:

- Per-session worktrees (in addition to per-feature)
- WSL setup wizard and better diagnostics
- macOS and Linux builds, once the Windows + WSL story is solid
- More MCP tools for agents

## Contributing

Issues and bug reports welcome — especially Windows + WSL edge cases and any place the WSL path translation gets weird. Please don't open large architectural PRs without filing an issue first; the surface area is still in flux.

## License

[Apache-2.0](./LICENSE). The Soloe name and logo are not granted under the code license.
