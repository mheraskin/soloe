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

Issues are tracked in this repository's GitHub Issues. See
`docs/agents/issue-tracker.md`.

### Triage labels

The canonical five-role label vocabulary is used. See
`docs/agents/triage-labels.md`.

### Domain docs

This repository currently uses a single root domain context. See
`docs/agents/domain.md`.
