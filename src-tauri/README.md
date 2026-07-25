# Soloe Tauri comparison shell

This directory is an evidence-gathering shell, not a second implementation of
Soloe. It stays thin by owning only Tauri setup, commands, process-tree sampling,
and the terminal channel bridge. PTY lifecycle and output batching remain in
`../crates/soloe-terminal`; frontend protocol types remain in `../shared`.

The comparison surface is `../src/tauri-benchmark/`. It supports:

- one interactive xterm terminal for WebKitGTK/WebView2 rendering checks;
- a visible 1 MiB paint burst with live frame-gap metrics;
- an automated transport benchmark matching the Electron terminal counts and
  output volume;
- release binary size, mounted startup, idle resource, latency, throughput, and
  process-count recording.

Electron remains the default application shell. Do not move application logic
into this crate or add general backend parity until the cross-platform results
justify continuing the migration.
