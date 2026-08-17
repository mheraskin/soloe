# Reliable events while retaining interactive agent CLIs

Research date: 2026-08-17

## Conclusion

Soloe can keep Claude Code, Codex CLI, and Cursor Agent CLI attached to a real
PTY and still make sidebar state primarily event-driven. The correct seam is a
device-local hook adapter: the provider continues drawing and accepting input
through the terminal, while hook subprocesses send small structured events to
Soloe out of band.

This is not the same architecture as app-server, ACP, or print mode. Terminal
bytes remain the rendering and control channel; hooks become the authoritative
observation channel. PTY inference remains an explicit fallback only for gaps
the interactive hook contracts do not expose.

Hooks must report to the Soloe runtime on the machine running the CLI. That
runtime normalizes and persists the events, then projects the small normalized
state to other devices. A hook must never call a viewing device over a WAN path.

## Coverage

| Capability | Claude Code interactive CLI | Codex interactive CLI | Cursor Agent interactive CLI |
| --- | --- | --- | --- |
| Session identity | `session_id` on every hook; `--session-id` and `--resume` are supported | `session_id` on every hook; `SessionStart.source` distinguishes startup/resume/clear/compact | stable `conversation_id`; `generation_id` changes per user message; `sessionStart.session_id` is the same conversation ID |
| Turn submitted | `UserPromptSubmit` | `UserPromptSubmit` | `beforeSubmitPrompt` |
| Turn stopped | `Stop`; typed `StopFailure` for failures and limits | `Stop`; no typed stop status in the hook payload | `stop.status`: `completed`, `aborted`, or `error` |
| Tool lifecycle | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`; MCP uses the same path | `PreToolUse`, `PostToolUse`; Bash, apply-patch, MCP, and most local function tools are covered | `preToolUse`, `postToolUse`, `postToolUseFailure`, plus specialized shell, MCP, read, edit, and subagent hooks |
| Exact approval begins | `PermissionRequest` fires immediately before the native prompt | `PermissionRequest` fires only when Codex is about to prompt | no documented `PermissionRequest`; shell/MCP hooks can return `permission: "ask"` |
| Native terminal handles approval | yes, if the hook returns no decision | yes, if the hook returns no decision | yes, when a controlling shell/MCP hook returns `ask`, or when native policy independently asks |
| Structured user input | `PreToolUse: AskUserQuestion`; MCP `Elicitation` / `ElicitationResult` | local function tools, including interactive tools, flow through `PreToolUse`/`PostToolUse` unless that specialized path opts out | no documented generic question/elicitation lifecycle; use a tool event when present and PTY fallback otherwise |
| Assistant output | `MessageDisplay` emits completed-line batches and final message metadata | not exposed by interactive hooks | `afterAgentResponse` emits aggregated final text |
| Reasoning | not exposed by interactive hooks | not exposed by interactive hooks | `afterAgentThought` emits an aggregated completed thinking block, not token deltas |
| Interruption | hook-only coverage is incomplete: `Stop` does not fire on user interrupt and cancelled tools can omit failure hooks | no dedicated interactive interruption hook | `stop.status: aborted` covers a stopped loop, but Soloe should still treat the Ctrl-C it sends and child exit as primary control facts |
| Session exit | `SessionEnd` with a reason | `SessionEnd`; current reason is only `other` | `sessionEnd` with reason and final status |

Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks),
[Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference),
[Codex hooks](https://developers.openai.com/codex/hooks), and
[Cursor hooks](https://cursor.com/docs/hooks).

## Provider behavior

### Claude Code

Keep the normal `claude` process on the PTY. Interactive mode cannot combine
the TUI with `--output-format stream-json`; structured stdout is a print-mode
surface. Hooks are therefore the supported out-of-band event source.

Every hook contains `session_id`, `transcript_path`, `cwd`, and
`hook_event_name`; prompt-related events also expose `prompt_id`. The useful
state sequence is:

```text
SessionStart -> idle
UserPromptSubmit -> working
PreToolUse -> running tool
PermissionRequest -> pending approval
PostToolUse / PostToolUseFailure -> working or failed
Stop / StopFailure -> idle, failed, or usage limited
SessionEnd -> exited
```

`PermissionRequest` may return no decision, in which case Claude displays its
normal terminal approval UI. It can alternatively return structured allow or
deny output and skip that UI. `Notification:permission_prompt` is delayed and
must not be the primary approval signal. When the native UI owns the response,
Soloe clears the pending approval when it forwards the user's terminal input;
the next tool or stop event reconciles the result.

`AskUserQuestion` is visible through `PreToolUse`. MCP elicitation has dedicated
`Elicitation` and `ElicitationResult` events. `MessageDisplay` can observe
assistant text, but it delays display until the hook returns and should not be
installed merely to calculate status.

An official session-scoped `--settings` file can inject Soloe's hook without
replacing omitted normal settings. This is preferable to permanently editing a
user's configuration. `SessionStart` is the capability handshake: if it does
not arrive, Soloe should expose degraded observation instead of assuming idle.
Managed policy, safe mode, disabled hooks, or an invalid hook configuration can
suppress the handshake.

Claude's web/cloud environment loads repository hooks inside its VM, not the
machine's user hooks. A loopback Soloe callback therefore applies to a CLI
process running on a Soloe-managed local or remote device; it must not be
claimed for a detached Anthropic cloud VM without a separately reachable
channel. See [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web).

### Codex CLI

Codex now has a first-class interactive hook contract. The release
documentation lists eleven events:

```text
SessionStart, SessionEnd, UserPromptSubmit,
PreToolUse, PermissionRequest, PostToolUse,
PreCompact, PostCompact,
SubagentStart, SubagentStop, Stop
```

Common input includes `session_id`, `cwd`, `transcript_path`, event name, and
model; turn-scoped events add `turn_id`. Tool events include `tool_name`,
`tool_use_id`, and JSON input/output. Most local functions and MCP tools share
this path, although hosted tools and specialized opt-outs are documented gaps.
The transcript path is explicitly not a stable interface, so transcript JSON
must not be the primary parser.

`PermissionRequest` is especially useful: it fires only when Codex is about to
ask for approval. A hook can return allow or deny, or make no decision and let
the original TUI prompt continue. This gives Soloe an exact approval-start
event without replacing the CLI. The approval is cleared when Soloe forwards
the terminal response; subsequent `PostToolUse` or `Stop` reconciles state.

Codex loads and appends hooks from active user, project, system, session, and
plugin config layers. Non-managed commands are hash-trusted and can be reviewed
with `/hooks`. Soloe's existing user hook installation must preserve other
groups and account for this trust state. Observer callbacks should remain
synchronous but extremely short; Codex background hooks can reorder and cannot
approve, block, or rewrite operations.

Current official implementation sources corroborate the contract and show
that permission hooks run before Guardian or the regular user prompt:
[hook event registry](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/lib.rs),
[hook runtime](https://github.com/openai/codex/blob/main/codex-rs/core/src/hook_runtime.rs), and
[approval routing](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/approvals.rs).

### Cursor Agent CLI

Cursor hooks are spawned processes using JSON over stdin/stdout while the
interactive agent remains on its PTY. The common payload provides
`conversation_id`, per-turn `generation_id`, model, event name, Cursor version,
workspace roots, and transcript path. Current official lifecycle and agent
events include:

```text
sessionStart, sessionEnd, beforeSubmitPrompt, stop,
preToolUse, postToolUse, postToolUseFailure,
subagentStart, subagentStop,
beforeShellExecution, afterShellExecution,
beforeMCPExecution, afterMCPExecution,
beforeReadFile, afterFileEdit,
preCompact, afterAgentResponse, afterAgentThought
```

The installed 2026.08.11 Cursor bundle contains these hook handlers, including
the per-event JSON request/response adapters. The installed executable could
not be invoked during this inspection because the macOS login keychain was
locked; the official contract and installed bundle agree on the event names.

The gap is approval identity. Cursor documents permission responses on
`preToolUse`, `beforeShellExecution`, and `beforeMCPExecution`, but it does not
document a distinct event that means native policy has actually decided to ask
the user. `preToolUse` accepts `ask` in its schema but does not currently
enforce it. Shell and MCP hooks do enforce `permission: "ask"`.

Therefore Cursor has two truthful operating modes:

1. **Soloe-governed approval mode:** for sessions configured to ask, the
   shell/MCP hook returns `ask`, emits pending approval, and leaves the answer
   to the visible TUI. This is exact for those tool families.
2. **Native-policy mode:** hooks observe tool lifecycle but PTY prompt detection
   is still required to know whether native policy asked. Soloe must label this
   capability as degraded rather than treating every `preToolUse` as approval.

Project and user hook files are additive. Cursor runs all matching hooks and
merges responses by source priority: enterprise, team, project, then user.
Soloe can install marked user entries in `~/.cursor/hooks.json` without
overwriting project hooks, and must preserve unrelated user entries. Cursor
automatically reloads hook files after changes.

Official details: [configuration and merge priority](https://cursor.com/docs/hooks#configuration),
[common schema](https://cursor.com/docs/hooks#common-schema), and
[event reference](https://cursor.com/docs/hooks#hook-events).

## Normalized Soloe interface

Do not reduce every event immediately to one mutually exclusive status. Keep
orthogonal projected facts so an approval cannot be overwritten by a later
"working" observation:

```ts
interface InteractiveAgentProjection {
  lifecycle: 'starting' | 'running' | 'exited' | 'failed';
  turn: 'idle' | 'working' | 'running_tool';
  attention:
    | { kind: 'none' }
    | { kind: 'approval'; requestKey?: string; summary?: string }
    | { kind: 'user_input'; requestKey?: string; summary?: string }
    | { kind: 'usage_limit'; summary?: string }
    | { kind: 'error'; summary?: string };
  providerSessionId?: string;
  providerTurnId?: string;
  tool?: { id?: string; name: string; input?: unknown };
  observation: 'exact' | 'degraded';
  lastEventAt: string;
}
```

The reducer should consume a provider-neutral event union such as
`session.started`, `session.ended`, `turn.submitted`, `turn.stopped`,
`tool.started`, `tool.finished`, `approval.requested`, `input.requested`,
`interrupted`, and `runtime.failed`. Both collapsed and expanded sidebars must
read the same projection. Display priority should be attention request/error,
then active tool/working, then idle/exited.

The hook adapter must retain the original provider payload for diagnostics but
should normalize identity as:

| Provider | Session key | Turn key | Tool key |
| --- | --- | --- | --- |
| Claude | `session_id` | `prompt_id` when present | `tool_use_id`; approval requests may require correlation because Claude omits it there |
| Codex | `session_id` | `turn_id` | `tool_use_id` |
| Cursor | `conversation_id` | `generation_id` | `tool_use_id` |

## Delta from Soloe today

Soloe already has much of the transport and projection plumbing:

- `HookInstaller` merges Claude and Codex user hooks without replacing unrelated
  entries.
- `AgentHookDispatcher` maps their payloads into observer state.
- `PtyManager` knows when Soloe submits Enter or Ctrl-C, clears an approval when
  it forwards input, watches process lifecycle, and scans output as a fallback.
- The observer is persisted and projected to remote devices.

The missing or outdated parts are:

1. Cursor installation currently adds MCP configuration only; it does not
   install `~/.cursor/hooks.json` entries. `mapCursorShellHook` only recognizes
   `SessionStart` and `SessionEnd`, despite the current Cursor hook contract.
2. Claude's installed event list omits current events including
   `PostToolUseFailure`, `PostToolBatch`, `Elicitation`, `ElicitationResult`,
   `MessageDisplay`, and other newer lifecycle detail.
3. Codex's list omits `SessionEnd`, `PreCompact`, `PostCompact`,
   `SubagentStart`, and `SubagentStop` even though current Codex documents them.
4. The HTTP hook endpoint always returns `{ "ok": true }` and the shell command
   discards it. That is sufficient for observation but cannot participate in
   structured approval decisions. The bridge needs a provider-aware response
   shape while defaulting to no decision so native terminal prompts remain.
5. `AgentHookDispatcher` reduces events directly to one state. Approval and
   input requests should be independent pending facts in the normalized
   projection.
6. Current PTY approval phrase matching should be retained only for a missing
   hook handshake, Cursor native-policy mode, and documented event gaps.

Relevant implementation points:
[`HookInstaller.ts`](../../packages/domain/src/integrations/HookInstaller.ts),
[`AgentHookDispatcher.ts`](../../electron/agents/AgentHookDispatcher.ts),
[`SoloeMcpServer.ts`](../../electron/agents/SoloeMcpServer.ts), and
[`PtyManager.ts`](../../electron/terminal/PtyManager.ts).

## Recommended implementation order

1. Introduce the provider-neutral event union and orthogonal projection above,
   keeping backward-compatible derivation of `AgentObservedState`.
2. Replace the curl-only hook command with a fast device-local helper that
   reliably queues the event and immediately returns provider-valid JSON. It
   must inherit `SOLOE_SESSION_ID`, never wait on a remote UI, and preserve hook
   ordering per provider session.
3. Expand Claude and Codex hook registration to the current documented event
   sets and add Cursor user-hook merging/installation.
4. Implement provider adapters that validate exact payload schemas and emit the
   normalized union. Detect successful observation through a `SessionStart`
   handshake and expose `observation: degraded` when absent.
5. Preserve native approval dialogs by default: Claude/Codex return no decision;
   Cursor uses explicit `ask` only in Soloe-governed approval mode. Terminal
   input remains the approval and structured-input response path.
6. Let PTY-owned Enter, Ctrl-C, resize, exit, and rendering remain terminal
   facts. Remove status inference where exact hooks exist; keep narrowly scoped,
   tested phrase detection for documented gaps.
7. Add captured hook fixtures for each supported CLI version and reducer tests
   that prove approval/input attention cannot be overwritten by working/tool
   events, including remote projection and both sidebar forms.

This preserves Soloe's differentiator: users interact with the genuine CLIs,
while Soloe adds reliable multi-device observation and control around them.
