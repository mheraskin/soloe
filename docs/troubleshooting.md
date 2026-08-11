# Troubleshooting

## The tray or client cannot reach the backend

Start Soloe through `pnpm dev` so the tray can supervise the runtime and application server. When starting components manually, start the runtime before the server and then the client. Check the local Soloe logs in the configured data directory.

## WSL is unavailable

Confirm `wsl.exe --status` succeeds, the selected distribution appears in `wsl.exe --list --quiet`, and the distribution can start from a normal terminal. Install Claude Code or Codex CLI inside that distribution if the session uses the WSL backend.

## An agent command is not found

Soloe uses the `PATH` of the selected Windows, Linux, or WSL environment. A CLI installed on Windows is not automatically available inside WSL, and the reverse is also true.

## A repository path fails

Confirm the path exists in the same host where the session runs and that Git recognizes it as a repository or worktree. For Windows + WSL path behavior, see the [backend guide](./development/windows-backends.md). Include spaces and non-ASCII characters in bug reports when they are relevant to the failure.

## Agent comments are not delivered

Check that the correct Claude Code or Codex integration is installed for the selected host, the MCP status is healthy, and the session is still running. WSL sessions require a Windows-host address reachable from the distribution. See [MCP security](./mcp-security.md) before changing bind or firewall settings.

## Preparing a bug report

Include the Soloe commit or version, operating system, backend mode, WSL distribution if applicable, repository location type, and the shortest reproduction steps. Review diagnostics before attaching them and remove private source, prompts, credentials, usernames, and paths that are not needed for the report.
