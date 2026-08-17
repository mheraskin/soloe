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

Soloe works locally without Tailscale. To connect Devices, install Tailscale and
sign in from its macOS app, then open **Settings > Connections**. Soloe
automatically configures its dedicated HTTPS Serve listener on standard HTTPS
port 443 and discovers compatible Soloe backends at their exact MagicDNS names.
That makes each device available at `https://<device>.ts.net/` without a port.
If Tailscale
requires one-time HTTPS approval, Connections opens the approval page and a
refresh completes setup without restarting Soloe.

No `tailscale serve` command, endpoint URL, or per-Device enable switch is part
of the normal workflow. Soloe never resets Tailscale Serve and refuses to
overwrite another service already using its dedicated port. Identified,
compatible Devices connect concurrently while Electron is open. The title-bar
control filters which Sessions are shown; it does not switch backends, move a
Session, relaunch Electron, or stop a Runtime.

The registry stores discovered endpoint and backend-owned Device identity
metadata, not backend bearer tokens. Remote access uses the Secure, HttpOnly
session issued from Tailscale identity headers. The Tailscale executable can be
overridden with `SOLOE_TAILSCALE_CLI` for development and tests.

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

For multi-Device validation, connect at least two enabled Devices with
colliding local Session IDs, place shared and isolated Sessions, and verify that
filter changes, catalog archiving, Electron restart, and one Device disconnect
do not stop either Runtime. Exercise explicit input takeover from two clients,
then export/import the catalog and verify the checksum/backup recovery path.
