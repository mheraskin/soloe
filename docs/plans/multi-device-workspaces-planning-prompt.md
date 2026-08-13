# Planning Prompt: Multi-Device Workspaces and Device-Placed Sessions

Use the following prompt with an implementation-planning agent after the current
Electron/Tailscale device-connection work has finished and its final code state
is available.

---

You are planning a major evolution of Soloe from a single-active-device desktop
client organized directly around physical Git worktrees into a multi-device
development cockpit organized around Projects, logical Workspaces, and Sessions.

This is a **planning and architecture pass only**. Do not implement the feature,
edit production code, perform a persistence migration, or make speculative UI
changes during this pass. Investigate the actual repository thoroughly, find its
existing implementation patterns and constraints, and produce an
implementation-ready plan. The plan must identify concrete implementation
changes after discovery, but this prompt deliberately does not prescribe files,
classes, stores, schemas, IPC endpoints, or component boundaries. Derive those
from the finished codebase.

The plan will be reviewed and approved before a later agent implements it.

## Product objective

Soloe should let one desktop client act as a cockpit for Sessions running on the
local machine and on multiple trusted Soloe Devices, potentially at the same
time. A user may work entirely on remote home/work servers without cloning any
source code to the laptop running the UI. The same logical Project and Workspace
may also have independent checkouts on several devices so that different
Sessions can perform builds, experiments, agent work, or other tasks wherever
the user chooses.

Device placement belongs to a **Session**. Do not call Sessions "tabs" in the
domain model, requirements, API, or plan. A tab may be a presentation mechanism,
but the durable product concept is a Session. A Session may own a terminal,
Codex or Claude interaction, files/review state, and related working context.

The design must retain the ability to move a Session between Workspaces through
the existing drag-and-drop interaction, while defining exactly what that move
means when the Session's physical checkout, branch, or device differs from the
destination Workspace.

## Canonical domain language

Use and refine the following vocabulary. Reconcile it with the repository's
existing `CONTEXT.md`; call out every collision or migration in meaning. Do not
use several names for the same concept.

### Project

A logical source-code project identified primarily by a Git repository. GitHub
is the first-class hosting workflow, but the architectural core should not
unnecessarily make all Git behavior dependent on GitHub or `gh`. A Project may
temporarily be unpublished: it can be a valid local Git repository with no
remote yet.

A Project may be present on zero, one, or many Soloe Devices. Presence on one
device does not imply that the repository must be cloned onto the desktop-client
device or onto every other device.

### Workspace

A durable, human-organized unit of active work within a Project. A Workspace is
logical and may span devices. It is not a directory, physical Git worktree,
branch, Session, or synonym for a repository checkout.

A Workspace groups related Sessions and declares a Workspace Source: the Git
intent that its ordinary locations are expected to follow. Examples may include
a branch, pull request, or pinned revision, subject to what the planning agent
finds appropriate after studying current behavior.

The main navigation hierarchy should be conceptually:

```text
Project
  Workspace
    Sessions
```

Physical worktrees should not automatically become top-level navigation groups.

### Workspace Source

The declared Git source intent for a Workspace. In the common case this is a
branch and its upstream remote-tracking branch. It may also need to represent a
pull request, detached revision, an unpublished branch, or another existing
Soloe workflow.

The Workspace Source expresses what the Workspace intends to track. It does not
claim that every device currently has identical files, the same HEAD, a clean
working tree, or even an available checkout.

The plan must decide how source identity is represented robustly, including
renamed remotes, canonical repository identity, branch deletion, default-branch
changes, unpublished branches, detached revisions, forks, and repositories with
no remote.

### Soloe Device

One trusted machine exposing a Soloe Application Server and its associated
Environment Runtime to authorized clients. A device owns its filesystem,
credentials, processes, repositories, worktrees, PTYs, agents, and authoritative
Session runtime state.

### Workspace Location

The device-local realization of a Workspace. It identifies one physical Git
checkout/worktree and its actual Git state on one Soloe Device. Two devices can
realize the same Workspace, but they never share the same physical worktree.

A Workspace Location records reality: device, checkout path, repository
identity, checked-out branch or detached revision, HEAD, upstream relationship,
working-tree state, and availability. It can be aligned with or drifted from the
Workspace Source.

On the same device, Git generally prevents one branch from being checked out in
multiple linked worktrees. The plan must respect real Git worktree constraints
rather than modeling cross-device or same-device locations as a shared folder.

### Session

The user-visible unit of interactive work. Every Session is placed on exactly
one Soloe Device and executes against exactly one device-local source location
at a time. The UI may render a Session in a tab, but neither the architecture nor
the language should call the Session a tab.

A Session remains owned by its Environment Runtime and may outlive desktop
windows, Application Server replacements, lost network connections, and
navigation changes. Merely moving or regrouping a Session in the UI must not
silently terminate or recreate its PTY or agent.

### Session Source

The exact physical checkout and Git state used by a Session. It may be:

- the ordinary Workspace Location on that Session's device;
- a Session-owned isolated/disposable worktree derived from the Workspace
  Source or a specific revision;
- an existing checkout selected by the user;
- temporarily mismatched from the Workspace Source because the user changed
  branches or otherwise changed Git state from a terminal.

Session Source is observable fact, not an assumption derived only from the
Session's containing Workspace.

### Worktree

A physical Git repository checkout on one device. Retain the repository's
existing precise Worktree semantics wherever possible. Worktrees are resources
used by Workspace Locations and isolated Sessions; they are not automatically
the primary navigation hierarchy.

Distinguish at least these product roles, even if the implementation ultimately
uses different names after domain analysis:

- a durable worktree that realizes a Workspace Location;
- an isolated/disposable worktree owned by a Session;
- an externally created or discovered worktree not yet adopted by a Workspace;
- the repository's main checkout where Git imposes different removal behavior.

### Branch

Git state and source metadata, not the primary navigation hierarchy. A branch
can exist without a checkout, a worktree can be detached, a checkout can change
branches, and separate devices can independently check out branches with the
same name. Do not equate branch identity with physical worktree identity.

## Required user experience

### Browsing Projects, Workspaces, and Sessions

The sidebar should organize Sessions beneath their logical Workspace and
Project. A Workspace should remain stable even when some of its Sessions use
isolated worktrees or run on different devices.

Every Session must visibly communicate its owning device. If all Sessions in a
Workspace are on one device, the Workspace may show one device chip. If its
Sessions are distributed, it should clearly indicate multiple devices without
hiding individual placement. The planner should specify accessible, compact
presentation behavior for normal, disconnected, loading, degraded, and mixed
device states.

Any application-level device selector should be reconsidered as a view filter,
focus control, or default placement for new Sessions—not necessarily as a global
operation that disconnects the application from every other device. The plan
must reconcile this with the newly completed device-connection implementation
rather than assuming its current whole-application selection behavior remains
the final model.

### Creating a Session

Session creation should let the user select a Soloe Device. The system then
determines whether the selected device already has a compatible Project
checkout and Workspace Location.

The plan must cover at least these cases:

1. The Workspace already has an aligned location on the selected device.
2. The Project exists on the device, but this Workspace does not yet have a
   suitable location.
3. The Project exists, but the desired branch is checked out in another
   worktree on the same device.
4. The Project is absent from the device but has a reachable Git remote.
5. The Project has no remote and therefore cannot be cloned normally.
6. The Workspace Source contains commits that have not been pushed.
7. The originating checkout has uncommitted or ignored files that Git cannot
   reproduce on another device.
8. The selected device is offline or its capabilities are unknown.
9. A compatible location exists but is dirty, behind, ahead, diverged, detached,
   or on the wrong branch.
10. The user wants an isolated Session checkout rather than reuse of a shared
    Workspace Location.

If the Project is absent but cloneable, Soloe should explicitly offer to clone
it **on the selected device** and then prepare the Workspace Location or
Session-owned worktree. Source must not be routed through or cloned onto the UI
machine unless that machine is the selected device.

If the Project has no remote, Soloe should explain why the selected device
cannot clone it and offer an explicit workflow such as creating a private
GitHub repository and publishing the required branch, choosing an existing
remote, or cancelling. The plan should explore whether a future direct
device-to-device transfer over Tailscale is desirable, but it must not confuse
that possible feature with ordinary Git synchronization or silently include it
in the first implementation.

### Explicit alignment, not filesystem synchronization

Soloe must not continuously synchronize source directories between machines.
It must not silently copy files, auto-commit changes, push, pull, reset, merge,
rebase, checkout branches, overwrite untracked files, or delete worktrees merely
because related Sessions exist elsewhere.

Git is the first coordination transport. Cross-device alignment operations must
be explicit, previewable, attributable to a source and destination device, and
safe in the presence of dirty or divergent repositories.

Avoid a vague binary "synced/not synced" state. The plan should define an
evidence-based state model capable of communicating states such as:

- aligned at the same revision;
- aligned branch but different HEAD revisions;
- dirty working tree;
- unpublished commits;
- ahead of or behind the relevant upstream;
- ahead of or behind another Workspace Location;
- diverged;
- wrong branch or detached revision;
- missing remote or remote branch;
- Project or Workspace Location absent;
- device unavailable or state too stale to compare.

Specify what facts make each comparison authoritative, when state becomes stale,
which comparisons are invalid, and which user actions are safe for each state.

When appropriate, Soloe may offer an explicit sequence such as push from one
device and update another. The plan must account for dirty changes, protected
branches, force-push risk, authentication failures, and concurrent mutations.
No action should imply that two device-local worktrees have become one shared
worktree.

### Shared Workspace Locations and isolated Session worktrees

A Session may use its device's ordinary Workspace Location or request an
isolated worktree. Isolated worktrees should be derived from an explicit base
revision and owned by the Session unless promoted.

The plan must define:

- how an isolated worktree and any generated branch are named and identified;
- whether a branch is required or detached operation is allowed;
- how ownership survives restart and reconnect;
- how Soloe detects that a user manually changed branch or repository state;
- how an isolated Session communicates ahead/behind/diverged state relative to
  the Workspace Source;
- when the checkout is eligible for cleanup;
- how dirty, untracked, ignored, committed-but-unpushed, or otherwise
  unrecoverable work blocks deletion;
- how a Session checkout is promoted into a durable Workspace Location or a new
  Workspace;
- how an isolated Session contributes work back through push, merge, or pull
  request workflows;
- what happens when a Session ends, is archived, is moved, or becomes orphaned.

An isolated Session changing branches should not redefine its Workspace Source.
If a Session shares a Workspace Location and changes its branch, every Session
using that location observes the same filesystem change. Soloe must detect that
drift and present explicit recovery or reclassification choices; it must not
silently rewrite the Workspace definition.

### Moving Sessions between Workspaces

Preserve drag-and-drop movement of Sessions between Workspaces. The plan must
define this as a first-class domain operation rather than a UI-only array
mutation.

Moving a Session between Workspaces must not imply that a running PTY can be
teleported to another device or working directory. Determine and document the
semantics for at least:

- source and destination Workspaces in the same Project with compatible
  sources;
- same Project with different Workspace Sources;
- different Projects;
- a Session using a shared Workspace Location;
- a Session using an isolated worktree;
- a dirty or unpublished Session Source;
- a running Session whose current process depends on its cwd;
- a disconnected owning device;
- a move that is organizational only versus one that requires preparation of a
  new checkout and creation of a successor Session.

The likely product distinction is between regrouping the existing Session as-is
and explicitly creating or migrating work into a source aligned with the
destination Workspace. Do not assume either behavior without specifying user
prompts, invariants, cancellation, failure recovery, and the fate of the
original Session. Preserve existing drag-and-drop affordances where their
semantics remain sound.

### Running the same experiment on multiple devices

The user should be able to prepare independent checkouts at an explicit branch
or revision on several devices and start separate Sessions for builds,
experiments, or agents. Each Session remains independent and visibly placed.

The plan must distinguish "same Workspace Source" from "same current files."
It should describe how the UI shows that two Sessions began from the same
revision but one later became dirty, advanced, or diverged.

### Per-device setup and capabilities

Prerequisites and credentials are per device. Plan a capability/readiness model
that can report, at minimum, relevant Git availability, repository access,
GitHub CLI availability/authentication, agent CLI availability, runtime/package
manager requirements, Tailscale reachability, and Soloe service compatibility.

Do not make `gh` universally mandatory for ordinary Git clone/fetch/push when
normal Git credentials are sufficient. GitHub-specific operations—creating a
repository, issues, pull requests, or other provider features—may require `gh`
or another provider adapter. The UX should explain partial capability rather
than treating the entire device as unusable.

Creating a remote repository is a consequential external operation. It requires
clear repository owner, name, visibility, remote name, source branch, and push
preview, followed by explicit user confirmation. Defaulting to a private remote
should be evaluated, not silently assumed.

## Architectural requirements and invariants

The plan must derive a target architecture from the repository rather than
bolting cross-device behavior onto renderer state. At minimum, investigate and
address the following concerns.

### Concurrent device connections

The desktop client must eventually maintain authenticated connections to
multiple Application Servers concurrently. A single mutable global backend
destination is insufficient for Session-level device placement.

Plan a connection/coordinator boundary that owns device discovery, per-device
authentication, compatibility, connection lifecycle, reconnect/backoff, event
routing, snapshots, and disposal. Preserve the shell-neutral Renderer Backend
Interface so Electron is reliable now and Tauri can later implement equivalent
host behavior without duplicating the domain model.

Do not assume the desktop renderer should directly coordinate arbitrary socket
sets. Determine where authoritative aggregation belongs and how the renderer
receives bounded, attributable state.

### Globally unambiguous identity and routing

Device-local IDs may collide. Every cross-device Session, Project presence,
Workspace Location, worktree observation, terminal event, request, cache,
subscription, optimistic update, and persisted selection must be attributable
to the correct Soloe Device.

The plan must establish identity and routing invariants without casually
rewriting every domain ID. Explain where composite scope is necessary, where
globally generated IDs are preferable, and how stale events from an old device
connection are prevented from mutating a newly selected entity.

Every filesystem, Git, terminal, agent, project, notes, review, and observation
operation must execute on the Session or Workspace Location's owning device.
No operation may fall back to a process-wide "current device" when its target is
already device-scoped.

### Authority and lifecycle

The owning Environment Runtime remains authoritative for running PTYs and
agents. The owning Application Server remains authoritative for that device's
domain state. The desktop cockpit aggregates and presents remote state but must
not accidentally adopt, duplicate, or terminate remote runtime ownership.

Disconnect is not stop. Filtering out a device, closing its visible UI, moving
a Session organizationally, losing Tailscale connectivity, or replacing an
Application Server must not stop agents. Explicit stop intent must still reach
the correct Environment Runtime.

Plan reconnection, replay, stale-state marking, device restarts, Application
Server replacement, incompatible protocol versions, removed devices, renamed
devices, and concurrent clients controlling the same Session.

### Persistence and migration

Study all current persistence owners and schemas before proposing changes. Plan
a safe migration from today's Project/Worktree/Session organization and the
newly completed single-active-device connection state.

Existing users must not lose Projects, Sessions, notes, drafts, terminal
history/replay references, worktree associations, layouts, or device connection
records. The migration must be restart-safe, idempotent, versioned, and able to
recover from partial failure. Clearly separate client-local cockpit preferences
from device-authoritative domain records.

Determine which logical objects should be shared or reconstructed across
devices and which must remain device-local. Do not introduce a hidden
distributed database merely to make the sidebar convenient.

### Security and trust

Preserve Tailscale identity/session-cookie behavior and the rule that backend
bearer tokens are not copied into the device registry or sent to unrelated
devices. Each device connection needs its own authenticated context and strict
origin/trust boundary.

Plan protections for remote clone URLs, credential prompts, GitHub operations,
external links, command construction, repository paths, device-supplied labels,
and malicious or incompatible remote responses. A trusted tailnet identity does
not make arbitrary repository paths or commands safe.

The desktop client must not centralize or exfiltrate per-device Git, GitHub,
Codex, Claude, SSH, or package-registry credentials merely to report readiness.

### Performance and bounded background work

Multi-device aggregation must not multiply every existing poller, watcher,
repository scan, worktree inventory, Git subprocess, terminal subscription, or
renderer payload without bounds. Reuse the repository's demand-driven
observation patterns.

Plan foreground/background/hidden behavior, per-device and global concurrency
budgets, snapshot freshness, cancellation, reconnect storms, device discovery
cadence, large Project/Workspace counts, and renderer virtualization. The UI
should become useful incrementally as devices respond instead of blocking on
the slowest device.

### Electron now, Tauri later

Electron is the reliability target for the initial implementation. The design
must work fully there. Tauri is developed separately, so the plan should preserve
a portable domain contract and identify the host capabilities a future Tauri
adapter must provide. Do not block the Electron implementation on simultaneous
Tauri completion, and do not leak Electron primitives into the shared Workspace
or Session model.

## Required planning process

Before proposing changes:

1. Confirm that the current device-connection implementation has finished and
   inspect the actual working tree and branch without destroying or overwriting
   user changes.
2. Read repository instructions, `CONTEXT.md`, architecture/process docs,
   relevant plans, persistence formats, API contracts, and tests.
3. Use the repository's code knowledge graph for discovery before text search,
   following its `AGENTS.md` priority order. Reindex only if required.
4. Trace current Project, Worktree, Session, terminal/runtime, renderer-backend,
   device-connection, IPC/RPC, event, persistence, sidebar, drag-and-drop, and
   new-Session flows end to end.
5. Identify which process is authoritative for every relevant state transition.
6. Find and cite established repository patterns for deep modules, scoped
   identities, demand, observation, persistence, transport adapters, tests, and
   migrations. Prefer extending coherent patterns over parallel systems.
7. Record contradictions between current behavior, current terminology, and
   this target model. Resolve them explicitly in the plan rather than hiding
   them behind aliases.
8. Stress-test the model using concrete multi-device scenarios and failure
   cases before selecting module boundaries.
9. Distinguish prerequisites, enabling refactors, product slices, migrations,
   and optional future extensions.
10. Do not implement until the resulting plan is approved.

## Scenarios the plan must walk through

For each scenario, give the user-visible flow, authoritative processes, domain
state transitions, remote calls/events, persistence effects, failure states,
and recovery behavior.

1. The laptop runs the Soloe UI but has no local clone; two home servers each
   run Sessions for the same Project in one logical Workspace.
2. A Workspace exists only on Server A. The user creates a Session on Server B,
   approves cloning there, and starts from the Workspace Source.
3. A local unpublished Project has no remote. The user asks to create a remote
   Session and chooses to create a private GitHub repository and publish it.
4. The source branch has unpushed commits and dirty files. Another device cannot
   reproduce the current state safely.
5. Two device locations track the same branch and commit; one becomes dirty,
   then commits without pushing, then pushes while the other location advances
   independently.
6. Two Sessions on different devices deliberately run the same experiment from
   the same pinned commit without either checkout becoming the other's source of
   truth.
7. A Session uses a shared Workspace Location and manually checks out a
   different branch from its terminal.
8. A Session uses a disposable isolated worktree, accumulates useful commits,
   and is promoted or merged back into durable work.
9. A dirty isolated Session is archived or deleted. Soloe must prevent loss and
   explain recovery options.
10. A running Session is dragged to another Workspace with a different source
    branch. Its PTY cannot change cwd or device invisibly.
11. A Session is dragged between compatible Workspaces and the intended move is
    organizational only.
12. A device disconnects during clone, fetch, push, worktree creation, Session
    creation, source comparison, or a drag-and-drop operation.
13. An Application Server restarts while its runtime-owned Sessions continue.
14. The same device is renamed or rediscovered at a new endpoint without losing
    durable identity.
15. `gh` is missing or unauthenticated on one device while ordinary Git access
    works, and another device has full GitHub capabilities.
16. A remote repository is renamed, transferred, deleted, made inaccessible, or
    replaced by a fork.
17. The same branch is already checked out in another worktree on the selected
    device.
18. Multiple Soloe desktop clients observe or control Sessions on the same
    devices concurrently.

## Decisions the plan must make

Do not leave these as vague implementation details:

- the durable identity of a Project across devices and before/after publication;
- the durable identity and ownership of a Workspace;
- the representable kinds and lifecycle of Workspace Source;
- whether Workspace definitions are client-local, device-authoritative, synced
  through Git metadata, or coordinated another explicit way;
- how Workspace Locations are discovered, adopted, created, drifted, removed,
  and compared;
- the exact relationship among Workspace, Workspace Location, Session, Session
  Source, physical Worktree, branch, and device;
- whether multiple Sessions may share one Workspace Location and what warnings
  or locking semantics apply;
- how isolated Session worktrees and generated branches are represented;
- drag-and-drop semantics for compatible and incompatible Session moves;
- how current whole-device switching evolves into concurrent device placement;
- how cross-device identity is represented in commands, events, caches, routes,
  and persisted UI state;
- which operations are safe to retry and how idempotency is achieved;
- how capability/version negotiation works;
- what alignment states exist and what evidence produces them;
- which Git/GitHub actions require confirmation and what each confirmation
  previews;
- what remains explicitly out of scope for the first release.

If a decision genuinely requires product input, present the competing options,
trade-offs, recommendation, and the concrete consequence of deferring it. Do
not replace analysis with a long list of unanswered questions.

## Required plan deliverable

Produce one cohesive implementation plan containing all of the following:

1. **Executive summary** — the proposed model, main architectural seam, user
   value, and most important trade-offs.
2. **Current-state findings** — evidence-backed description of how the finished
   repository currently models Projects, Worktrees, Sessions, device selection,
   transports, persistence, events, and drag-and-drop.
3. **Ubiquitous language** — final concise definitions, avoided synonyms, and
   proposed glossary updates. Explicitly preserve "Session," not "tab," and
   "Workspace," not "Work Area."
4. **Invariants and ownership table** — every core entity, its authoritative
   process, durable owner, identity, lifetime, and allowed transitions.
5. **Target architecture** — responsibilities and deep module boundaries,
   concurrent connection topology, routing, event flow, and Electron/Tauri seam.
   Include small diagrams where they materially clarify the system.
6. **State model** — conceptual schemas and relationships for Projects,
   Workspaces, Workspace Sources, Workspace Locations, Sessions, Session Sources,
   devices, capabilities, and alignment evidence. These may be pseudotypes, not
   premature code.
7. **Command and event model** — domain operations, validation, idempotency,
   ownership, progress, cancellation, errors, and event/snapshot repair.
8. **User flows** — creation, clone, publication, alignment, isolation,
   promotion, cleanup, device filtering, reconnect, and drag-and-drop behavior.
9. **Persistence and migration strategy** — existing-data mapping, versioning,
   partial-failure recovery, rollback/compatibility considerations, and how old
   single-device state becomes the new model.
10. **Security and capability model** — per-device auth, credential locality,
    trust boundaries, Git/GitHub readiness, compatibility negotiation, and safe
    remote command execution.
11. **Performance model** — demand ownership, concurrency limits, freshness,
    batching, cancellation, payload bounds, and behavior with many devices and
    repositories.
12. **Implementation phases** — ordered, vertically testable slices with
    dependencies and stage gates. Identify the earliest slice that delivers
    useful multi-device behavior without requiring unsafe source automation.
13. **Concrete change inventory** — only after repository discovery, list the
    actual modules, contracts, schemas, tests, and documentation that each phase
    should add, change, migrate, or retire. Explain why each change belongs
    there. This inventory is planning output, not implementation in this pass.
14. **Testing strategy** — domain tests, contract tests, persistence/migration
    tests, multi-server integration tests, Electron tests, failure injection,
    Git fixture matrices, security tests, performance budgets, and manual smoke
    scenarios across at least two real Soloe Devices.
15. **Rollout and observability** — feature gating if warranted, diagnostics,
    safe logs, migration telemetry if applicable, recovery affordances, and
    rollback boundaries.
16. **Risks and rejected alternatives** — especially filesystem synchronization,
    renderer-owned orchestration, one global current device, branch-as-sidebar,
    worktree-as-logical-workspace, and implicit destructive Git operations.
17. **Definition of done** — externally verifiable acceptance criteria for both
    product behavior and architectural integrity.

For every implementation phase, state:

- user-visible outcome;
- domain concepts introduced or changed;
- prerequisite refactors;
- authoritative process and module responsibilities;
- persistence/API/event changes;
- compatibility and migration concerns;
- tests required before proceeding;
- risks and explicit non-goals.

End with a recommended execution order and a short list of approval decisions
needed before implementation begins. Then stop and wait for approval. Do not
write implementation code in the planning pass.

## Product principles that must survive planning

1. Sessions are placed on devices; the UI machine does not need a local clone.
2. A Workspace is logical and cross-machine; a Worktree is physical and
   device-local.
3. A Workspace Source is intent; each Workspace Location and Session Source
   reports actual Git state.
4. Branches are source metadata, not the main navigation hierarchy.
5. Disposable worktrees belong to Sessions and should not clutter the top-level
   Workspace list unless promoted or explicitly inspected.
6. Git coordinates source explicitly; Soloe does not pretend separate
   filesystems are continuously synchronized.
7. No clone, remote creation, commit, push, pull, merge, reset, checkout,
   overwrite, worktree deletion, or cross-device transfer occurs implicitly.
8. Drag-and-drop Session movement remains available, with honest semantics that
   never teleport a running process or silently discard source state.
9. Device disconnection never means Session or agent termination.
10. Electron receives the complete reliable implementation first while shared
    contracts remain portable to a future Tauri adapter.
11. Existing user data and running-agent ownership boundaries are preserved.
12. Every remote fact and operation is explicitly scoped to its owning device.

---

Do not shorten the planning work merely because this prompt is detailed. Treat
the behavioral material above as product intent, verify it against the finished
codebase, challenge inconsistencies with concrete scenarios, and design the
deepest coherent architecture the repository can support.
