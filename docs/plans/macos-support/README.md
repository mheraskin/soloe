# macOS Support Plan Set

Status: **Implemented; Apple-silicon hardware smoke pending**  
Branch: `feat/macos-support`  
Prepared: 2026-08-11

## Goal

Make Soloe a first-class macOS application across its shared contracts, Electron desktop, runtime/server processes, Tauri tray supervisor, integrations, persistence, packaging, CI, release, and documentation. Support both Intel (`x64`) and Apple silicon (`arm64`) Macs without regressing Windows, WSL, or Linux.

## Audit baseline

- The public repository is cloned and the complete repository is indexed as the codebase-memory project `Users-mhera-Projects-soloe`.
- The persisted graph contains 7,331 nodes, 25,863 edges, and 709 files.
- The current product model admits only `windows`, `wsl`, and `linux`; `darwin` is rejected at startup.
- Several Unix-compatible pieces already exist: macOS application-data paths, Unix sockets, native `node-pty`, shell detection, Command-key shortcuts, and Electron activation/window lifecycle handling.
- The largest blockers are cross-layer platform unions, macOS login-shell discovery, frameless desktop chrome, tray backend placement, and the tray supervisor's `/proc`-based ownership check.
- Packaging and release currently produce only Windows x64 and Linux x64 artifacts.

## Proposed decisions

1. Use `macos` as the product/domain value and translate Node's `darwin` only at the platform boundary.
2. Keep OS behavior behind compact platform interfaces rather than spreading new `process.platform` branches.
3. Treat macOS as native POSIX execution, with an explicit login-shell adapter for GUI-launched processes.
4. Give the tray supervisor a tested Unix process-group ownership implementation; do not emulate Linux `/proc` on macOS.
5. Ship separate native x64 and arm64 artifacts first. Consider a universal artifact only after native `node-pty` and tray binaries pass a dedicated merge test.
6. Make signing and notarization secret-driven. Unsigned local packages remain possible, while public release is gated on Apple credentials.

## Execution sequence

1. [Platform contracts and persistence](./01-platform-contracts-and-persistence.md)
2. [Native runtime, paths, and integrations](./02-runtime-paths-and-integrations.md)
3. [Electron desktop and tray supervision](./03-desktop-and-tray.md)
4. [Packaging, CI, and release](./04-packaging-ci-and-release.md)
5. [Verification and rollout](./05-verification-and-rollout.md)

Each plan has its own acceptance gate. Work must stop at a failed gate rather than carrying an unverified assumption into the next plan.

## Execution record

The plan set was approved and implemented on `feat/macos-support`. Intel Electron and tray packages, the separate packaged Runtime/Application Server, server-backed Electron and web clients, and native `node-pty` were verified locally. Native x64 and arm64 CI/release jobs are defined; Apple signing credentials and a physical Apple-silicon clean-machine smoke remain external release gates.

## Primary references

- [Electron macOS window options](https://www.electronjs.org/docs/latest/api/base-window)
- [Electron application menus](https://www.electronjs.org/docs/latest/tutorial/application-menu)
- [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [electron-builder macOS and architecture support](https://www.electron.build/mac/)
- [GitHub-hosted runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Tauri system tray guide](https://v2.tauri.app/learn/system-tray/)
