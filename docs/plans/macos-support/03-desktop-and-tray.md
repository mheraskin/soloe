# Plan 3: Electron Desktop and Tray Supervision

Status: **Implemented and verified on Intel macOS**  
Depends on: Plans 1–2

## Outcome

The Electron application feels native on macOS, and the Tauri menu-bar supervisor reliably starts, detects, restarts, and terminates Soloe-owned runtime/server/desktop processes.

## Scope

### 1. Electron window and application lifecycle

- Use a macOS-specific hidden/inset title bar with native traffic lights; retain the current custom window buttons on Windows/Linux only.
- Adjust drag regions and left-side spacing so traffic lights never overlap Soloe navigation.
- Build a native macOS application menu with standard app, edit, view, window, and help roles; continue suppressing the menu bar on Windows/Linux.
- Preserve single-instance, Dock activation, close-window, quit, external-link, zoom, devtools, and notification-focus behavior with macOS accelerators.
- Add the macOS app icon and Dock behavior without changing existing Windows/Linux assets.

### 2. Tray placement model

- Replace the tray's Windows-default backend model with explicit native and WSL placements, while deserializing existing `windows` settings safely.
- Make labels, preflight checks, commands, paths, and error messages platform-neutral or macOS-specific as appropriate.
- Add a macOS menu-bar icon suitable for template rendering and verify tray menu actions.

### 3. Process ownership and shutdown

- Replace the non-Windows `/proc/<pid>/environ` assumption with a platform adapter.
- Implement macOS ownership using isolated Unix process groups plus persisted service identity; signal only verified Soloe-owned groups.
- Preserve Windows Job Objects and Linux behavior behind the same ownership interface.
- Cover crash recovery, stale service records, orphan cleanup, repeated start/stop, partial startup, and supervisor exit without broad PID killing.

## Tests first

- Electron option/menu templates as pure functions with platform matrices.
- Renderer tests for traffic-light clearance and conditional custom controls.
- Rust unit tests for placement migration, host labels, service records, ownership decisions, and termination ordering.
- macOS integration tests that spawn a harmless process tree and prove stop/restart removes the tree but not an unrelated process.

## Acceptance gate

- The desktop opens, closes, reopens from Dock, quits, and handles shortcuts like a normal macOS app.
- No duplicate Windows-style controls appear beside macOS traffic lights.
- Tray start, stop, restart, open, health display, and quit work repeatedly with no surviving Soloe process tree.
- Ownership tests demonstrate that stale or forged records cannot terminate unrelated processes.
