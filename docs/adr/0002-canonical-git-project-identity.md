# ADR 0002: Match Projects by canonical Git remote

Status: accepted

## Context

Each Device persists its own Project records and therefore uses Device-local
Project IDs. The desktop needs to recognize the same repository on several
Devices without asking the user to link them or introducing another global
Project database.

## Decision

For multi-Device presentation, Soloe reads the configured `origin` URL locally
on each Device and uses its redacted, normalized Git remote as the Project key.
Device-local Project IDs remain unchanged and are used only when addressing the
owning Device.

A Project without a usable Git remote remains a separate Device-local Project.
Soloe does not guess identity from folder names, paths, or commit similarity.
Adding or changing the remote naturally changes the next derived projection;
it does not rewrite Device-local Session records.

## Consequences

- Clones of the same remote merge automatically in navigation.
- Paths and Project IDs may differ on every Device.
- Unpublished repositories do not merge across Devices automatically.
- Forks with distinct remotes remain distinct even when they share history.
- Remote identity is read with local Git configuration only; discovery does
  not contact the Git host.

## Rejected alternatives

- A client-generated UUID requires explicit linking and a second authority.
- Folder name or path identity collides and is Device-specific.
- Commit-graph identity conflates forks and requires expensive observation.
