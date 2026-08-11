# Soloe Tauri experiment

This package is an experimental desktop shell for the existing Svelte client.
It connects to the Node Application Server and does not own Sessions or PTYs.
Electron remains the supported desktop shell.

```sh
pnpm --filter @soloe/desktop-tauri dev
pnpm --filter @soloe/desktop-tauri build
```

On Linux these commands prepare the pinned Ghostty source, use Zig from `PATH`
or Nix, enable the native prototype, and select it through the default `auto`
preference after complete initialization. Other platforms and any failed native
initialization use xterm automatically.

## Linux libghostty vertical slice

The standard Linux Tauri dev/build scripts enable a Linux-only Cargo feature
that builds a native GTK3 terminal surface around the exact official
`libghostty-vt` revision in `src-tauri/libghostty-source.json`.
The pinned upstream MIT notice is retained in `src-tauri/libghostty-LICENSE`.

Prepare the pinned source with the authenticated GitHub CLI:

```sh
pnpm prepare:libghostty
```

Then build or test with Zig 0.16 on `PATH` and the prepared source path:

```sh
SOLOE_LIBGHOSTTY_SOURCE="$PWD/target/libghostty-source" \
  cargo test -p soloe-desktop-tauri --features libghostty-linux-prototype
```

Nix can provide the pinned revision's Zig version without installing it
globally:

```sh
nix shell nixpkgs#zig -c env \
  SOLOE_LIBGHOSTTY_SOURCE="$PWD/target/libghostty-source" \
  cargo build -p soloe-desktop-tauri --features libghostty-linux-prototype
```

The feature makes the capability available and fresh settings use `auto`, so a
successfully initialized Linux native host is selected by default. Choose
`xterm` in Settings to opt out. Direct builds without the feature and all
unsupported platforms safely fall back to xterm.

The Linux prototype creates a shell-owned GTK surface, associates it with a
Soloe Session, consumes replay/live PTY output, emits keyboard and paste input
back through the Renderer Backend Interface, resizes, focuses, hides/shows,
exports its buffer, and disposes independently from the PTY. It is not yet at
xterm parity: styled GPU rendering, selection, visual search results, links,
IME, and robust Wayland positioning remain incomplete.
