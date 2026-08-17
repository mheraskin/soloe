# ADR 0001: Derive Workspace navigation from Device inventories

Status: accepted

## Context

Soloe can connect to several machines at once. Each machine already persists
its Projects and Sessions, owns its Git checkouts, and runs its own terminals.
A second client-owned Project/Workspace/Session catalog would duplicate those
facts, introduce conflicting membership, and require import/export for state
that the Devices already own.

## Decision

Each Soloe Device publishes a bounded inventory of its Projects, Git
Worktrees, Sessions, and Runtime state. The Application Server Sessions module combines
those inventories into the normal Project → Workspace → Session navigation:

- a Project is identified across Devices by its canonical Git remote;
- a Workspace is identified by Project plus Branch or pinned Revision;
- each physical checkout is a Workspace Location on one Device;
- each Session remains owned and executed by exactly one Device.

Project and Session identity, metadata, and ordering remain in the existing
Device-local stores. The Application Server may cache last-known inventory for disabled
offline presentation, but that cache is evidence, not an authority. There is
no separate logical catalog, Session membership table, active Device switch,
default-placement preference, or catalog import/export.

Creating a Session always names its target Device. If that Device lacks the
Workspace Location, Soloe presents an exact clone or Worktree preparation plan
for confirmation before creating and starting the Session there.

## Consequences

- Connecting a compatible Device automatically adds its inventory to the same
  navigation; disconnecting it disables its Sessions without moving them.
- The same Project and Branch on several Devices appears once with several
  Location chips.
- A Session can be opened only while its owning Device is reachable.
- Closing a desktop or web client releases its presentations but does not stop
  the Application Server's Device transports or Device-owned Runtime processes.
- Empty logical Workspaces that have no Device Location are not represented.
  If that becomes a product requirement, it needs an explicit shared authority
  rather than an implicit client-local duplicate.

## Rejected alternatives

- A client-local logical catalog duplicates Device state and creates two places
  to organize the same Session.
- Selecting one active Device hides the multi-Device model and makes ordinary
  navigation depend on a global switch.
- Peer replication makes every Device a competing writer without adding user
  value to the initial multi-Device workflow.
