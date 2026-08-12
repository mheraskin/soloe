# Plan 5: Verification and Rollout

Status: **Intel verification complete; Apple-silicon hardware smoke pending**  
Depends on: Plans 1–4

## Outcome

macOS support is demonstrated through automated and manual evidence, documented accurately, and rolled out without claiming unperformed Apple-silicon hardware validation.

## Verification matrix

| Layer | Intel macOS | Apple silicon macOS | Windows/WSL | Linux |
| --- | --- | --- | --- | --- |
| Typecheck/unit tests | Local + CI | CI | CI | CI |
| Rust tray tests | Local after Rust setup + CI | CI | CI | CI |
| Runtime/server/socket | Local + CI | CI | Regression | Regression |
| Electron package/PTY smoke | Local + CI | Native arm64 CI | Regression | Regression |
| Tray process-tree lifecycle | Local + CI | Native arm64 CI | Regression | Regression |
| Signed/notarized install | Credential-gated CI/manual | Credential-gated CI/manual | Existing release | Existing release |
| Clean-machine user smoke | Current Intel Mac | Required when device arrives | Existing support | Existing support |

## End-to-end scenarios

1. Fresh launch from Finder; create/import a project whose path contains spaces.
2. Start terminal, Claude, and Codex sessions; resize, reconnect, stop, and restore them.
3. Exercise Git status/diff/worktrees, file search, editor/external-open, browser, notes, and vault surfaces.
4. Install and refresh Claude/Codex integrations without losing unrelated config.
5. Close the Electron window and verify its process exits while the menu-bar host, Application Server, browser access, Runtime, and agents remain; reopen it repeatedly from **Open Soloe** and use standard macOS shortcuts.
6. Choose **Quit Soloe** and verify the tray, UI, Server, Runtime, PTYs, and agents stop; simulate a crash and confirm safe ownership recovery.
7. Install the correct DMG on a clean account and verify Gatekeeper, app data paths, upgrade, and uninstall behavior.

## Documentation updates after implementation

- Update README support claims and screenshots only after the relevant gates pass.
- Add macOS sections to install, troubleshooting, process model, release channels, public launch checklist, and known limitations.
- Document Intel/Apple-silicon downloads, unsigned local builds, signing requirements, Homebrew/login-shell discovery, permissions, and diagnostics.
- Record any remaining hardware-only Apple-silicon check as pending rather than presenting CI packaging as physical-device proof.

## Completion criteria

- All automated matrix jobs pass twice from clean caches.
- Intel end-to-end smoke passes on the current machine.
- Native arm64 CI package/PTY/tray smoke passes.
- No macOS-specific critical/high issues remain; lower-risk limitations are explicit in `docs/known-limitations.md`.
- Final Apple-silicon clean-machine smoke is either complete or clearly identified as the only post-delivery verification item.
