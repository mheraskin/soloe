# Repository instructions

## Commit messages

All commits use Conventional Commits:

`<type>[optional scope][!]: <description>`

Use one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, or `revert`. Keep the header at 100 characters or fewer, use a concise
lowercase description without a trailing period, and split unrelated concerns.

When staging files to commit immediately, stage and commit in one command.

## Code discovery

Prefer codebase-memory-mcp graph tools for code discovery. Use text search for
configuration, documentation, string literals, or when the graph is insufficient.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in this repository's GitHub Issues. Infer the repository from the
current Git remote. Read issues with their comments and labels. Publishing an issue or PRD means
creating a GitHub issue. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical five-role label vocabulary:

- `needs-triage`: maintainer evaluation is required
- `needs-info`: more information is required from the reporter
- `ready-for-agent`: fully specified and ready for an agent
- `ready-for-human`: human implementation is required
- `wontfix`: the issue will not be actioned

See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses the single root `CONTEXT.md` domain glossary. Read it before changing
behavior and use its vocabulary in tests, code, and public writing. See `docs/agents/domain.md`.
