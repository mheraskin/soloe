# macOS Development and Release

Soloe supports native macOS execution with separate Intel (`x64`) and Apple-silicon (`arm64`) packages. Users install one `Soloe.app`: its lightweight Tauri menu-bar host owns private, separate Environment Runtime and Application Server processes plus on-demand Electron/Svelte and browser clients. The private payload includes native `node-pty`; macOS does not use WSL or install a second application.

## Prerequisites

- Node.js 22 or newer and the repository-pinned PNPM version;
- Git and at least one authenticated `claude` or `codex` CLI;
- Xcode Command Line Tools;
- a Rust toolchain for the optional Tauri tray.

```bash
corepack enable
corepack prepare pnpm@10.34.5 --activate
pnpm install --frozen-lockfile
```

Soloe resolves the login-shell environment for applications launched from Finder or the Dock. Homebrew's common Intel and Apple-silicon paths are supported through that shell environment rather than hard-coded into session commands.

## Development

Start all supervised components with `pnpm dev`. For focused work, start the long-lived Runtime first, then the Server, web client, and optional Electron client independently:

```bash
pnpm dev:runtime
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
```

The native tray is independently runnable with `pnpm dev:tray`. In a packaged build, the tray starts the Runtime and standalone Server. **Open Soloe** starts at most one remote Electron client, **Open in browser** opens the packaged web client, and both connect to that Server. Closing Electron exits only that client; the Server, browser access, Runtime, and agents remain available. **Quit Soloe** ends every process owned by the product. macOS application data and service records live under `~/Library/Application Support/Soloe` unless `SOLOE_DATA_DIR` overrides the location.

## Tailscale device connections

To make one machine available to other tailnet devices, enable Tailscale Serve
for the active Soloe web endpoint. Source development uses the web host on
4318; the packaged application serves the production PWA from its Application
Server on 4317:

```bash
# Source checkout
tailscale serve --bg 4318

# Packaged Soloe.app
tailscale serve --bg 4317
```

Electron's **Settings > Connections** page reads `tailscale status --json`,
probes online peers at their exact MagicDNS HTTPS names, and lists only peers
whose `/__soloe/ready` endpoint identifies a running Soloe host. The same
devices appear in the title-bar device menu. Selecting a different device
persists the choice and relaunches only the Electron client; runtimes and agents
on either machine continue running. Select **This device** to return to the
tray-provided local Server.

A trusted `https://` MagicDNS or Tailscale Serve URL can also be saved manually.
The registry stores endpoint metadata, not backend bearer tokens. Remote access
uses the Secure, HttpOnly session issued from Tailscale identity headers. The
Tailscale executable can be overridden with `SOLOE_TAILSCALE_CLI`; a host that
cannot run the CLI can provide its exact `.ts.net` name with
`SOLOE_TAILSCALE_HOSTNAME`.

## Packages

Build on the native architecture so native modules match Electron:

```bash
pnpm package:macos:x64
pnpm package:macos:arm64
```

Each command builds the production PWA and a private architecture-matched Electron payload containing the Runtime and Server entries, embeds it inside the outer Tauri application, and produces the only public installer under `target/release/bundle/dmg/`. The GitHub CI matrix runs x64 on `macos-15-intel` and arm64 on `macos-latest`.

## Signing and notarization

Tag releases require these GitHub secrets:

- `MACOS_CERTIFICATE` and `MACOS_CERTIFICATE_PASSWORD` for a Developer ID Application certificate;
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID` for notarization.

The release workflow fails before packaging when credentials are absent, imports the Developer ID certificate into an ephemeral keychain, signs the embedded Electron app and outer Soloe app with the same identity, and lets Tauri notarize the complete product. Local packages use ad-hoc signing and are not notarized, so Gatekeeper acceptance is not expected.

## Verification

Before publishing, run `pnpm typecheck`, `pnpm test`, Rust formatting/Clippy/tests, and both native package jobs. Verify the Runtime and standalone Server start without Electron, **Open in browser** and **Open Soloe** share backend state, closing Electron leaves browser access and agents running, reopening works, a PTY can be spawned, and **Quit Soloe** cleans the complete owned process group.

Intel macOS has passed this flow locally. Native arm64 packaging is configured on an Apple-silicon CI runner, but the final clean-machine smoke must be repeated on physical Apple-silicon hardware when available.
