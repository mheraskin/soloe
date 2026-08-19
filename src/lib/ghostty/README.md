# Ghostty web terminal

This directory is adapted from T3 Code's MIT-licensed browser terminal at
`apps/web/src/terminal/ghostty`, commit
`82b8a9380298509d68170961d9717be62836e490`. It uses the official
`libghostty-vt` C ABI and is intentionally not an xterm compatibility layer.

Soloe keeps the T3 module structure and behavior. Local adaptations isolate
font/platform/link helpers, expose full-buffer text, and host the surface from
Svelte. `LICENSE.t3` preserves the source license.

- `runtime.ts` owns the singleton WebAssembly instance and runtime ABI layouts.
- `ghostty-write-pty.wasm` is a 112-byte callback trampoline for terminal-generated PTY replies.
- `core.ts` owns per-terminal Ghostty handles and translates the C ABI into render snapshots.
- `renderer.ts` batches backgrounds and style runs into a Canvas 2D frame.
- `surface.ts` owns browser input, IME, selection, scrolling, sizing, links, and cursor blinking.
- `fonts/` vendors the symbols-only Nerd Font (MIT) the surface registers lazily, so
  prompt glyphs render without a locally installed Nerd Font.
- `vendor/` holds the T3-built artifacts from Ghostty revision
  `9f62873bf195e4d8a762d768a1405a5f2f7b1697` and Ghostty's license.

Keep browser behavior here and terminal transport in `terminal-session.ts`.
Both WASM artifacts are ordinary read-only assets, not native executables.
