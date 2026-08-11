# Terminal Presentation Module

The Terminal Presentation Module separates renderer-side terminal behavior
from every process and transport boundary. Its purpose is not to move PTYs. It
creates a deep, shell-neutral Interface around the behavior TerminalPane
actually needs, while keeping xterm and native terminal details local to their
Implementations.

```text
Environment Runtime
  PTY + replay + input + resize + stop + semantic observation
             |
             | Application Server / Electron IPC
             v
Renderer Backend Interface
  ordered Terminal Replay Tail + live output + Terminal Output Demand
             |
             v
Terminal Presentation Interface
  mount, output, selection, search, clipboard, bounds, focus, configuration
             |
             +-- XtermTerminalPresentationAdapter
             |
             `-- LibghosttyTerminalPresentationAdapter
                    |
                    `-- Native Terminal Host (shell-side)
```

## Ownership

The Environment Runtime remains the exclusive owner of PTY creation, replay,
input, resize, stop, terminal identity, and Terminal Semantic Observation. A
Terminal Presentation is disposable renderer residency for one running
Session. Closing Electron, Tauri, a browser, TerminalPane, or a native surface
does not stop the PTY.

The Renderer Backend Interface remains transport-neutral. Electron, the
ordinary browser, and Tauri satisfy it through separate Renderer Backend
Adapters. Terminal Output Demand and Terminal Replay Tail ordering remain in
`TerminalOutputRouter`; Presentation Adapters receive an already serialized
`replace`/`write` stream.

The Terminal Presentation Interface owns:

- attachment and disposal;
- focus, visibility, bounds, fit, and dormant presentation resources;
- ordered output writes and replay replacement;
- terminal input, selection changes, search, paste, and complete-buffer export;
- font, theme, cursor, Unicode, and scrollback configuration;
- link activation and renderer failure reporting;
- keyboard routing needed by terminal shortcuts and Ask Agent.

It deliberately exposes no xterm `Terminal`, addon, renderer DOM, Tauri
command, native surface handle, Ghostty type, Zig type, or C type. That Locality
keeps the Seam useful even if the Tauri experiment is deleted.

## Xterm Implementation

`XtermTerminalPresentationAdapter` is the production-ready fallback Adapter in
Electron, Tauri WebView2, Tauri WKWebView, WebKitGTK, and an ordinary browser.
It owns xterm construction and addons: fit, lazy search, WebLinks, Unicode 11,
clipboard, WebGL, and Canvas. WebGL context loss falls back to Canvas; Canvas
failure leaves xterm's DOM renderer available. Hidden presentations release
renderers, font listeners, observers, and fit work while output recovery stays
owned by `TerminalOutputRouter`.

The ordinary browser always selects xterm. This is true even if a stored
preference requests `libghostty` or `auto`.

## Experimental libghostty Implementation

`LibghosttyTerminalPresentationAdapter` is a thin renderer-side control Adapter
for a shell-owned native surface. `NativeTerminalHost` is the stable boundary
above platform-specific surface ownership. A future macOS AppKit, Windows,
Linux, Tauri, or Electron host can implement it without changing TerminalPane.

Soloe has two independently pinned Ghostty integrations. Linux uses official
Ghostty revision `426386b8579d5e558aa5d4cfdfb003ad06bc4fc5`, recorded in
`apps/desktop-tauri/src-tauri/libghostty-source.json`. macOS uses the exact
MIT-licensed `manaflow-ai/ghostty` revision
`f76c132e526f124fe4aaebd39f516751656844bc`, release tag, and SHA-256 recorded
in `apps/desktop-tauri/src-tauri/ghostty-surface-source.json`. The latter fork
adds an unversioned manual-I/O surface Interface that upstream Ghostty does not
yet expose.

[cmux](https://github.com/manaflow-ai/cmux) is the architectural reference for
embedding a full Ghostty AppKit/Metal surface. Soloe does not copy cmux Swift or
application code and does not inherit its GPL license. Soloe independently
implements its Native Terminal Host against the fork's MIT-licensed C API.

The standard Linux Tauri dev/build scripts prepare the pinned source and enable
the Linux-only `libghostty-linux-prototype` Cargo feature. It adds the first
real vertical slice.
It builds the exact official `libghostty-vt` C API revision, keeps the Zig/C
FFI behind a small C bridge, and uses a Soloe-owned native GTK3 surface. That
surface associates itself with one Session, consumes ordered replay/live PTY
output, emits keyboard and paste input back through the Renderer Backend
Interface, resizes, focuses, hides/shows, exports its buffer, and disposes
without touching the PTY.

Fresh settings select `auto`. A feature-enabled Linux Tauri host therefore
uses the native Adapter after the host initializes successfully; direct Cargo,
Electron, browser, Windows, and failed native initialization continue to use
xterm. An explicit `xterm` preference remains the opt-out. The current GTK
renderer is deliberately a vertical slice, not a parity claim: styled GPU
rendering, selection, visual search results, links, IME, and robust Wayland
positioning remain incomplete. The running PTY is untouched by initialization
failure and output is recovered through the existing replay path.

### macOS full Ghostty surface

Standard macOS Tauri commands download and checksum the pinned universal
GhosttyKit XCFramework, enable `libghostty-macos-surface`, and attach a child
AppKit view above the WKWebView terminal placeholder. The Native Terminal Host
creates `ghostty_surface` with `GHOSTTY_SURFACE_IO_MANUAL`. It never supplies a
command, working directory, environment, or PTY.

The manual-I/O mode is the architectural hinge. Ordered Terminal Replay Tail
and live PTY bytes enter through `ghostty_surface_process_output`. Ghostty owns
terminal protocol parsing and full AppKit/Metal rendering, then returns encoded
keyboard input and parser replies through `io_write_cb`. The callback follows
the existing `soloe://native-terminal-input` event and Renderer Backend
Interface back to the Environment Runtime-owned PTY. `MANUAL_MIRROR` is not
used because it suppresses parser replies and assumes a second terminal core
outside Ghostty.

Bounds, real Ghostty grid dimensions, focus, occlusion, mouse input, selection,
link actions, clipboard paste, buffer export, and disposal stay behind the
Native Terminal Host. `replace` frees and recreates the Ghostty surface under
the same Soloe presentation identity before injecting replay, because the fork
does not expose a complete terminal-state reset. Surface disposal releases
only presentation resources and never stops the Session PTY.

This is a real full-renderer vertical slice, not a cross-platform parity claim.
IME/preedit, native visual search highlighting, complete Ghostty configuration
mapping, app-level shortcut arbitration, and macOS runtime/packaging validation
remain before promotion. A macOS initialization or surface-creation failure
falls back to xterm while the running Session and replay remain intact.

Upstream's pinned full surface library is still described as internal and its
normal surface creates and owns the terminal process. The pinned MIT fork is
used specifically because its manual-I/O extension removes that ownership
conflict. The Linux prototype continues using public `libghostty-vt`; it does
not pretend its Soloe-owned Cairo view is Ghostty's renderer.

`libghostty-vt` WebAssembly is not a complete browser presentation. It provides
terminal parsing/state but still requires a separately implemented browser
renderer. It is not used to pretend that libghostty can render directly into a
DOM element.

## Selection and fallback

The Terminal settings vocabulary accepts:

- `xterm`: always use the xterm Adapter;
- `auto`: try a complete Native Terminal Host on a desktop shell, otherwise
  use xterm;
- `libghostty`: request the experimental native Adapter, with the same safe
  fallback when capability discovery or initialization fails.

`auto` is the default for fresh settings. It changes selection only; it never
changes Session or PTY ownership.

The factory does not select a native Adapter merely because a shell command
exists. The Native Terminal Host must report both `available` and `complete`,
and surface initialization must succeed. Failed initialization disposes the
partial native surface before xterm is created.

## Depth, leverage, and testing

The Interface has Depth because it hides renderer initialization, addons,
selection mechanics, resource residency, and native control behind a compact
behavioral contract. Its Leverage is that TerminalPane, Ask Agent, output
recovery, and every client shell use the same vocabulary without knowing the
Implementation.

Factory tests cover capability selection and fallback. Native Adapter contract
tests cover initialization, bounds, output/replay, selection, search, paste,
buffer export, visibility, focus, and disposal. Existing
`TerminalOutputRouter` and terminal-input tests remain authoritative for replay
ordering, live output admission, dormant behavior, and agent TUI input.

The GTK lifecycle and pinned `libghostty-vt` write/resize/replace/export path
are covered by feature-gated Rust tests. The macOS source revision, release
artifact checksum, build feature, callback lifetime, and shell-neutral FFI are
pinned in the repository, but AppKit/Metal behavior cannot be executed from the
Linux/WSL development host.

The existing benchmark framework does not yet instantiate the macOS native
surface, so it cannot produce an honest xterm-versus-Ghostty comparison yet.
Before promotion, extend that harness on macOS to record cold start, idle
memory, input latency, burst output, animated agent TUI behavior, resize, and
terminal-count scaling for both Implementations. No comparative number is
reported until the same workload paints both surfaces.
