# Plan 2: Native Runtime, Paths, and Integrations

Status: **Implemented and verified**  
Depends on: Plan 1

## Outcome

Terminal sessions, background agents, Git/files, hooks, and runtime/server communication behave natively on macOS, including when Soloe is launched from Finder and does not inherit an interactive terminal's `PATH`.

## Scope

### 1. Native POSIX command seam

- Extract a small native-POSIX login-shell adapter shared by SessionCommandBuilder and BackgroundAgentExecution.
- Resolve the user's configured shell from `SHELL`, with a macOS-safe fallback, and invoke login semantics so Homebrew and user-installed `claude`, `codex`, `git`, `gh`, `fd`, and `rg` are discoverable.
- Retain direct Windows and WSL builders unchanged behind the same interface.
- Clarify the misleading `WindowsCommandBuilder.ts` naming while preserving a compatibility export if needed.

### 2. Paths, projects, and process inspection

- Remove ProjectStore assumptions where “not Linux” currently means Windows.
- Use native POSIX normalization for macOS worktrees, repository search, file indexing, editor launch, and Git operations.
- Verify existing `~/Library/Application Support/Soloe` paths and Unix runtime socket permissions across runtime, server, and desktop.
- Validate BSD `ps` parsing for CPU/memory sampling and system diagnostics; isolate platform-specific command construction if output differs from Linux.

### 3. Agent integrations

- Add a `macos` host kind to HookInstaller and integration IPC/UI.
- Reuse Unix Claude/Codex config layouts only where verified; explicitly test install, status, refresh, uninstall, and preservation of unrelated user configuration.
- Validate Codex shell-snapshot watching and Claude/Codex resume metadata on macOS filesystem events.
- Keep WSL detection dormant on non-Windows hosts.

### 4. Native behaviors

- Verify safe external-open behavior uses `open` and that notification clicks reactivate/focus the app.
- Treat signed-build notification behavior as a packaging acceptance item because modern Electron/macOS requires signing for reliable native notification events.

## Tests first

- Command/escaping matrices containing spaces, quotes, Unicode, Homebrew paths, environment variables, and custom shells.
- Finder-like environment tests with a minimal inherited `PATH`.
- Temporary-home integration fixtures for Claude and Codex config mutation and rollback.
- macOS fixtures for project path parsing, Git/file commands, shell snapshots, and BSD `ps` output.

## Acceptance gate

- Native terminal, Claude, and Codex sessions launch from both Terminal and Finder-style environments.
- Git, worktree, file search, background summaries, and integration install/status flows work with paths containing spaces.
- Runtime/server/desktop reconnect over the macOS Unix socket after a supervised restart.
- Windows, WSL, and Linux command-builder tests remain green.
