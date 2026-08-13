# Multi-Device Workspaces

Status: implemented in the desktop application

## Product model

Soloe presents one Project → Workspace → Session navigation assembled from all
reachable Soloe Devices.

| Concept | Meaning |
| --- | --- |
| Device | One machine running a Soloe Application Server and Environment Runtime. |
| Project | One Git repository, matched across Devices by canonical remote identity. |
| Workspace | One logical workstream in a Project, normally a Branch or pinned Revision. |
| Workspace Location | One physical checkout or Worktree for a Workspace on one Device. |
| Session | One interactive work record owned and executed by exactly one Device. |

A Device does not own a logical Workspace. It owns a physical Location for that
Workspace and any Sessions running from that Location. The same Workspace can
therefore have Locations on a Mac, a Windows machine, and another machine at
the same time.

## User experience

- The title bar shows this Device's name next to a Device icon.
- The Device menu is status only. It lists this Device and automatically
  discovered remote Devices with a green, gray, or warning indicator and a
  short state label. It does not filter navigation or switch a global backend.
- The sidebar shows all Project, Workspace, and Session inventory together.
- Each Workspace Location and Session carries a chip containing its Device
  name. A reachable Device has a green dot. An unavailable Device is labeled
  Offline; its Sessions are visibly disabled and cannot be opened.
- A Device that cannot provide the current multi-Device Sessions contract is
  labeled Update Soloe. Protocol and capability details remain diagnostics and
  are not shown in the ordinary UI.
- New Session asks for a Workspace and the Device where the Session should run.
  Reachable Devices are choices; unavailable Devices are disabled.
- If the selected Device already has the Workspace Location, Soloe reviews and
  creates the Session there.
- If it lacks the Location, Soloe first reviews the exact clone or Worktree
  path, warnings, and blockers. Only explicit confirmation performs that
  preparation and then starts the Session.

There is no “All Devices” mode, Device view filter, active Device switch,
default placement, per-Device enable toggle, endpoint entry form, or separate
catalog import/export.

## Discovery and connectivity

The application works normally without Tailscale. In that state only the local
Device inventory is available.

When Tailscale is installed and signed in:

1. The Soloe Application Server ensures its Tailscale Serve mapping on startup.
2. The desktop reads the local tailnet peer list.
3. It probes the fixed Soloe HTTPS endpoint for online peers.
4. It authenticates the Tailscale identity, negotiates the Device descriptor,
   and pins the durable Device ID.
5. Compatible Devices are connected automatically. No URL entry, bearer-token
   storage, restart, or separate `tailscale serve` command is required.

If Serve needs user approval, Connection settings presents the Tailscale
approval URL. After approval, Refresh is sufficient; Soloe does not need to
restart.

## Authority and persistence

Each Device remains authoritative for:

- its Project records and ordering;
- its repository Checkouts and Worktrees;
- its Session records and ordering;
- its Runtime processes, terminal replay, and input leases;
- its typed Git and Workspace preparation commands.

The desktop Sessions service owns only aggregation, routing, and last-known
presentation evidence. It derives Project and Workspace grouping from Device
inventories and stores no parallel logical Project/Workspace/Session
membership model.

The connection registry stores discovered endpoints, durable Device identity
pins, compatibility, and last-known availability. It never stores Tailscale or
Soloe bearer tokens.

## Runtime and resource behavior

- Starting a Session on another Device creates and starts it on that Device.
  The Session and PTY never live in the initiating desktop process.
- Opening a remote Session requests bounded replay, then subscribes only to
  that terminal's demanded output.
- Hiding or closing its terminal presentation releases output demand without
  stopping the Runtime process.
- Concurrent inventory refresh requests are coalesced. Inventories refresh on
  connection, explicit Refresh, Device lifecycle events, and local
  Project/Session/Worktree changes rather than by an additional UI poller.
- Closing the Electron client closes its Device transports. Remote agents keep
  running under their owning Environment Runtime.

## Interfaces

Renderer multi-Device behavior is part of the existing `sessions` API:

- read and refresh the combined Device Sessions state;
- plan, confirm, and create a Session on a named Device;
- route terminal replay, demand, input, resize, stop, and input takeover by
  composite Device/Terminal reference;
- subscribe to combined state and Device events.

The host-private Device adapter uses typed Application Server RPCs for
Projects, Git Worktrees and remote identity, Sessions, terminal control, and
Workspace preparation. The renderer cannot forward arbitrary RPC calls.

## Failure behavior

- An unreachable Device preserves its last-known hierarchy for the current
  client lifetime and disables its Locations and Sessions.
- A Device identity mismatch is rejected at the transport boundary.
- A protocol or Sessions inventory mismatch appears as Update Soloe and is not
  partially connected.
- A preparation plan is bound to the target Device, expected revisions,
  capability revision, exact intent, and expiry. The returned receipt must
  match the command before its Checkout can be adopted.
- A failed preparation does not silently create a Session elsewhere.

## Test strategy

The implementation is developed through red-green slices covering:

- automatic discovery, identity pinning, and update classification;
- merging the same Git Project and Branch across Devices;
- last-known offline projection and disabled Sessions;
- Device-owned Session creation and terminal routing;
- clone/Worktree plan review and trusted execution receipts;
- synchronous IPC handler registration and event broadcasts;
- local and remote Device adapters, canonical remote identity, and malformed
  RPC rejection;
- coalesced inventory refresh and local inventory change propagation;
- Svelte type checking and semantic status-color availability.

## Acceptance criteria

- A compatible second Device appears automatically after both machines join
  the same tailnet and run current Soloe.
- The same repository and Branch on two Devices appears as one Workspace with
  two Device Location chips.
- A remote Session opens through its owning Device and remains running after
  this client closes.
- Taking that Device offline disables its Sessions and labels the Device
  Offline without moving or deleting anything.
- An old Device is labeled Update Soloe without exposing protocol or capability
  internals.
- Creating on a Device without the Project requires review of the exact clone
  or Worktree action before any filesystem mutation.
- Local-only Soloe continues to work when Tailscale is absent or signed out.
