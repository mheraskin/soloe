# API compatibility

`shared/api-contract.ts` is the authoritative compatibility declaration. It
enumerates every `SoloeApi` method, host-private `DEVICE_RPC_METHODS`, the
Application Server RPC handlers, server events, runtime-owned methods,
browser-native helpers, and the only methods that remote Electron may override
locally. Contract tests compare that
declaration with the real `SoloeDomain` handler table and the visible PWA pane
requirements.

There are now two intentionally different API layers:

- `SoloeApi` is the complete single-Device renderer contract. The Application
  Server implements its authenticated RPC/event half and Electron supplies
  native client behavior.
- optional methods on `SessionsApi` form an Application Server-hosted
  multi-Device port. It aggregates Device inventories and routes every Session
  or terminal request by a composite Device reference. Neither renderer
  constructs a socket set or receives Device credentials.

In the table below:

- **Server** means authenticated HTTP RPC or WebSocket event transport.
- **Runtime** means the Server forwards the operation to the Environment
  Runtime, which owns PTYs and agents.
- **IPC** means the local Electron main process composes the reusable domain
  service directly.
- **Native** means client-side browser or Electron behavior with no backend
  domain ownership.
- **Unavailable** is intentional and must return `rpc_not_supported` or expose
  no control.

## Complete method matrix

| Namespace | Methods | Local Electron | Remote Electron | Browser/PWA | Backend owner |
| --- | --- | --- | --- | --- | --- |
| `sessions` | `list`, `listArchived`, `get`, `create`, `update`, `delete`, `reorder`, `previewCommand`, `onChange`, `onDelete` | IPC | Server | Server | Application Server |
| `terminal` | `start`, `stop`, `restart`, control-lease acquire/current/release, `input`, `resize`, `listRunning`, `replay`, `setOutputDemand`, and terminal events | IPC/Runtime | Server/Runtime | Server/Runtime | Environment Runtime |
| `observer` | `list`, `listEvents`, `createWorkerSession`, `sendWorkerPrompt`, `getWorkerStatus`, `stopWorkerSession`, `onSnapshot`, `onEvent` | IPC/Runtime | Server/Runtime | Server/Runtime | Environment Runtime with Server projection |
| `system` | `platform`, `openPath`, `listWslDistros`, `usage` | IPC | Server | Server | Application Server |
| `system` | `saveText`, `openExternal` | Native | Native | Native | Current client |
| `settings` | `get`, `update`, `onChange` | IPC | Server | Server | Application Server |
| `projects` | `list`, `get`, `create`, `open`, `update`, `delete`, `touch`, `reorder`, `refreshFavicons`, `readFavicon`, `detectFromPath`, `suggestPaths`, `onChange` | IPC | Server | Server | Application Server |
| `notes` | `list`, `read`, `write`, `rename`, `delete`, `saveImage`, `readImage`, `cleanupImages`, `onChange` | IPC | Server | Server | Application Server |
| `git` | `status`, `aheadBehind`, `shortstat`, `dirty`, `worktrees`, `branches`, `recentCommits`, `refHistory`, `commitsBetween`, `rangeChanges`, `resolveRefs`, `checkout`, `createWorktree`, `workingChanges`, `workingTreeSnapshot`, `setObservationDemand`, `fileDiff`, `reviewDiffs`, `fileBlame`, `fileLines`, `stageFiles`, `unstageFiles`, `discardFiles`, `commit`, `push`, `pull`, `fetch`, `onChange` | IPC | Server | Server | Application Server Git service |
| `files` | `search`, `openInEditor`, `pasteIntoTerminal`, `pasteImagesIntoTerminal`, `listTree`, `readFile`, `writeFile` | IPC | Server | Server | Application Server Files service; paste targets Runtime |
| `diagnostics` | `list`, `crashLogs` | IPC | Server | Server | Application Server |
| `window` | `minimize`, `toggleMaximize`, `zoomIn`, `zoomOut`, `close` | Native | Native | Unavailable | Electron |
| `agentIntegration` | `status`, `installClaude`, `uninstallClaude`, `installCodex`, `uninstallCodex`, `installCursor`, `uninstallCursor`, `onChange` | IPC | Server | Server | Application Server |
| `notify` | `onToast`, `onActivateSession` | IPC event | Unavailable | Unavailable | Local Electron notification integration |
| `overview` | `get`, `regenerate`, `askStart`, `askCancel`, `onChunk` | IPC | Server | Server | Application Server |
| `comments` | `onRpcRequest`, `sendRpcResponse` | IPC | Server | Server | Application Server bridge |
| `diff` | `onRpcRequest`, `sendRpcResponse` | IPC | Server | Server | Application Server bridge |
| `features` | `scan`, `setBranchStatus`, `setIssueStatus`, `subscribe`, `unsubscribe`, `onChange` | IPC | Server | Server | Application Server |
| `vault` | `list`, `save`, `update`, `delete`, `getSecret`, `onChange` | IPC | Server | Server | Application Server |
| `browser` | `enableDeviceEmulation`, `disableDeviceEmulation`, `setUserAgent`, `openDevTools`, `setDevToolsLayout`, `closeDevTools` | Native | Native | Unavailable | Electron WebContents |
| `sessions` multi-Device extension | Device inventory state/refresh, plan+confirm creation, composite terminal demand/input/takeover/replay/resize/stop, Device events | Server | Server | Server | Application Server Sessions module, with effects delegated to the owning Device/Runtime |

Remote Electron's preload starts with the browser/server adapter and keeps only
window/browser controls and Vault on Electron IPC. Device discovery and the
multi-Device Sessions port use the authenticated server adapter, exactly like
the PWA. Contract tests enumerate these exceptions so another namespace cannot
silently bypass the transport boundary.

Local Electron remains a supported standalone transport. Its IPC handlers
compose the same platform-independent Files, Git, Notes, Features, Overview,
Diagnostics, Vault, integrations, and usage services used by the Server;
renderer code does not own those operations.

## Device protocol extensions

The renderer does not receive generic Git or arbitrary RPC forwarding. The
host-private `SessionDevice` negotiates the authenticated Device descriptor, then
uses the following typed server capabilities:

| Capability | Device RPCs | Authority |
| --- | --- | --- |
| Description/snapshot | bounded descriptor plus epoch/sequence-qualified snapshot | Application Server |
| Sessions inventory | Projects, canonical Git remote, Worktrees, Sessions, and running terminals | Application Server and Environment Runtime |
| Workspace device state | `workspaceDevice.snapshot`, `plan`, `execute`, `getCommand` | Application Server and Device operation journal |
| Placed Sessions | preallocated create and optimistic Session Source binding | Application Server Session store |
| Terminal control | acquire/current/release identity-qualified Session Control plus lease-authorized input/resize and ordinary replay/stop | Environment Runtime |
| GitHub publication | provider status/owners, repository plan/execute/getCommand | Device-local provider adapter and journal |

`DeviceCommandEnvelope` binds a UUID command to client, actor client, target
Device, capability revision, plan token/expiry, expected entity versions, and
optional exact Checkout evidence. A repeated successful command returns its
durable receipt without repeating effects; a different intent under the same
ID is rejected. Plans expose blockers, warnings, and required acknowledgements
before any filesystem, Git, Session, or provider effect.

## Browser behavior

All shared rail panes work in the PWA:

- Worktree Overview;
- Working Diff, including range review and Git mutations;
- Files and File Palette, including read, edit, save, refresh, and search;
- Feature Lab;
- Notes;
- Process Usage.

Vault and agent-integration management remain available in Settings. Backend
diagnostics are also server-backed. `saveText` downloads through browser APIs,
`openExternal` performs validated browser navigation, and file opening uses the
shared Files editor rather than an operating-system shell.

The embedded Browser pane is the intentional exception. It requires Electron
`<webview>` and WebContents APIs, is omitted from the PWA rail, and is not
reimplemented with an unrestricted iframe. It remains native in local and
remote Electron.

## Events and reconnect

The Server publishes:

- session changes and deletion;
- project and settings snapshots;
- observer snapshots/events;
- terminal output, status, exit, and location;
- Terminal Control Lease acquisition, renewal, canonical resize, expiry, release, and takeover;
- Notes, Git, Feature Lab, and Vault changes;
- Worktree Overview chunks;
- agent-integration changes;
- comments and diff bridge requests.

The browser adapter uses a stable client ID. Observation demand and Feature Lab
subscriptions are reference-counted by client, and disconnect cleanup does not
stop runtime-owned terminals or agents. After a WebSocket reconnect, client
stores refresh their snapshots and discard stale in-flight responses. Terminal
output is recovered from the last observed sequence through bounded replay.
Overview tasks either resume from backend-owned state or return an explicit
restart state.

Multi-Device transports opt into `envelope-v1`. Each event is attributable to a
Device ID and server epoch and has a monotonic sequence. The host rejects
events from a replaced socket, a changed identity, an old epoch, or a sequence
gap and repairs from an authority snapshot/cursor. Output demand is partitioned
per Device and Terminal so a non-visible terminal is not fanned out to every
client.

## Security and diagnostics

HTTP RPC and WebSocket events share the token-protected localhost boundary.
Handlers validate request shape, placement, WSL distribution, worktree
identity, relative paths, payload size, and destructive Git inputs. Files and
Notes reject traversal and symlink escape. Vault list/change payloads never
contain secrets; `getSecret` is the only explicit secret read.

Workspace operations accept semantic intents, validated refs/URLs, bounded
managed paths, immutable OIDs, and non-force Git primitives. The desktop never
receives Git/provider credentials or source bytes from one Device to replay on
another. Cleanup is blocked unless a fresh Device scan proves the isolated
Checkout is non-main, clean (including ignored/untracked data), published or
otherwise reachable, unconsumed, correctly owned, and free of active
operations.

Remote Electron development may load the renderer from a different loopback
origin than the Application Server. The Server answers `POST /api/rpc`
preflight requests only for `http://localhost`, `http://127.0.0.1`, or
`http://[::1]` origins and only for the `Authorization` and `Content-Type`
headers. Non-loopback origins are rejected, and successful RPC calls still
require the install token.

RPC diagnostics record namespace, method, outcome, structured error code,
duration, and safe request/response sizes. Logs do not record authorization
tokens, cookies, terminal input, file/note content, provider credentials, or
Vault secrets. Diagnostic log tails are bounded and limited to known Soloe
services.

## Capability failures

`rpc_not_supported` means the client contract does not advertise that
transport/method pair. Check, in order:

1. renderer methods exist in `SOLOE_API_METHODS`, while host-private Device
   methods exist in `DEVICE_RPC_METHODS` and are intentionally not renderer
   methods;
2. an RPC method exists in `SERVER_RPC_METHODS`, or an event exists in
   `SERVER_EVENT_METHODS`;
3. `SoloeDomain` has the matching handler;
4. `src/lib/browser-api.ts` maps the method arguments correctly;
5. the UI capability requirement names the same namespace and method;
6. client and server builds come from the same revision.

For multi-Device failures, also compare the descriptor protocol range and required
feature names. An incompatible or partially capable Device remains visible but
is not offered unsupported mutation plans. `terminal_input_owned` means another
authenticated client currently controls the terminal;
`terminal_control_lease_stale` means a newer generation has already won. The UI
may explicitly take over rather than silently stealing control.

Do not add a UI-only stub or a second handwritten support list. Add the real
handler and update the central contract so compatibility tests can detect
drift.
