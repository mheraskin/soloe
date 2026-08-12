# MCP security

Soloe uses an MCP bridge to deliver review comments and related context to an agent session. Requests require a random bearer token, and the application-server architecture binds its MCP service to `127.0.0.1`.

## Windows + WSL boundary

A process inside WSL cannot always reach a Windows service through WSL's own loopback address. The legacy packaged Electron path therefore has a broader Windows bind and advertises a probed Windows-host address to WSL integrations. This is an unresolved public-release hardening item: token authentication reduces accidental access, but listening beyond loopback can expose the port to interfaces other than the intended WSL boundary depending on Windows and firewall configuration.

Until that path is narrowed and validated:

- do not expose the MCP port through router forwarding, a public tunnel, or a permissive firewall rule;
- treat the token as a secret and rotate/reinstall integrations if it is disclosed;
- use the application-server path's loopback binding when WSL reachability is not required;
- verify listening interfaces and Windows Firewall behavior before using Soloe on an untrusted network.

## Request surface

The bridge accepts only its MCP and supported agent-hook routes. Requests require the configured bearer or Soloe token. Authentication does not authorize arbitrary networks and does not replace OS firewall policy.

## Hook configuration

Soloe writes connection information to the agent integration files documented in [Agent integrations](./agent-integrations.md). Remove integrations through Soloe when possible and keep backups until removal has been verified.

See the [security policy](../SECURITY.md) for private vulnerability reporting.

## Multi-Device isolation

MCP and agent hooks are installed and authenticated on the Device that owns the
agent CLI and Session. A Cockpit connection to several Devices does not create
one shared MCP bridge: each Device keeps its own bearer/cookie context, Vault,
Git credentials, provider login, and integration files. Device authentication
material is never persisted in the cockpit catalog or connection-registry
records and is never forwarded to another Device.

The desktop pins the durable Device ID learned through the authenticated
descriptor. A later endpoint that reports a different identity is blocked
before event or command routing. Every physical command names its target Device
and cannot fall back to the current filter or default-placement preference.

Catalog exports contain logical names, source refs, Device identifiers,
Repository/Checkout associations, and Session references. They exclude bearer
tokens, cookies, Vault secrets, provider credentials, terminal input, and
source files, but can still reveal private development metadata and should be
handled as sensitive files.

Recovery reports copied from the UI are deliberately redacted to operation and
plan IDs, kind/state/phase/progress, child Device/command IDs, and timestamps.
Do not replace them with raw operation objects: those may contain paths,
command arguments, provider details, or error output.
