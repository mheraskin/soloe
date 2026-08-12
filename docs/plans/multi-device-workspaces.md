# Multi-Device Workspaces and Device-Placed Sessions

Status: implemented for the Electron/Application Server/Runtime stack; native
iOS adaptation is tracked as a separate branch follow-up.

This document began as the planning deliverable requested by
[\`multi-device-workspaces-planning-prompt.md\`](./multi-device-workspaces-planning-prompt.md).
It now also records the accepted decisions and stage gates implemented by the
corresponding feature work. The document itself does not mutate persisted user
data.

## 1. Executive summary

Soloe should evolve around one new deep host module, the **Cockpit Coordinator**.
It lives outside the renderer, owns concurrent authenticated connections to
many Soloe Devices, and exposes a small semantic \`CockpitPort\` to the shared
renderer. Electron implements it first. A future Tauri host implements the same
port without changing the Project, Workspace, Session, or command model.

The recommended first-release ownership model is:

- A versioned **cockpit-local catalog** is authoritative for logical Projects,
  Workspaces, Workspace Sources, ordering, and the membership of a device-scoped
  Session in a Workspace.
- Each Device Application Server remains authoritative for that Device's
  repositories, checkouts, Workspace Location observations, durable Session
  record, capabilities, Git operations, and operation receipts.
- Each Device Environment Runtime remains authoritative for PTYs, agents,
  terminal output sequence, replay, input, and process lifetime.
- The cockpit caches device snapshots only as timestamped observations. It
  neither replicates device state nor becomes a failover Runtime.

That split is intentionally honest. It permits logical Workspaces that span
devices, exist while all devices are offline, or temporarily have no location,
without adding peer replication among servers. A second desktop may organize
the same device Sessions differently. If shared Workspace organization across
desktop clients becomes a requirement, the catalog port can later target one
explicitly designated Home Catalog service. It must not grow into informal
last-writer-wins replication between Devices.

The first useful vertical slice is concurrent multi-device observation and
terminal attachment: one packaged Electron UI stays loaded, shows Sessions
from several Devices with durable device identity, and routes terminal actions
to their owners. It needs no clone, push, pull, branch change, or source
automation. Logical catalog migration follows. Explicit checkout preparation,
clone/publication/alignment, and isolated worktree lifecycle are later gated
slices.

The central product trade-offs are:

1. **Cockpit-local organization versus cross-client convergence.** The former
   is recommended initially because it supplies one clear writer without a
   new always-online coordinator. Export/import is possible; automatic sharing
   is not implied.
2. **Additive sagas versus fake transactions.** Cross-device placement creates
   destination resources first and leaves the original intact. Partial
   completion is visible and repairable.
3. **Evidence versus “sync” labels.** Git state is represented by timestamped
   local and remote-ref evidence. Soloe never claims that separate filesystems
   are one checkout.
4. **Composite routing versus a wholesale ID rewrite.** Existing IDs remain
   valid inside a durable \`DeviceId\` namespace. New logical IDs and new
   device records use random UUIDs.

### Decisions made by this plan

| Question | Decision |
| --- | --- |
| Project identity | Opaque cockpit-generated UUID; repository/provider evidence is used to verify or suggest adoption, never to derive the ID. |
| Workspace identity and owner | Opaque cockpit-generated UUID in the cockpit catalog. |
| Workspace Source | Versioned discriminated value: branch, pull request, or pinned revision; last resolution is evidence, not identity. |
| Workspace definitions | Cockpit-local in the first release. Not Git metadata, not replicated between Devices. |
| Device identity | Device-generated durable UUID returned by an authenticated handshake; endpoints and names are mutable aliases. |
| Session routing | \`SessionRef = (DeviceId, SessionId)\`; new Session IDs should be UUIDs, but legacy IDs need not be rewritten. |
| Physical identity | Device-owned stable \`RepositoryId\` and \`CheckoutId\`; paths are mutable locators. |
| Workspace Location | Cockpit-owned association from a Workspace to one device-owned Checkout, combined with a device-authoritative observation. |
| Ordinary locations | At most one ordinary Workspace Location per \`(WorkspaceId, DeviceId)\` in the first release. |
| Shared checkout use | Multiple Sessions may share one ordinary location. Git mutations are serialized per Checkout and warn about all consumers; there is no exclusive filesystem lock. |
| Isolated checkout | Device-owned Checkout with a Session owner and explicit base revision; normally a generated branch, optionally detached by explicit choice. |
| Session move | Planned domain operation: regroup as-is, create a successor, or block. It never mutates a running process's Device or cwd. |
| Device selector | View filter/focus plus a separately persisted default placement; it no longer swaps the process-wide backend. |
| Retry model | UUID command IDs, expected versions/evidence, device result journal, query-before-retry, and additive recovery. |
| GitHub dependency | Ordinary Git uses Git credentials. Provider operations use a GitHub adapter and may require authenticated \`gh\`; partial capability is normal. |

## 2. Current-state findings

### 2.1 Baseline and prerequisite

The prerequisite device-connection work is complete in the inspected branch.
\`HEAD\` is \`8c74e70 feat(desktop): add tailscale device switching\`; it adds the
connection registry, Tailscale discovery/probing, connection UI, remote preload,
Tailscale cookie bootstrap, and process documentation. The working tree was
already dirty before this plan: code-graph artifacts are modified and the
planning prompt is untracked. This plan does not alter or overwrite those
files.

The code knowledge graph was indexed and used first for architectural discovery.
Its transport later closed, so the remaining inspection used targeted source
reads and text search, as the repository instructions permit when graph results
are insufficient.

### 2.2 Current model and flow

| Area | Repository evidence | Consequence for the target |
| --- | --- | --- |
| Project | [\`shared/types/projects.ts\`](../../shared/types/projects.ts) defines a Project as \`id + name + path\`, runtime defaults, and an ordered list of worktree paths. [\`ProjectStore.ts\`](../../electron/projects/ProjectStore.ts) persists version 2 \`projects.json\` on one backend. | Today's “Project” is a device-local repository checkout record, not a logical cross-device Project. Preserve it as migration input/a Project Presence, not as the new authority. |
| Worktree identity | [\`shared/worktree-identity.ts\`](../../shared/worktree-identity.ts) correctly scopes a physical checkout by normalized path, run mode, and WSL distro. | Keep this precise physical concept inside a Device, then add Device and stable Checkout IDs at the cross-device seam. |
| Navigation | [\`worktree-groups.ts\`](../../src/lib/worktree-groups.ts) buckets Sessions directly by cwd and labels buckets from Git branches. [\`ProjectSection.svelte\`](../../src/components/ProjectSection.svelte) renders Project → physical worktree → Session. | Physical Worktrees and Branches currently form the navigation model; both must become evidence/resources beneath logical Workspaces. |
| Session | [\`shared/types/sessions.ts\`](../../shared/types/sessions.ts) persists \`cwd\`, run mode, optional \`projectId\`, and launch metadata. IDs and runtime maps are unscoped strings. | Add an exact device-owned Session Source binding and route externally with \`SessionRef\`; do not infer source only from cwd or containing Workspace. |
| Session creation | [\`NewSessionPickerDialog.svelte\`](../../src/components/NewSessionPickerDialog.svelte) chooses only a launch kind. [\`sessions.svelte.ts\`](../../src/stores/sessions.svelte.ts) derives cwd from the current Project/defaults, creates, then starts; start failure leaves the durable Session. | Replace immediate creation with a device/source placement plan. Retain “created but not started” as an explicit recoverable result. |
| Worktree creation | [\`CreateWorktreeDialog.svelte\`](../../src/components/CreateWorktreeDialog.svelte) always asks for a base, new branch, and path. [\`GitService.ts\`](../../packages/domain/src/git/GitService.ts) executes \`git worktree add -b\`. | There is no clone, existing-branch placement, detached placement, worktree removal, promotion, or loss scan. Those need typed commands rather than renderer-composed Git calls. |
| Drag and drop | [\`WorktreeGroup.svelte\`](../../src/components/WorktreeGroup.svelte) explicitly constrains Session reorder to siblings in one physical worktree; [\`SessionItem.svelte\`](../../src/components/SessionItem.svelte) carries Project/cwd drag context, but the target callback exists only inside that group. | The prompt's cross-Workspace move is a new durable behavior built on the existing affordance. The repository does **not** currently move Sessions across worktrees or Projects. |
| Device selection | [\`ConnectionRegistry.ts\`](../../electron/connections/ConnectionRegistry.ts) persists one \`activeId\`; connection IDs are derived from endpoints. Selection returns \`relaunching: true\`. [\`electron/main.ts\`](../../electron/main.ts) chooses one \`remoteServerUrl\`, one preload, and either remote or local services at startup. | Endpoint identity and whole-process selection cannot support Session placement. Migrate selection into filter/default placement and connect all enabled Devices concurrently. |
| Renderer backend | [\`src/lib/ipc.ts\`](../../src/lib/ipc.ts) exposes one shell-neutral backend singleton. [\`browser-api.ts\`](../../src/lib/browser-api.ts) creates one base-URL RPC client and one event socket. | Preserve the renderer-host seam, but expose an aggregated semantic port. Keep \`SoloeApi\` as an internal per-device adapter during migration. |
| Server and events | [\`SoloeServer.ts\`](../../apps/server/src/SoloeServer.ts) has a generic namespace/method RPC body and broadcasts \`{event,payload}\`. Readiness returns only \`{ready:true}\`; there is no durable Device ID, protocol/capability descriptor, server epoch, event sequence, entity version, or command ID. | Add authenticated describe/negotiation, event envelopes, snapshot cursors, expected revisions, and command receipts before concurrent mutation. |
| Authentication | The server accepts its bearer token or a Strict HttpOnly session cookie. Tailscale identity headers are trusted only from loopback Tailscale Serve. [\`ConnectionRegistry.ts\`](../../electron/connections/ConnectionRegistry.ts) stores no token. | Preserve these boundaries and create one isolated auth context per Device. Never put tokens in catalog/registry records. |
| Runtime | [\`RuntimeHost.ts\`](../../apps/runtime/src/RuntimeHost.ts) owns one terminal per local Session ID, output sequence, cwd observation, and replay; Application Server disconnect does not stop processes. [\`packages/protocol\`](../../packages/protocol/src/index.ts) has local IDs only. | Keep the Runtime conceptually unchanged. Namespace at the cockpit boundary; do not restart PTYs for catalog migration or regrouping. |
| Reconnect | Browser events reconnect after a fixed 500 ms in [\`browser-api.ts\`](../../src/lib/browser-api.ts); malformed messages are ignored and stores refresh on reconnect. The server gives a client a five-second lease grace. | Generalize the established “events are advisory, snapshots repair” pattern per Device, with jittered backoff, stream sequence, epochs, disposal, and stale-state marking. |
| Git observation | [\`GitService.ts\`](../../packages/domain/src/git/GitService.ts) produces coherent local working-tree snapshots with generations and bounded caches. [\`git.svelte.ts\`](../../src/stores/git.svelte.ts) polls 5 s/30 s, inventories 1 min/10 min, and limits work to two globally/one per group. [\`GitProcessExecutor.ts\`](../../packages/domain/src/git/GitProcessExecutor.ts) caps each backend at two Git child processes. | Reuse demand, generation, cache, and two-child patterns, but move multi-device demand aggregation out of renderer stores. Current status lacks remote identity, upstream OID/fetch freshness, ignored-file loss evidence, and peer comparison. |
| Git mutation | Current checkout may use force, and push/pull/fetch are thin wrappers; pull is \`--ff-only\`. Calls have no plan token, expected HEAD, command ID, journal, or preview. | Keep low-level Git adapters, add a higher typed planning/command module, and never expose force or arbitrary argument assembly through the cockpit. |
| Persistence | Device backend owns \`projects.json\`, \`sessions.json\`, \`settings.json\`, \`observer.json\`, \`browser-sessions.json\`, \`overview-cache.json\`, notes, vault, and bridge state. Desktop owns \`connections.json\`. Renderer localStorage owns selection, layout, notes drafts/recovery, browser fallback, diff comments, comment agents, and rail state, mostly keyed by Project ID or Worktree identity. | Migration needs an inventory, device namespace, stable Checkout mapping, and explicit owner for every key. Cwd-only or local-ID-only keys can collide across Devices. |
| Deletion/archive | [\`sessions.svelte.ts\`](../../src/stores/sessions.svelte.ts) stops a live terminal before delete/archive and continues even when stop fails. Missing worktree inventory auto-archives Sessions. | This conflicts with “disconnect/regroup is not stop” and isolated-source loss protection. Split stop, archive metadata, and source cleanup into explicit operations with fresh evidence. |
| Capability | Settings can override \`git\`, \`gh\`, Claude, Codex, \`rg\`, \`fd\`, and editor. Model discovery probes agent CLIs; HookInstaller reports per-host integration state; WSL detection is explicit. | Compose existing probes into a versioned per-Device readiness snapshot. Do not collapse all readiness into one boolean. |

### 2.3 Established patterns to retain

- Atomic JSON replacement with a serialized write queue in Project, Session,
  Settings, browser-state, and summary stores.
- Versioned parsing, corrupt-file backup, and conservative migration rather
  than trusting arbitrary persisted input.
- \`WorktreeIdentity\` and \`WorktreeScope\` as precise physical scope inside a
  Device.
- Application Server modules that own device state and expose transport-neutral
  methods through both local IPC and server RPC.
- Ref-counted observation demand, bounded Git children, bounded caches, and
  replay/snapshot repair.
- Contract matrices in [\`shared/api-contract.ts\`](../../shared/api-contract.ts)
  and compatibility tests that keep transports honest.
- The Runtime/Application Server lifetime split documented in
  [\`process-model.md\`](../architecture/process-model.md).

### 2.4 Contradictions that must be resolved

1. Current **Project** means one device-local path; target Project is logical.
2. Current **Worktree** is both precise physical identity and a navigation
   group. Retain only the physical meaning.
3. Current branch labels effectively name navigation groups; target Branch is
   source metadata.
4. Current global active connection changes the whole backend; target placement
   belongs to a Session.
5. Current drag-and-drop only reorders siblings; target cross-Workspace movement
   is a planned domain operation.
6. Current settings/comments still use “tab” in names such as
   \`confirmDeleteTabs\`, storage comments, and handoff copy. Public/domain
   contracts must migrate to “Session”; compatibility fields may retain the old
   serialized spelling temporarily.
7. Current archive/delete can stop a Runtime process implicitly. Target archive
   is metadata; stop and source cleanup require separate intent.
8. Current disappearance of a physical Worktree auto-archives Sessions. Target
   treats a missing Checkout as unavailable/orphaned evidence and does not infer
   process termination.

## 3. Ubiquitous language

The following definitions are final for the implementation unless an approval
decision below changes them.

| Term | Definition and avoided synonyms |
| --- | --- |
| Project | Cockpit-owned logical source-code project with an opaque ID. It may have zero or many Project Presences. It is not a path, checkout, Device, or Git remote. |
| Project Presence | Association between a Project and a Device-owned Repository record. This replaces the cross-device use of today's path-based Project. |
| Repository | A Git object database/configuration known to one Device. It may own a main checkout and linked Worktrees. |
| Workspace | Cockpit-owned durable human grouping inside one Project. It declares one Workspace Source and contains Session memberships. It is not a directory, Branch, Worktree, Session, “Work Area,” or repository checkout. |
| Workspace Source | Versioned Git intent: Branch, Pull Request, or pinned Revision. It is desired intent plus last-resolution evidence, never a claim about current files. |
| Soloe Device / Device | Trusted machine identified by durable Device ID and exposing an Application Server plus associated Runtime. “Machine” is allowed only in low-level discovery UI, not as a second domain term. |
| Checkout | Device-owned stable record for one physical checked-out worktree path. It has a role and live Git observation. |
| Workspace Location | One Workspace's ordinary realization on one Device: a cockpit association to a Device Checkout plus current device observation. It is not a shared folder. |
| Session | User-visible interactive work record on exactly one Device. Never call this durable concept a tab. |
| Session Source | Device-authoritative binding from a Session to the exact Checkout and provenance it uses. It can refer to a shared Workspace Location, isolated Session checkout, or explicitly selected external Checkout. |
| Worktree | Physical Git checkout on one Device. It may be the main checkout, a durable Workspace Location, an isolated Session resource, or external/unadopted. |
| Branch | Git ref/source metadata. It can exist without a checkout and is not a navigation container. |
| Alignment Evidence | Timestamped facts used to compare a Source, Location, or Session Source. Avoid “sync state.” |
| Regroup | Change only a Session's cockpit Workspace membership; Device, Runtime, cwd, and Session Source stay unchanged. |
| Successor Session | New Session created on a prepared destination when an existing running Session cannot be moved physically. The original remains until separately stopped/archived. |
| Cockpit | One desktop host, its catalog, connection registry, coordinator, and local preferences. |

Proposed \`CONTEXT.md\` update after approval:

- Replace the current navigation relationship with Project → Workspace →
  Session and move Current Worktree beneath Checkout/Session Source.
- Retain Environment Runtime, Application Server, Renderer Backend Interface,
  Inventory Demand, and Refresh Observation definitions.
- Add Project Presence, Workspace Source, Workspace Location, Session Source,
  Checkout role, Cockpit Catalog, Device ID, Command Plan, and Alignment
  Evidence.
- Deprecate Active Device Connection as an exclusive backend choice; redefine
  it as optional focus/default placement while enabled Device Connections remain
  concurrent.
- State explicitly that “tab” is presentation only and “Work Area” is not a
  synonym for Workspace.

This plan does not edit the glossary before approval.

## 4. Invariants and ownership

### 4.1 Entity ownership table

| Entity/state | Authority | Durable owner | Identity/address | Lifetime and allowed transitions |
| --- | --- | --- | --- | --- |
| Cockpit | Desktop host | \`cockpit.json\` identity record | random \`CockpitId\` | Created once; export/import may preserve it. Never inferred from hostname. |
| Device | Owning Application Server | device identity file in server data dir | random \`DeviceId\` | Survives rename, endpoint change, and server replacement. Reset is explicit and appears as a new Device. |
| Endpoint alias | Desktop host | connection registry | registry record ID + URL | May be added/removed/repointed only after handshake pin validation. Not Device identity. |
| Device capability snapshot | Device Application Server | bounded device probe cache; cockpit cache is observation | \`DeviceId + capabilityRevision\` | Recomputed on settings/binary/auth/service change; becomes stale. |
| Logical Project | Cockpit catalog | desktop host catalog | random \`ProjectId\` | Create/update/archive/delete with expected catalog revision. Delete cannot delete Device repositories. |
| Repository record | Device Application Server | device repository/checkout registry | local random \`RepositoryId\`, externally \`(DeviceId, RepositoryId)\` | Discovered/adopted/forgotten; forgetting never deletes files. |
| Project Presence | Cockpit catalog | desktop host catalog | \`(ProjectId, DeviceId, RepositoryId)\` | Link after evidence review; unlink removes association only. |
| Workspace | Cockpit catalog | desktop host catalog | random \`WorkspaceId\` | Create/update/archive/delete/reorder. Delete cannot stop Sessions or remove Checkouts. |
| Workspace Source | Cockpit catalog | embedded versioned value in Workspace | \`WorkspaceId + sourceVersion\` | Draft/resolved/unresolved/retired; source changes require expected Workspace version and never mutate Checkouts automatically. |
| Checkout | Device Application Server | device checkout registry plus filesystem/Git | local random \`CheckoutId\`, externally \`CheckoutRef\` | Pending → ready/degraded/missing → cleanup-planned → removed. Path may change after explicit rediscovery/relink. |
| Workspace Location | Cockpit projection with split facts | catalog stores association; Device owns Checkout and observation | random \`LocationId\` + \`CheckoutRef\` | Proposed → preparing → available/drifted/unavailable → unlinked. One ordinary location per Workspace/Device initially. |
| Session record | Owning Device Application Server | evolved \`sessions.json\` | local \`SessionId\`; externally \`SessionRef\` | Created/active/archived/deleted. Archive does not imply Runtime stop. New IDs are UUIDs; legacy IDs remain. |
| Session membership | Cockpit catalog | desktop host catalog | \`SessionRef → WorkspaceId\` | Assign/regroup/unassign with catalog revision. Does not mutate Session Source. |
| Session Source | Owning Device Application Server | Session record + checkout registry | \`SessionRef + sourceVersion\` | Bound at creation; may be reclassified/promoted through explicit commands. Runtime cwd observation does not rewrite it. |
| PTY/agent | Owning Environment Runtime | current Runtime state/replay mechanism | local \`TerminalId\`; externally \`TerminalRef\` | Start/attach/input/resize/stop/exit. Only explicit stop or Runtime shutdown kills it. |
| Git observation | Owning Device Application Server | repository + bounded cache | \`CheckoutRef + evidenceGeneration\` | Immutable snapshot at \`observedAt\`; superseded, never merged across Devices. |
| Device command | Target Device Application Server | bounded operation/result journal | \`(CockpitId, CommandId)\` | Planned/accepted/running/needs-attention/succeeded/failed/cancelled/interrupted. |
| Cross-device saga | Cockpit Coordinator | cockpit operation journal | random \`OperationId\` | Additive steps with receipts; partial state is recoverable, not rolled back destructively. |
| Notes | Device Application Server in first release | existing per-presence notes directory | \`DeviceId + legacy/new ProjectPresence ref + filename\` | Preserve as device-scoped artifacts; do not silently merge same-named notes across Devices. |
| UI preferences | Cockpit/renderer | client-local catalog preference file/localStorage | keys scoped by logical or composite ref | May differ across desktop clients; never device authority. |

### 4.2 Hard invariants

1. Every physical operation has an explicit \`DeviceId\` target. If an object
   already has an owner, routing never falls back to a current/default Device.
2. Every Session has exactly one owning Device and one Session Source at a time.
3. A Runtime process is not moved. A new Device or Checkout means a new
   successor Session.
4. Disconnect, filter, navigation, regroup, catalog deletion, or Application
   Server replacement is not Runtime stop.
5. A Workspace belongs to exactly one Project. Cross-Project drag cannot be a
   regroup; it is blocked or creates a successor after explicit destination
   preparation.
6. A physical Checkout belongs to one Device and may be linked as at most one
   ordinary Workspace Location per cockpit. Multiple Sessions may consume it.
7. Session-owned isolated Checkouts have exactly one Session owner until
   explicit promotion; promotion clears/replaces that ownership atomically on
   the Device.
8. Paths, branch names, remote names, endpoint URLs, and display names are
   locators/labels, never global identity.
9. Workspace Source changes do not implicitly checkout, fetch, push, reset,
   merge, rebase, copy files, or change a Session Source.
10. Local Git evidence is authoritative only for its Device, Checkout,
    generation, and observation time. Remote-relative evidence is no fresher
    than its recorded fetch.
11. Catalog snapshots and cached device snapshots never terminate or overwrite
    device-owned facts.
12. All cleanup is preceded by a fresh device loss scan. Uncertain, dirty,
    untracked, ignored, unpublished, or multiply-consumed state blocks cleanup.
13. Events are advisory. Entity versions and authority snapshots repair gaps.
14. Stale events from an old endpoint/socket cannot update current state:
    the host checks \`DeviceId\`, server epoch, connection generation, stream
    sequence, and entity version.
15. Credentials never cross from one Device's auth context into another
    Device, the connection registry, the cockpit catalog, readiness payloads,
    or logs.

## 5. Target architecture

### 5.1 Process topology

\`\`\`text
┌──────────────────────────── shared renderer ────────────────────────────┐
│ Sidebar / Session UI / placement wizard / Git evidence views           │
│                     CockpitPort only                                    │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ local typed host bridge
┌──────────────── Electron desktop host ─────────────────────────────────┐
│ CockpitCoordinator                                                     │
│  ├─ CockpitCatalog + PreferenceStore                                   │
│  ├─ ProjectionEngine                                                   │
│  ├─ CommandPlanner / SagaJournal                                       │
│  └─ DeviceCoordinator                                                  │
│      ├─ DeviceClient(local DeviceId)  ─┐                               │
│      ├─ DeviceClient(server-a)        ─┼─ auth, handshake, snapshots,   │
│      └─ DeviceClient(server-b)        ─┘  events, demand, disposal      │
└───────────────┬──────────────────┬──────────────────┬───────────────────┘
                │                  │                  │
       ┌────────▼────────┐ ┌───────▼────────┐ ┌──────▼─────────┐
       │ Device A Server│ │ Device B Server│ │ Device C Server│
       │ local domain   │ │ local domain   │ │ local domain   │
       │ Git/checkout   │ │ Git/checkout   │ │ Git/checkout   │
       └────────┬────────┘ └───────┬────────┘ └──────┬─────────┘
                │                  │                  │
       ┌────────▼────────┐ ┌───────▼────────┐ ┌──────▼─────────┐
       │ Runtime A      │ │ Runtime B      │ │ Runtime C      │
       │ PTYs / agents  │ │ PTYs / agents  │ │ PTYs / agents  │
       └─────────────────┘ └────────────────┘ └────────────────┘
\`\`\`

The local Device is not a privileged domain special case. It uses an in-process
or loopback \`DevicePort\` adapter and has a durable Device ID like remotes.
Native window/browser/save-dialog capabilities remain separate host services.

### 5.2 Deep modules and ports

#### CockpitCoordinator

Small renderer-facing interface:

\`\`\`ts
interface CockpitPort {
  snapshot(demand?: CockpitDemand): Promise<CockpitSnapshot>;
  setDemand(demand: CockpitDemand): Promise<void>;
  plan(intent: CockpitIntent): Promise<CockpitPlan>;
  execute(planId: PlanId, acknowledgements: AcknowledgementId[]): Promise<OperationRef>;
  cancel(operationId: OperationId): Promise<void>;
  onEvent(listener: (event: CockpitEvent) => void): Unsubscribe;
}
\`\`\`

It hides catalog migrations, endpoint discovery, authentication contexts,
socket generations, backoff, per-device adapters, ID namespacing, projection,
demand aggregation, plans, device child commands, compensation boundaries, and
recovery journals. It must not expose a generic
\`call(deviceId, namespace, method, args)\`, arbitrary Git arguments, shell
commands, bearer tokens, or unvalidated host paths. That constraint keeps it a
deep module instead of a multiplexing pass-through.

#### DeviceCoordinator

Owns registry reconciliation, endpoint aliases, one \`DeviceClient\` per enabled
Device, authentication/bootstrap, protocol negotiation, independent lifecycle,
snapshot paging, event cursor/gap repair, terminal stream demand, and disposal.
It stamps host-only connection generations and rejects identity changes.

#### CockpitCatalog

Owns logical objects, Session membership, ordering, catalog revision,
client-local migration state, and optimistic transactions. It stores foreign
refs to device records, not copies of device records. Use the existing atomic
versioned persistence pattern initially; keep a \`CatalogStore\` port so a
future Home Catalog or SQLite implementation does not affect the domain API.

#### Device Workspace/Checkout module

A new Application Server domain module owns repository discovery/adoption,
stable Repository/Checkout records, source evidence, location preparation,
checkout consumer tracking, mutation serialization, isolated ownership, loss
scans, and device command receipts. It composes the existing \`GitService\`
rather than putting planning rules inside Git command adapters.

#### ProjectionEngine

Joins catalog objects with independently arriving device snapshots. It emits
bounded attributable view models, dangling/stale refs, alignment summaries, and
incremental changes. It does not become an authority or invent a global event
order.

#### CommandPlanner and operation journals

Builds effect previews from current catalog and device evidence, obtains
device-issued plan tokens, executes additive sagas, records receipts, and
surfaces residues. A Device always revalidates local preconditions.

### 5.3 Electron/Tauri boundary

Electron:

- Always loads the packaged/local renderer shell.
- Implements \`CockpitPort\` in the main process and exposes it through the
  local preload.
- Uses host-private per-Device HTTP/WebSocket adapters and isolated cookie
  contexts.
- Keeps native Window, Browser, notifications, file dialogs, and local secure
  credential handles outside shared domain types.

Tauri later:

- Implements the same \`CockpitPort\`, \`DevicePort\`, secure credential
  resolver, durable catalog/preferences, and native shell ports.
- Does not reimplement Workspace projection or move semantics in Rust unless
  that shared implementation is intentionally moved.
- Is not a gate for Electron phases.

The existing broad \`SoloeApi\` remains a compatibility adapter for a single
Device during transition and for the single-device web client. The multi-device
renderer must not retain direct access once stores are migrated.

### 5.4 Alternatives considered

1. **Client-local catalog — selected.** One explicit writer, supports empty and
   offline Workspaces, lowest first-release control-plane cost. Trade-off:
   organization differs across desktop clients.
2. **Designated Home Application Server — preserved behind \`CatalogStore\`
   port, not selected initially.** Best if multi-client shared organization is
   mandatory. It adds Home selection, backup, availability, actor authorization,
   catalog epochs, takeover/fencing, and a management-plane single point of
   failure while the desktop still needs all Device connections.
3. **Federated/replicated Device catalogs — rejected.** If mutable definitions
   replicate, the product needs clocks, tombstones, anti-entropy, conflicts,
   membership, and compaction: a distributed database. Pure reconstruction is
   acceptable for read-only discovery but cannot preserve empty Workspaces,
   canonical source intent, or consistent naming/order.

## 6. State model

### 6.1 Conceptual types

\`\`\`ts
type DeviceId = UUID;
type ProjectId = UUID;
type WorkspaceId = UUID;
type LocationId = UUID;
type CommandId = UUID;

type SessionRef = { deviceId: DeviceId; sessionId: string };
type TerminalRef = { deviceId: DeviceId; terminalId: string };
type RepositoryRef = { deviceId: DeviceId; repositoryId: string };
type CheckoutRef = { deviceId: DeviceId; checkoutId: string };

interface Project {
  id: ProjectId;
  version: number;
  name: string;
  canonicalRepository: RepositoryIdentity;
  repositoryAliases: RepositoryIdentityEvidence[];
  archivedAt?: Timestamp;
}

interface ProjectPresence {
  projectId: ProjectId;
  repository: RepositoryRef;
  adoptedFromEvidence: RepositoryIdentityEvidence;
  linkedAt: Timestamp;
}

interface Workspace {
  id: WorkspaceId;
  projectId: ProjectId;
  version: number;
  name: string;
  source: WorkspaceSource;
  order: number;
  archivedAt?: Timestamp;
}

type WorkspaceSource =
  | {
      kind: "branch";
      localRef: FullBranchRef;
      upstream?: { repository: RepositoryIdentityRef; ref: FullBranchRef };
      lastResolved?: ResolvedSourceEvidence;
    }
  | {
      kind: "pull_request";
      provider: "github";
      repository: RepositoryIdentityRef;
      providerPullRequestId: string;
      number: number;
      head: { repository: RepositoryIdentityRef; ref: FullBranchRef };
      base: { repository: RepositoryIdentityRef; ref: FullBranchRef };
      lastResolved?: ResolvedSourceEvidence;
    }
  | {
      kind: "revision";
      repository?: RepositoryIdentityRef;
      oid: FullObjectId;
      label?: string;
    };

interface CheckoutRecord {
  id: string;                       // Device-local UUID
  repositoryId: string;
  path: string;                     // Locator, not identity
  role: "main" | "workspace" | "isolated-session" | "external";
  ownerSessionId?: string;
  lifecycle: "pending" | "ready" | "missing" | "cleanup-planned";
  version: number;
}

interface WorkspaceLocation {
  id: LocationId;                   // Catalog association identity
  workspaceId: WorkspaceId;
  checkout: CheckoutRef;
  desiredRole: "ordinary";
  state: "proposed" | "preparing" | "available" | "drifted" | "unavailable";
  observation?: CheckoutEvidence;   // Device fact, cached with freshness
}

type SessionSource =
  | { kind: "workspace-location"; checkoutId: string; locationCorrelation?: LocationId }
  | {
      kind: "isolated-worktree";
      checkoutId: string;
      base: SourceRevision;
      generatedBranch?: FullBranchRef;
      ownership: "session";
    }
  | { kind: "existing-checkout"; checkoutId: string; adopted: boolean };

interface DeviceSession {
  id: string;
  version: number;
  source: SessionSource;
  launch: SessionLaunch;
  archivedAt?: Timestamp;
  // cwd/projectId remain compatibility projections during migration.
}

interface CheckoutEvidence {
  deviceId: DeviceId;
  checkoutId: string;
  generation: number;
  observedAt: Timestamp;
  repositoryIdentity: RepositoryIdentityEvidence;
  headOid: FullObjectId | null;
  branchRef: FullBranchRef | null;
  detached: boolean;
  upstream?: {
    repository: RepositoryIdentityEvidence;
    ref: FullBranchRef;
    localTrackingOid: FullObjectId | null;
    remoteObservedAt: Timestamp | null; // last explicit fetch/ls-remote evidence
  };
  worktree: {
    staged: number;
    unstaged: number;
    untracked: number;
    dirty: boolean;
    ignoredLossScan?: "not-run" | "clear" | "present";
  };
  inProgressGitOperation?: string;
}
\`\`\`

### 6.2 Relationships

\`\`\`text
Project 1 ── * Workspace 1 ── * SessionMembership * ── 1 SessionRef
   │              │
   │              └── 1 WorkspaceSource (intent)
   │
   └── * ProjectPresence ── 1 RepositoryRef (device fact)

Workspace 1 ── 0..* WorkspaceLocation ── 1 CheckoutRef (device fact)

SessionRef 1 ── 1 DeviceSession ── 1 SessionSource ── 1 CheckoutRef
SessionRef 1 ── 0..1 running TerminalRef (Runtime fact)
\`\`\`

A Session rendered under Workspace B may still use a Checkout associated with
Workspace A after an explicit regroup. That is not corruption; it is a visible
\`source-mismatch\` until the user creates a successor or reclassifies/promotes
the source. The containing Workspace never rewrites the Session Source.

### 6.3 Repository and Project identity

The logical Project ID is generated before publication and never changes.
Evidence used to link a Device repository to it is ranked:

1. Stable provider repository identifier (for GitHub, provider node/database
   identity) plus provider host.
2. Previously verified canonical remote alias/history.
3. Canonicalized remote URL host/owner/repository as a suggestion.
4. Object-format/root/reachable-commit evidence as supporting information only.
5. User confirmation.

Remote names such as \`origin\`, paths, default branch, and URLs are mutable and
never identity. An unpublished repository cannot be auto-matched across
Devices; it is linked explicitly or after publication. A GitHub rename or
transfer retains provider identity and updates URL aliases. Without a stable
provider ID, a changed URL is reverified. A fork has a distinct provider
identity; it can be explicitly associated as a fork remote of the same Project,
but is never silently merged. Deletion/inaccessibility retains historical
identity with an unavailable state.

### 6.4 Workspace Source lifecycle

- **Branch:** full \`refs/heads/...\` intent; upstream identifies a repository
  identity and full remote branch ref, not a device-local remote name. Upstream
  may be absent for unpublished work.
- **Pull request:** provider identity and immutable provider PR ID/number plus
  explicit head/base repository+refs. Resolution may become unavailable after
  close/delete; the Workspace persists.
- **Revision:** full object ID and optional repository identity/label. It is the
  normal source for reproducible experiments and explicit detached operation.

Branch deletion changes the source to unresolved; it does not delete Workspace
or locations. Default-branch changes affect future defaults only. Updating a
Workspace Source increments its version and offers separately planned location
alignment; no Git mutation is coupled to the catalog transaction.

### 6.5 Alignment evidence and derived states

Do not persist one binary \`synced\` field. Derive independent dimensions:

| Dimension | States | Required evidence |
| --- | --- | --- |
| Availability | present, absent, offline, unknown, stale, incompatible | Device lifecycle + observation timestamp + protocol state |
| Repository match | verified, explicitly linked, unverified, conflict | Project Presence and repository identity evidence |
| Source conformance | exact source revision, correct branch/different HEAD, wrong branch, expected detached, unexpected detached, source unresolved | Workspace Source resolution + local branch/ref/HEAD |
| Working tree | clean, staged, unstaged, untracked, ignored-risk-unknown, ignored-risk-present | coherent local snapshot; ignored scan only for destructive plans |
| Publication | no upstream, unpublished commits, up to date, ahead, behind, diverged, remote missing/inaccessible, auth unknown | local upstream refs plus recorded explicit fetch/remote evidence |
| Peer relation | same revision, A ahead, B ahead, diverged, unrelated, object unavailable, incomparable/stale | verified same Project; both full OIDs; merge-base/rev-list on a Device that has both objects |

Authority/freshness rules:

- Local HEAD/branch/dirty facts are authoritative only at \`observedAt\`; a
  device command rechecks them immediately before mutation.
- Foreground local evidence is fresh for display for 10 seconds, background for
  60 seconds; after that it is marked stale. A destructive plan requires a
  forced observation no older than five seconds and still revalidates on
  execute. These are initial policy constants, not wire semantics.
- Ahead/behind an upstream is relative to the local remote-tracking ref. It is
  labelled “as of last fetch” and never treated as current network truth.
- Cross-Device same-revision is valid when repository association is verified
  and full object IDs match.
- Peer ahead/behind/diverged is valid only if a comparison command has both
  objects and a merge base. Missing objects yields unknown, not diverged.
- Clock timestamps communicate age but never establish cross-Device causality.

Safe default actions:

| Evidence | Safe offers |
| --- | --- |
| Available, verified, source-conforming, clean | Reuse location; create Session. |
| Correct branch, clean, behind known upstream | Explicit fetch + fast-forward plan with old/new OIDs and fetch age. |
| Clean, branch already checked out elsewhere on same Device | Reuse that Checkout if it may be the ordinary location; otherwise offer isolated detached/source-derived checkout or cancel. Never force duplicate branch checkout. |
| Dirty/untracked | Reuse as-is with warning or create a separate source from a reproducible commit. No checkout/reset/delete. |
| Ignored status unknown | Harmless observation can continue; cleanup/cross-device reproducibility claims are blocked pending loss scan. |
| Ahead/unpublished commits | Offer explicit push/publication preview if remote capability exists. |
| Diverged/wrong branch/unexpected detached | Inspect, regroup as mismatch, create isolated/successor, or perform separately planned expert Git action. No automatic repair. |
| Offline/stale/incompatible | View cached state only; no physical mutation or queued destructive command. |

## 7. Command and event model

### 7.1 Planning before effects

All consequential physical workflows use two stages:

1. \`plan(intent)\` gathers fresh evidence from every owner, resolves
   capabilities, validates catalog versions, and returns an expiring immutable
   preview. The preview names Devices, repositories, paths (redacted when
   appropriate), refs, expected old/new OIDs, credentials required, warnings,
   irreversible effects, original Session fate, and acknowledgements.
2. \`execute(planId, acknowledgements)\` sends typed device commands. Each
   Device revalidates local facts and rejects stale plans. The cockpit records
   receipts and publishes progress.

Catalog-only rename/reorder operations can be single optimistic transactions.
Regroup still goes through \`plan\` because the UI must classify source mismatch
and explain that the process stays where it is.

### 7.2 Envelopes

\`\`\`ts
interface DeviceCommandEnvelope<T> {
  cockpitId: CockpitId;
  commandId: CommandId;
  targetDeviceId: DeviceId;
  actorClientId: string;
  expectedEntityVersions: Record<string, number>;
  expectedEvidence?: {
    checkoutId: string;
    generation: number;
    headOid: string | null;
    dirtyFingerprint: string;
  };
  capabilityRevision: string;
  planToken: string;
  planExpiresAt: Timestamp;
  intent: T;
}

interface DeviceEventEnvelope<T> {
  deviceId: DeviceId;
  serverEpoch: string;
  sequence: number;
  entityRef?: string;
  entityVersion?: number;
  commandId?: CommandId;
  observedAt: Timestamp;
  payload: T;
}
\`\`\`

The desktop adds a non-persisted \`connectionGeneration\` before an event
reaches the ProjectionEngine. Server sequence is ordered only within one server
epoch. There is no cross-Device global event order.

### 7.3 Semantic intents and device commands

Cockpit catalog intents:

- \`CreateProject\`, \`UpdateProject\`, \`ArchiveProject\`
- \`CreateWorkspace\`, \`UpdateWorkspaceSource\`, \`ArchiveWorkspace\`,
  \`ReorderWorkspaces\`
- \`LinkProjectPresence\`, \`LinkWorkspaceLocation\`, \`UnlinkLocation\`
- \`RegroupSession\`, \`UnassignSession\`, \`AdoptUnassignedSession\`
- \`SetDeviceFilter\`, \`SetDefaultPlacement\` (preference transactions)

Device-domain commands:

- \`DescribeDevice\`, \`GetSnapshot\`, \`SetObservationDemand\`
- \`DiscoverRepositories\`, \`InspectRepository\`, \`AdoptRepository\`
- \`PrepareWorkspaceLocation\`, \`CloneProjectPresence\`
- \`PrepareSharedSessionSource\`, \`PrepareIsolatedSessionSource\`
- \`CreateSession\`, \`StartSession\`, \`ArchiveSessionRecord\`,
  \`StopTerminal\`
- \`InspectAlignment\`, \`FetchRemoteEvidence\`,
  \`FastForwardLocation\`, \`PublishBranch\`
- \`CreateGitHubRepository\` through a provider adapter
- \`PromoteIsolatedSource\`, \`PlanCheckoutCleanup\`, \`RemoveCheckout\`
- \`GetCommand\`, \`CancelCommand\`

Cockpit sagas compose those commands:

- \`PlaceSession\`
- \`PublishThenPlaceSession\`
- \`AlignLocations\`
- \`CreateSuccessorSession\`
- \`PromoteSessionWork\`
- \`CleanupArchivedSessionSource\`

No command accepts a shell string or generic Git argv. Low-level
\`GitService\` methods remain module-private implementation tools.

### 7.4 Operation lifecycle, retry, and recovery

Progress states are \`planned → accepted → running → needs-attention →
succeeded | failed | cancelled | interrupted\`. Progress includes bounded
phase/percentage/message fields, never subprocess stdout containing secrets.
Cancellation is best effort; completion may race cancellation and is reconciled
from the command journal.

| Operation kind | Retry policy |
| --- | --- |
| Snapshot/describe/status/replay | Safe to retry; replace projection only when epoch/version rules pass. |
| Catalog transaction | Same command ID returns recorded result; a different command with stale expected revision fails. |
| Session/create/checkout record creation | IDs and intended path are preallocated. Device stores pending record before effect; same command rediscover/adopts its result. |
| Clone/worktree creation | Query command journal and filesystem/repository postcondition before retry. A staging/pending record makes residue visible. Never create a second path blindly. |
| Fetch | Safe to repeat, but the result gets a new evidence generation. |
| Fast-forward | Recheck expected local and upstream OIDs. Already-at-target succeeds; any other state is stale/precondition failure. |
| Normal push | Bind to expected local and remote OIDs. On unknown outcome query remote evidence before retry. |
| Force push | Not in the first-release alignment path. A future command must use explicit \`--force-with-lease\`, show lease OID, and require separate acknowledgement. |
| Merge/rebase/reset/checkout-force | Not generic retries. Initial release blocks or uses a narrower typed command with fresh preview. |
| Terminal input | Never automatically retried because duplicate bytes are destructive. |
| Stop | Idempotent for an already-stopped Terminal, but always explicit and routed to its owner. |
| Cleanup | Re-run a fresh loss/consumer scan; already-removed succeeds only when the recorded Checkout identity matches. |

The Device persists a bounded receipt journal keyed by
\`(CockpitId, CommandId)\`. The cockpit persists saga state and child command
IDs. After an unknown network outcome it asks \`GetCommand\` before retrying.
After Application Server restart, a subprocess may be \`interrupted\`; postcondition
inspection decides succeeded, resumable residue, or needs-attention.

### 7.5 Events, snapshots, and demand

- Device events carry epochs, sequence, versions, and owner identity.
- A sequence gap, changed server epoch, malformed payload, reconnect, or
  projection inconsistency triggers a paged authority snapshot.
- Snapshot application is per Device; a slow Device never blocks others.
- Terminal output remains sequence/replay based. Output is delivered only to
  clients with demand for that \`TerminalRef\`, not broadcast for every Runtime
  terminal.
- Checkout and Workspace observations are ref-counted by visible Session,
  Workspace expansion, diff/files/notes surfaces, and pending plans.
- Events with an obsolete connection generation or lower entity version are
  ignored.

### 7.6 Exact Session move semantics

\`PlanSessionMove(SessionRef, destinationWorkspaceId)\` returns one of:

1. **Regroup as-is.** Same Project and compatible source, or the user explicitly
   accepts a visible source mismatch. Only the catalog membership changes.
   Session, Device, Runtime, Terminal, cwd, Checkout, and Session Source are
   unchanged. This works while the Device is offline because it is catalog-only,
   but stale source evidence is labelled and no claim of compatibility is made.
2. **Create successor.** Required for a different Project, requested Device
   change, requested source alignment, or any physical transition. The plan
   prepares a destination Checkout on its Device, creates/starts a new Session,
   then commits destination membership. The original remains running and
   grouped where it was unless the user separately regroups/archives/stops it.
3. **Blocked.** Used when evidence/capability is insufficient or the requested
   operation would risk dirty, ignored, unpublished, divergent, or otherwise
   unreproducible work.

Detailed classification:

| Source/destination | Result |
| --- | --- |
| Same Project, equivalent Workspace Source | Default regroup; show “process and checkout stay on Device X.” |
| Same Project, different Source | Offer regroup with persistent mismatch or successor aligned to destination. Never checkout the running Session's shared source. |
| Different Projects | No plain regroup. Offer successor only after explicit Project Presence/source plan; otherwise cancel. |
| Shared Location source | Regroup can leave it referencing the original Checkout and displays the original Workspace Location as its source. Other sharing Sessions are unaffected. |
| Isolated source | Regroup retains isolated ownership and mismatch. Promotion or successor is separate. |
| Dirty/unpublished source | Regroup is safe because it changes only catalog organization; successor is blocked until a reproducible commit/remote path exists or user explicitly chooses a different base. |
| Running process/cwd dependency | Regroup only, or additive successor. Never mutate cwd. |
| Owning Device disconnected | Catalog regroup is permitted with stale warning; successor/physical work is unavailable and not queued. |

Dropping first opens/executes this plan; it does not optimistically mutate an
array. Keyboard users get the same “Move Session…” action and plan dialog.
Cancellation leaves both catalog and physical state unchanged. Partial
successor creation leaves an explicit adoptable destination residue.

### 7.7 Shared location concurrency

Multiple Sessions may share a Workspace Location. Soloe does not claim an
exclusive filesystem lock. The Device module:

- tracks all Session consumers of a Checkout;
- serializes Soloe-issued Git mutations with a short checkout-scoped command
  mutex;
- revalidates after acquiring the mutex because terminals/external tools can
  mutate Git outside Soloe;
- warns before branch-changing operations and lists affected Sessions/clients;
- publishes drift to every consumer after a branch/HEAD/working-tree change;
- never cleans a Checkout while any active Session consumes it.

For multiple desktop clients, observation is collaborative. Initial input can
retain today's authorized shared-control behavior, but phase 6 adds a
Device-owned renewable terminal input lease to prevent interleaved keystrokes.
Taking control is visible; a stale lease expires. Observation, replay, and an
explicit stop command are not owned by the cockpit catalog.

## 8. User flows

### 8.1 Navigation and device presentation

The default sidebar is \`Project → Workspace → Sessions\`.

- Every Session row has a compact Device chip and accessible text such as
  “Device build-a, connected” or “Device home-b, last seen 8 minutes ago.”
- A Workspace with one Session Device may show that Device chip in its header.
  A distributed Workspace shows a multi-Device icon/count and tooltip/popover;
  individual Session chips remain visible.
- Status is not color-only: ready uses a label/check, connecting a spinner,
  stale a clock/dashed style plus age, offline a disconnected label, degraded a
  warning with partial capability, and incompatible a blocked label/version.
- Loading is per Device. Existing Projects/Workspaces render immediately from
  catalog; Sessions stream into them. Unknown Sessions appear in an “Unassigned
  on Device X” recovery group until adopted.
- The device control defaults to “All Devices.” Selecting Devices filters/focuses
  the view but does not disconnect them. “Default for new Sessions” is a
  separate persisted preference. Connection enable/disable/forget remains in
  settings.
- Physical Checkout details live in a Workspace/Session source inspector, not
  as automatic sidebar groups. Isolated and external Checkouts are badged on
  their owning Session.

### 8.2 Session creation

The creation flow selects Session kind, Workspace, target Device, and source
mode (reuse ordinary location or isolated). A preflight incrementally reports:

| Case | Flow |
| --- | --- |
| 1. Aligned location exists | Show current evidence; create/start against that Checkout. |
| 2. Project present, no location | Offer a new ordinary linked Worktree at the Source or explicit adoption of a compatible existing Checkout. Preview path/ref. |
| 3. Branch checked out elsewhere on Device | Offer to use/adopt that Checkout if appropriate, create an isolated detached/purpose branch from a reproducible OID, choose another Device, or cancel. |
| 4. Project absent, remote reachable | Offer clone **on the selected Device**, show URL/destination/ref/credential capability, then create location/source and Session. |
| 5. No remote | Explain that ordinary clone cannot reproduce it. Offer add existing remote, explicitly create/publish a GitHub repository, choose a Device where it exists, or cancel. Direct transfer is future work. |
| 6. Source has unpushed commits | Block claim that another Device can reproduce it; offer explicit push/publication or choose a published/base OID. |
| 7. Dirty/untracked/ignored files | Explain Git cannot reproduce them. Regroup/reuse on owning Device is possible; remote placement from “current files” is blocked. No auto-commit/copy. |
| 8. Device offline/capabilities unknown | Keep selection and cached facts visible; disable execute and offer retry/change Device. Do not queue clone or creation. |
| 9. Existing location drifted | Show dimensions and safe choices: reuse as-is, explicit fetch/fast-forward if proven safe, isolated source, inspect, or cancel. |
| 10. Isolated requested | Choose an explicit base OID, generated branch by default, preview path/ownership/cleanup rules, prepare, then create Session. |

The plan result shows each phase. If Checkout preparation succeeds but Session
creation fails, the Checkout is “prepared, unused” with Retry, Adopt, or
freshly-planned Cleanup. If Session record creation succeeds but Runtime start
fails, the stopped Session remains and offers Start; it is not silently deleted.

### 8.3 Clone, publication, alignment, isolation, and cleanup

**Clone:** target Device chooses a path inside its configured repository root,
validates containment, clones directly using that Device's Git credentials,
records pending/ready Repository and Checkout IDs, and emits progress. The UI
machine never receives source bytes unless it is the target Device.

**Publish an unpublished Project:** provider planning discovers GitHub identity,
\`gh\` availability/auth, owner choices, name conflicts, visibility, remote
name, source branch, expected local HEAD, and push permissions. The confirmation
shows all values. Recommend Private as a visibly preselected default, never as
an unshown assumption. Repository creation and push are separate receipts; if
push fails, the newly created remote is reported and never silently deleted.

**Align:** inspect both locations, optionally fetch explicit remote evidence,
then offer only proven transitions. A common initial sequence is Push from A
with expected remote OID, then Fetch + fast-forward B with expected local/remote
OIDs. Each step names source/destination Device. Protected branch/auth failures
stop the saga; no fallback force push, merge, reset, or file copy.

**Isolated source:** Device preallocates a Checkout ID and default path under a
configurable Soloe-managed root. Default generated branch:
\`refs/heads/soloe/session/<short-session-id>-<slug>\`. A revision-only
experiment may explicitly choose detached mode. The device records
\`pending\` ownership before \`git worktree add\`, then marks ready. Manual
branch changes update evidence but never the Workspace Source.

**Promotion:** inspect loss/publication state, then either:

- relink the isolated Checkout as a new ordinary Workspace Location;
- create a new Workspace whose Source follows the generated/existing Branch;
- push and open a pull request through provider commands; or
- merge/cherry-pick through a separately previewed future expert workflow.

Promotion atomically replaces Session ownership only after the catalog link is
committed; partial completion is repairable.

**Cleanup:** archiving a Session does not clean its source. Cleanup runs a fresh
consumer and loss scan including staged, unstaged, untracked, ignored, commits
not reachable from retained refs/remotes, remote publication, main-checkout
status, and active operations. Any uncertainty blocks. Eligible isolated
Checkouts are removed through \`git worktree remove\` without force; generated
branch deletion is a second explicit choice with its own reachability preview.

### 8.4 Required scenario walkthroughs

#### 1. UI laptop has no clone; two home servers run one Workspace

- **User flow:** the local packaged UI loads the cockpit catalog, connects to
  Servers A/B, and shows both Sessions under one Workspace with separate Device
  chips. Laptop has no Project Presence and no source is cloned to it.
- **Authority/state/calls:** catalog owns Project/Workspace/memberships; A/B
  snapshots own their Repository, Checkout, Session, and Runtime facts.
  \`DescribeDevice → GetSnapshot → SetObservationDemand\` runs independently.
- **Persistence:** catalog stores two SessionRefs and two Location links;
  Servers retain their own records; laptop stores only connection/auth handles,
  preferences, and cached observations.
- **Failure/recovery:** one server going offline marks only its Sessions stale;
  the other remains usable. Reconnect repairs that Device by epoch/cursor or
  full snapshot. Nothing stops.

#### 2. Workspace only on A; clone and start on B

- **User flow:** New Session → Device B. Preflight finds no Presence on B,
  verifies a reachable remote from Project identity, previews B's clone
  destination/branch, obtains confirmation, clones, creates B's ordinary
  Location, then creates/starts the Session.
- **Authority/state/calls:** B executes \`CloneProjectPresence\`,
  \`PrepareWorkspaceLocation\`, \`CreateSession\`, \`StartSession\`; catalog
  links the resulting Repository/Checkout and SessionRef after receipts.
- **Persistence:** B journals command IDs and stores Repository/Checkout/Session;
  catalog journals saga and associations. A is unchanged.
- **Failure/recovery:** disconnect leaves pending B records. On reconnect the
  cockpit queries command IDs and inspects the path; it offers resume/adopt or
  loss-checked cleanup. It never reclones blindly.

#### 3. Unpublished Project; create private GitHub remote

- **User flow:** remote placement explains “no clone source.” User selects
  Publish with GitHub, chooses owner/name/visibility/remote name/source branch,
  reviews a Private-preselected preview, confirms repository creation, then
  confirms push and resumes placement.
- **Authority/state/calls:** originating Device's provider adapter checks \`gh\`
  auth and executes \`CreateGitHubRepository\`; its Git module adds the remote
  and pushes expected HEAD. Catalog adds stable provider identity/URL alias
  without changing ProjectId. Destination Device then clones.
- **Persistence:** provider creation receipt, device remote/push evidence,
  catalog repository identity, and cross-device saga are durable.
- **Failure/recovery:** creation may succeed while remote add/push fails. Show
  the created repository and retry only the missing step after inspection.
  Never delete the repository or expose credentials automatically.

#### 4. Unpushed commits plus dirty files

- **User flow:** placement shows published base, local unpublished commits, and
  non-reproducible working-tree changes. Options are push commits (after
  reviewing), choose a published/base OID for the remote Session, keep work on
  the original Device, or cancel. “Current files on Device B” is unavailable.
- **Authority/state/calls:** source Device produces fresh HEAD/upstream/dirty
  and ignored-loss evidence. No destination mutation occurs until a
  reproducible Source is chosen.
- **Persistence:** only evidence/plan is cached; a confirmed push creates a
  command receipt and updated Source resolution. Dirty files remain local.
- **Failure/recovery:** stale or auth-failed push returns to preflight. Soloe
  never auto-commits, stashes, copies, or discards files.

#### 5. Same commit; dirty, local commit, push, independent advance

- **User flow:** both locations initially show same OID. A becomes dirty, then
  clean/ahead after commit, then published after push. If B independently
  advances, comparison becomes diverged after fresh evidence rather than
  “synced.”
- **Authority/state/calls:** A/B each emit new Checkout evidence generations.
  Remote relations update only after explicit fetch/push/remote check.
  \`InspectAlignment\` computes peer merge-base relation when objects exist.
- **Persistence:** repositories contain commits; device caches/journals record
  observations and push; catalog Source itself does not change merely because
  a location advances.
- **Failure/recovery:** missing/stale remote evidence displays unknown/as-of
  time. Divergence offers inspect or separately planned merge/rebase work, not
  reset/pull/force.

#### 6. Same pinned experiment on two Devices

- **User flow:** user selects a Revision Workspace Source and prepares isolated
  detached (or explicitly branched) Checkouts on A/B, then starts independent
  Sessions. UI says “started from OID X,” not “same files forever.”
- **Authority/state/calls:** each Device resolves the full OID and prepares its
  own Checkout. Separate Runtime Sessions own subsequent work.
- **Persistence:** catalog has one revision Source and two memberships/location
  correlations; each Device owns its Checkout/Session. No Device is source of
  truth for the other.
- **Failure/recovery:** if a Device lacks the object, explicit fetch is required.
  Later dirty/HEAD changes appear independently; disconnect has no effect on
  the other experiment.

#### 7. Shared Workspace Location manually changes branch

- **User flow:** all Sessions sharing the Checkout receive a drift warning with
  old/new branch and affected Session list. Choices: keep mismatch, restore
  through an explicit safe checkout plan, or reclassify/promote into another
  Workspace.
- **Authority/state/calls:** terminal/external Git changes are detected by
  device watcher/demand refresh; Device publishes Checkout evidence; catalog
  Workspace Source is unchanged.
- **Persistence:** actual Git ref is in repository; latest observation is
  cached. Reclassification is a separate catalog transaction.
- **Failure/recovery:** dirty or branch-in-use constraints block restoration.
  No silent checkout occurs, and every sharing Session sees the same drift.

#### 8. Useful commits in an isolated Session

- **User flow:** source inspector shows generated branch, ahead/publication
  state, and Promote. User chooses new Workspace Location, new Workspace, push,
  or pull-request workflow and confirms effects.
- **Authority/state/calls:** Device loss scan and \`PromoteIsolatedSource\`
  validate owner/HEAD; catalog creates/relinks logical records only after the
  physical result is stable.
- **Persistence:** Checkout role/ownership changes on Device; catalog gains
  Location/new Workspace; command and saga receipts survive restart.
- **Failure/recovery:** partial catalog/device completion appears as “promotion
  needs repair” with Adopt/Revert-link options. Checkout and commits remain.

#### 9. Dirty isolated Session archived or deleted

- **User flow:** Archive changes Session record/membership presentation but
  explicitly says its source remains. Cleanup request reports dirty/untracked/
  ignored/unpublished blockers and offers reopen, inspect, commit/publish, or
  cancel.
- **Authority/state/calls:** Device archives metadata separately from
  \`PlanCheckoutCleanup\`. Runtime stop, archive, and cleanup are three distinct
  intents.
- **Persistence:** Session and Checkout remain; loss report/plan is ephemeral
  or journaled. Nothing is removed.
- **Failure/recovery:** unknown evidence or disconnect blocks cleanup. A later
  fresh plan can proceed; no force removal.

#### 10. Running Session dragged to different-source Workspace

- **User flow:** drop opens a plan: “Keep this running Session on Device A and
  regroup with mismatch” or “Prepare aligned source and create successor.”
  The original fate is explicit.
- **Authority/state/calls:** regroup is a catalog membership transaction.
  Successor is \`Prepare... → CreateSession → StartSession → catalog membership\`.
  Original Runtime receives no cwd/stop call.
- **Persistence:** either only membership changes or destination resources plus
  saga receipts are added.
- **Failure/recovery:** cancellation is no-op. Partial successor remains
  adoptable/cleanable. Original keeps running even if destination disconnects.

#### 11. Compatible organizational drag

- **User flow:** drop preview states Device and source will not change; confirm
  (or a user preference may allow immediate safe regroup with undo).
- **Authority/state/calls:** Cockpit validates same Project/source compatibility
  from current evidence and commits \`RegroupSession\` with expected catalog
  revision. No Device call is necessary.
- **Persistence:** catalog membership/order only.
- **Failure/recovery:** catalog conflict refreshes and reoffers placement.
  Undo is another versioned regroup; offline Device is acceptable.

#### 12. Disconnect during every long operation

- **User flow:** operation remains visible as “outcome unknown” with its last
  confirmed step, never as automatic failure/success. Retry becomes available
  only after reconciliation.
- **Authority/state/calls:** Device journals accepted command before effect;
  cockpit journals child IDs. Reconnect performs \`GetCommand\` and
  postcondition snapshots for clone/fetch/push/worktree/Session/source compare.
- **Persistence:** completed receipts survive server restart; pending filesystem
  residues retain Checkout/Repository IDs.
- **Failure/recovery:** safe reads/fetch may repeat; push queries remote; create
  adopts existing result; source comparison simply reruns; DnD catalog regroup
  is independent; unsafe ambiguous mutation requires user decision.

#### 13. Application Server restarts while Runtime Sessions continue

- **User flow:** Device briefly shows reconnecting/stale; terminal output pauses,
  then Sessions reattach and replay. No “Session stopped” inference.
- **Authority/state/calls:** new server epoch connects to existing Runtime,
  rebuilds Device domain, lists running terminals, and publishes snapshot.
  Cockpit discards old-epoch events and replays from terminal sequence.
- **Persistence:** Session/Checkout stores survive; Runtime retains processes
  and replay under current behavior. Catalog is untouched.
- **Failure/recovery:** missing Runtime terminal after repair is shown as exited/
  unknown based on Runtime authority, not connection loss.

#### 14. Device rename/new endpoint

- **User flow:** connection name/endpoint updates while all Project/Session
  links remain. A hostname that now serves another Device shows
  identity-mismatch and blocks commands.
- **Authority/state/calls:** authenticated \`DescribeDevice\` returns durable
  DeviceId. Registry merges a new endpoint alias only when it matches the
  pinned ID.
- **Persistence:** registry v2 updates aliases/name/last seen; catalog refs use
  DeviceId and need no rewrite.
- **Failure/recovery:** user may forget the stale alias or explicitly register
  the new Device. Identity is never reassigned by endpoint coincidence.

#### 15. \`gh\` absent on one Device, Git works; another has full GitHub support

- **User flow:** ordinary clone/fetch/push remains enabled on the first Device;
  Create repository/PR/issue actions explain missing provider capability. The
  second Device exposes provider actions.
- **Authority/state/calls:** per-Device capability snapshot separates
  \`git.transport\` from \`provider.github.*\`. Git credentials and \`gh\` auth
  are probed locally with sanitized results.
- **Persistence:** only capability revisions/status are cached; no auth material
  leaves either Device.
- **Failure/recovery:** install/auth instructions target the correct Device.
  Capability refresh re-enables only the affected actions.

#### 16. Remote renamed/transferred/deleted/inaccessible/forked

- **User flow:** provider-stable rename/transfer updates alias after review.
  Deleted/inaccessible retains Project/Workspace with unresolved evidence.
  A fork is offered as an explicit additional repository identity, never as an
  automatic replacement.
- **Authority/state/calls:** provider adapter and Git remote inspection produce
  identity evidence. Catalog ProjectId and WorkspaceId remain stable.
- **Persistence:** alias history/provider identity update in catalog; device
  remotes change only through explicit Git command.
- **Failure/recovery:** without stable provider evidence, the UI asks the user
  to verify relinking. No URL/name heuristic rewrites identity.

#### 17. Branch already checked out in another worktree

- **User flow:** preflight names the existing Checkout and consuming Sessions.
  User may adopt/reuse it, choose isolated work based on an OID (detached or a
  different generated branch), select another Device, or cancel.
- **Authority/state/calls:** Device's worktree inventory enforces Git reality;
  \`PrepareWorkspaceLocation\` refuses a duplicate local branch checkout.
- **Persistence:** adoption creates a catalog Location link; isolated choice
  creates a separate Checkout record. No forced Git override.
- **Failure/recovery:** stale inventory is forced before execution; a concurrent
  new checkout yields precondition failure and a refreshed plan.

#### 18. Multiple desktop clients control the same Devices

- **User flow:** both see device-owned Sessions/Runtime truth; their Workspace
  names/membership may differ and are labelled as cockpit organization.
  Device Git mutations use versions/mutexes; terminal input ownership is
  visible once leases ship.
- **Authority/state/calls:** Devices arbitrate physical commands by evidence,
  command ID, checkout mutex, consumers, and later terminal input lease.
  Each cockpit has independent auth and catalog.
- **Persistence:** each catalog/preferences differ; Device Session/Checkout/
  command journals are shared authority. A Session created by another cockpit
  appears unassigned until adopted locally.
- **Failure/recovery:** stale plans fail rather than last-write-win. One client
  cannot clean a Checkout consumed by the other. Shared organization requires
  the future explicit Home Catalog option, not implicit replication.

## 9. Persistence and migration strategy

### 9.1 Target persistence ownership

| Store | Target owner and scope |
| --- | --- |
| \`device-identity.json\` (new) | Device Application Server; UUID, schema, created time. |
| \`repositories.json\` / \`checkouts.json\` (new names conceptual) | Device Application Server; stable local IDs, paths, roles, ownership, pending operations. |
| \`device-operations.json\` (new) | Device Application Server; bounded idempotency/receipt journal. |
| \`sessions.json\` | Device; add entity version and Session Source while retaining compatibility cwd/projectId fields. |
| \`projects.json\` | During transition, remains device-local legacy repository catalog and feeds Repository/Project Presence adoption. It is not the new logical Project authority. |
| \`settings.json\` | Split conceptually: backend placement, binaries, runtime/agent/provider configuration remain per Device; appearance, layout, shortcuts, filter/default placement become cockpit preferences. Dual-read during migration. |
| \`observer.json\` | Device, namespaced externally by DeviceId. |
| \`overview-cache.json\` | Device, rekey from Worktree path identity to CheckoutId + evidence fingerprint; legacy cache may be invalidated, never cross-linked by guess. |
| notes directory | Device-scoped Project Presence notes in first release. Preserve and label Device. A later explicit logical-note migration is separate. |
| vault/bridge/service records | Device/local host as today; never catalog data. |
| \`browser-sessions.json\` | Single-device web client remains device-owned. Multi-device Electron browser presentation migrates to cockpit-host persistence keyed by logical/Checkout refs; import is explicit and bounded. |
| \`connections.json\` | Cockpit registry v2 keyed by DeviceId with endpoint aliases and provisional legacy endpoints; no bearer tokens. |
| \`cockpit-catalog.json\` (new) | Desktop host; Projects, Workspaces, Sources, Presence/Location links, Session membership, revisions, migration map. |
| \`cockpit-operations.json\` (new) | Desktop host; unfinished saga/child command receipts. |
| renderer localStorage | Preferences only, keyed by WorkspaceId, SessionRef, LocationRef, or CheckoutRef. Never physical authority. |

### 9.2 Existing data mapping

Migration is additive and staged:

1. **Device identity first.** Each Application Server atomically
   \`loadOrCreate\`s a DeviceId. Local Device participates. Endpoint-derived
   connection records remain provisional until authenticated handshake.
2. **Device physical records.** For each legacy Project path and Git worktree,
   create stable Repository/Checkout records with a migration fingerprint. For
   each Session, bind the Checkout matching exact Worktree identity; if none is
   provable, create an external/missing source record and surface it for repair.
   Never change Runtime Session IDs.
3. **Cockpit catalog import.** On first enablement, copy each legacy local
   Project into a logical Project candidate and each visible physical worktree
   grouping into a Workspace candidate. Derive a branch Source only from fresh
   branch/upstream evidence; use pinned revision or unresolved branch otherwise.
   Preserve Project/worktree/Session order and membership.
4. **Other Devices.** Their records appear as unassigned candidates. Repository
   evidence may suggest linking to an existing Project, but the user confirms.
   Same name/path/remote URL alone never auto-merges independent records.
5. **Compatibility projection.** Keep Session \`cwd\`, \`runMode\`,
   \`wslDistro\`, and legacy \`projectId\` through at least two releases. New
   source binding is authoritative; old clients can still render physical
   groups. New UUID Session IDs are additive.
6. **Renderer keys.** Map:
   - selected Session IDs to SessionRefs;
   - selected-by-Project/Worktree to Project/Workspace/Checkout refs;
   - sidebar expansion/worktree order to Workspace IDs;
   - browser state, right rail, scroll, diff comments, comment agents, notes
     draft/view/recovery, and overview references from Worktree identity to
     explicit Location/Checkout/Session refs.
   Ambiguous WSL/path entries stay in a Legacy Recovery bucket; never guess.

Saved notes remain on their source Device and retain filenames/revisions/images.
Drafts and saved-note recovery buffers are copied to new keys before old keys
are removed. Diff comments, browser history, and layouts are client-local and
can be migrated without device writes. Terminal replay has no catalog format
migration: retain Session/Terminal IDs and reattach to the owning Runtime.

### 9.3 Restart safety and partial failure

- Every schema has an explicit version and parser; unknown future versions
  disable mutation and keep diagnostics/export available.
- Before first write, copy the original file to a timestamped migration backup.
- Use \`pending → committed\` migration records with source file hash,
  DeviceId, target IDs, and step number. Re-running the same step is idempotent.
- Write new stores to temporary files and atomically rename; never mutate Git
  or old JSON merely to build the catalog.
- Device migrations are independent. The cockpit can operate with migrated,
  legacy-read-only, offline, and incompatible Devices simultaneously.
- Catalog links commit only after device records are durable. Unlinked device
  records are shown as adoptable; dangling catalog refs are shown as missing.
- Do not auto-archive a Session because a Worktree inventory lacks its path.
  Mark Session Source missing/unavailable and preserve the record/Runtime view.

### 9.4 Rollback and compatibility

- Gate catalog UI/commands behind a local feature flag through phases 1–5.
- Phases 0–1 are wire/additive and can fall back to current single-device UI.
- Until the new catalog becomes the sole writer, dual-read old files and
  preserve compatibility fields. Disabling the feature returns to physical
  grouping without deleting new Checkouts or Sessions.
- A rollback never attempts to undo completed Git clone/worktree/push/provider
  effects. It exposes them as ordinary device resources in the old UI or
  recovery tooling.
- Once a catalog migration is committed, rollback uses the backed-up catalog
  and old device files; do not down-migrate in place.
- Mixed-version capability negotiation permits observation when safe and
  disables placement/move/alignment commands that require missing invariants.

## 10. Security and capability model

### 10.1 Authentication and trust boundaries

- Preserve bearer auth for local/managed service clients and Tailscale Serve's
  loopback-validated identity → Strict HttpOnly Secure cookie bootstrap.
- Give every \`DeviceClient\` an isolated cookie/auth context. The shared
  contract sees an opaque credential handle, not Electron session objects.
- Registry/catalog store DeviceId, endpoint aliases, trust status, and last
  seen—never bearer tokens, cookies, SSH keys, provider tokens, or agent creds.
- Pin the authenticated DeviceId after first confirmation. Endpoint identity
  mismatch blocks all commands and cached state is not reassigned.
- Include protocol range, schema range, server epoch, build version, and
  capability revision in authenticated \`DescribeDevice\`. Readiness probe may
  remain unauthenticated but must reveal no sensitive inventory.
- Apply strict schemas, size/count/string limits, control-character stripping,
  and safe rendering to all remote labels/errors/events. Treat a trusted Device
  as a remote input source, not as trusted HTML or command text.

### 10.2 Capability dimensions

\`\`\`text
service:
  protocol / snapshot / event-envelope / command-journal versions
runtime:
  reachable / platform / supported run modes / terminal attach / replay
git:
  installed / version / clone / fetch / push / worktree / object format
repository access:
  per Project/remote read / write / unknown, last probed
github provider:
  gh installed / authenticated / repository-create / pull-request / issues
agents:
  codex / claude installed, integration version, model discovery
environment:
  WSL hosts, configured repository root, required package managers/tools
network:
  endpoint/Tailscale reachability and authenticated identity
\`\`\`

Each item is \`available | unavailable | unknown | degraded | incompatible\`
with sanitized reason/remediation and \`observedAt\`. Capabilities are action
specific: missing \`gh\` does not disable Git clone/fetch/push; missing Claude
does not disable terminal/Codex Sessions.

Repository/runtime prerequisites are evaluated after choosing Device and
Project. Generic package-manager requirements belong to a future
Project-defined environment adapter; the initial release reports detected
binaries and lets Session start surface the actual command failure. It must not
run arbitrary repository setup scripts as a capability probe.

### 10.3 Safe command construction

- Clone URLs accept explicit supported schemes/structured SCP-like SSH syntax;
  reject credentials in URLs for persistence/display, \`file:\`, helper/ext
  transports, NUL/control characters, leading option confusion, and oversized
  values.
- Device-selected destinations must be canonical, contained in a configured
  repository/worktree root, non-symlink-escaping, and collision checked.
- Spawn executables with argument arrays. Validate refs using Git's ref
  validation and use \`--\` path separators where supported.
- Never accept a remote Device's arbitrary path as a path on the UI host.
- External URLs continue through the existing HTTP(S) allowlist and
  \`noopener/noreferrer\`.
- Provider creation confirmation shows actor/account, owner, repository name,
  visibility, remote name, source Branch/OID, target URL, and push effect.
- Protected branch/force semantics are explicit failures. No fallback force,
  reset, checkout, clean, stash, auto-commit, or merge.
- Capability probes return booleans/versions, not command output or credential
  locations. Logs redact URLs with credentials, tokens, home paths where
  diagnostics policy requires, prompts, terminal data, and note contents.

## 11. Performance model

### 11.1 Connection and reconnect budgets

- Keep one lightweight control stream per enabled Device; terminal output is
  separately demand-gated.
- Limit simultaneous connect/handshake/snapshot synchronizations to four and
  normal control RPCs to eight globally, with fair per-Device queues.
- Reconnect independently with exponential backoff starting near 500 ms,
  capped at 30 seconds while recently active and 60 seconds after prolonged
  outage, with jitter. Visibility resume staggers Devices.
- Discovery is manual plus a bounded foreground cadence (initially five
  minutes); hidden windows stop discovery and heavy polling. Known direct
  endpoints do not require rediscovery to reconnect.
- Dispose sockets, timers, cookie contexts, demand leases, and in-flight reads
  when a Device is disabled/forgotten. Forget never stops its Runtime.

### 11.2 Observation and Git budgets

- Preserve current local evidence cadences: selected/foreground Checkout about
  5 seconds, background demanded Checkout 30 seconds, inventory 1 minute/10
  minutes. No demand means no periodic Git scan.
- Each Device keeps the established maximum of two physical Git children;
  resource groups such as WSL remain one at a time. The cockpit caps concurrent
  observation RPCs across Devices but cannot pretend to control physical
  subprocesses on another Device.
- Remote fetch/ls-remote is never a background “sync” side effect. Fetch occurs
  only from explicit refresh/plan/execute and is labelled.
- Deduplicate demand by CheckoutRef, coalesce generations, cancel superseded
  reads, and discard late results by generation.
- Checkout watchers/caches retain the existing bounded/ref-counted pattern.
  Large ignored-file and reachability loss scans run only for cleanup/publish
  plans and expose progress/cancellation.

### 11.3 Payload and renderer bounds

- Page snapshots (initial target 200 entities/page) and cap event frames;
  preserve server response limits but do not rely on a 32 MiB response as a
  normal payload.
- Send normalized deltas and summary evidence to the renderer; fetch detailed
  diffs/history/files on demand from the owning Device.
- Virtualize the sidebar and large Session/Workspace lists once a view exceeds
  roughly 200 rows; filtering operates on bounded metadata, not terminal data.
- Load catalog immediately, then apply each Device independently. “Useful”
  never waits for the slowest Device.
- Demand terminal output only for mounted/selected panes and explicit
  background agent notifications. Preserve bounded Runtime replay (current
  per-terminal/global caps) and request replay by last sequence.
- Hidden windows release Git, files, diff, browser, and terminal-output demand
  except explicitly retained notification leases; control connections remain
  light so lifecycle changes can be observed.

Performance gates should measure reconnect storms at 10 Devices, 100 Projects,
500 Workspaces, and 2,000 Sessions; four simultaneously visible terminals; and
large repositories with worktree inventories. Exact limits may be tuned from
benchmarks, but unbounded fan-out is not acceptable.

## 12. Implementation phases

Each phase is vertically testable and must pass its gate before the next phase
can enable writes.

### Phase 0 — Identity, compatibility, and attributable transport

- **User-visible outcome:** connection diagnostics show a stable Device identity,
  service/protocol compatibility, and partial capabilities. Existing exclusive
  switching still works.
- **Domain concepts:** DeviceId, server epoch, protocol/capability revision,
  composite refs, event envelope, entity version conventions.
- **Prerequisite refactors:** factor readiness/describe from the generic RPC
  route; make connection registry schema migration explicit; add a disposable
  per-device transport abstraction without changing renderer behavior.
- **Authority/modules:** Device Application Server owns Device identity and
  description; Electron ConnectionRegistry owns endpoint aliases/trust pins;
  Runtime ownership is unchanged.
- **Persistence/API/events:** add \`device-identity.json\`; migrate
  \`connections.json\` v1→v2 while preserving \`activeId\` as temporary default;
  add authenticated describe/snapshot metadata and enveloped event opt-in.
- **Compatibility/migration:** old servers retain endpoint-derived provisional
  records and are read-only for new features. Old event format stays supported
  by the single-device adapter. No user Project/Session migration.
- **Tests/gate:** identity survives rename/restart/endpoint change; endpoint
  mismatch blocks; v1 registry rollback fixture; protocol min/max matrix;
  malformed/oversized descriptor tests; server epoch/event sequence tests;
  existing API compatibility and Runtime replacement suites pass.
- **Risks/non-goals:** risk is two IDs for one unreachable legacy endpoint;
  resolve only after handshake. No concurrent UI, logical catalog, Git mutation,
  or PTY ID rewrite.

### Phase 1 — Concurrent multi-device Sessions and terminal attachment

- **User-visible outcome:** one Electron UI connects to several enabled Devices,
  progressively lists their Sessions, displays Device chips/states, filters by
  Device, and attaches to demanded terminals. This is the earliest useful
  multi-device slice and performs no source automation.
- **Domain concepts:** CockpitPort, DeviceCoordinator, DeviceClient,
  SessionRef/TerminalRef, disposable device projection, default placement
  preference distinct from filter.
- **Prerequisite refactors:** always load the local packaged renderer; move
  \`createBrowserApi\` behind a host-private DevicePort; route all existing
  Session/terminal methods by explicit DeviceRef; make output subscriptions
  target/ref-counted.
- **Authority/modules:** Electron CockpitCoordinator aggregates; each Device
  Server/Runtime remains authority. Renderer stores consume one bounded cockpit
  snapshot and cannot open sockets.
- **Persistence/API/events:** cockpit identity/preferences and cached device
  summaries; ConnectionRegistry enabled/focused/default fields; new CockpitPort
  snapshot/demand/events. No logical Project writes yet.
- **Compatibility/migration:** synthesize read-only physical groups per Device
  using current Project/worktree data. Retain exclusive-switch fallback behind
  feature flag. Existing IDs are wrapped, not changed.
- **Tests/gate:** two in-process Servers with colliding Session/Terminal IDs;
  independent reconnect/replay; stale old-socket event rejection; terminal
  input never cross-routes; filter does not disconnect/stop; server replacement;
  renderer never sees token/base URL; 10-Device fan-out benchmark; Electron
  smoke with two real Devices.
- **Risks/non-goals:** terminal output fan-out and auth cookie isolation are the
  main risks. No Workspace catalog, cross-Workspace DnD, clone, worktree create,
  alignment, or Settings merge.

### Phase 2 — Logical catalog, migration, navigation, and safe regroup

- **User-visible outcome:** Project → Workspace → Session navigation, preserved
  ordering/layout, stable offline Workspaces, unassigned recovery groups,
  explicit source inspectors, and compatible drag/keyboard regroup. Physical
  Worktrees leave the primary hierarchy.
- **Domain concepts:** logical Project, Project Presence, Workspace,
  Workspace Source, Checkout, Workspace Location, Session Source,
  SessionMembership, catalog revision.
- **Prerequisite refactors:** introduce device Repository/Checkout registry and
  Session Source compatibility projection; extract catalog/projection from
  renderer stores; replace cwd-based navigation contracts with logical/composite
  refs.
- **Authority/modules:** cockpit catalog owns logical definitions/membership;
  Device server owns Repository/Checkout/Session Source; ProjectionEngine joins
  them.
- **Persistence/API/events:** new catalog and migration map; device
  repository/checkout stores; additive Session fields; migration of localStorage
  keys/drafts/browser/layout/comments; catalog transactions/events. Notes remain
  device-scoped.
- **Compatibility/migration:** staged import described in section 9; keep old
  fields and physical-group fallback; do not auto-merge remote-device Projects;
  do not auto-archive missing sources.
- **Tests/gate:** fixture migrations for every current schema/version, WSL/path
  ambiguity, duplicate IDs, corrupt/partial/restart cases, order/selection/
  notes/drafts/comments/browser/layout preservation, catalog optimistic
  conflicts, DnD regroup invariants, accessibility for all Device states.
- **Risks/non-goals:** mistaken repository equivalence and UI regression are
  primary. No physical move from DnD, clone, push, cleanup, or automatic source
  alignment. Different-Project and requested physical moves are explained/
  blocked until later.

### Phase 3 — Placement on Devices where the Project is already present

- **User-visible outcome:** New Session chooses Device and shared versus
  isolated-ready mode; preflight can reuse/adopt an existing Checkout or create
  an ordinary Workspace Location when the Project is already on that Device.
  It handles same-device branch checkout constraints honestly.
- **Domain concepts:** CockpitPlan, device plan token, Checkout evidence,
  capability snapshot, pending/ready physical resource, device command receipt.
- **Prerequisite refactors:** place a typed Workspace/Checkout service above
  GitService; add forced evidence, full ref/OID/upstream identity, consumer
  tracking, per-Checkout mutex, and operation journals.
- **Authority/modules:** Device planner validates paths/Git and performs
  worktree/session effects; cockpit planner composes and commits logical links;
  Runtime starts only the resulting Session.
- **Persistence/API/events:** device operation journal; Checkout lifecycle;
  Session Source/version; plan/execute/get/cancel APIs and progress events;
  catalog saga journal.
- **Compatibility/migration:** existing creation remains available only in
  legacy UI; new flow can create a stopped Session if start fails. Existing
  \`createWorktree\` UI is replaced, not silently reused.
- **Tests/gate:** branch already checked out, main checkout, detached base,
  dirty existing location, concurrent external branch change, duplicate command
  retry, disconnect at each step, path/symlink attacks, Session-create/start
  split, shared-consumer warnings, two-client stale plan.
- **Risks/non-goals:** worktree creation residue and stale Git facts. No clone,
  remote creation, cross-device publication, merge/rebase/reset/force, or
  cleanup. Isolated creation may be preview-only until Phase 5 if ownership/loss
  gate is not complete.

### Phase 4 — Explicit clone, publication, and bounded alignment

- **User-visible outcome:** a Project can be cloned directly on the selected
  Device; unpublished work can be explicitly published through GitHub; two
  locations can be compared and offered push/fetch/fast-forward sequences.
- **Domain concepts:** repository identity evidence/aliases, provider adapter,
  publication evidence, peer relation, additive cross-device saga.
- **Prerequisite refactors:** add typed Git clone/remote/ref inspection,
  current-fetch evidence, provider capability probes, protected/remote-OID
  preconditions, and safe URL/path construction.
- **Authority/modules:** target Device clones with its credentials; source
  Device publishes; provider adapter performs GitHub-only effects; cockpit
  coordinates receipts without seeing credentials/source bytes.
- **Persistence/API/events:** Repository pending/ready records, remote/provider
  identity in catalog, publish/alignment operation receipts, progress and
  needs-attention events.
- **Compatibility/migration:** Projects without provider IDs continue with
  explicit remote aliases. Ordinary Git remains available without \`gh\`.
  Existing thin push/fetch APIs remain internal until callers migrate.
- **Tests/gate:** local/bare/SSH/HTTPS fixtures; no-remote Project; GitHub adapter
  fake for owner/name/visibility conflicts; created-remote/push-failed recovery;
  auth/protected branch failures; push unknown outcome; A/B ahead/behind/
  diverged/object-missing matrix; no source bytes on UI host.
- **Risks/non-goals:** external side effects and ambiguous push outcomes.
  Initial safe alignment is normal push plus fetch/fast-forward only. No
  continuous sync, direct Device transfer, force push, merge, rebase, reset,
  auto-commit, or automatic pull.

### Phase 5 — Isolated Session sources, promotion, cleanup, and successors

- **User-visible outcome:** users can create Session-owned isolated Worktrees,
  see provenance/drift, promote useful work, request guarded cleanup, and use
  DnD to create a successor when regroup is insufficient.
- **Domain concepts:** isolated ownership, generated branch, base revision,
  loss report, promotion, orphan/residue, successor Session.
- **Prerequisite refactors:** ignored/untracked/reachability/publication loss
  scan; \`git worktree remove\` without force; promotion transaction; complete
  plan-driven DnD UI; archive/stop/cleanup separation.
- **Authority/modules:** Device owns isolated Checkout and loss scan; catalog
  owns destination Workspace/location/membership; cockpit saga makes promotion
  and successor additive; Runtime original is untouched.
- **Persistence/API/events:** owner SessionRef/correlation, Checkout lifecycle,
  generated branch metadata, cleanup/promote/successor commands and receipts,
  recoverable orphan list.
- **Compatibility/migration:** legacy Sessions keep external/shared sources.
  Archive behavior changes only under the feature gate; old automatic
  missing-worktree archive is retired. New physical resources remain visible
  if rolling back UI.
- **Tests/gate:** dirty/staged/unstaged/untracked/ignored, unpublished reachable/
  unreachable commits, active consumers, main Checkout, manual branch change,
  archive without stop, promotion failures at every boundary, successor start
  failure, DnD cancel/keyboard/accessibility, no force deletion.
- **Risks/non-goals:** loss detection false negatives are release blockers.
  No automatic cleanup on archive/end, branch deletion by default, implicit
  merge/cherry-pick, or PTY/device migration.

### Phase 6 — Hardening, multi-client control, retirement, and portability

- **User-visible outcome:** explicit terminal input ownership across clients,
  polished recovery/diagnostics, export/import of cockpit catalog, and removal
  of the exclusive selector from normal use. Electron is production-ready;
  Tauri has a verified adapter contract but need not ship simultaneously.
- **Domain concepts:** terminal control lease, catalog export epoch, recovery
  bundle, deprecated transport/schema capabilities.
- **Prerequisite refactors:** instrument bounded diagnostics, finish all
  renderer store migrations, remove direct broad backend access, and define
  host adapter conformance suite.
- **Authority/modules:** Runtime/Device owns input lease; cockpit export/import
  owns catalog continuity; host adapters own native integration.
- **Persistence/API/events:** lease events/expiry, export manifest/checksums,
  migration completion marker, deprecation telemetry/counters, final registry
  removal of \`activeId\` semantics.
- **Compatibility/migration:** retain read/export support for one additional
  release; then retire remote preload/exclusive relaunch and cwd-only keys after
  migration evidence. Tauri implements contract later.
- **Tests/gate:** two clients racing input/Git/cleanup; lease expiry/takeover;
  catalog export/import/corruption; downgrade recovery; soak/reconnect/fault
  injection; Electron packaging on Windows/macOS/Linux; adapter conformance.
- **Risks/non-goals:** feature retirement may expose overlooked callers. A Home
  Catalog is still a separate product phase, not smuggled into hardening.

## 13. Concrete change inventory

Names for new files are recommended seams, not code committed by this planning
pass.

### Shared contracts

- Add \`shared/types/devices.ts\`: durable Device descriptor, lifecycle,
  protocol/capability snapshot, DeviceRef.
- Add \`shared/types/workspaces.ts\`: logical Project/Workspace/Source,
  Presence/Location, CheckoutRef, SessionRef, evidence/alignment view models.
- Add \`shared/types/commands.ts\`: plan, acknowledgement, command/event/operation
  envelopes and stable errors.
- Evolve [\`connections.ts\`](../../shared/types/connections.ts): DeviceId-keyed
  registry projection, endpoint aliases, enabled/focus/default placement;
  deprecate endpoint-derived identity and exclusive \`active\`.
- Evolve [\`projects.ts\`](../../shared/types/projects.ts): rename the current
  path record at the domain boundary to device repository/presence DTO; retain
  wire compatibility during migration.
- Evolve [\`sessions.ts\`](../../shared/types/sessions.ts): entity version and
  Session Source; retain cwd/run-mode/project compatibility projection; remove
  “tab” language from public fields/copy over a deprecation window.
- Evolve [\`git.ts\`](../../shared/types/git.ts): full refs, repository identity,
  upstream/fetch evidence, ignored/loss scan, Checkout evidence, typed plan
  requests; keep low-level diff APIs.
- Evolve [\`ipc.ts\`](../../shared/types/ipc.ts) and
  [\`api-contract.ts\`](../../shared/api-contract.ts): small CockpitPort for
  Electron renderer plus versioned Device describe/snapshot/command methods.
  Preserve the existing transport matrix for web/single-device compatibility.
- Update contract/compatibility tests in [\`shared/api-contract.test.ts\`](../../shared/api-contract.test.ts),
  [\`tests/compatibility/api-contract.test.ts\`](../../tests/compatibility/api-contract.test.ts),
  and [\`renderer-backend-seam.test.ts\`](../../tests/compatibility/renderer-backend-seam.test.ts).

### Electron desktop host

- Add \`electron/cockpit/CockpitCoordinator.ts\`,
  \`DeviceCoordinator.ts\`, \`DeviceClient.ts\`, \`ProjectionEngine.ts\`,
  \`CommandPlanner.ts\`, \`CockpitCatalogStore.ts\`,
  \`CockpitOperationStore.ts\`, and \`CockpitMigration.ts\`.
- Add \`electron/ipc/cockpit.ipc.ts\` as the renderer's only multi-device
  bridge. Keep native Window/Browser/Vault host adapters separate.
- Evolve [\`ConnectionRegistry.ts\`](../../electron/connections/ConnectionRegistry.ts)
  and tests for v2 Device identity/aliases/enabled/default/focus, bounded
  discovery, and no tokens.
- Refactor [\`electron/main.ts\`](../../electron/main.ts) to always create the
  local UI and CockpitCoordinator. Remove \`remoteServerUrl\` as process-wide
  backend identity after compatibility rollout.
- Evolve [\`preload.ts\`](../../electron/preload.ts) to expose CockpitPort.
  Retain [\`preload-remote.ts\`](../../electron/preload-remote.ts) only for
  temporary legacy/single-device mode, then retire it.
- Move [\`browser-api.ts\`](../../src/lib/browser-api.ts) transport behavior
  behind a host-private DeviceClient adapter; add disposal, jittered backoff,
  handshake, event cursor/epoch, isolated auth context, and targeted output.
- Add migration tests using byte-for-byte fixtures of \`connections.json\`,
  catalog/localStorage exports, partial files, and endpoint rename.

### Device Application Server and domain

- Add \`apps/server/src/DeviceIdentityStore.ts\` and
  \`DeviceDescriptorService.ts\`; wire through
  [\`ServerHost.ts\`](../../apps/server/src/ServerHost.ts) and
  [\`SoloeServer.ts\`](../../apps/server/src/SoloeServer.ts).
- Add domain modules under \`packages/domain/src/workspaces/\`:
  \`RepositoryStore\`, \`CheckoutStore\`, \`WorkspaceDeviceService\`,
  \`GitEvidenceService\`, \`CheckoutLossScanner\`, and
  \`DeviceOperationStore\`. Export them through
  [\`packages/domain/src/index.ts\`](../../packages/domain/src/index.ts).
- Compose these modules in [\`SoloeDomain.ts\`](../../apps/server/src/SoloeDomain.ts);
  avoid adding more physical policy directly to its large RPC switch. Keep
  SoloeDomain as composition/dispatch, not the new deep module.
- Evolve [\`ProjectStore.ts\`](../../electron/projects/ProjectStore.ts) into
  legacy input/device repository discovery or replace it behind an adapter;
  do not let two stores independently own the same logical Project.
- Evolve [\`SessionStore.ts\`](../../electron/sessions/SessionStore.ts) with
  source/version migration and separate archive semantics.
- Extend [\`GitService.ts\`](../../packages/domain/src/git/GitService.ts) only
  with narrow primitives needed by the Workspace service: clone, remote/ref
  inspection, existing/detached worktree add, non-force worktree remove,
  merge-base/rev-list evidence, and ignored/loss inputs. Do not put cockpit
  sagas or confirmations in GitService.
- Reuse [\`GitProcessExecutor.ts\`](../../packages/domain/src/git/GitProcessExecutor.ts)
  for the per-Device two-child budget.
- Add a GitHub provider adapter under
  \`packages/domain/src/providers/github/\`; it may drive configured \`gh\`
  with argument arrays but exposes semantic create-repository/PR capabilities.
- Update [\`SoloeServer.test.ts\`](../../apps/server/src/SoloeServer.test.ts) and
  [\`SoloeDomain.test.ts\`](../../apps/server/src/SoloeDomain.test.ts) for
  identity, protocol, snapshots, command journals, auth, bounds, and real Git
  fixtures.

### Runtime/protocol

- Keep [\`RuntimeHost.ts\`](../../apps/runtime/src/RuntimeHost.ts) and
  [\`packages/protocol/src/index.ts\`](../../packages/protocol/src/index.ts)
  local-ID based through early phases; namespace at DeviceClient.
- Add targeted output demand/attachment metadata if the current server path
  still broadcasts every Runtime event.
- In Phase 6 add Runtime-owned terminal control lease methods/events. Never
  make Cockpit/Workspace ownership part of the Runtime protocol.
- Add tests for reattach across server epoch, colliding IDs on two Runtimes,
  replay gaps, no input retry, lease races, and disconnect-not-stop.

### Renderer

- Add \`src/stores/cockpit.svelte.ts\` and focused projection selectors. Migrate
  [\`sessions.svelte.ts\`](../../src/stores/sessions.svelte.ts),
  [\`projects.svelte.ts\`](../../src/stores/projects.svelte.ts),
  [\`connections.svelte.ts\`](../../src/stores/connections.svelte.ts), and
  [\`git.svelte.ts\`](../../src/stores/git.svelte.ts) from one backend/unscoped
  maps to CockpitPort/composite refs. DeviceCoordinator, not renderer stores,
  owns multi-device sockets and heavy polling.
- Replace [\`worktree-groups.ts\`](../../src/lib/worktree-groups.ts) with a
  Workspace projection selector after using it once for migration.
- Replace [\`WorktreeGroup.svelte\`](../../src/components/WorktreeGroup.svelte)
  with \`WorkspaceGroup.svelte\`; evolve
  [\`ProjectSection.svelte\`](../../src/components/ProjectSection.svelte),
  [\`Sidebar.svelte\`](../../src/components/Sidebar.svelte),
  [\`MobileWorkspaceNav.svelte\`](../../src/components/MobileWorkspaceNav.svelte),
  and [\`SessionItem.svelte\`](../../src/components/SessionItem.svelte) for
  logical hierarchy, Device status, source mismatch, loading/stale states, and
  virtualization.
- Evolve [\`dnd.svelte.ts\`](../../src/stores/dnd.svelte.ts) to carry
  SessionRef/WorkspaceId and invoke plan, with equivalent keyboard/context-menu
  action. Remove cwd-scoped drop mutation.
- Replace [\`NewSessionPickerDialog.svelte\`](../../src/components/NewSessionPickerDialog.svelte)
  and [\`CreateWorktreeDialog.svelte\`](../../src/components/CreateWorktreeDialog.svelte)
  with a staged \`SessionPlacementDialog\`; evolve
  [\`AgentLaunchPopover.svelte\`](../../src/components/AgentLaunchPopover.svelte)
  to open it rather than create immediately.
- Evolve [\`ConnectionMenu.svelte\`](../../src/components/ConnectionMenu.svelte)
  and [\`ConnectionsForm.svelte\`](../../src/components/forms/ConnectionsForm.svelte)
  into filters/default placement plus enabled/trust management.
- Migrate [\`right-rail.svelte.ts\`](../../src/stores/right-rail.svelte.ts),
  [\`browser.svelte.ts\`](../../src/stores/browser.svelte.ts),
  [\`notes.svelte.ts\`](../../src/stores/notes.svelte.ts),
  [\`diff-comments.svelte.ts\`](../../src/stores/diff-comments.svelte.ts),
  [\`comment-agents.svelte.ts\`](../../src/stores/comment-agents.svelte.ts),
  sidebar expansion/nav/working-diff/files/features, and
  [\`notes-draft-persistence.ts\`](../../src/lib/notes-draft-persistence.ts) to
  explicit logical/composite addresses with one-shot legacy adoption.
- Rename domain-facing “tab” copy/settings. Keep serialized
  \`confirmDeleteTabs\` as a read alias, write the new Session name in the next
  settings version, and document removal.

### Documentation and architecture records

After approval/implementation begins:

- Update [\`CONTEXT.md\`](../../CONTEXT.md) with section 3's vocabulary.
- Update [\`process-model.md\`](../architecture/process-model.md) and
  [\`api-compatibility.md\`](../architecture/api-compatibility.md).
- Add ADRs for (1) cockpit-local catalog authority and rejected federation/Home
  alternatives, and (2) opaque Project identity plus repository evidence.
- Update [\`mcp-security.md\`](../mcp-security.md),
  [\`agent-integrations.md\`](../agent-integrations.md), known limitations,
  troubleshooting, and development docs for per-Device capabilities/recovery.

## 14. Testing strategy

### 14.1 Domain/unit tests

- Identity parsing, repository evidence ranking, remote canonicalization,
  Project adoption, Source resolution, alignment dimensions/freshness.
- Catalog optimistic revisions, dangling refs, Session membership, regroup/
  successor classification, and no physical side effects from logical edits.
- Checkout lifecycle/consumer tracking, generated names, same-branch Git
  constraints, main Checkout rules, promotion, orphan recovery, loss scanning,
  and cleanup refusal.
- Command plan expiry/preconditions, journal idempotency, cancellation races,
  query-before-retry, postcondition repair, and bounded retention.
- Capability composition: Git without \`gh\`, one agent missing, WSL partial,
  incompatible protocol, auth unknown.

### 14.2 Persistence/migration fixtures

Check in representative fixtures for every current store version and:

- duplicate Project/Session IDs on two Devices;
- endpoint-derived connection records, unreachable endpoint, renamed endpoint;
- Windows case/separator variants and same Linux path in two WSL distros;
- main/linked/detached/missing Worktrees;
- active/archived/standalone Sessions and running Runtime IDs;
- notes/images/revisions, drafts and saved-note recovery;
- browser v1/v2/v3, diff comments, comment agents, right rail/scroll/layout,
  selection maps, worktree order, overview cache;
- corrupt, truncated, future-version, partial temp, committed migration, and
  crash-after-each-step files.

Assertions: restart idempotence, original backups, no dropped bytes for user
content, no guessed ambiguous mapping, preserved order/selection, and feature
rollback readability.

### 14.3 Git fixture matrix

Use real temporary repositories/bare remotes for:

- no remote, multiple remotes, renamed remote, SSH/HTTPS aliases, provider fork;
- unborn/default-changed/deleted/unpublished branches;
- clean/dirty/staged/unstaged/untracked/ignored;
- same OID, ahead, behind, diverged, unrelated histories, missing objects,
  shallow clone, detached HEAD;
- branch checked out in another linked Worktree and main-checkout removal;
- normal push, auth/protected failure fakes, unknown push outcome, fetch and
  fast-forward races;
- isolated branch/detached creation, manual branch change, promotion, commits
  reachable only from generated branch/reflog, and every cleanup blocker.

No test should use force deletion to make an unsafe expectation pass.

### 14.4 Contract/security tests

- Every CockpitPort/Device command/event is classified on every transport.
- Renderer code cannot import raw DeviceClient/base URLs/tokens; architecture
  test enforces the seam.
- Tailscale loopback header trust, cookie isolation per Device, bearer redaction,
  endpoint pinning/mismatch, origin/CORS, malformed payloads, frame/page limits.
- Clone URL/ref/path injection, symlink escape, device-supplied labels,
  credential-in-URL redaction, external link rules, provider confirmation
  binding, and no cross-Device credential/header reuse.
- Fuzz parsers for descriptors, snapshots, command/event envelopes, migration
  files, Git porcelain, and provider output.

### 14.5 Multi-process/integration tests

Build a harness with two or three Server/Runtime pairs and one CockpitCoordinator:

- colliding IDs and independent events;
- one slow/offline/incompatible Device;
- reconnect storms, server epoch change, Runtime survival/replay;
- disconnect during every saga step;
- clone A/B, placement, source drift, push/fetch/fast-forward, successor;
- two cockpits issuing stale/concurrent Git/cleanup/input requests;
- connection filter/forget/window close never stops Runtime;
- host restart recovers saga receipts and prepared residues.

### 14.6 Renderer/Electron/accessibility tests

- Progressive loading, single/multi Device chips, all lifecycle states, tooltips
  and screen-reader names; status never color-only.
- Project → Workspace → Session navigation and virtualization.
- Creation/preflight/confirmation/error/recovery flows.
- Drag and keyboard move parity; regroup, mismatch, successor, cancel, partial
  completion, catalog conflict.
- Selection, split terminal, rail, notes, browser, diff/files/features state
  remains attached to the correct Device/Checkout.
- Packaged Electron smoke on Windows, macOS, Linux; at least two real Tailscale
  Devices, UI laptop with no clone, remote-only Sessions, restart/rename/offline.

### 14.7 Performance gates

- Ten-device simultaneous reconnect stays within connection/RPC limits and
  produces jittered requests.
- No more than two Git children per Device from Soloe observation.
- Hidden window releases heavy demand.
- 2,000 Session projection/sidebar interaction remains responsive and payloads
  stay paged/bounded.
- Four visible terminal streams retain sequence/replay correctness while
  non-demanded streams send no output payload to that cockpit.
- Migration and catalog startup are measured with 100 Projects/500 Workspaces;
  one slow Device does not delay first useful render.

## 15. Rollout and observability

### 15.1 Gates and cohorts

Use local gates in order:

1. \`device_identity_v2\`
2. \`multi_device_read\`
3. \`workspace_catalog\`
4. \`device_placement\`
5. \`remote_source_operations\`
6. \`isolated_source_lifecycle\`

Mutation gates require all earlier gates. Unsupported Devices remain visible in
legacy/read-only mode. Do not remotely auto-enable a migration without a
release-specific rollback path.

### 15.2 Diagnostics

Add bounded structured local diagnostics for:

- Device lifecycle transition, endpoint alias and identity mismatch;
- protocol/capability revision and incompatibility reason;
- snapshot page counts/durations, event gaps, discarded stale events;
- demand counts, active streams, queue depths, reconnect delay;
- command/operation IDs, phase, duration, outcome, stale precondition, and
  residue—not arguments or sensitive stdout;
- migration source version/hash prefix, step, result, backup path token, and
  recovery action;
- Git child admission/queue duration and evidence age.

Diagnostics redact tokens/cookies, URL userinfo, full home paths where current
policy redacts them, prompts, terminal output, notes, diff content, repository
secrets, and provider output. External telemetry is out of scope unless Soloe
adopts an explicit consent/privacy policy; local exportable diagnostics are
enough for initial rollout.

### 15.3 Recovery affordances

- “Reconnect / Re-authenticate / Verify replacement Device.”
- “Refresh evidence” with timestamp and no implicit fetch unless labelled.
- “Resume / Inspect / Adopt / Clean up” for unfinished operations.
- “Unassigned Sessions/Repositories/Checkouts” after migration or another
  cockpit's creation.
- Catalog export and backup restore.
- Read-only legacy view when catalog/device schema is incompatible.
- Copyable redacted operation report with Device/command IDs.

Rollback boundary is the feature/UI/catalog writer. Completed Git/provider
effects are never automatically reversed. Device records make them discoverable
after rollback.

## 16. Risks and rejected alternatives

| Risk | Mitigation |
| --- | --- |
| Catalog loss makes organization disappear | Atomic writes, backups, checksums, export/import, dangling/unassigned reconstruction. Physical Sessions/source remain safe. |
| Users assume catalog is shared across desktops | Say “this cockpit” in onboarding/export; other-client Sessions appear unassigned; approve Home Catalog separately if needed. |
| Repository false match | Opaque IDs, evidence ranking, explicit adoption, stable provider IDs, no name/path/URL-only auto-merge. |
| Stale/ambiguous Git effect | Fresh plan + execute revalidation, expected OIDs, typed actions, command journal, query/postcondition before retry. |
| Cross-device partial completion | Additive saga, original retained, persistent child IDs, visible residue, separate cleanup. |
| Data loss from cleanup/archive | Separate stop/archive/cleanup; exhaustive loss/consumer scan; no force; uncertainty blocks. |
| Renderer orchestration grows back | Architecture import test and CockpitPort-only rule; no generic RPC multiplex method. |
| Fan-out overload | Ref-counted demand, per-Device two-child cap, global fair queues, paging, virtualization, jittered reconnect. |
| Token/cookie crossover | Isolated auth contexts, opaque handles, Device pinning, no registry secrets, security tests. |
| Multi-client terminal/Git races | Device entity versions/mutex/consumer checks; terminal input lease in hardening. |
| \`SoloeDomain\` becomes a god object | Add cohesive Workspace/Checkout and operation modules; keep dispatch thin. |
| Long mixed-version period | Capability gates, compatibility projections, deprecation counters, time-boxed two-release field retention. |

Rejected alternatives:

- **Filesystem synchronization/direct copying as alignment:** violates explicit
  Git coordination, cannot reproduce ignored/dirty state safely, creates
  conflict/deletion/security semantics. Future direct Device transfer, if ever
  built, is an explicit separate capability and not “sync.”
- **Renderer-owned socket sets/pollers:** loses lifecycle on reload, duplicates
  orchestration in stores/Tauri, exposes auth/routing, and multiplies work.
- **One global current Device:** cannot show or safely route concurrent Sessions;
  retained only as a temporary compatibility mode.
- **Branch as sidebar identity:** branches can be unchecked-out, detached,
  deleted, or independently advanced; names are not physical/logical identity.
- **Worktree as logical Workspace:** a physical path cannot span Devices, may be
  isolated/external/main, and can change Branch.
- **Endpoint-derived Device identity:** loses state on rename/new endpoint and
  can attach cached state to the wrong server.
- **Remote URL-derived Project identity:** fails before publication, across
  rename/transfer/forks/multiple remotes, and after history/provider changes.
- **Mutable federation among Devices:** is an undeclared distributed database.
- **Git metadata for Workspace catalog:** pollutes repositories, cannot represent
  zero-presence/unpublished/offline cases reliably, and creates merge/conflict
  side effects.
- **Automatic clone/push/pull/checkout/reset/merge/rebase/stash/commit/cleanup:**
  obscures external/destructive consequences and violates Source-as-intent.
- **“Move” by editing Session cwd/Device:** a running process cannot be
  teleported; use regroup or successor.
- **Stopping Runtime on archive/filter/disconnect:** violates the existing
  Runtime ownership boundary and risks agent loss.
- **Making \`gh\` mandatory:** ordinary Git transport can work without it;
  provider operations are optional capabilities.

Explicit first-release non-goals:

- continuous filesystem or Git synchronization;
- direct Device-to-Device source transfer;
- automatically shared Workspace catalog across desktop clients;
- automatic Home election/failover;
- force push, reset, rebase, merge, stash, auto-commit, or conflict resolution;
- automatic cleanup or generated branch deletion;
- moving a live PTY/agent between Device/Checkout;
- provider support beyond the GitHub adapter;
- simultaneous full Tauri delivery.

## 17. Definition of done

### Product behavior

- A packaged Electron cockpit with no local clone shows and controls Sessions
  on at least two Devices concurrently.
- Sidebar is Project → Workspace → Session; no physical Worktree automatically
  becomes a top-level logical group.
- Every Session and mixed Workspace communicates Device and lifecycle
  accessibly.
- Device filters/default placement never disconnect or stop unrelated Sessions.
- New Session can select Device and correctly handles all ten creation cases in
  section 8.2 with explicit previews and safe blocks.
- A Project can exist with zero local presence and before publication; its ID
  survives publication and remote rename/transfer.
- Same Workspace can have independent ordinary locations on two Devices; state
  shows evidence dimensions/freshness, not a binary sync flag.
- Same-revision experiments remain independent and later drift is visible.
- Shared Location branch drift warns every consuming Session and does not
  rewrite Workspace Source.
- Isolated worktree ownership survives restart; dirty/untracked/ignored/
  unpublished/consumed uncertainty prevents cleanup; promotion is recoverable.
- DnD and keyboard moves classify regroup/successor/blocked, never teleport or
  stop the original process, and recover from every injected disconnect.
- Ordinary Git remains usable without \`gh\`; GitHub-only actions show
  per-Device capability and full confirmation.
- Server replacement reattaches to Runtime Sessions; Device rename/endpoint
  change preserves identity; identity mismatch blocks.
- Multiple cockpits cannot cross-route IDs or clean a resource used by another.

### Data integrity

- Migration preserves Projects, Sessions, notes/images, drafts/recovery,
  browser state, diff comments, observer data, selections, layouts/order,
  source associations, and live Runtime attachment where authority still has it.
- Migration is versioned, restart-idempotent, backed up, partial-failure
  recoverable, and does not guess ambiguous identities.
- Legacy IDs collide safely across Devices because all external maps/routes/
  caches/events use composite refs.
- Disabling/rolling back the feature does not undo or delete completed physical
  effects and retains a recovery path.

### Architectural integrity

- Renderer imports only CockpitPort for multi-device domain work and owns no
  arbitrary socket set, bearer token, endpoint routing, or Git poll fan-out.
- Every physical command/event/snapshot/cache/subscription is attributable to
  DeviceId; stale epochs/generations/versions are rejected.
- Logical catalog, Device domain, and Runtime each have one documented
  authority; no replicated mutable Workspace database exists.
- Cockpit/Device command journals provide query-before-retry and visible
  residues; cross-device flows make no atomicity claim.
- Per-Device credentials never enter catalog/registry/readiness/logs or another
  Device request.
- Demand and performance gates in section 14.7 pass.
- Contract, migration, security, Git matrix, multi-server, Electron, and two-real-
  Device smoke suites pass on supported desktop platforms.
- \`CONTEXT.md\`, process/API docs, security docs, and the two ADRs match the
  shipped architecture.

## Recommended execution order and approval decisions

Execute Phases 0 → 1 → 2 → 3 → 4 → 5 → 6. Do not combine Phase 2 catalog
migration with Phase 4 remote Git effects; do not enable cleanup until the full
Phase 5 loss matrix passes. Each stage gate should land as a separately
reversible Conventional Commit series.

Approval is requested for these product/architecture decisions before any
implementation:

1. **Catalog authority:** approve cockpit-local Projects/Workspaces/membership
   for the first release, accepting that different desktop clients may organize
   the same device Sessions differently. If shared organization is mandatory
   now, replace this with the explicit Home Catalog variant and expand scope.
2. **Notes/browser ownership:** approve preserving saved notes as Device-scoped
   Project Presence artifacts initially, while Electron browser/layout/draft/
   comment presentation becomes cockpit-local. No silent cross-Device note
   merge.
3. **Move policy:** approve regroup-as-is (with persistent mismatch when chosen)
   versus additive successor; never mutate or stop the original Runtime as part
   of a move.
4. **Safe Git scope:** approve normal clone/push/fetch/fast-forward and explicit
   GitHub repository creation only. Force/merge/rebase/reset/stash/auto-commit/
   direct transfer remain out of scope.
5. **Isolation/publication defaults:** approve generated Branch by default for
   isolated work (\`soloe/session/...\`), detached only by explicit choice, and
   a visibly preselected—but changeable—Private visibility for GitHub creation.

After these decisions are approved, implementation can begin with Phase 0.
