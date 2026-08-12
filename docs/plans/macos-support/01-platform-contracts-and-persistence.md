# Plan 1: Platform Contracts and Persistence

Status: **Implemented and verified**  
Depends on: none

## Outcome

Soloe recognizes macOS as a supported native host and persists macOS projects, settings, sessions, integration hosts, and renderer state without corrupting existing Windows/Linux data.

## Scope

### 1. Central platform model

- Extend `SupportedHostPlatform`, `HostPlatform`, and `RunMode` with `macos`.
- Map `process.platform === 'darwin'` to `macos` in `shared/platform.ts`.
- Return `['macos']` from `supportedRunModes('macos')`, make it the default run mode, and add the `macOS` label.
- Replace inline run-mode and host-kind unions with shared exported types where practical.

### 2. Persistence and compatibility

- Update SettingsStore, ProjectStore, SessionStore, domain authorization, IPC validators, renderer comment/agent persistence, and migrations to accept `macos`.
- Preserve every existing serialized value and default; no rewrite should occur merely because a file is loaded.
- Model backend placement as native versus WSL at the shared boundary, while accepting the existing serialized `windows` value for backward compatibility.
- Add explicit malformed/foreign-platform behavior so a macOS host reports a useful validation error instead of silently selecting Windows semantics.

### 3. UI platform choices

- Add native macOS choices and labels to project creation, new-session flows, command palette, preferences, and agent-integration surfaces.
- Hide Windows-only `cmd` and WSL controls on macOS while retaining `auto`, `bash`, `zsh`, `pwsh`, and custom shells.
- Ensure project search scope and path previews use macOS/POSIX semantics instead of the current “not Linux means Windows” fallback.

## Tests first

- Table-driven platform tests for `win32`, `linux`, `darwin`, and unsupported hosts.
- Round-trip fixtures for old Windows/Linux settings, projects, and sessions plus new macOS fixtures.
- Renderer/store tests proving `macos` survives validation and reload.
- UI tests proving only valid run modes, shells, placements, and integration hosts are offered per platform.

## Acceptance gate

- macOS reaches initial state loading without an unsupported-platform exception.
- A macOS project and session can be created, saved, reloaded, and rendered.
- Existing Windows/WSL/Linux fixtures remain byte-compatible unless explicitly updated by the user.
- The full TypeScript validation suite passes on Linux, Windows, and macOS.
