# Cursor Agent CLI integration research

Research date: 2026-08-16

This note records the supported integration contract for Cursor's terminal agent. It uses only
first-party Cursor documentation, Cursor's published changelog, and the current first-party
installer. No Cursor CLI executable is installed in this worktree's host environment, so claims
that depend on live `--help`, authenticated model listings, or captured agent runs are called out
as unverified rather than inferred.

## Source and environment status

The current product documentation names `agent` as the primary command. Cursor's January 2026
changelog says `cursor-agent` remains a backward-compatible alias. The current installer creates
both `~/.local/bin/agent` and `~/.local/bin/cursor-agent` symlinks to the same executable under
`~/.local/share/cursor-agent/versions/<release>/cursor-agent`. On 2026-08-16, the published
installer referenced release `2026.08.11-e8db854`.
([installation docs](https://cursor.com/docs/cli/installation),
[January 8 changelog](https://cursor.com/changelog/cli-jan-08-2026),
[current installer](https://cursor.com/install))

Read-only checks on this host found none of `agent`, `cursor-agent`, `cursor`, or
`cursor-agent-cli` on `PATH`, no `/Applications/Cursor.app`, no CLI symlink in
`/usr/local/bin`, `/opt/homebrew/bin`, or `~/.local/bin`, and no Cursor Agent executable below
`~/.local/share/cursor-agent` or `~/.cursor`. Consequently, the installed version string, live
help output, account model list, real event variants, signal exit status, and resumed-session ID
behavior could not be observed locally.

## Discovery, version, installation, and authentication

For discovery, look for `agent` first and `cursor-agent` second. Cursor documents
`agent --version` as the verification/version command and `agent update` as the manual updater.
The supported Unix installer is `curl https://cursor.com/install -fsS | bash`; native Windows
uses `irm 'https://cursor.com/install?win32=true' | iex`. Both the docs and installer place the
Unix shims in `~/.local/bin`.
([installation docs](https://cursor.com/docs/cli/installation),
[current installer](https://cursor.com/install))

Authentication is either browser login (`agent login`, `agent status`, `agent logout`) or a user
API key via `CURSOR_API_KEY` or `--api-key <key>`. `NO_OPEN_BROWSER=1 agent login` prints the
login URL instead of opening a browser, which is the documented option for a terminal without a
usable browser.
([authentication docs](https://cursor.com/docs/cli/reference/authentication))

## Exact launch and resume surface

The global parameters relevant to an embedding are:

| Capability | Exact CLI surface |
| --- | --- |
| Non-interactive execution | `-p`, `--print` |
| Output encoding | `--output-format text\|json\|stream-json` (default `text`) |
| Incremental text | `--stream-partial-output`, valid with print + stream JSON |
| Resume by chat ID | `--resume [chatId]` |
| Resume latest | `--continue` (alias for `--resume=-1`) |
| Model selection | `--model <model>` |
| Mode selection | `--mode plan\|ask`; no value means Agent mode |
| Plan shorthand | `--plan` |
| Model discovery | `--list-models` or `agent models` |
| Unattended approval | `-f`, `--force`; `--yolo` is an alias |
| Command sandbox | `--sandbox enabled\|disabled` |
| MCP server approval | `--approve-mcps` |
| Headless workspace trust | `--trust` |
| Workspace root | `--workspace <path>` |
| Isolated worktree | `-w`, `--worktree [name]`, plus `--worktree-base <ref>` |

Cursor also documents `-H, --header <header>` as repeatable, `--plugin-dir <path>` as
repeatable, and `--skip-worktree-setup`. The full command table includes `agent ls`,
`agent resume`, and `agent create-chat`; the last creates an empty chat and returns its ID.
([parameter reference](https://cursor.com/docs/cli/reference/parameters))

The official CLI changelog is ahead of the parameter table in at least two places: it documents
`--auto-review` (June 22) and repeatable `--add-dir <path>` (June 29), while the current parameter
reference omits both. These are real first-party release claims, but an embedding should gate them
by installed version/help rather than assume every supported Cursor CLI has them.
([CLI changelog](https://cursor.com/docs/cli/changelog),
[parameter reference](https://cursor.com/docs/cli/reference/parameters))

A new Soloe-managed streaming run should therefore explicitly request the non-default structured
format:

```text
agent -p --output-format stream-json --stream-partial-output [provider options] <prompt>
```

Writing in a fully unattended print run requires `--force`/`--yolo`; without it, the current
headless guide says modifications are proposed rather than applied. `--trust` is separately
documented as headless workspace trust, and `--approve-mcps` separately approves configured MCP
servers. These controls should not be conflated in Soloe's UI or persistence.
([headless guide](https://cursor.com/docs/cli/headless),
[parameter reference](https://cursor.com/docs/cli/reference/parameters))

For an existing Cursor conversation, use the same print/format flags with
`--resume=<chatId>` and the new prompt. `agent resume` resumes the latest conversation
interactively; `--continue`/`--resume=-1` is the scriptable latest-session form. `agent ls` opens
the conversation picker. Cursor says `--resume [thread id]` loads prior context. The docs call
the output `session_id` a unique UUID-like identifier and promise only that it remains consistent
through one agent execution; they do **not** specify whether a resumed process reuses the same
`session_id`, nor whether the `chatId` and streamed `session_id` are always identical.
([CLI overview](https://cursor.com/docs/cli/overview),
[CLI capabilities](https://cursor.com/docs/cli/using),
[output format](https://cursor.com/docs/cli/reference/output-format))

The current CLI changelog says the conversation picker and resume commands can show chats across
workspaces and that resuming from another directory loads the full conversation. That is product
behavior, not a documented storage/protocol API; Soloe should keep the authoritative device and
workspace with its own session metadata and launch resume on that device.
([CLI changelog](https://cursor.com/docs/cli/changelog))

## Models and modes

Agent mode is the default and has full tool access. Plan is available through `--plan` or
`--mode=plan`; Ask is available through `--mode=ask` and is documented as read-only exploration.
Debug exists as an interactive `/debug` command, but the parameter reference does not advertise
`debug` as a valid `--mode` value. Do not send undocumented launch values.
([CLI overview](https://cursor.com/docs/cli/overview),
[CLI capabilities](https://cursor.com/docs/cli/using),
[slash commands](https://cursor.com/docs/cli/reference/slash-commands),
[parameter reference](https://cursor.com/docs/cli/reference/parameters))

The model list is account- and release-dependent. Discover it using `agent models` or
`--list-models`, and pass the returned identifier through `--model <model>`. Examples such as
`gpt-5` and `sonnet-4-thinking` exist in the docs, but they are examples, not a stable enum or a
promise of availability to every account. Soloe should not hardcode a supposedly complete model
list.
([parameter reference](https://cursor.com/docs/cli/reference/parameters),
[configuration reference](https://cursor.com/docs/cli/reference/configuration))

## JSON and stream-JSON contract

`--output-format json` emits one success object only after completion. It emits no deltas or tool
events. On failure, the process exits nonzero, writes an error to stderr, and emits no guaranteed
well-formed JSON result.
([output format](https://cursor.com/docs/cli/reference/output-format))

`--output-format stream-json` is newline-delimited JSON, one object per line. Without
`--stream-partial-output`, assistant text is aggregated into one event per message segment between
tool calls. With partial output enabled, character-level text is emitted as several assistant
events. A successful stream ends in `result`; a failed stream may stop early with only stderr and
a nonzero exit.
([output format](https://cursor.com/docs/cli/reference/output-format))

### Documented event types

The following are the **only** event types for which the current Cursor output reference publishes
a stream-JSON schema:

#### `system` / `init`

```json
{
  "type": "system",
  "subtype": "init",
  "apiKeySource": "env|flag|login",
  "cwd": "/absolute/path",
  "session_id": "<uuid>",
  "model": "<model display name>",
  "permissionMode": "default"
}
```

Cursor says future fields such as `tools` and `mcp_servers` may be added. Treat unknown fields as
forward-compatible additions.

#### `user`

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [{ "type": "text", "text": "<prompt>" }]
  },
  "session_id": "<uuid>"
}
```

#### `assistant`

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "<assistant text>" }]
  },
  "session_id": "<uuid>"
}
```

When `--stream-partial-output` is active, assistant records have three documented shapes:

| `timestamp_ms` | `model_call_id` | Meaning | Consumer action |
| --- | --- | --- | --- |
| present | absent | new text delta | append all text content |
| present | present | buffered pre-tool flush; duplicate | skip text |
| absent | absent | end-of-turn final flush; duplicate | skip text |

The terminal `result.result` is the canonical complete assistant response if real-time rendering
is not needed.

#### `tool_call` / `started`

```json
{
  "type": "tool_call",
  "subtype": "started",
  "call_id": "<string id>",
  "tool_call": {
    "readToolCall": { "args": { "path": "file.txt" } }
  },
  "session_id": "<uuid>"
}
```

#### `tool_call` / `completed`

```json
{
  "type": "tool_call",
  "subtype": "completed",
  "call_id": "<string id>",
  "tool_call": {
    "readToolCall": {
      "args": { "path": "file.txt" },
      "result": {
        "success": {
          "content": "file contents...",
          "isEmpty": false,
          "exceededLimit": false,
          "totalLines": 54,
          "totalChars": 1254
        }
      }
    }
  },
  "session_id": "<uuid>"
}
```

The documented native variants are `readToolCall` and `writeToolCall`. A write start contains
`path`, `fileText`, and `toolCallId`; its success contains absolute `path`, `linesCreated`, and
`fileSize`. Other tools **may** use `tool_call.function` with `name` and `arguments`. The docs do
not enumerate command execution, file edit/delete, web, task/subagent, image, or MCP-specific
variant names. Correlate starts and completions with `call_id`, retain the entire raw payload, and
normalize a recognized native variant or generic function without assuming a closed enum.

#### `result` / `success`

```json
{
  "type": "result",
  "subtype": "success",
  "duration_ms": 1234,
  "duration_api_ms": 1234,
  "is_error": false,
  "result": "<full assistant text>",
  "session_id": "<uuid>",
  "request_id": "<optional request id>"
}
```

Cursor currently describes `duration_api_ms` as equal to `duration_ms`. `request_id` is optional.
The CLI changelog says token totals were added to stream JSON in February 2026, but the current
schema reference does not name or type those fields. Consume token fields opportunistically if
observed, but do not make them required.
([output format](https://cursor.com/docs/cli/reference/output-format),
[CLI changelog](https://cursor.com/docs/cli/changelog))

### Explicit stream limitations

The current output reference explicitly says `thinking` events are suppressed in print mode and
do not appear in any output format. Therefore Cursor headless mode cannot truthfully provide
reasoning-event parity through the documented stream contract. Interactive Cursor can display
thinking blocks, and ACP advertises richer client updates, but neither fact establishes a
stream-JSON reasoning schema.
([output format](https://cursor.com/docs/cli/reference/output-format),
[configuration reference](https://cursor.com/docs/cli/reference/configuration),
[ACP docs](https://cursor.com/docs/cli/acp))

Cursor does not publish stream-JSON schemas for any of the following:

- a distinct lifecycle-start/end record beyond `system/init` and successful `result`;
- a reasoning/thinking record;
- command output or background-command progress;
- file edit, patch, delete, or diff records beyond the write-file example;
- MCP calls/results as a distinct category;
- tool failure results;
- retry/reconnection notices;
- an error terminal result;
- interruption or cancellation.

For errors, the only supported contract is nonzero process exit plus stderr, possibly after a
partial stream with no `result`. For a Soloe-initiated interruption, Soloe should record its own
interrupted state based on the control action and process termination rather than claim it parsed
a Cursor event. Unknown valid JSON records must be retained/ignored safely, as Cursor explicitly
allows backward-compatible field additions, but their semantics should not be guessed.
([output format](https://cursor.com/docs/cli/reference/output-format))

This is also an authoritative-docs inconsistency worth preserving: the current changelog mentions
headless background-work events, stable session IDs in hooks, richer thinking over ACP, and token
usage in stream JSON, while the current output-format reference neither defines those event
schemas nor exposes thinking in print mode. Installed authenticated fixtures are required before
mapping any such additions beyond the generic/unknown fallback.
([CLI changelog](https://cursor.com/docs/cli/changelog),
[output format](https://cursor.com/docs/cli/reference/output-format))

## MCP behavior

The CLI automatically detects Cursor MCP configuration and uses the same configured servers and
tools as the editor. Configuration locations are project `.cursor/mcp.json` and global
`~/.cursor/mcp.json`. Cursor documents stdio (`command`, optional `args`, `env`, `envFile`) and
remote (`url`, `headers`, optional static OAuth `auth`) configurations, with stdio, SSE, and
Streamable HTTP transports. MCP capabilities include tools, prompts, resources, roots,
elicitation, and the MCP Apps extension.
([CLI capabilities](https://cursor.com/docs/cli/using),
[MCP docs](https://cursor.com/docs/mcp))

The supported management commands are:

```text
agent mcp login <identifier>
agent mcp list
agent mcp list-tools <identifier>
agent mcp enable <identifier>
agent mcp disable <identifier>
```

`--approve-mcps` automatically approves all configured MCP servers. MCP tools normally ask for
approval; CLI permissions can allow them with `Mcp(server:tool)` patterns. Cursor's output-format
reference does not define an MCP-specific stream event, so such calls must be normalized through
the generic tool-call path unless a future first-party schema or captured installed fixture proves
a stable discriminator.
([parameter reference](https://cursor.com/docs/cli/reference/parameters),
[permissions reference](https://cursor.com/docs/cli/reference/permissions),
[MCP docs](https://cursor.com/docs/mcp))

## ACP as a separate, richer protocol

Cursor also exposes `agent acp`, a newline-delimited JSON-RPC 2.0 ACP server over stdio, and
describes it specifically as the surface for custom client integrations. The documented flow is:

1. `initialize`;
2. `authenticate` with `methodId: "cursor_login"`;
3. `session/new` or `session/load`;
4. `session/prompt`;
5. consume `session/update` notifications while output streams;
6. answer `session/request_permission` with `allow-once`, `allow-always`, or `reject-once`;
7. optionally send `session/cancel`.

Cursor's minimal client example initializes with ACP protocol version 1, creates a session with a
`cwd` and `mcpServers`, sends prompt content as typed text blocks, reads
`agent_message_chunk` updates, and receives a prompt result with a stop reason. Cursor advertises
`cursor_login`; an ACP process can also be pre-authenticated through normal CLI login/API-key
paths or the ACP page's `--auth-token`/`CURSOR_AUTH_TOKEN` path. The general parameter table does
not list `--auth-token`, another reason to capability-test the installed CLI.

ACP also defines Cursor-specific blocking calls `cursor/ask_question` and `cursor/create_plan`, and
notifications `cursor/update_todos`, `cursor/task`, and `cursor/generate_image`. It can therefore
express interactive semantics that print-mode stream JSON does not document. It is, however, a
different bidirectional protocol. ACP messages must not be assumed to appear in
`--output-format stream-json`, and optional ACP capabilities should be negotiated rather than
assumed.
([ACP docs](https://cursor.com/docs/cli/acp))

ACP supports project/user `.cursor/mcp.json`, but Cursor explicitly says team-level dashboard MCP
servers are not supported in ACP mode. That limitation applies to an ACP adapter, not necessarily
the normal CLI integration.
([ACP docs](https://cursor.com/docs/cli/acp))

## Implementation conclusions for Soloe

1. Discover `agent`, then the compatible `cursor-agent` alias; detect with `--version`.
2. Prefer `agent acp`, Cursor's documented custom-client interface, for a long-lived first-class
   integration. Capability-negotiate it and persist the `sessionId` returned by `session/new` for
   later `session/load`.
3. If Soloe uses a single-turn print fallback, request explicit `stream-json` plus
   `--stream-partial-output`; never rely on the current default `text` format.
4. In that fallback, persist the first streamed `session_id` as provider metadata but keep Soloe's
   own stable identity. Resume with `--resume=<id>` on the authoritative device/workspace, while
   surfacing that Cursor does not document equality or resume stability between chat IDs and
   streamed IDs.
5. Dynamically discover models, and expose only Agent, Plan, and Ask as documented launch modes.
6. For the print fallback, parse the five documented top-level event types, de-duplicate partial
   assistant flushes exactly as documented, correlate tools by `call_id`, retain raw unknown
   payloads, and tolerate added fields/events.
7. In print mode, map process stderr/nonzero exit to failure and a Soloe control action/process
   exit to interruption. Do not fabricate Cursor error/interruption records.
8. Mark reasoning streaming as unavailable for the print-mode adapter. Prefer the officially
   designated ACP custom-client seam when Soloe needs long-lived bidirectional sessions,
   structured cancellation/permissions, or richer interactive semantics; use negotiated ACP
   capabilities and its typed protocol rather than translating assumptions from stream JSON.
9. Reuse Cursor's existing MCP config and approval surface; do not translate or overwrite user
   `mcp.json` files unless a separate, explicit feature calls for it.
10. Add parser fixtures for every documented record and for unknown fields/types, malformed lines,
    early EOF, stderr failure, duplicate assistant flushes, generic function tools, and absent
    optional `request_id`.
