# Install Soloe

Soloe has not published its first binary alpha yet. This page records the intended release flow and the supported source setup while release artifacts are being validated.

## Requirements

- Windows 11 or a current Linux distribution;
- Git;
- Node.js 22 or newer when running from source;
- at least one authenticated CLI agent, currently Claude Code or Codex CLI;
- WSL and a selected distribution when using the Windows + WSL backend.

Soloe uses the existing CLI installation and authentication in the selected host. Install the agent inside WSL for WSL sessions and on Windows for native Windows sessions.

## Run from source

```bash
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
pnpm dev
```

The tray supervises the selected backend, runtime, server, and clients. See the [process model](./architecture/process-model.md) before starting components individually.

## Planned alpha artifacts

The first validated release is intended to include an unsigned Windows installer and Linux AppImage/DEB artifacts with SHA-256 checksums. Verify the checksum before running a downloaded artifact. Unsigned Windows builds can trigger SmartScreen.

Do not treat a build as supported merely because a packaging command succeeds. The [launch checklist](./public-launch-checklist.md) tracks clean-machine installation, upgrade, uninstall, runtime connectivity, and rollback validation.
