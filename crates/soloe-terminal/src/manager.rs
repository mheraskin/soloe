use crate::batching::{
    DEFAULT_BATCH_INTERVAL, DEFAULT_MAX_BATCH_BYTES, OutputBatch, OutputBatcher,
};
use crate::protocol::{
    ExitEvent, Outbound, OutputEvent, SidecarEvent, StartRequest, StartResponse,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError, SyncSender, sync_channel};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const READ_BUFFER_BYTES: usize = 64 * 1024;
const READ_QUEUE_DEPTH: usize = 8;

type EventSink = SyncSender<Outbound>;

struct TerminalHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
}

struct Inner {
    terminals: Mutex<HashMap<String, Arc<TerminalHandle>>>,
    terminals_changed: Condvar,
}

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Inner>,
    events: EventSink,
    batch_interval: Duration,
    max_batch_bytes: usize,
}

impl TerminalManager {
    pub fn new(events: EventSink) -> Self {
        Self::with_batching(events, DEFAULT_BATCH_INTERVAL, DEFAULT_MAX_BATCH_BYTES)
    }

    pub fn with_batching(
        events: EventSink,
        batch_interval: Duration,
        max_batch_bytes: usize,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                terminals: Mutex::new(HashMap::new()),
                terminals_changed: Condvar::new(),
            }),
            events,
            batch_interval,
            max_batch_bytes,
        }
    }

    pub fn start(&self, request: StartRequest) -> Result<StartResponse, String> {
        validate_start(&request)?;
        {
            let terminals = self.lock_terminals()?;
            if terminals.contains_key(&request.terminal_id) {
                return Err(format!("terminal already exists: {}", request.terminal_id));
            }
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: request.rows,
                cols: request.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("failed to open PTY: {error:#}"))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("failed to clone PTY reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("failed to take PTY writer: {error}"))?;

        let mut command = CommandBuilder::new(&request.file);
        command.args(&request.args);
        command.cwd(&request.cwd);
        command.env_clear();
        for (key, value) in &request.env {
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("failed to spawn PTY process: {error:#}"))?;
        let pid = child
            .process_id()
            .ok_or_else(|| "PTY process did not expose a process id".to_string())?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let handle = Arc::new(TerminalHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
        });
        self.lock_terminals()?
            .insert(request.terminal_id.clone(), handle);

        let (output_tx, output_rx) = sync_channel::<Vec<u8>>(READ_QUEUE_DEPTH);
        let reader_thread = thread::Builder::new()
            .name(format!("soloe-pty-read-{}", request.terminal_id))
            .spawn(move || {
                let mut buffer = vec![0_u8; READ_BUFFER_BYTES];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            if output_tx.send(buffer[..read].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })
            .map_err(|error| format!("failed to start PTY reader: {error}"))?;

        let batch_terminal_id = request.terminal_id.clone();
        let batch_session_id = request.session_id.clone();
        let batch_events = self.events.clone();
        let batch_interval = self.batch_interval;
        let max_batch_bytes = self.max_batch_bytes;
        let batch_thread = thread::Builder::new()
            .name(format!("soloe-pty-batch-{}", request.terminal_id))
            .spawn(move || {
                run_batcher(
                    output_rx,
                    batch_events,
                    batch_terminal_id,
                    batch_session_id,
                    batch_interval,
                    max_batch_bytes,
                );
            })
            .map_err(|error| format!("failed to start PTY batcher: {error}"))?;

        let supervisor_inner = self.inner.clone();
        let supervisor_events = self.events.clone();
        let terminal_id = request.terminal_id.clone();
        let session_id = request.session_id.clone();
        thread::Builder::new()
            .name(format!("soloe-pty-wait-{}", request.terminal_id))
            .spawn(move || {
                let status = child.wait();
                let _ = reader_thread.join();
                let _ = batch_thread.join();
                if let Ok(mut terminals) = supervisor_inner.terminals.lock() {
                    terminals.remove(&terminal_id);
                    supervisor_inner.terminals_changed.notify_all();
                }
                let (exit_code, signal_name) = match status {
                    Ok(status) => (status.exit_code(), status.signal().map(str::to_owned)),
                    Err(_) => (1, None),
                };
                let _ = supervisor_events.send(Outbound::Event(SidecarEvent::Exit(ExitEvent {
                    terminal_id,
                    session_id,
                    exit_code,
                    signal_name,
                })));
            })
            .map_err(|error| format!("failed to start PTY supervisor: {error}"))?;

        Ok(StartResponse {
            terminal_id: request.terminal_id,
            session_id: request.session_id,
            pid,
        })
    }

    pub fn write(&self, terminal_id: &str, data: &[u8]) -> Result<(), String> {
        let handle = self.get(terminal_id)?;
        let mut writer = handle
            .writer
            .lock()
            .map_err(|_| "PTY writer lock poisoned".to_string())?;
        writer
            .write_all(data)
            .and_then(|_| writer.flush())
            .map_err(|error| format!("failed to write PTY input: {error}"))
    }

    pub fn resize(&self, terminal_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        if cols == 0 || rows == 0 {
            return Err("terminal dimensions must be positive".to_string());
        }
        let handle = self.get(terminal_id)?;
        let master = handle
            .master
            .lock()
            .map_err(|_| "PTY master lock poisoned".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("failed to resize PTY: {error}"))
    }

    pub fn stop(&self, terminal_id: &str) -> Result<(), String> {
        let handle = self.get(terminal_id)?;
        let mut killer = handle
            .killer
            .lock()
            .map_err(|_| "PTY killer lock poisoned".to_string())?;
        killer
            .kill()
            .map_err(|error| format!("failed to stop PTY: {error}"))
    }

    pub fn shutdown(&self, timeout: Duration) {
        let handles = self
            .lock_terminals()
            .map(|terminals| terminals.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for handle in handles {
            if let Ok(mut killer) = handle.killer.lock() {
                let _ = killer.kill();
            }
        }

        let deadline = Instant::now() + timeout;
        let Ok(mut terminals) = self.inner.terminals.lock() else {
            return;
        };
        while !terminals.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let Ok((next, _)) = self
                .inner
                .terminals_changed
                .wait_timeout(terminals, deadline - now)
            else {
                break;
            };
            terminals = next;
        }
    }

    fn get(&self, terminal_id: &str) -> Result<Arc<TerminalHandle>, String> {
        self.lock_terminals()?
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| format!("terminal not found: {terminal_id}"))
    }

    fn lock_terminals(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<TerminalHandle>>>, String> {
        self.inner
            .terminals
            .lock()
            .map_err(|_| "terminal registry lock poisoned".to_string())
    }
}

fn validate_start(request: &StartRequest) -> Result<(), String> {
    if request.terminal_id.trim().is_empty() || request.session_id.trim().is_empty() {
        return Err("terminalId and sessionId are required".to_string());
    }
    if request.file.trim().is_empty() || request.cwd.trim().is_empty() {
        return Err("file and cwd are required".to_string());
    }
    if request.cols == 0 || request.rows == 0 {
        return Err("terminal dimensions must be positive".to_string());
    }
    Ok(())
}

fn run_batcher(
    receiver: Receiver<Vec<u8>>,
    events: EventSink,
    terminal_id: String,
    session_id: String,
    interval: Duration,
    max_batch_bytes: usize,
) {
    let mut batcher = OutputBatcher::new(interval, max_batch_bytes);
    loop {
        let message = if batcher.is_empty() {
            receiver.recv().map_err(|_| RecvTimeoutError::Disconnected)
        } else {
            let timeout = batcher
                .deadline()
                .map(|deadline| deadline.saturating_duration_since(Instant::now()))
                .unwrap_or(interval);
            receiver.recv_timeout(timeout)
        };

        match message {
            Ok(data) => {
                for batch in batcher.push(&data, Instant::now()) {
                    if !emit_batch(&events, &terminal_id, &session_id, batch) {
                        return;
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if let Some(batch) = batcher.flush_due(Instant::now())
                    && !emit_batch(&events, &terminal_id, &session_id, batch)
                {
                    return;
                }
            }
            Err(RecvTimeoutError::Disconnected) => {
                if let Some(batch) = batcher.flush() {
                    let _ = emit_batch(&events, &terminal_id, &session_id, batch);
                }
                return;
            }
        }
    }
}

fn emit_batch(events: &EventSink, terminal_id: &str, session_id: &str, batch: OutputBatch) -> bool {
    events
        .send(Outbound::Event(SidecarEvent::Output(OutputEvent {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
            data_base64: BASE64.encode(batch.data),
            seq: batch.seq,
        })))
        .is_ok()
}
