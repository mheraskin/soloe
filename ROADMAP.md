# Soloe roadmap

Soloe is an agent development environment for one developer coordinating several long-running
worktrees. This roadmap records direction, not release dates.

## Available in the source preview

- Interactive Claude Code, Codex CLI, Cursor Agent CLI, and ordinary terminal sessions.
- Native macOS, native Linux, native Windows, and Windows + WSL execution.
- A Runtime that keeps PTYs alive when the Server or a client restarts.
- Electron and browser/PWA clients over authenticated local transports.
- Tailscale discovery for trusted Soloe Devices.
- Project, workspace, worktree, and session inventories across connected devices.
- Remote project registration, checkout preparation, and session control.
- One terminal input controller with spectator clients and explicit takeover.
- A Ghostty WebAssembly terminal renderer with reconnectable history.
- Device-aware localhost and subdomain routing in the Browser rail.
- Multi-commit and working-tree review with line attribution.
- Line comments that agents can read and resolve through the authenticated MCP bridge.
- Files, notes, browser tools, worktree summaries, notifications, and diagnostics.
- Experimental Feature Lab support for repository plans, coverage maps, and local issues.

## First binary alpha

- Build Windows, Linux, Intel macOS, and Apple-silicon macOS artifacts on clean runners.
- Test install, upgrade, uninstall, and rollback on clean machines.
- Complete a physical Apple-silicon smoke test and a multi-computer Tailscale test matrix.
- Publish SHA-256 checksums and known issues with every artifact.
- Audit the MCP and WSL network boundary, hooks, token rotation, and diagnostic redaction.
- Add a short demo made with public fixtures.
- Keep unsigned artifacts clearly labeled until platform signing is in place.

## Planning and navigation

- **Visual plan map.** Turn Markdown plans into a navigable drawing while keeping Markdown as the
  source of truth.
- **Decision and dependency views.** Connect plans, decisions, issues, worktrees, agents, and review
  state without hiding the files behind a proprietary format.
- **Kanban view.** Present tasks and issues as a board without requiring a Soloe-hosted tracker.
- **Wayfinder support.** Read and display large initiatives and their decision tickets.
- **Broader skills support.** Follow more artifact conventions from
  [Matt Pocock's skills](https://github.com/mattpocock/skills).
- **Planning to execution.** Keep the relationship between a plan, its issues, worktrees, active
  sessions, and final review.

## Review intelligence

- Summarize the feature story across tens or hundreds of commits.
- Point to risky, surprising, cross-cutting, or unresolved changes that need review.
- Group mechanical, corrective, and feature commits without hiding the raw history.
- Save review scopes and progress.
- Link summaries to the exact commits, diffs, issues, comments, worktrees, and sessions behind
  them.

AI summaries should shorten the search for evidence. They should not replace the evidence.

## Solo-developer scale

- Cross-project and cross-worktree attention views.
- Better memory for long-running features and sessions.
- One inbox for approvals, failed tasks, unresolved comments, and work that needs a person.
- Background work with explicit ownership, cancellation, and review boundaries.
- Better recovery when a device, client, or server disappears during an operation.

## Release channels

| Channel | Purpose | Expected stability |
| --- | --- | --- |
| Nightly | Optional manual or main-branch artifacts | May be broken; no migration guarantee |
| Alpha | Public workflow and platform validation | Incomplete; breaking changes possible |
| Beta | Installer and core workflow validation | Fewer breaking changes; still pre-release |
| Stable | Signed and validated supported-platform release | Not available |

During the initial public release period, only the newest alpha will receive fixes. Release notes
will list platform requirements, security changes, migration steps, known issues, and rollback
instructions. Checksums verify download integrity but do not replace platform code signing.

## Deliberate non-goals

- Replacing teams or human collaboration.
- Claiming fully autonomous software delivery.
- Hiding changes behind AI summaries.
- Requiring a Soloe cloud account.
- Optimizing for an unlimited swarm of disposable worktrees.
