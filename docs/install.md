# Install Soloe

Soloe has not published its first binary alpha yet. This page records the intended release flow and the supported source setup while release artifacts are being validated.

## Requirements

- macOS, Windows 11, or a current Linux distribution;
- Git;
- Node.js 22 or newer when running from source;
- at least one authenticated CLI agent: Claude Code, Codex CLI, or Cursor Agent CLI;
- WSL and a selected distribution when using the Windows + WSL backend;
- Xcode Command Line Tools and Rust when building the native macOS tray from source.

Soloe uses the existing CLI installation and authentication in the selected host. Install the agent inside WSL for WSL sessions and on the native host for macOS, Linux, or Windows sessions.

## Run from source

```bash
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm dev
```

The tray supervises the selected backend, runtime, server, and clients. See the [process model](./architecture/process-model.md) before starting components individually.

## macOS source packages

```bash
pnpm package:macos:x64    # Intel
pnpm package:macos:arm64  # Apple silicon; build on an Apple-silicon runner
```

Each command produces one installable Soloe DMG. The single outer `Soloe.app` contains the lightweight menu-bar host, separate private Runtime and Application Server entries, production web client, on-demand Electron/Svelte client, and matching native `node-pty` payload. Separate native x64 and arm64 runners are required because both `node-pty` and the tray contain native code. See the [macOS guide](./development/macos.md) for signing, notarization, and verification.

## Planned alpha artifacts

The first validated release is intended to include one signed and notarized Soloe DMG for each macOS architecture, an unsigned Windows installer, and Linux AppImage/DEB artifacts with SHA-256 checksums. Verify the checksum before running a downloaded artifact. Unsigned Windows builds can trigger SmartScreen.

Do not treat a build as supported merely because a packaging command succeeds. The [launch checklist](./public-launch-checklist.md) tracks clean-machine installation, upgrade, uninstall, runtime connectivity, and rollback validation.
