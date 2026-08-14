# Privacy

Soloe has no Soloe-hosted cloud, analytics, advertising, or telemetry. Its application state is stored on infrastructure controlled by the user.

That does not mean all activity is offline. Claude Code, Codex CLI, Git remotes, links opened in a browser, and any other tools launched from a terminal communicate under their own configuration and provider terms. Optional Tailscale Serve access also moves the browser client beyond strict loopback-only use.

## Stored data

Depending on the features used, Soloe may store project and worktree references, terminal session metadata, settings, browser-session metadata, notes, worktree overviews, summaries, comment state, logs, crash information, MCP connection details, and encrypted vault entries.

The default data directory is:

| Platform | Location |
| --- | --- |
| Windows | `%LOCALAPPDATA%\\Soloe` |
| Linux | `$XDG_STATE_HOME/soloe` or `~/.local/state/soloe` |
| macOS | `~/Library/Application Support/Soloe` |

Set `SOLOE_DATA_DIR` to use another location. Common entries include `sessions.json`, `settings.json`, `projects.json`, `browser-sessions.json`, `device-identity.json`, `device-workspaces.json`, `notes/`, `vault/`, logs, and `crashes/`.

Vault values use AES-256-GCM in the current cross-platform implementation. A local `.vault-key` is stored alongside the vault with restrictive filesystem permissions where the platform supports them. Encryption at rest does not protect data from other software already running as the same user.

## Agent integration files

When integrations are installed, Soloe can update:

- `~/.claude/settings.json` for Claude Code hooks;
- `~/.claude.json` for the Claude Code MCP entry;
- `~/.codex/config.toml` for Codex MCP configuration.

Soloe creates timestamped backups before changing existing integration files. See [Agent integrations](./docs/agent-integrations.md) before installing or removing them.

## Removing local data

1. Stop the Soloe tray, runtime, server, Electron client, and any Soloe-owned agent sessions.
2. Uninstall agent integrations from Soloe or restore the documented backup files.
3. Back up anything you want to retain.
4. Delete the resolved Soloe data directory shown above or configured by `SOLOE_DATA_DIR`.

Removing Soloe data does not remove repositories, provider-side histories, Git remotes, CLI authentication, or data stored by Claude Code, Codex CLI, Tailscale, or other external tools.
