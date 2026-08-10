# Soloe Public Launch Checklist

This checklist replaces the original early launch plan. It reflects the repository as audited on 10 August 2026 and distinguishes implemented capabilities from launch hardening and longer-term product direction.

Soloe should launch as a **public alpha**, not as a finished v1:

> Soloe is a local-first Agent Development Environment for solo developers who use Claude Code and Codex CLI to plan, run, and review work across serious, long-lived worktrees.

## 1. Current product posture

- [x] Native Linux support exists.
- [x] Native Windows and Windows + WSL backend modes exist.
- [x] Claude Code, Codex CLI, and standard terminals run through interactive PTYs.
- [x] Project, worktree, and persistent session organization exists.
- [x] Runtime-owned sessions can survive browser, Electron, and application-server restarts.
- [x] Working-tree and multi-commit review exist, including line-level commit attribution.
- [x] Diff comments can be sent to and resolved by agents through MCP.
- [x] Files, notes, browser tooling, worktree overviews, notifications, and diagnostics exist.
- [x] Feature Lab reads repository-native plans, coverage maps, and local issue artifacts.
- [x] A browser/PWA client and Electron client exist.
- [ ] Treat all of the above as public-alpha behavior until clean-machine validation is complete.

The old checklist's Windows + WSL emphasis remains important as the origin and a core product strength, but “Windows + WSL only” is no longer accurate. Likewise, multi-commit review is a current feature, not a future promise.

## 2. Positioning and origin story

- [x] Lead with **solo developer workflow**, **terminal-first**, **worktree-aware**, and **human review**.
- [x] Explain that Soloe began because Windows + WSL lacked a native-feeling agent environment.
- [x] State that the project began before T3 Code and Orca were publicly available.
- [x] Explain the name: Soloe optimizes the development loop around one developer's judgment and capacity.
- [x] Make clear that “solo” is not criticism of teams or collaboration.
- [x] Avoid “replace your team,” “autonomous engineer,” “unlimited agents,” and generic “10x” claims.
- [x] Avoid defining Soloe only as a desktop cockpit now that browser/PWA and split runtime/server clients exist.
- [ ] Test the short description with early users before freezing GitHub and social copy.

Recommended one-line description:

> Local-first agent development environment for solo developers using Claude Code, Codex CLI, worktrees, plans, and multi-commit review.

## 3. MIT license decision

Soloe still needs a `LICENSE` file. Changing from Apache-2.0 to MIT changes the terms; it does not remove the license.

- [x] Replace Soloe's Apache-2.0 text with the MIT license.
- [x] Change root package and Cargo metadata from `Apache-2.0` to `MIT`.
- [x] Change README badges and license copy to MIT.
- [x] Keep `THIRD_PARTY_LICENSES.md`; dependencies retain their own licenses.
- [x] Clarify that the Apache NOTICE obligation belongs to the Apache-licensed dependency, not to Soloe's MIT license.
- [x] Keep the Soloe name and logo outside the code-license grant.
- [ ] Run a dependency-license report against the packaged artifacts before release.
- [ ] Decide whether outside contributions need a DCO after contributors appear; do not add a CLA by default.

MIT advantages for Soloe:

- Short, familiar, and easy for users and contributors to understand.
- Permits commercial use, modification, redistribution, and private use.
- Creates little adoption friction for a developer tool and leaves room for paid builds, support, or services.
- Matches the goal of maximizing public reach and reuse.

MIT trade-offs:

- It has no explicit patent grant comparable to Apache-2.0.
- It permits closed-source forks and commercial redistribution.
- It does not by itself protect the Soloe name or logo; brand protection remains separate.
- A permissively released version cannot later be made unavailable under the license already granted.

## 4. Repository audit: present and missing

Present now:

- [x] `README.md` with product copy, honest pre-release status, source setup, and development setup.
- [x] `LICENSE` and `THIRD_PARTY_LICENSES.md`.
- [x] `.gitignore` covers dependencies, generated output, releases, logs, environment files, and Rust targets.
- [x] GitHub CI and release workflow files exist.
- [x] Windows NSIS, Linux AppImage, and Linux DEB package targets exist.
- [x] A substantial automated test suite exists across TypeScript/Svelte and Rust.
- [x] Architecture, API compatibility, and Windows backend documentation exist.
- [x] Conventional Commit rules and agent/domain documentation exist.
- [x] A tracked-file scan found no obvious provider keys, GitHub tokens, AWS keys, or private-key blocks.

Missing or incomplete for launch:

- [x] Add `CONTRIBUTING.md` with supported setup, test commands, contribution scope, and response expectations.
- [x] Add `CODE_OF_CONDUCT.md`.
- [x] Add `SECURITY.md` with a private vulnerability-reporting path and supported-version policy.
- [x] Add `PRIVACY.md` explaining stored data, providers, optional Tailscale access, and deletion.
- [x] Add `CHANGELOG.md`; generated GitHub release notes are also configured.
- [x] Add `ROADMAP.md` without dates or false commitments.
- [x] Add GitHub issue forms and a pull-request template.
- [x] Add Dependabot for PNPM, Cargo, and GitHub Actions dependencies.
- [x] Add CodeQL JavaScript/TypeScript code scanning.
- [x] Add installation, troubleshooting, agent integration, MCP security, release-channel, and known-limitation docs.
- [x] Replace machine-specific paths in development documentation and source examples with neutral values.
- [x] Inspect Git history—not only the current tree—for old secrets, private paths, transcripts, and generated artifacts.
- [x] Remove the private-context `docs/media/hero.png` from the current branch.
- [ ] Resolve three historical commits containing a personal home path and purge the historical screenshot blob before changing visibility. History rewriting requires an explicit decision.
- [x] Confirm the repository is private, Issues are enabled, no releases exist, and branch protection is unavailable on the current private/free-plan combination.
- [ ] Recheck visibility, description, topics, Issues, and branch protection immediately before launch.

## 5. CI and release blockers

The workflow files are present, but presence is not the same as a verified release pipeline.

- [x] Replace `npm ci` with the PNPM setup action reading the exact version pinned in `package.json`; the repo has `pnpm-lock.yaml`, not `package-lock.json`.
- [x] Use `pnpm` consistently in CI and release commands.
- [x] Configure typechecking, the complete test suite, Rust format/lint/tests, and production client builds on every pull request.
- [x] Include current protocol, domain, runtime, server, web, remote Electron, and Rust workspace checks.
- [ ] Build Windows and Linux artifacts from a clean GitHub runner.
- [ ] Verify the packaged clients connect to the current server/runtime architecture.
- [x] Configure SHA-256 checksum generation for every release artifact.
- [x] Configure tagged GitHub releases as pre-releases.
- [x] Pass the complete local TypeScript/Svelte suite: 144 files and 1,043 tests.
- [x] Pass root and application-server typechecks, current web/Electron production builds, Rust format/lint, and all 23 Rust tests.
- [x] Produce local Linux AppImage and DEB artifacts and verify SHA-256 calculation.
- [ ] Publish explicit known issues and platform requirements in each release.
- [ ] Keep unsigned builds clearly labeled; plan stable Windows signing after alpha feedback.
- [ ] Test install, upgrade, uninstall, and rollback on clean machines.
- [ ] Do not add auto-update until artifact identity, signing, and rollback are reliable.

Suggested channels remain:

```text
nightly  -> optional main-branch or manual builds
alpha    -> public feedback releases
beta     -> installer and workflows considered broadly usable
stable   -> signed and validated on supported platforms
```

## 6. Security and privacy launch gate

Soloe controls terminals, repositories, hooks, secrets, browser sessions, and local services. Security documentation is a launch requirement, not polish.

Verified in the current implementation:

- [x] Electron renderer uses `contextIsolation: true` and `nodeIntegration: false`.
- [x] Renderer access is mediated through preload/backend interfaces.
- [x] The application server defaults to loopback and authenticated RPC/event transports.
- [x] Browser/PWA hosting defaults to loopback.
- [x] A CSP exists for the main renderer.
- [x] MCP requests are token-protected.
- [x] No Soloe telemetry or Soloe-hosted cloud is part of the current product claim.

Still requiring review or documentation:

- [ ] Document why the Windows MCP bridge binds beyond loopback for WSL reachability, its firewall boundary, and the actual exposure model.
- [ ] Confirm the MCP bridge cannot be reached from unintended LAN interfaces, or narrow the bind without breaking WSL.
- [x] Restrict Electron external-URL opening to absolute HTTP and HTTPS URLs in the legacy IPC and new-window paths, with focused tests.
- [ ] Audit every IPC/RPC payload and filesystem boundary, including linked worktrees and symlinks.
- [x] Document hook files Soloe reads or changes and the existing backup/uninstall/restore flow.
- [ ] Verify token rotation and revocation for server, browser, MCP, and integration credentials.
- [ ] Redact secrets, prompts, source text, and tokens from logs and diagnostic bundles by default.
- [x] Document where projects, sessions, notes, browser state, vault data, summaries, tokens, and logs are stored.
- [x] Explain that Claude Code and Codex still communicate with their providers under the user's provider terms.
- [x] Explain optional Tailscale Serve access; do not call that configuration strictly “local-only.”
- [x] Add a clear-local-data procedure.

## 7. Platform validation matrix

- [ ] Windows 11 with native Windows backend.
- [ ] Windows 11 with Ubuntu WSL backend.
- [ ] Windows 11 with more than one WSL distribution.
- [ ] Repository in the WSL filesystem.
- [ ] Repository under `/mnt/c/...`.
- [ ] Windows and WSL paths containing spaces and non-ASCII characters.
- [ ] Claude Code installed only in WSL, only on Windows, and only on Linux.
- [ ] Codex CLI installed only in WSL, only on Windows, and only on Linux.
- [ ] Native Linux AppImage and DEB installs.
- [ ] Missing WSL, stopped distribution, missing Git, and missing agent binary states.
- [ ] Browser/PWA and Electron reconnect after application-server replacement.
- [ ] Running PTYs survive client and server restarts and stop on explicit runtime shutdown.
- [ ] Externally deleted worktrees and branches recover cleanly.
- [ ] Multi-commit review across branch-only, worktree, untracked, and large-range changes.
- [ ] MCP comment delivery and failure states across native and WSL sessions.
- [ ] Feature Lab with GitHub-tracker, local-Markdown, partial, and absent setup artifacts.
- [ ] Tailscale Serve disabled, enabled, and allowlisted configurations.

macOS stays on the roadmap rather than in the launch matrix until it can be built, tested, and supported.

## 8. Feature Lab and Matt Pocock skills

Current support is real but intentionally narrow:

- [x] Detect Feature artifacts from `docs/grill`, `docs/plans`, and `.scratch/<feature>/issues`.
- [x] Read coverage, plan, issue, tracker, and agent-instruction metadata.
- [x] Update coverage-branch and local-issue status.
- [x] Detect whether repository agent-skills setup exists.
- [x] Attribute the workflow inspiration to [Matt Pocock](https://www.mattpocock.com/) and [his skills repository](https://github.com/mattpocock/skills).
- [x] State that Soloe is independent and not endorsed by Matt Pocock.
- [ ] Document the exact supported artifact grammar and failure behavior for users.
- [ ] Add compatibility fixtures for evolving versions of the skills.
- [ ] Add broader support for new Matt Pocock skills as their workflows stabilize.
- [ ] Add Wayfinder support and visualize its decision-ticket graph.
- [ ] Avoid implying that Soloe bundles, owns, or automatically installs all third-party skills.

## 9. Product roadmap: keep the ambitious items

These items are not launch claims, but they should remain visible as direction:

- [ ] A visual canvas for features, plans, decisions, tasks, agents, and worktrees.
- [ ] Convert Markdown plans into a scalable canvas while preserving Markdown as source of truth.
- [ ] Make large plans easier to comprehend through drawings and relationship maps.
- [ ] Add a Kanban view of tasks and issues.
- [ ] Add Wayfinder integration.
- [ ] Add support for new Matt Pocock skills and artifact conventions.
- [x] Multi-commit diff review exists today.
- [ ] Add saved progress and deeper navigation to multi-commit review.
- [ ] Add AI-assisted intelligence for large commit histories.
- [ ] For histories of around 100 commits, summarize the feature story and identify what needs developer attention.
- [ ] Cluster mechanical, corrective, and substantive commits without hiding raw evidence.
- [ ] Link commit summaries back to plans, issues, comments, worktrees, and agent sessions.

The product promise is not “AI will review everything for you.” The promise is that Soloe will reduce the cost of finding the parts that still need human judgment.

## 10. README, demo, and media

- [x] Product name, solo-developer meaning, and origin story are in the README.
- [x] Current Linux, native Windows, Windows + WSL, browser/PWA, and Electron support is explicit.
- [x] Feature Lab and Matt Pocock attribution are explicit.
- [x] Current features and future roadmap are separated.
- [x] Remove the private-context hero image from the README and current branch.
- [ ] Add a clean public hero before launch and purge the old image from public history.
- [ ] Add a 30–60 second clean demo GIF or video.
- [ ] Show project → worktree → session organization.
- [ ] Show a long-lived session surviving a client/server restart.
- [ ] Show Feature Lab moving from plan to issues and active work.
- [ ] Show multi-commit review, line attribution, and an agent resolving a comment.
- [ ] Add a GitHub social preview image and short X video crop.
- [ ] Add known limitations near download instructions.

## 11. GitHub and community setup

- [x] Add the repository description and ten focused discovery topics while keeping the repository private.
- [x] Issues are enabled; bug and feature forms are prepared locally.
- [ ] Keep Discussions disabled until there is enough traffic to maintain it.
- [ ] Protect `main`, require CI, block force pushes, and prefer linear history.
- [x] Keep the default community labels and add the canonical `needs-triage`, `needs-info`, `ready-for-agent`, and `ready-for-human` labels; the existing `wontfix` completes the five-role vocabulary.
- [ ] Add platform and security labels when there are issues that need them.
- [ ] Publish contribution boundaries before inviting large architectural changes.
- [ ] Start with docs, reproducible platform bugs, installer testing, UI polish, and tests as contribution areas.
- [ ] Keep security-sensitive MCP, remote-access, and vault changes under closer maintainer review.
- [ ] Add GitHub Sponsors, Polar, or another support link only when there is a clear place for it.

MIT keeps future monetization options open. Potential paid value should center on convenience—signed builds, support, advanced cross-project planning, or optional services—not on weakening the open-source core's trust model.

## 12. Launch messaging and channels

- [ ] Prepare one GitHub alpha release with checksums and known limitations.
- [ ] Prepare an X post/thread and short demo clip.
- [ ] Share with Linux and Windows + WSL Claude Code/Codex users first.
- [ ] Post to Hacker News only after installation and the demo are credible.
- [ ] Use Reddit, Bluesky, Mastodon, LinkedIn, and relevant communities with concrete technical detail rather than generic promotion.
- [ ] Defer Product Hunt until onboarding and releases can absorb broader traffic.

Suggested launch-post core:

> I built Soloe because the agent tools I could find did not fit my Windows + WSL workflow. I wanted a few serious worktrees, long-running Claude Code and Codex sessions, repository-native plans, and one place to review the feature across many commits. Soloe is the local-first environment I built so one developer can plan and deliver more while keeping the terminal and human review in control. It is now an MIT-licensed public alpha for Linux and Windows + WSL.

## 13. Minimum viable public alpha

Required before changing repository visibility:

- [x] MIT license and aligned metadata.
- [x] Clear README, origin story, current support, and roadmap without claiming an unreleased binary exists.
- [ ] No secrets, transcripts, private code, or private paths in the current tree or Git history.
- [ ] Green PNPM-based CI from a fresh clone.
- [ ] Working Windows and Linux alpha artifacts.
- [x] Checksum generation and unsigned-build warnings are prepared; release execution remains gated on artifact validation.
- [x] Security and privacy documentation.
- [x] Install and troubleshooting documentation.
- [x] Known limitations.
- [ ] GitHub templates are prepared and Issues are enabled; branch protection still requires public visibility or a paid plan.
- [ ] One clean demo video.

Not required for the first public alpha:

- [ ] Auto-update.
- [ ] Code signing.
- [ ] macOS support.
- [ ] A completed visual canvas.
- [ ] A completed Kanban or Wayfinder integration.
- [ ] AI summarization of 100-commit histories.
- [ ] Paid plans or team features.
- [ ] Perfect branding or complete documentation.

## 14. Recommended execution order

1. Finish repository and Git-history hygiene, including neutralizing private paths and screenshots.
2. Make PNPM CI green and confirm it covers the current monorepo architecture.
3. Add security, privacy, contribution, support, installation, and troubleshooting documents.
4. Audit MCP/WSL exposure, external URLs, hooks, tokens, diagnostics, and vault boundaries.
5. Produce clean Windows and Linux artifacts, checksums, and fresh-machine smoke tests.
6. Add issue forms, PR template, dependency updates, code scanning, and branch protection.
7. Record the short demo and prepare GitHub/X media.
8. Publish the MIT-licensed public alpha.
9. Collect platform and workflow failures before adding signing or auto-update.
10. Build the planning canvas, Kanban, Wayfinder, broader skills support, and commit intelligence iteratively from real usage.
