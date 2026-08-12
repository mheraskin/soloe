# Plan 4: Packaging, CI, and Release

Status: **Implemented; notarized release requires Apple credentials**  
Depends on: Plans 1–3

## Outcome

Soloe produces reproducible macOS packages for Intel and Apple silicon, validates both architectures in CI, and is ready for signed/notarized public releases when Apple credentials are supplied.

## Scope

### 1. Packaging

- Build an architecture-matched private Electron application with an `.icns` asset and explicit bundle identifier.
- Add root scripts for native `x64` and `arm64` macOS packaging.
- Rebuild `node-pty` for each target architecture and verify the packaged native module with Electron, not only system Node.
- Build the Tauri menu-bar host for both macOS architectures, embed the private Electron/runtime payload, and publish one `Soloe.app` DMG per architecture rather than a separate service application.
- Produce separate x64 and arm64 DMGs first. Add a universal artifact only if a dedicated native-module and tray-binary verification passes.

### 2. CI

- Extend validation to macOS and add architecture-specific packaging jobs on pinned Intel and arm64 GitHub-hosted runners available at implementation time.
- Install pinned Node/pnpm and Rust toolchains, cache by architecture, and avoid reusing native artifacts across architectures.
- Run TypeScript tests, Rust tests, package smoke checks, architecture inspection (`file`/`lipo`), launch checks, and artifact upload.
- Keep existing Windows and Linux jobs intact.

### 3. Signing, notarization, and release

- Add secret-driven Developer ID signing and Apple notarization configuration without committing credentials.
- Permit clearly labeled unsigned local engineering packages; require signing/notarization for public macOS release artifacts.
- Include macOS files in checksums and release notes, and verify Gatekeeper assessment/stapled notarization in the release job.
- Document the exact required repository secrets and local keychain prerequisites.

## External prerequisites

- Xcode/Command Line Tools and Rust are required for local tray validation.
- Public distribution requires Apple Developer Program membership, a Developer ID Application certificate, and notarization credentials.
- The current Intel development machine can validate x64 locally; arm64 native validation will run in CI until the Apple-silicon machine is available.

## Acceptance gate

- Clean CI creates one installable Soloe DMG for x64 and one for arm64, each with matching native tray, Electron, and `node-pty` architectures.
- Each packaged app launches and can create a PTY session on its native runner.
- Signed release artifacts pass `codesign`, Gatekeeper, and notarization checks when credentials are present.
- Windows and Linux release artifacts and checksum generation remain unchanged.
