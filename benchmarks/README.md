# Performance benchmarks

Soloe's migration benchmarks compare the Electron/Node PTY backend with the
opt-in Rust PTY sidecar behind the same renderer and Electron IPC Interface.
Run them on each target platform with the machine otherwise idle:

```bash
npm run benchmark:electron
npm run benchmark:rust
```

The command builds the production application, launches it with an isolated
temporary user-data directory, and writes a JSON result under
`benchmarks/results/`. Override the defaults when needed:

```bash
node scripts/benchmark-electron.mjs \
  --terminal-backend=node \
  --startup-iterations=5 \
  --terminal-counts=5,10,20 \
  --output-bytes=262144 \
  --usage-samples=3 \
  --idle-settle-ms=3000 \
  --output=benchmarks/results/my-machine.json
```

## Recorded measurements

- process spawn to mounted Svelte renderer;
- idle CPU, working-set memory, and process counts;
- PTY creation time for 5, 10, and 20 terminals;
- renderer-to-PTY-to-renderer input-marker latency;
- batched output throughput across all active terminals;
- renderer `requestAnimationFrame` gaps during the output burst;
- resource usage with each terminal count.

The terminal scenarios use native `bash` sessions and the same preload/backend
Interface as the application. They acquire explicit Terminal Output Demand, so
the output crosses node-pty, batching, Electron IPC, preload, and the renderer.
They do not claim to measure xterm paint latency: the benchmark listener consumes
events without attaching a Terminal Presentation. A Rust result can therefore
show backend/transport improvement, while a separate interactive or browser-
driven paint benchmark remains necessary before blaming or exonerating the
terminal renderer.

Run the Node backend and Rust sidecar with identical arguments on the same
machine. The Rust command builds the release sidecar before running. Keep raw
result files out of source control; publish selected comparison
fixtures only when the hardware, OS, WebView/Electron version, power state, and
benchmark configuration are recorded alongside them.

## Tauri comparison spike

`src-tauri/` is a deliberately thin comparison shell. It reuses the Svelte,
xterm, shared terminal protocol, and `soloe-terminal` crate, but it does not
claim application parity. Terminal output uses a Tauri channel rather than the
global event bus because channels are the streaming-oriented IPC primitive.

On Debian or Ubuntu, install Tauri's native prerequisites first:

```bash
sudo apt update
sudo apt install pkg-config libdbus-1-dev libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

Launch the interactive terminal laboratory:

```bash
npm run dev:tauri
```

Or build the release binary and run the automated 5/10/20-terminal comparison:

```bash
npm run benchmark:tauri
```

The automated workload is transport-only (`paintsXterm: false`) so it can be
compared with `benchmark:electron` and `benchmark:rust`. The interactive window's
1 MiB paint burst is the separate visible-xterm check. Repeat both on Linux
WebKitGTK and Windows WebView2 before making a shell-migration decision.
