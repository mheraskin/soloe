# Soloe Roadmap

Soloe is building an Agent Development Environment for a solo developer who wants to plan, run, understand, and review more work without handing control to a cloud service or an opaque swarm.

This roadmap records product direction. It does not promise release dates, and ambitious items stay visible even when their shape is still being explored.

## Available in the public alpha

- Native Linux, native Windows, and Windows + WSL agent sessions.
- Interactive Claude Code, Codex CLI, and standard terminal sessions.
- Long-lived runtime-owned PTYs that survive client and application-server restarts.
- Project, worktree, and session organization.
- Multi-commit and working-tree diff review with line attribution.
- Line comments that agents can read and resolve through the authenticated MCP bridge.
- Files, persistent notes, browser tooling, worktree overviews, notifications, and diagnostics.
- Experimental Feature Lab support for repository-native plans, coverage maps, and local issue artifacts.
- Browser/PWA and Electron clients over local authenticated transports.

## Public-launch hardening

- Complete security, privacy, contribution, and support documentation.
- Make CI and release automation use the pinned PNPM toolchain consistently.
- Verify clean-machine install and packaging on native Linux, native Windows, and Windows + WSL.
- Add release checksums and document unsigned-build verification.
- Audit the MCP/WSL network boundary, external URL handling, hook installation, and diagnostic redaction.
- Add a short product demo and clean public fixtures.

## Planning and navigation

- **Visual canvas.** Convert Markdown plans into a scalable visual map while keeping Markdown as the portable source of truth.
- **Comprehensible drawings.** Show dependencies, decisions, issues, worktrees, agents, and review state in a form that is faster to understand than a directory of documents.
- **Kanban view.** Present tasks and issues as a board without forcing projects into a Soloe-hosted tracker.
- **Wayfinder support.** Visualize large initiatives and the decision tickets that make work safe to split across many agent sessions.
- **Broader skills support.** Track new releases and more artifact conventions from [Matt Pocock's skills](https://github.com/mattpocock/skills) while keeping the integration explicit and adaptable.
- **Planning-to-execution loop.** Move from a plan to issues, worktrees, active sessions, and review without losing the relationships between them.

## Review intelligence

- **Large-history summarization.** Analyze tens or hundreds of commits and explain the feature-level story rather than presenting an undifferentiated log.
- **Attention guidance.** Surface risky, surprising, cross-cutting, or unresolved changes that deserve a developer's review.
- **Commit clustering.** Group mechanical, corrective, and feature-bearing commits so the raw history remains available but becomes navigable.
- **Multi-commit review improvements.** Extend the current range review with saved review scopes, stronger attribution, progress state, and links back to plans and issues.
- **Evidence, not magic.** Every summary should remain traceable to commits, diffs, issues, and agent sessions so AI guidance never replaces inspectable source material.

## Solo-developer scale

- Cross-project and cross-worktree attention views.
- Better feature and session memory across long-running efforts.
- A clear inbox for approvals, failed tasks, unresolved comments, and work that needs human judgment.
- More robust background work with explicit ownership, cancellation, and review boundaries.
- Optional macOS support when it can be tested and maintained properly.

## Deliberate non-goals for now

- Replacing teams or human collaboration.
- Claiming fully autonomous software delivery.
- Hiding changes behind AI summaries.
- Making a Soloe cloud account mandatory.
- Optimizing primarily for an unlimited swarm of disposable worktrees.
