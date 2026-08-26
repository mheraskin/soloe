# Contributing to Soloe

Soloe is a public source preview with no binary release yet. Focused bug reports, platform
reproductions, documentation, tests, and small UI improvements are the most useful early
contributions.

Open an issue before starting a large feature, dependency migration, or architectural change. Security-sensitive changes to the MCP bridge, remote access, hooks, terminal execution, or vault need maintainer discussion first.

## Development setup

Requirements:

- Node.js 22 or newer;
- Corepack and PNPM 10.34.5 (pinned in `package.json`);
- Git;
- a stable Rust toolchain for the runtime and tray packages;
- platform dependencies required by Tauri when building the Linux tray.

Install dependencies from the repository root:

```bash
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
```

Start the tray-managed development environment with `pnpm dev`. The individual processes are
available through `pnpm dev:runtime`, `pnpm dev:server`, `pnpm dev:web`,
`pnpm dev:desktop`, and `pnpm dev:tray`. Start the Runtime before the Server when running them
manually.

## Checks

Run the checks relevant to your change before opening a pull request:

```bash
pnpm typecheck
pnpm --filter @soloe/protocol --filter @soloe/domain --filter @soloe/runtime --filter @soloe/server typecheck
pnpm test
pnpm --filter @soloe/web build
pnpm --filter @soloe/desktop-electron build
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Platform packaging and browser integration checks may need additional native dependencies:

```bash
pnpm test:browser-integration
pnpm package:windows
pnpm package:linux
```

## Pull requests

- Keep changes focused and explain the user-visible outcome.
- Add or update tests for behavior changes.
- Update documentation when setup, security boundaries, stored data, or supported behavior changes.
- Do not include real repositories, transcripts, credentials, user paths, or private source code in fixtures or screenshots.
- Use Conventional Commits: `type(scope): lowercase description` with a header no longer than 100 characters.

Maintainer availability is currently best-effort. A lack of immediate response does not mean a proposal has been rejected.

By contributing, you agree that your contribution is licensed under the repository's [MIT License](./LICENSE).
