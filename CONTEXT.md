# Soloe Runtime

Soloe coordinates terminal sessions and repository observations across native and WSL worktrees while keeping background resource use bounded.

## Language

**Worktree**:
A repository checkout that can own one or more Soloe sessions.
_Avoid_: Folder, workspace

**Working Tree Snapshot**:
One coherent generation containing repository status, line totals, and working changes for a Worktree.
_Avoid_: Git poll result, status bundle

**Worktree Identity**:
The canonical path, runtime mode, and—under WSL—distribution that uniquely identify one Worktree across renderer and main-process state.
_Avoid_: cwd key, repository string

**Worktree Scope**:
An immutable operation address containing a Worktree path, runtime mode, and—under WSL—distribution; it resolves to exactly one Worktree Identity.
_Avoid_: Current context, cwd plus options

**Refresh Intent**:
The desired observation cadence and runtime context for one Worktree.
_Avoid_: Poller, interval

**Worktree Observation**:
A completed Working Tree Snapshot together with the cause that requested it.
_Avoid_: Tick, refresh result

**Worktree Inventory**:
A successful, authoritative `git worktree list` observation for one Project and runtime context.
_Avoid_: Worktree sweep, folder scan

**Inventory Demand**:
The desired freshness tier for one runtime-qualified Project's Worktree Inventory.
_Avoid_: Project poller, global worktree refresh

**Background Agent Request**:
A Soloe-dispatched, non-terminal model invocation with explicit priority, provider candidates, runtime scope, timeout, and cancellation validity.
_Avoid_: Hidden worker, helper spawn

**Durable Agent Observation**:
The restart-safe projection of worker observations and current TUI usage limits, committed from the latest semantic observer state.
_Avoid_: Observer event log, per-event persistence

**Worktree Evidence**:
One immutable, completeness-qualified generation of resolved Git facts, full working-patch fingerprint, and ordered Session transcript references used to validate or generate a Worktree overview.
_Avoid_: Overview inputs, Git summary

**Terminal Presentation**:
One resident renderer-side terminal emulator for a running Session, independent of the Session's PTY lifetime.
_Avoid_: Terminal process, terminal tab

**Terminal Replay Tail**:
A bounded, sequence-qualified main-process output tail used to initialize or resume a Terminal Presentation before live output is admitted.
_Avoid_: Terminal cache, output backlog

**Terminal Output Demand**:
Ref-counted intent from a visible Terminal Presentation to publish one PTY's live output across the main-to-renderer boundary.
_Avoid_: Terminal listener, running terminal

**Terminal Semantic Observation**:
One bounded interpretation of a terminal output batch for location, approval, and usage-limit facts, independent of presentation visibility.
_Avoid_: Per-chunk scan, terminal parsing

**Review Surface**:
One shared, virtualized multi-file diff viewport that owns review-wide interaction resources.
_Avoid_: Diff file pane, resident diff collection

**Review Demand**:
Ref-counted intent from a visible Diff or Files Rail Surface to keep one Worktree's review state fresh.
_Avoid_: Cached review, previously opened diff

**Rail Surface Residency**:
Renderer allocation for one currently visible rail tab body; continuity belongs to its store rather than hidden DOM.
_Avoid_: Keep-alive pane, hidden mounted tab

**Files Payload Residency**:
Ref-counted ownership of one Worktree's heavyweight Files tree and clean editor payload, separate from protected unsaved buffer continuity.
_Avoid_: Files cache, mounted editor state

**Browser DevTools View**:
One main-process native view attached to an inspected browser target and aligned to a renderer-owned placeholder.
_Avoid_: DevTools webview, floating debugger panel

**Browser Session State**:
The bounded, exact-Worktree persistence record for browser tabs, navigation history, and emulation intent, separate from live webview residency.
_Avoid_: Browser cache, whole browser store

**Resource Usage Observation**:
One demand-qualified snapshot of cheap application process totals and optional VM-wide WSL detail.
_Avoid_: Resource poll, diagnostics tick

**Feature Artifact Index**:
One bounded catalog of the files whose names or contents can change a Feature Snapshot for one Worktree Identity.
_Avoid_: Feature directory scan, watcher digest

**Feature Artifact Observation**:
One deterministic Feature Artifact Index revision produced for an actively subscribed Worktree Identity.
_Avoid_: Feature polling pass, recursive watcher

**Git Process Budget**:
The shared main-process admission limit governing physical native Git and WSL Git children across all Worktrees and evidence generations.
_Avoid_: Git thread pool, per-feature limiter

**Git Observation Lease**:
A Session-owned, runtime-qualified claim on native repository filesystem observation; passive Git reads and Worktree Inventory do not acquire it.
_Avoid_: Repository watcher, cache subscription

**Project Icon Demand**:
An explicit renderer query for bounded favicon discovery or one validated selected asset, kept separate from shared Project metadata.
_Avoid_: Project favicon cache, startup icon scan

**Notes Draft Durability**:
The coalesced restart-safe persistence of the latest Project-, exact Worktree-, or saved-note-owned unsaved text, independent of textarea input frequency.
_Avoid_: Per-keystroke draft save, editor cache

**Saved Note Recovery**:
A local recovery record for one saved note whose editor buffer is newer than its authoritative file.
_Avoid_: Saved draft, autosave cache

## Relationships

- A **Worktree** has at most one in-flight **Worktree Observation**
- Every cache, Refresh Intent, and publication for a **Worktree** is owned by its runtime-qualified **Worktree Identity**
- Every filesystem or repository mutation accepts an explicit **Worktree Scope** rather than consulting mutable path context
- A **Refresh Intent** schedules recurring **Worktree Observations**
- **Worktree Inventory** never creates **Refresh Intent**; Session presence creates background cadence and only the selected Worktree receives foreground cadence
- Every configured Project owns one initial **Inventory Demand**; the selected Project observes foreground inventory each minute, inactive Projects receive a ten-minute integrity cadence, and hidden windows suspend both
- Resuming a hidden window observes only foreground **Inventory Demand** immediately; background inventory is staggered from resume rather than stampeded
- An unchanged **Worktree Inventory** preserves renderer state identity while still publishing its authoritative result for Session integrity
- Releasing the final Session-owned **Refresh Intent** releases its cached sidebar evidence so an unknown Worktree is never presented as unchanged
- A **Worktree Observation** produces one **Working Tree Snapshot**
- A **Worktree Inventory** reconciles which project-bound Sessions still belong to a Worktree
- A **Background Agent Request** acquires shared process capacity before resolving and launching a provider
- One semantic observer mutation creates at most one **Durable Agent Observation** commit, regardless of how many presentation notifications it publishes
- A **Durable Agent Observation** excludes ordinary TUI lifecycle noise and permits only one atomic replacement at a time
- **Worktree Evidence** is acquired once and may be handed from overview validation to one immediate regeneration
- Incomplete **Worktree Evidence** may be displayed diagnostically but cannot validate, generate, or populate an overview cache
- One WSL **Worktree Evidence** generation crosses the host boundary through one bounded process; its working patch carries a bounded preview plus a full-content digest
- Native **Worktree Evidence** streams the same bounded patch preview and full-content digest
- Every ordinary Git command and native or WSL evidence generation acquires the shared two-child **Git Process Budget**
- The first Session-owned **Refresh Intent** acquires a **Git Observation Lease**; the final release closes native watchers and retires heavyweight snapshot payload, while passive repository caches remain bounded
- Shared Project metadata persists only a selected relative icon path; **Project Icon Demand** owns bounded traversal and asset payloads without Project-list persistence or broadcast
- **Notes Draft Durability** keys Worktree-owned state by **Worktree Identity**, keeps the latest in-memory text immediate, coalesces durable writes by immutable note address, flushes on shutdown, and cancels pending writes before discard
- **Saved Note Recovery** remains restart-safe until the authoritative note write succeeds; navigation never replaces a dirty saved-note buffer after a failed flush
- A running Session may outlive its **Terminal Presentation**; visible Sessions and a small recent set own the resident presentations
- A **Terminal Replay Tail** is capped at 4 MiB and 4,096 live events per Session, plus 32 MiB and 32,768 live events globally; its chronologies contain only retained chunks, and snapshot overlap is removed before ordered live output is admitted
- A hidden resident **Terminal Presentation** is dormant; reveal resumes from its last applied sequence through the **Terminal Replay Tail**
- The first visible **Terminal Presentation** acquires **Terminal Output Demand** for its PTY; the final hidden owner releases cross-process publication without stopping replay retention or agent observation
- Each output batch receives one **Terminal Semantic Observation** before replay publication; usage-limit state outranks approval redraws and hidden presentations remain observable
- One **Review Surface** owns one text-selection action; resident file bodies contribute exact review-entry identity without adding global listeners
- A cached review does not imply **Review Demand**; the final visible owner releases tick-driven range refresh and resident payload pins
- Only visible rail tabs own **Rail Surface Residency**; Worktree layout, review state, scroll positions, and unsaved file content survive outside renderer allocation
- A visible Files **Rail Surface Residency** acquires **Files Payload Residency**; final release retains at most two clean recent scopes while unsaved or saving buffers remain protected independently of evictable trees
- Switching the file addressed by **Files Payload Residency** cannot replace an unsaved buffer without an explicit discard decision
- A **Browser DevTools View** observes layout on demand; unchanged geometry performs no frame work or cross-process publication
- **Browser Session State** persists only changed Worktree scopes after a short coalescing window, with bounded scope, tab, history, title, and URL payloads
- A summary **Resource Usage Observation** never launches a WSL process; demanded WSL detail is serialized and briefly shared across observers
- A Feature Snapshot is materialized from exactly one **Feature Artifact Index** revision
- One active **Feature Artifact Observation** exists per subscribed **Worktree Identity**, regardless of renderer count
- A **Feature Artifact Observation** traverses only the fixed-depth semantic artifact grammar and publishes only to exact subscribed owners

## Example dialogue

> **Dev:** "Does opening three sessions create three Git pollers?"
> **Domain expert:** "No. Their shared Worktree produces one Refresh Intent and at most one Worktree Observation at a time."

> **Dev:** "Can overview regeneration reuse the Git and transcript reads from the dialog's validation?"
> **Domain expert:** "Yes. It consumes that exact Worktree Evidence generation once, provided the Worktree, runtime, base, and ordered Session scope are identical."

## Flagged ambiguities

- "refresh" previously meant both timer scheduling and repository materialization; **Refresh Intent** owns scheduling while **Working Tree Snapshot** owns materialization.
