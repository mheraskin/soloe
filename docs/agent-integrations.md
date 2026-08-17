# Agent integrations

Soloe integrates with installed Claude Code, Codex CLI, and Cursor Agent CLI binaries. It launches them in interactive terminal mode and can add an authenticated local MCP connection so agents can read and resolve Soloe review comments.

## Files changed by setup

| Integration | File | Soloe entry |
| --- | --- | --- |
| Claude Code hooks | `~/.claude/settings.json` | hook commands for Soloe events |
| Claude Code MCP | `~/.claude.json` | Soloe MCP server configuration |
| Codex MCP | `~/.codex/config.toml` | Soloe MCP server configuration |
| Cursor MCP | `~/.cursor/mcp.json` | Soloe MCP server configuration |

The paths are resolved in the selected native or WSL host. Existing files are backed up as `<name>.soloe-backup-<timestamp>` before modification, then written atomically with restrictive permissions where supported.

In the multi-Device Sessions view, “selected host” means the Device and native/WSL
environment that owns the Session. Integration state is a per-Device
capability; installing Codex, Claude, or Cursor integration on one Device does not
install it on another and does not make that Device's credentials available to
the desktop client. A Device without a particular CLI remains usable for ordinary Git
and terminal work, while placement UI disables only the missing capability.

## Install and remove

Use Soloe's integration controls for the host that owns the agent CLI. Uninstall removes Soloe-managed entries; it does not uninstall Claude Code, Codex CLI, Cursor Agent CLI, or remove their authentication. Keep the timestamped backup until the integration has been exercised successfully.

Creating a successor Session on another Device requires the target Device to
have the selected agent and integration available. An existing Session cannot
be moved between Devices and no integration configuration is copied. GitHub
publication similarly uses the source Device's local `gh` authentication; no
provider token is copied through the desktop client.

If an interrupted write or manual edit leaves a configuration unusable, stop Soloe, compare the current file with the newest backup, and restore only after preserving any unrelated changes made since the backup.

## Cursor Agent CLI behavior

Soloe discovers Cursor as `agent` first and the backward-compatible `cursor-agent` alias second. The Integration settings show the detected binary and the result of the documented `--version` probe for each available local or WSL host. A custom binary can be set under Settings → Binaries.

Interactive sessions use Cursor's normal TUI. New chats, latest-chat resume, exact chat-id resume, model selection, and Agent/Plan/Ask modes use Cursor's documented CLI flags. Soloe-managed workers use [`agent acp`](https://cursor.com/docs/cli/acp), Cursor's supported custom-client protocol, so session identity, reasoning, plans, tools, permissions, cancellation, and completion remain structured. Older CLIs that explicitly reject the `acp` command fall back to the documented stream-JSON print interface.

Cursor reads user and project MCP configuration from `~/.cursor/mcp.json` and `.cursor/mcp.json`. Soloe adds only its marked `mcpServers.soloe` remote entry and preserves other servers. `--approve-mcps` is independent from `--force`; quick-launch presets make both choices visible in their arguments.

Known upstream boundaries are surfaced rather than inferred:

- Cursor does not document that a print-stream `session_id` and a resumable chat ID are always identical. Soloe retains the observed ID as the strongest available resume candidate while keeping its own Session identity authoritative.
- Cursor's interactive TUI does not expose its new chat ID to the parent terminal process. Exact reload therefore requires a chat ID captured by ACP/streaming or supplied through “Resume by chat id”; otherwise Soloe uses Cursor's documented latest-chat resume and labels that behavior accordingly. Soloe does not parse Cursor's undocumented on-disk chat storage.
- Cursor's interactive TUI does not document a structured status stream for its parent terminal. Soloe marks a turn working only when input is submitted (draft keystrokes do not change state) and recognizes the approval surfaces emitted by the installed CLI. ACP worker state remains protocol-driven.
- Cursor's print format intentionally suppresses thinking and has no documented MCP-specific event variant. The fallback preserves unknown raw records and reports MCP activity through the generic tool path. ACP is used when richer event semantics are available.
- Cursor states that team-dashboard MCP servers are not supported in ACP mode. User and project `.cursor/mcp.json` servers remain supported.
- Soloe workers can answer ACP permission requests automatically only when the owning Session is in an auto-approval mode. Otherwise the worker reports `waiting_for_approval` and rejects the request because Soloe's worker-control protocol has no interactive permission-response command. Cursor-specific blocking question and plan-approval requests are reported as `waiting_for_input` and rejected for the same reason; interactive Cursor TUI Sessions handle both normally.
- The first-party Cursor CLI is installed on the development host. Structured parser fixtures remain based on the published schemas; interactive approval fixtures additionally use exact strings verified in the installed first-party bundle. See [the research record](./research/cursor-agent-cli.md) for exact sources and evidence.

## Third-party skills

Feature Lab recognizes repository artifacts shaped by [Matt Pocock's Skills for Real Engineers](https://github.com/mattpocock/skills). Soloe does not currently bundle or automatically install the complete third-party skill set. The integration is independent and is not endorsed by Matt Pocock.
