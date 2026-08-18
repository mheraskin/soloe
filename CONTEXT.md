# Soloe Runtime

Soloe coordinates terminal sessions and repository observations across native and WSL worktrees while keeping background resource use bounded.

## Language

**Project**:
A source-code repository identified by its canonical Git remote. A Project may have independent physical locations on several Devices.
_Avoid_: Repository checkout, project folder

**Workspace**:
A logical workstream inside one Project, normally identified by a Branch or pinned Revision. The same Workspace can have independent Locations on several Devices.
_Avoid_: Device, shared folder, Session group

**Workspace Source**:
The Git intent for a Workspace: a Branch, pull request, or pinned Revision. It does not claim that every Location currently conforms to that intent.
_Avoid_: Current branch, synced state

**Workspace Location**:
One Workspace's ordinary realization through a Device-owned Checkout. Locations on separate Devices are independent physical resources.
_Avoid_: Shared folder, synchronized copy

**Worktree**:
A physical repository checkout on exactly one Device. It can realize a Workspace Location, belong to an isolated Session, be the main Checkout, or remain external.
_Avoid_: Workspace, logical project

**Checkout**:
A Device-owned stable record for one Worktree whose path is a mutable locator rather than its identity.
_Avoid_: Workspace, path identity

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

**Session**:
A user-visible interactive work record owned and executed by exactly one Device, normally bound to one Workspace Location on that Device.
_Avoid_: Tab, terminal process

**Session Source**:
The Device-authoritative binding from a Session to its exact Checkout and provenance. The client derives Project and Workspace presentation from that binding instead of storing a second membership record.
_Avoid_: Sidebar membership, current filter

**Successor Session**:
A new Session created on a prepared destination when work must continue on another Device or Checkout; the original remains independent.
_Avoid_: Moved Session, migrated PTY

**Terminal Replay Tail**:
A bounded, sequence-qualified Environment Runtime output tail used to initialize or resume a Terminal Presentation before live output is admitted.
_Avoid_: Terminal cache, output backlog

**Environment Runtime**:
The long-lived local process that exclusively owns agent PTYs, terminal replay,
and terminal input/resize/stop control independently of every UI and
Application Server connection.
_Avoid_: Electron main process, terminal container

**Application Server**:
The replaceable local process that owns domain state and exposes authenticated
HTTP, RPC, and WebSocket transports to browser and desktop clients without
owning agent PTY lifetime.
_Avoid_: Environment Runtime, tray backend

**Soloe Environment**:
The Application Server and Environment Runtime running together on one Device.
_Avoid_: Backend, Soloe Server, Soloe Client

**Tray Host**:
The windowless native supervisor that reports service state and explicitly
starts or stops the Environment Runtime and Application Server.
_Avoid_: Desktop client, background Electron window

**Soloe Client**:
The user-facing desktop application that connects to an Application Server
without owning the Environment Runtime or agent process lifetime.
_Avoid_: Electron app, Tray Host, Soloe application (when the lifecycle distinction matters)

**Backend Placement**:
The restart-applied setting that places the Application Server and Environment
Runtime together on either Windows or one selected WSL distribution while
clients and the Tray Host remain on Windows.
_Avoid_: Session run mode, terminal shell, WSL connector

**Terminal Output Demand**:
Ref-counted intent from a visible Terminal Presentation to publish one PTY's live output across the main-to-renderer boundary.
_Avoid_: Terminal listener, running terminal

**Terminal Control Lease**:
The non-expiring Environment Runtime-owned capability binding one Session to one
controlling Soloe Device. Commands prove control with the Session ID, its owner
Device ID, the controlling Device ID, and the granted Lease ID. It remains
authoritative across Client, tab, and transport inactivity until explicit
release, Terminal exit, Environment Runtime shutdown, or takeover by another
Device.
_Avoid_: Terminal Input Lease, focused terminal, permanent lock

**Session Control**:
The current binding between one Session and the Soloe Device controlling it, independent of the Device that owns and executes the Session.
_Avoid_: Controller Session, selected tab, transport connection

**Controller**:
The Soloe Device that currently holds a Session's Terminal Control Lease.
_Avoid_: Owner, focused client, active terminal

**Spectator**:
A Client that observes a Session without holding its Terminal Control Lease.
_Avoid_: Disabled terminal, passive controller

**Active Client**:
A Client whose selected Session view is visible and eligible to claim an unclaimed Terminal Control Lease.
_Avoid_: Connected client, focused terminal

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

**Worktree File Index**:
One bounded, freshness-qualified catalog of Worktree-relative files shared by the Files tree and file palette for one Worktree Identity.
_Avoid_: File-search cache, repeated repository listing

**Renderer Backend Interface**:
The transport-neutral renderer seam through which Svelte Modules invoke backend behavior and subscribe to backend events.
_Avoid_: Electron IPC wrapper, preload global

**Renderer Backend Adapter**:
One shell-specific implementation of the Renderer Backend Interface, such as the current Electron preload transport or a future Tauri transport.
_Avoid_: Renderer backend, IPC implementation

**Soloe Device**:
One trusted machine with a durable Device identity that exposes a Soloe Application Server and its associated Environment Runtime.
_Avoid_: Backend URL, remote workspace, endpoint

**Device Connection Registry**:
The Application Server-owned cache of this Device and automatically discovered Soloe Devices, including durable identity pins and last-known availability. It stays active independently of browser or desktop selection so status remains current. Tailscale credentials and per-Device enablement are not part of this model.
_Avoid_: Device picker, Tailscale token store

**Alignment Evidence**:
Timestamped Device facts used to compare a Workspace Source, Location, or Session Source without claiming filesystem synchronization.
_Avoid_: Sync state, source of truth

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
- Cancelling a **Background Agent Request** immediately leaves admission, kills its active native or WSL child, and renderer destruction or application shutdown aborts every request it owns
- One semantic observer mutation creates at most one **Durable Agent Observation** commit, regardless of how many presentation notifications it publishes
- A **Durable Agent Observation** excludes ordinary TUI lifecycle noise and permits only one atomic replacement at a time
- **Worktree Evidence** is acquired once and may be handed from overview validation to one immediate regeneration
- Incomplete **Worktree Evidence** may be displayed diagnostically but cannot validate, generate, or populate an overview cache
- One WSL **Worktree Evidence** generation crosses the host boundary through one bounded process; its working patch carries a bounded preview plus a full-content digest
- Native **Worktree Evidence** streams the same bounded patch preview and full-content digest
- Every ordinary Git command and native or WSL evidence generation acquires the shared two-child **Git Process Budget**
- After termination is requested, every Git Adapter releases its **Git Process Budget** admission within one bounded close grace even when the child never publishes close
- One **Worktree File Index** materialization is shared by concurrent tree and palette demand, capped per inventory and across a small exact-identity LRU
- Invalidating a **Worktree File Index** during materialization queues one fresh generation and never publishes the stale catalog
- The first Session-owned **Refresh Intent** acquires a **Git Observation Lease**; the final release closes native watchers and retires heavyweight snapshot payload, while passive repository caches remain bounded
- Shared Project metadata persists only a selected relative icon path; **Project Icon Demand** owns bounded traversal and asset payloads without Project-list persistence or broadcast
- **Notes Draft Durability** keys Worktree-owned state by **Worktree Identity**, keeps the latest in-memory text immediate, coalesces durable writes by immutable note address, flushes on shutdown, and cancels pending writes before discard
- **Saved Note Recovery** remains restart-safe until the authoritative note write succeeds; navigation never replaces a dirty saved-note buffer after a failed flush
- A running Session may outlive its **Terminal Presentation**; visible Sessions and a small recent set own the resident presentations
- **Session Order** is shared presentation metadata, independent from Runtime
  Placement; reordering a merged local/remote list preserves global slots and
  propagates the same order to every represented Device
- A running Session may outlive every **Application Server** and client; only
  explicit stop intent sent to the **Environment Runtime** ends its PTY
- Replacing or rebuilding an **Application Server** disconnects transports but
  never shuts down the **Environment Runtime**
- Exiting a browser or Soloe Client releases only its presentations and
  connections; **Tray Host** quit is the explicit whole-backend stop boundary
- The **Tray Host** owns every native backend and client process group through
  an OS-enforced lifetime boundary; a Tray Host crash stops those groups, and a
  later Tray Host reclaims any verified residue left by an older build
- One **Backend Placement** owns both the **Application Server** and
  **Environment Runtime**; changing it never moves or adopts running PTYs and
  therefore requires an explicit Tray Host stop followed by start
- The Tray Host remembers the active **Backend Placement** independently from
  the newly selected setting so stop intent always reaches the processes that
  actually own the running agents
- A **Terminal Replay Tail** is capped at 4 MiB and 4,096 live events per Session, plus 32 MiB and 32,768 live events globally; its chronologies contain only retained chunks, and snapshot overlap is removed before ordered live output is admitted
- A hidden resident **Terminal Presentation** is dormant; reveal resumes from its last applied sequence through the **Terminal Replay Tail**
- A **Terminal Presentation** is reconstructed when its runtime Terminal identity changes; Session metadata changes such as rename preserve the existing presentation
- Transient Soloe Device unavailability preserves the selected remote Session; reconnect resumes its visible presentation from the last applied sequence through the owning Device's **Terminal Replay Tail**
- The first visible **Terminal Presentation** acquires **Terminal Output Demand** for its PTY; the final hidden owner releases cross-process publication without stopping replay retention or agent observation
- Terminal input and PTY resize require the exact Session ID, owner Device ID, Controller Device ID, and Lease ID of the current **Terminal Control Lease**; generations may order observations but never establish ownership, a **Spectator** may explicitly take over, and neither lease loss nor takeover stops the PTY
- Each output batch receives one **Terminal Semantic Observation** before replay publication; usage-limit state outranks approval redraws and hidden presentations remain observable
- One **Review Surface** owns one text-selection action; resident file bodies contribute exact review-entry identity without adding global listeners
- A **Review Surface** auto-loads ordinary resident untracked text through two shared admissions; dependency, cache, generated-output, binary, and oversized paths remain explicit-load only
- A cached review does not imply **Review Demand**; the final visible owner releases tick-driven range refresh and resident payload pins
- Only visible rail tabs own **Rail Surface Residency**; Worktree layout, review state, scroll positions, and unsaved file content survive outside renderer allocation
- A visible Files **Rail Surface Residency** acquires **Files Payload Residency**; final release retains at most two clean recent scopes while unsaved or saving buffers remain protected independently of evictable trees
- Switching the file addressed by **Files Payload Residency** cannot replace an unsaved buffer without an explicit discard decision
- A **Browser DevTools View** observes layout on demand; unchanged geometry performs no frame work or cross-process publication
- **Browser Session State** is host-owned in bounded `browser-sessions.json` storage and persists only changed Worktree scopes after a short coalescing window; renderer localStorage is a migration and fallback mirror, never the authoritative record
- A summary **Resource Usage Observation** never launches a WSL process; demanded WSL detail is serialized and briefly shared across observers
- A Feature Snapshot is materialized from exactly one **Feature Artifact Index** revision
- One active **Feature Artifact Observation** exists per subscribed **Worktree Identity**, regardless of renderer count
- A **Feature Artifact Observation** traverses only the fixed-depth semantic artifact grammar and publishes only to exact subscribed owners
- Every Svelte Module crosses the **Renderer Backend Interface**; only a **Renderer Backend Adapter** may access shell-specific globals or transport primitives
- Electron IPC and browser HTTP/WebSocket are separate **Renderer Backend
  Adapters** over the same UI; neither owns agent process lifetime
- A **Project** is merged across Devices by canonical Git repository identity
- A **Workspace** is merged across Devices by Project and Workspace Source
- Every **Workspace Location** and **Session Source** references a **Checkout** owned by exactly one **Soloe Device**
- Every **Session** remains owned by its Device; opening it routes terminal control to that Device and never migrates its process
- The Sessions interface derives Project → Workspace → Session navigation from current and last-known Device inventories; it stores no parallel logical catalog or Session membership
- Offline Device observations remain visible but disabled, and creating work on a different Device requires an explicit preparation review before a **Successor Session** is created
- The **Device Connection Registry** discovers Tailscale HTTPS endpoints automatically, pins durable Device identities, and stores no bearer tokens

## Example dialogue

> **Dev:** "Does opening three sessions create three Git pollers?"
> **Domain expert:** "No. Their shared Worktree produces one Refresh Intent and at most one Worktree Observation at a time."

> **Dev:** "Can overview regeneration reuse the Git and transcript reads from the dialog's validation?"
> **Domain expert:** "Yes. It consumes that exact Worktree Evidence generation once, provided the Worktree, runtime, base, and ordered Session scope are identical."

## Flagged ambiguities

- "refresh" previously meant both timer scheduling and repository materialization; **Refresh Intent** owns scheduling while **Working Tree Snapshot** owns materialization.
