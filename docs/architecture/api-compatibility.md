# API compatibility

The shared Svelte UI has three transports. The contract is declared in
`shared/api-contract.ts` and checked by compatibility tests.

| API area | Local Electron | Remote Electron | Browser/PWA | Owner |
| --- | --- | --- | --- | --- |
| Sessions and projects | Full | Full | Full | Application Server |
| Terminal start/stop/input/resize/list/replay | Full | Full | Full | Environment Runtime through Server |
| Observer snapshots/events/workers | Full | Full | Full | Application Server |
| Settings | Full | Full | Full | Application Server |
| Platform and backend discovery | Full | Startup-safe subset | Startup-safe subset | Application Server |
| Window controls | Full | Full native override | Not available | Client |
| Embedded-browser controls | Full | Full native override | Not available | Client |
| Git, files, notes, overview, features, vault | Full | Explicitly gated | Explicitly gated | Migration pending |
| Notifications/comments/diff bridge | Full events | Explicitly gated | Explicitly gated | Migration pending |

The browser adapter does not send unsupported calls and returns the structured
`rpc_not_supported` code. This is intentional capability gating, not a silent
fallback to Electron-owned state.

Shared UI startup requires:

- `system.platform`
- `settings.get`
- `projects.list`
- `sessions.list`
- `sessions.listArchived`
- `terminal.listRunning`
- `observer.list`
- `agentIntegration.status`

Compatibility tests require every startup call to exist on the Application
Server. Remote Electron uses the same server-backed terminal contract as the
PWA; only window and embedded-browser controls remain local Electron IPC.
