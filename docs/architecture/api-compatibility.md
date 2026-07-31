# API compatibility

`shared/api-contract.ts` is the authoritative compatibility declaration. It
enumerates every `SoloeApi` method, the Application Server RPC handlers, server
events, runtime-owned methods, browser-native helpers, and the only methods
that remote Electron may override locally. Contract tests compare that
declaration with the real `SoloeDomain` handler table and the visible PWA pane
requirements.

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
| `terminal` | `start`, `stop`, `restart`, `input`, `resize`, `listRunning`, `replay`, `setOutputDemand`, `onOutput`, `onExit`, `onStatus`, `onLocation` | IPC/Runtime | Server/Runtime | Server/Runtime | Environment Runtime |
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
| `agentIntegration` | `status`, `installClaude`, `uninstallClaude`, `installCodex`, `uninstallCodex`, `onChange` | IPC | Server | Server | Application Server |
| `notify` | `onToast`, `onActivateSession` | IPC event | Unavailable | Unavailable | Local Electron notification integration |
| `overview` | `get`, `regenerate`, `askStart`, `askCancel`, `onChunk` | IPC | Server | Server | Application Server |
| `comments` | `onRpcRequest`, `sendRpcResponse` | IPC | Server | Server | Application Server bridge |
| `diff` | `onRpcRequest`, `sendRpcResponse` | IPC | Server | Server | Application Server bridge |
| `features` | `scan`, `setBranchStatus`, `setIssueStatus`, `subscribe`, `unsubscribe`, `onChange` | IPC | Server | Server | Application Server |
| `vault` | `list`, `save`, `update`, `delete`, `getSecret`, `onChange` | IPC | Server | Server | Application Server |
| `browser` | `enableDeviceEmulation`, `disableDeviceEmulation`, `setUserAgent`, `openDevTools`, `setDevToolsLayout`, `closeDevTools` | Native | Native | Unavailable | Electron WebContents |

Remote Electron's preload starts with the browser/server adapter and replaces
only the `window` and `browser` objects. A regression test enumerates every
namespace above and fails if any other object is replaced with Electron IPC.
Its main process registers only `WindowIpc` and `BrowserIpc` in remote mode.

Local Electron remains a supported standalone transport. Its IPC handlers
compose the same platform-independent Files, Git, Notes, Features, Overview,
Diagnostics, Vault, integrations, and usage services used by the Server;
renderer code does not own those operations.

## Browser behavior

All shared rail panes work in the PWA:

- Inspector and Worktree Overview;
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

## Security and diagnostics

HTTP RPC and WebSocket events share the token-protected localhost boundary.
Handlers validate request shape, placement, WSL distribution, worktree
identity, relative paths, payload size, and destructive Git inputs. Files and
Notes reject traversal and symlink escape. Vault list/change payloads never
contain secrets; `getSecret` is the only explicit secret read.

RPC diagnostics record namespace, method, outcome, structured error code,
duration, and safe request/response sizes. Logs do not record authorization
tokens, cookies, terminal input, file/note content, provider credentials, or
Vault secrets. Diagnostic log tails are bounded and limited to known Soloe
services.

## Capability failures

`rpc_not_supported` means the client contract does not advertise that
transport/method pair. Check, in order:

1. the method exists in `SOLOE_API_METHODS`;
2. an RPC method exists in `SERVER_RPC_METHODS`, or an event exists in
   `SERVER_EVENT_METHODS`;
3. `SoloeDomain` has the matching handler;
4. `src/lib/browser-api.ts` maps the method arguments correctly;
5. the UI capability requirement names the same namespace and method;
6. client and server builds come from the same revision.

Do not add a UI-only stub or a second handwritten support list. Add the real
handler and update the central contract so compatibility tests can detect
drift.
