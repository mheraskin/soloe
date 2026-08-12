# ADR 0002: Use opaque Project identity with repository evidence

Status: accepted

## Context

A logical Project may begin unpublished, gain or rename a remote, move between
providers or owners, be forked, and have independent Checkouts on several
Devices. Paths, names, URLs, default branches, and commit history all change or
can legitimately collide.

## Decision

Logical Projects receive random opaque UUIDs and retain those IDs through
publication, remote rename/transfer, and Device changes. Provider IDs, canonical
remote URLs, aliases, paths, and Git history are typed evidence for explicit
adoption or operator review. They never derive or silently replace Project
identity.

Repository and Checkout IDs are separately Device-owned and become globally
addressable only when paired with the durable Device ID.

## Consequences

- Publishing an unpublished Project updates repository evidence without
  changing its Project ID or Workspace membership.
- Forks and repositories with similar history do not merge automatically.
- Migration can preserve ambiguous legacy records as separate Projects rather
  than guessing.
- Catalog import/export can retain stable logical references even when a Device
  endpoint or repository locator changes.

## Rejected alternatives

- Canonical remote URL fails for unpublished work and changes on rename or
  transfer.
- Provider repository ID excludes non-provider and multi-provider projects.
- Root path is Device-local and mutable.
- Commit-graph or content-derived identity conflates forks and independent
  projects with shared history.
