# Electron baseline — Linux under WSLg

Measured 2026-07-15 from the production build at base commit `fdcb70fbfac5`
plus the current native-Linux and renderer-backend worktree changes.

## Environment

- Soloe 0.1.0
- Electron 41.5.0 / Chrome 146.0.7680.216
- Node.js 22.22.2
- Linux x64, kernel `6.18.33.2-microsoft-standard-WSL2`
- WSLg display, 12 logical CPUs, 20,840,062,976 bytes host-visible memory
- Three startup runs; three usage samples 1.1 seconds apart; three-second idle settle
- 256 KiB configured output per terminal, with PTY newline expansion included in observed bytes

This is a native Linux application/PTY result, but it is not a bare-metal Linux
desktop result. Repeat on the supported Linux distributions before treating the
absolute figures as release gates.

## Startup and idle

| Measurement | Result |
| --- | ---: |
| Mounted startup median | 1,340.27 ms |
| Mounted startup p95 | 1,342.98 ms |
| Idle CPU median | 1.3% |
| Idle working-set median | 726.90 MiB |
| Idle processes | 8 total / 4 Electron / 4 child |

## Concurrent terminals

| PTYs | Spawn time | Input p95 | Settled CPU median | Working-set median | Output throughput | Max frame gap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 99.40 ms | 20.60 ms | 1.3% | 751.75 MiB | 15.10 MiB/s | 16.80 ms |
| 10 | 160.10 ms | 20.30 ms | 1.1% | 782.07 MiB | 13.85 MiB/s | 16.80 ms |
| 20 | 405.20 ms | 21.40 ms | 2.3% | 840.00 MiB | 12.05 MiB/s | 16.80 ms |

The stable frame gaps show that the benchmark listener itself does not overload
the renderer event loop. They do not prove that an xterm Terminal Presentation
can paint the same stream without lag. Rust-side comparisons must use this exact
transport benchmark; Electron-versus-Tauri renderer comparisons additionally
need a visible xterm paint benchmark on WebKitGTK and WebView2.

The complete local result is `benchmarks/results/electron-wslg-linux-baseline.json`
(ignored by Git because it is machine-specific).
