# Agent integrations

Soloe currently integrates with installed Claude Code and Codex CLI binaries. It launches them in interactive terminal mode and can add an authenticated local MCP connection so agents can read and resolve Soloe review comments.

## Files changed by setup

| Integration | File | Soloe entry |
| --- | --- | --- |
| Claude Code hooks | `~/.claude/settings.json` | hook commands for Soloe events |
| Claude Code MCP | `~/.claude.json` | Soloe MCP server configuration |
| Codex MCP | `~/.codex/config.toml` | Soloe MCP server configuration |

The paths are resolved in the selected native or WSL host. Existing files are backed up as `<name>.soloe-backup-<timestamp>` before modification, then written atomically with restrictive permissions where supported.

In a multi-Device Cockpit, “selected host” means the Device and native/WSL
environment that owns the Session. Integration state is a per-Device
capability; installing Codex or Claude integration on one Device does not
install it on another and does not make that Device's credentials available to
the Cockpit. A Device without a particular CLI remains usable for ordinary Git
and terminal work, while placement UI disables only the missing capability.

## Install and remove

Use Soloe's integration controls for the host that owns the agent CLI. Uninstall removes Soloe-managed entries; it does not uninstall Claude Code, Codex CLI, or remove their authentication. Keep the timestamped backup until the integration has been exercised successfully.

Creating a successor Session on another Device requires the target Device to
have the selected agent and integration available. Regrouping an existing
Session does not move the process or copy integration configuration. GitHub
publication similarly uses the source Device's local `gh` authentication; no
provider token is copied through the catalog or desktop host.

If an interrupted write or manual edit leaves a configuration unusable, stop Soloe, compare the current file with the newest backup, and restore only after preserving any unrelated changes made since the backup.

## Third-party skills

Feature Lab recognizes repository artifacts shaped by [Matt Pocock's Skills for Real Engineers](https://github.com/mattpocock/skills). Soloe does not currently bundle or automatically install the complete third-party skill set. The integration is independent and is not endorsed by Matt Pocock.
