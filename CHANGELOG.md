# Changelog

Soloe has not published a binary release. Changes below are available from the public source
preview on `main`.

## Unreleased

### Added

- Native macOS execution and separate Intel and Apple-silicon packaging.
- Cursor Agent CLI sessions, resume flows, modes, MCP setup, and structured worker support.
- Multi-device project, workspace, worktree, and session inventories over authenticated
  connections.
- Remote checkout preparation, project registration, session placement, and terminal control.
- Spectator terminals and explicit input takeover between clients.
- A Ghostty WebAssembly and Canvas2D terminal renderer.
- Device-aware localhost routing, subdomain proxying, and short browser hostnames through
  Tailscale.
- Adaptive light and dark appearance.
- Native clipboard image paste and mobile terminal touch scrolling.
- Public contribution, security, privacy, installation, troubleshooting, and release
  documentation.

### Changed

- The Environment Runtime owns PTYs and replay history independently from the replaceable
  Application Server and clients.
- Terminal history uses a renderer-neutral VT stream that clients can replay after reconnecting.
- Project and worktree actions route to the device that owns the checkout.
- Soloe uses the MIT license.

### Fixed

- Remote sessions now keep their terminal presentation across device reconnects, client switches,
  and inventory refreshes.
- Remote worktree tools now use the selected session's owning device.
- Remote projects can be edited and removed from the same sidebar as local projects.
- Terminal fixes cover shifted printable keys, ANSI color handling, native image paste, and
  inertial touch scrolling.

### Security

- Authenticated HTTP, RPC, WebSocket, and MCP transports.
- Tailscale identity checks for browser sessions.
- HTTP and HTTPS allowlisting for externally opened URLs.
- Backup and atomic-write handling for agent integration configuration.
