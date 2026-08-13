# Known limitations

Soloe is pre-release software. The first public alpha should not be published until the blocking items in the [launch checklist](./public-launch-checklist.md) are resolved or explicitly accepted.

- Intel macOS has been locally validated; the native Apple-silicon CI package exists, but a clean-machine smoke on physical Apple-silicon hardware remains pending.
- macOS installs as one Soloe application with an embedded on-demand UI; local development DMGs are ad-hoc signed but not notarized and can be rejected by Gatekeeper. Public artifacts require the release workflow's Apple signing credentials.
- Windows and Linux installers have not yet completed the clean-machine validation matrix.
- Early Windows builds will be unsigned and may trigger SmartScreen.
- The legacy Electron MCP path uses a broader bind for WSL reachability; its effective interface and firewall exposure still need validation.
- Electron uses an unsandboxed preload and a browser webview. Context isolation is enabled, but the combined boundary needs continued review.
- Optional Tailscale Serve access is not strictly local-only. Soloe configures its dedicated route after Tailscale sign-in, while tailnet membership and policy remain the user's security boundary.
- Workspace organization is cockpit-local. Two desktop Cockpits can connect to
  the same Devices but do not automatically converge Project/Workspace names,
  ordering, or Session Membership; use checksummed export/import deliberately.
- Multi-Device support coordinates independent Git Checkouts. It does not
  replicate files continuously or transfer uncommitted bytes between Devices.
  Alignment is limited to normal push followed by fetch/fast-forward with exact
  revision checks; divergent history requires external/manual resolution.
- The legacy process-wide Device selector remains readable for one migration
  window and can be re-enabled only with
  `SOLOE_LEGACY_EXCLUSIVE_CONNECTION=1`. It should not be used for normal
  multi-Device workflows.
- GitHub is the only provider adapter. Ordinary Git remains available without
  `gh`, and repository creation is disabled on Devices where `gh` is absent or
  unauthenticated.
- Catalog import is explicit replacement with a local backup, not merge or
  replication. It changes logical metadata only and never removes physical
  Repositories, Checkouts, Sessions, or Runtime processes.
- Feature Lab supports a narrow, evolving set of Markdown plan, coverage, issue, and agent-setup artifacts.
- Visual canvas, Markdown-to-canvas conversion, Kanban, Wayfinder, broader Matt Pocock skills compatibility, and AI-assisted large-history summaries are roadmap items, not current features.
- Diagnostics and logs can contain sensitive development context. Review and redact them before sharing.
- Auto-update and signed stable builds are not available.
