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

The source is pinned to Ghostty revision
`426386b8579d5e558aa5d4cfdfb003ad06bc4fc5` in
`apps/desktop-tauri/src-tauri/libghostty-source.json`. Ghostty is MIT-licensed.
[cmux](https://github.com/manaflow-ai/cmux) is an architectural reference for a
native application embedding libghostty; no cmux source is copied and its GPL
license is not inherited.

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
Electron, browser, macOS, Windows, and failed native initialization continue to
use xterm. An explicit `xterm` preference remains the opt-out. The current GTK
renderer is deliberately a vertical slice, not a parity claim: styled GPU
rendering, selection, visual search results, links, IME, and robust Wayland
positioning remain incomplete. The running PTY is untouched by initialization
failure and output is recovered through the existing replay path.

The pinned Ghostty source also contains `libghostty-internal`, the surface
library used by Ghostty's macOS/iOS application. Upstream explicitly describes
that Interface as internal, platform-specific, and unsuitable for external
embedders. More importantly for Soloe, it creates and owns the terminal process
and does not expose a supported byte-stream input Interface for an externally
owned PTY. Using it would violate Environment Runtime ownership. The public
`libghostty-vt` Interface accepts the Environment Runtime's ordered PTY output,
so it is the correct foundation until upstream publishes an external native
surface Interface with manual I/O.

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
are covered by feature-gated Rust tests. The existing benchmark framework does
not yet instantiate shell-owned native surfaces, so it cannot produce an
honest xterm-versus-libghostty comparison yet. Before promoting the prototype,
extend that harness to record cold start, idle memory, input latency, burst
output, animated agent TUI behavior, resize, and terminal-count scaling for
both Implementations. No comparative number is reported until the same
workload paints both surfaces.
