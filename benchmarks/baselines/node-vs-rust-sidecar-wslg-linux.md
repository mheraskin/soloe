# Node PTY versus Rust sidecar — Linux under WSLg

Measured 2026-07-15 from the same production Electron build and base commit
`fdcb70f`, with only `SOLOE_TERMINAL_BACKEND` changed between sequential runs.
This is an initial directional comparison, not a release gate.

## Environment and workload

- Soloe 0.1.0, Electron 41.5.0, Node.js 22.22.2
- Linux x64, kernel `6.18.33.2-microsoft-standard-WSL2`
- WSLg display, 12 logical CPUs, 20,840,062,976 bytes host-visible memory
- Release Rust sidecar built with Rust 1.97.0 and `portable-pty` 0.9.0
- Three startup runs; three usage samples 1.1 seconds apart
- 256 KiB configured output per terminal; PTY newline expansion is included in observed bytes
- Node and Rust both traverse the same Electron IPC, preload, and renderer listener

## Results

| PTYs | Metric | Node | Rust | Rust delta |
| ---: | --- | ---: | ---: | ---: |
| 5 | Spawn | 51.8 ms | 67.6 ms | +30.5% |
| 5 | Input p95 | 18.5 ms | 19.1 ms | +3.2% |
| 5 | Output throughput | 20.94 MiB/s | 25.08 MiB/s | +19.8% |
| 5 | Settled CPU median | 0.7% | 0.9% | +0.2 pp |
| 5 | Working-set median | 751.58 MiB | 751.77 MiB | +0.0% |
| 10 | Spawn | 105.4 ms | 88.2 ms | -16.3% |
| 10 | Input p95 | 19.7 ms | 19.6 ms | -0.5% |
| 10 | Output throughput | 17.80 MiB/s | 22.59 MiB/s | +26.9% |
| 10 | Settled CPU median | 0.6% | 2.3% | +1.7 pp |
| 10 | Working-set median | 782.75 MiB | 787.63 MiB | +0.6% |
| 20 | Spawn | 260.1 ms | 345.1 ms | +32.7% |
| 20 | Input p95 | 19.6 ms | 26.6 ms | +35.7% |
| 20 | Output throughput | 16.30 MiB/s | 21.98 MiB/s | +34.8% |
| 20 | Settled CPU median | 0.3% | 4.8% | +4.5 pp |
| 20 | Working-set median | 847.41 MiB | 853.75 MiB | +0.7% |

Rust adds one sidecar process. Startup and idle measurements do not include it
because the adapter starts lazily with the first PTY. Both implementations held
renderer frame gaps at approximately 16.8 ms in this transport-only benchmark.

## Decision

Keep the Rust backend as an opt-in prototype. Its 20–35% burst-throughput gain
is substantial enough to continue investigating, but it does not yet justify a
Tauri shell migration: at 20 terminals it regressed p95 input latency by 35.7%,
used materially more settled CPU, and took longer to spawn and stop terminals.

Before another migration decision, profile the sidecar's per-PTY reader threads,
base64/JSON framing, and synchronous outbound queue under 20-terminal load. Then
repeat multiple alternating Node/Rust runs on native Linux and Windows, and add a
visible xterm paint-latency workload. A Rust transport win alone cannot establish
that WebKitGTK or WebView2 rendering will improve.

The complete machine-specific inputs are ignored local files:

- `benchmarks/results/electron-node-comparison.json`
- `benchmarks/results/electron-rust-comparison.json`
