# Soloe Tauri experiment

This package is an experimental desktop shell for the existing Svelte client.
It connects to the Node Application Server and does not own Sessions or PTYs.
Electron remains the supported desktop shell.

```sh
pnpm --filter @soloe/desktop-tauri dev
pnpm --filter @soloe/desktop-tauri build
```

On Linux these commands prepare the pinned official Ghostty source. On macOS
they prepare the checksum-pinned GhosttyKit artifact. On Windows they publicly
clone and verify the pinned surface fork and build its full Win32/WGL renderer.
Each platform enables only its Native Terminal Host feature and selects it
only when `auto` or `libghostty` is selected and initialization completes.
Fresh settings temporarily default to xterm. Any failed native initialization
uses xterm automatically without touching the Session PTY.

## Windows full Ghostty surface

Install Zig 0.16.0 and Visual Studio 2022 Build Tools with **Desktop development
with C++**, then use the standard Tauri commands from Developer PowerShell:

```powershell
pnpm --filter @soloe/desktop-tauri dev
pnpm --filter @soloe/desktop-tauri build
```

The preparation script uses public HTTPS Git access, verifies the exact fork
revision, and builds `ghostty-internal.dll`; it does not require `gh` or a
GitHub login. The DLL is copied beside the Tauri executable. The host attaches
a child HWND above WebView2 and uses `GHOSTTY_SURFACE_IO_MANUAL`, so the
Environment Runtime remains the only PTY owner. OpenGL 4.3 is required. A
missing build toolchain stops the build with an actionable error. An
incompatible graphics driver or native surface creation failure is reported
and falls back to xterm without touching the Session PTY.

## Linux libghostty vertical slice

The standard Linux Tauri dev/build scripts enable a Linux-only Cargo feature
that builds a native GTK3 terminal surface around the exact official
`libghostty-vt` revision in `src-tauri/libghostty-source.json`.
The pinned upstream MIT notice is retained in `src-tauri/libghostty-LICENSE`.

Prepare the pinned source over public HTTPS Git access:

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

The feature makes the capability available. Choose `auto` or `libghostty` in
Settings to exercise it; fresh settings temporarily use xterm. Direct builds
without the feature and all unsupported platforms safely fall back to xterm.

The Linux prototype creates a shell-owned GTK surface, associates it with a
Soloe Session, consumes replay/live PTY output, emits keyboard and paste input
back through the Renderer Backend Interface, resizes, focuses, hides/shows,
exports its buffer, and disposes independently from the PTY. It is not yet at
xterm parity: styled GPU rendering, selection, visual search results, links,
IME, and robust Wayland positioning remain incomplete.
