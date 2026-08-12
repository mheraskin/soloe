# ADR 0001: Keep logical Workspace organization cockpit-local

Status: accepted

## Context

Logical Projects and Workspaces must exist while every Device is offline and
must not make one ordinary development machine an accidental availability or
replication leader. Device Application Servers already own physical
Repositories, Checkouts, Sessions, and Git evidence, but none is the natural
owner of another Device's logical organization.

## Decision

Soloe stores Projects, Workspaces, Workspace Sources, Workspace Locations,
Session Memberships, ordering, and migration records in one versioned
cockpit-local catalog. Mutations use optimistic catalog revisions and atomic
replacement. Export/import is explicit, checksummed replacement with a backup;
it is not synchronization.

Devices remain authoritative for physical facts. The catalog references them
by durable Device and local entity IDs and treats snapshots as timestamped
observations. A catalog mutation cannot stop a Runtime or create, modify, or
delete a physical Checkout without a separately planned Device command.

## Consequences

- Empty and fully offline Workspaces are first-class.
- One Cockpit has one clear writer and no last-writer-wins merge behavior.
- Two Cockpits may organize the same Device Sessions differently.
- Cross-Device operations are recoverable sagas rather than distributed
  transactions.
- A future shared Home Catalog must be designed as a new explicit authority and
  adapter; it cannot emerge through peer replication between Devices.

## Rejected alternatives

- Git metadata would couple human organization to repository availability and
  cannot represent unpublished or zero-presence Projects reliably.
- Choosing a Home Device would make its uptime a hidden dependency.
- Peer replication or last-writer-wins would create conflicting writers and
  ambiguous deletion/ordering semantics without a conflict model.
