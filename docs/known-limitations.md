# Known limitations

Soloe is pre-release software. The first public alpha should not be published until the blocking items in the [launch checklist](./public-launch-checklist.md) are resolved or explicitly accepted.

- macOS is not yet a supported public release target. The experimental Tauri
  client now has a pinned full Ghostty AppKit/Metal surface, but it still needs
  native macOS runtime, IME, packaging, signing, and clean-machine validation.
- The Tauri desktop client is experimental. It uses the existing Node
  Application Server and Environment Runtime, requires the Web Host to be
  running for a functional client, and has not completed the platform test
  matrix.
- Tauri's embedded browser surface currently opens external platform DevTools.
  Docked DevTools, per-tab native residency parity, element-source inspection,
  credential autofill, and complete mobile device emulation remain Electron-only.
- Standard Linux Tauri dev/build commands enable a GTK3 vertical slice using
  the exact pinned official `libghostty-vt` source. Fresh settings select it
  through `auto` after complete native-host initialization. It is not at xterm
  parity: styled GPU rendering, selection, visual search, links, IME, and
  robust Wayland positioning remain incomplete. It needs Zig 0.16 to build.
  Direct Cargo builds without the feature, unsupported platforms, and failed
  native initialization fall back to xterm without stopping the Session PTY.
- Standard macOS Tauri commands download a checksum-pinned GhosttyKit artifact
  from the MIT `manaflow-ai/ghostty` fork and enable the manual-I/O AppKit
  surface. This keeps the Environment Runtime as exclusive PTY owner. The
  initial slice supports rendering, output/replay replacement, keyboard and
  mouse input, resize, focus, visibility, selection, links, paste, export, and
  disposal. IME/preedit, visual search highlighting, complete configuration
  mapping, app-shortcut arbitration, and native test coverage remain incomplete.
- Windows and Linux installers have not yet completed the clean-machine validation matrix.
- Early Windows builds will be unsigned and may trigger SmartScreen.
- The legacy Electron MCP path uses a broader bind for WSL reachability; its effective interface and firewall exposure still need validation.
- Electron uses an unsandboxed preload and a browser webview. Context isolation is enabled, but the combined boundary needs continued review.
- Optional Tailscale Serve access is not strictly local-only and must be configured and secured by the user.
- Feature Lab supports a narrow, evolving set of Markdown plan, coverage, issue, and agent-setup artifacts.
- Visual canvas, Markdown-to-canvas conversion, Kanban, Wayfinder, broader Matt Pocock skills compatibility, and AI-assisted large-history summaries are roadmap items, not current features.
- Diagnostics and logs can contain sensitive development context. Review and redact them before sharing.
- Auto-update and signed stable builds are not available.
