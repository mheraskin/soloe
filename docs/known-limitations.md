# Known limitations

Soloe is pre-release software. The first public alpha should not be published until the blocking items in the [launch checklist](./public-launch-checklist.md) are resolved or explicitly accepted.

- Intel macOS has been locally validated; the native Apple-silicon CI package exists, but a clean-machine smoke on physical Apple-silicon hardware remains pending.
- macOS installs as one Soloe application with an embedded on-demand UI; local development DMGs are ad-hoc signed but not notarized and can be rejected by Gatekeeper. Public artifacts require the release workflow's Apple signing credentials.
- Windows and Linux installers have not yet completed the clean-machine validation matrix.
- Early Windows builds will be unsigned and may trigger SmartScreen.
- The legacy Electron MCP path uses a broader bind for WSL reachability; its effective interface and firewall exposure still need validation.
- Electron uses an unsandboxed preload and a browser webview. Context isolation is enabled, but the combined boundary needs continued review.
- Optional Tailscale Serve access is not strictly local-only and must be configured and secured by the user.
- Feature Lab supports a narrow, evolving set of Markdown plan, coverage, issue, and agent-setup artifacts.
- Visual canvas, Markdown-to-canvas conversion, Kanban, Wayfinder, broader Matt Pocock skills compatibility, and AI-assisted large-history summaries are roadmap items, not current features.
- Diagnostics and logs can contain sensitive development context. Review and redact them before sharing.
- Auto-update and signed stable builds are not available.
