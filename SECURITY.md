# Security Policy

Soloe launches terminals and coding agents, reads repositories, installs optional agent hooks, and exposes authenticated local services. Please treat suspected vulnerabilities as private until they have been investigated and a fix or mitigation is available.

## Supported versions

Soloe has not published its first alpha. During the alpha period, only the newest release will receive security fixes. Older pre-release builds may be superseded rather than patched individually.

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting form](https://github.com/mheraskin/soloe/security/advisories/new). If that form is unavailable, contact the maintainer privately through the address on the maintainer's GitHub profile.

Include the affected version or commit, platform and backend mode, reproduction steps, expected impact, and any suggested mitigation. Redact credentials, provider tokens, private source, and unrelated user data. Do not open a public issue for an unpatched vulnerability.

The project will acknowledge reports and coordinate next steps as maintainer availability permits. No fixed response-time SLA is offered during the alpha.

## Security boundaries

- Soloe runs with the permissions of the user who launched it.
- Agent CLIs retain their own authentication and communicate with their respective providers.
- Browser/PWA access is loopback-only by default; optional remote access is controlled by infrastructure configured by the user.
- MCP and application transports require authentication tokens, but a token does not make an intentionally exposed service safe for an untrusted network.
- Repositories and terminal commands remain potentially untrusted input. Review agent-produced changes before running or publishing them.

See [MCP security](./docs/mcp-security.md), [privacy](./PRIVACY.md), and [known limitations](./docs/known-limitations.md) for the current model and open hardening work.
