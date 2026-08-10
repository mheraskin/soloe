# Release channels

Soloe uses pre-release channels until platform packaging and upgrade behavior are proven.

| Channel | Purpose | Expected stability |
| --- | --- | --- |
| Nightly | Optional manual or main-branch artifacts | May be broken; no migration guarantee |
| Alpha | Public workflow and platform validation | Incomplete and unsigned; breaking changes possible |
| Beta | Installer and core workflows broadly usable | Fewer breaking changes; still pre-release |
| Stable | Signed and validated supported-platform release | Not available yet |

The newest alpha is the only supported version during the initial public period. Release notes should list platform requirements, security-relevant changes, migration steps, known issues, and rollback instructions. Checksums authenticate download integrity but do not replace platform code signing.
