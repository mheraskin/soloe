use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use soloe_terminal::TerminalManager;
use soloe_terminal::protocol::{
    InputRequest, Outbound, ResizeRequest, SidecarEvent, StartRequest, StartResponse,
    TerminalRequest,
};
use std::collections::{HashMap, VecDeque};
use std::process::Command as ProcessCommand;
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::ipc::Channel;

const OUTBOUND_QUEUE_DEPTH: usize = 256;

struct TerminalState {
    manager: TerminalManager,
    output_channel: Arc<Mutex<Option<Channel<SidecarEvent>>>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpikeInfo {
    cwd: String,
    shell: String,
    platform: &'static str,
    benchmark: bool,
    benchmark_started_at_ms: Option<u64>,
}

#[tauri::command]
fn spike_info() -> Result<SpikeInfo, String> {
    let cwd = std::env::current_dir()
        .map_err(|error| format!("failed to resolve current directory: {error}"))?
        .to_string_lossy()
        .into_owned();
    let shell = std::env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(windows) {
            "powershell.exe".to_string()
        } else {
            "/bin/bash".to_string()
        }
    });
    Ok(SpikeInfo {
        cwd,
        shell,
        platform: std::env::consts::OS,
        benchmark: std::env::var_os("SOLOE_TAURI_BENCHMARK_OUTPUT").is_some(),
        benchmark_started_at_ms: std::env::var("SOLOE_TAURI_STARTED_AT_MS")
            .ok()
            .and_then(|value| value.parse().ok()),
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageSnapshot {
    cpu_percent: f64,
    memory_bytes: u64,
    process_count: usize,
    sampled_at_ms: u128,
}

#[derive(Clone, Copy)]
struct ProcessRow {
    parent: u32,
    rss_kib: u64,
    cpu_percent: f64,
}

#[tauri::command]
fn spike_usage() -> Result<UsageSnapshot, String> {
    let rows = platform_process_rows()?;
    let selected = collect_process_tree(&rows, std::process::id());
    summarize_process_rows(&rows, &selected)
}

fn summarize_process_rows(
    rows: &HashMap<u32, ProcessRow>,
    selected: &[u32],
) -> Result<UsageSnapshot, String> {
    let (memory_bytes, cpu_percent) = selected.iter().fold((0_u64, 0_f64), |total, pid| {
        let Some(row) = rows.get(pid) else {
            return total;
        };
        (
            total.0.saturating_add(row.rss_kib.saturating_mul(1024)),
            total.1 + row.cpu_percent,
        )
    });
    let sampled_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("system clock is before Unix epoch: {error}"))?
        .as_millis();
    Ok(UsageSnapshot {
        cpu_percent: (cpu_percent * 10.0).round() / 10.0,
        memory_bytes,
        process_count: selected.len(),
        sampled_at_ms,
    })
}

#[cfg(not(windows))]
fn platform_process_rows() -> Result<HashMap<u32, ProcessRow>, String> {
    let output = ProcessCommand::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,pcpu="])
        .output()
        .map_err(|error| format!("failed to sample processes: {error}"))?;
    if !output.status.success() {
        return Err("process sampler exited unsuccessfully".to_string());
    }
    Ok(parse_process_rows(&String::from_utf8_lossy(&output.stdout)))
}

#[cfg(windows)]
fn platform_process_rows() -> Result<HashMap<u32, ProcessRow>, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct WindowsProcessRow {
        process_id: u32,
        parent_process_id: u32,
        working_set_size: u64,
    }

    let output = ProcessCommand::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize) | ConvertTo-Json -Compress",
        ])
        .output()
        .map_err(|error| format!("failed to sample Windows processes: {error}"))?;
    if !output.status.success() {
        return Err("Windows process sampler exited unsuccessfully".to_string());
    }
    let rows: Vec<WindowsProcessRow> = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("failed to parse Windows process sample: {error}"))?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.process_id,
                ProcessRow {
                    parent: row.parent_process_id,
                    rss_kib: row.working_set_size / 1024,
                    // PowerShell's cheap process inventory does not expose an
                    // interval CPU percentage. Windows comparison docs must
                    // treat this field as unavailable rather than as evidence.
                    cpu_percent: 0.0,
                },
            )
        })
        .collect())
}

#[tauri::command]
fn benchmark_complete(app: tauri::AppHandle, result: serde_json::Value) -> Result<(), String> {
    let output_path = std::env::var("SOLOE_TAURI_BENCHMARK_OUTPUT")
        .map_err(|_| "benchmark output path is not configured".to_string())?;
    let json = serde_json::to_string_pretty(&result)
        .map_err(|error| format!("failed to serialize benchmark: {error}"))?;
    std::fs::write(&output_path, format!("{json}\n"))
        .map_err(|error| format!("failed to write benchmark to {output_path}: {error}"))?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn terminal_subscribe(
    state: tauri::State<'_, TerminalState>,
    on_event: Channel<SidecarEvent>,
) -> Result<(), String> {
    *state
        .output_channel
        .lock()
        .map_err(|_| "terminal output channel lock poisoned".to_string())? = Some(on_event);
    Ok(())
}

#[tauri::command]
fn terminal_start(
    state: tauri::State<'_, TerminalState>,
    mut request: StartRequest,
) -> Result<StartResponse, String> {
    if request.env.is_empty() {
        request.env = std::env::vars().collect();
    }
    state.manager.start(request)
}

#[tauri::command]
fn terminal_input(
    state: tauri::State<'_, TerminalState>,
    request: InputRequest,
) -> Result<(), String> {
    let data = BASE64
        .decode(request.data_base64)
        .map_err(|error| format!("invalid input base64: {error}"))?;
    state.manager.write(&request.terminal_id, &data)
}

#[tauri::command]
fn terminal_resize(
    state: tauri::State<'_, TerminalState>,
    request: ResizeRequest,
) -> Result<(), String> {
    state
        .manager
        .resize(&request.terminal_id, request.cols, request.rows)
}

#[tauri::command]
fn terminal_stop(
    state: tauri::State<'_, TerminalState>,
    request: TerminalRequest,
) -> Result<(), String> {
    state.manager.stop(&request.terminal_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (outbound_tx, outbound_rx) = sync_channel::<Outbound>(OUTBOUND_QUEUE_DEPTH);
    let output_channel = Arc::new(Mutex::new(None::<Channel<SidecarEvent>>));
    let dispatch_channel = output_channel.clone();
    thread::Builder::new()
        .name("soloe-tauri-terminal-output".to_string())
        .spawn(move || {
            while let Ok(outbound) = outbound_rx.recv() {
                let Outbound::Event(event) = outbound else {
                    continue;
                };
                let channel = dispatch_channel
                    .lock()
                    .ok()
                    .and_then(|channel| channel.clone());
                if let Some(channel) = channel {
                    let _ = channel.send(event);
                }
            }
        })
        .expect("failed to start terminal output dispatcher");

    let terminal_state = TerminalState {
        manager: TerminalManager::new(outbound_tx),
        output_channel,
    };
    tauri::Builder::default()
        .manage(terminal_state)
        .invoke_handler(tauri::generate_handler![
            spike_info,
            spike_usage,
            benchmark_complete,
            terminal_subscribe,
            terminal_start,
            terminal_input,
            terminal_resize,
            terminal_stop
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager as _;
                window
                    .app_handle()
                    .state::<TerminalState>()
                    .manager
                    .shutdown(Duration::from_secs(3));
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Soloe Tauri spike");
}

fn parse_process_rows(output: &str) -> HashMap<u32, ProcessRow> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let parent = fields.next()?.parse().ok()?;
            let rss_kib = fields.next()?.parse().ok()?;
            let cpu_percent = fields.next()?.parse().ok()?;
            Some((
                pid,
                ProcessRow {
                    parent,
                    rss_kib,
                    cpu_percent,
                },
            ))
        })
        .collect()
}

fn collect_process_tree(rows: &HashMap<u32, ProcessRow>, root: u32) -> Vec<u32> {
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for (&pid, row) in rows {
        children.entry(row.parent).or_default().push(pid);
    }
    let mut selected = Vec::new();
    let mut queue = VecDeque::from([root]);
    while let Some(pid) = queue.pop_front() {
        if selected.contains(&pid) {
            continue;
        }
        selected.push(pid);
        queue.extend(children.remove(&pid).unwrap_or_default());
    }
    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_the_complete_process_tree() {
        let rows = parse_process_rows("10 1 100 0.1\n11 10 200 0.2\n12 11 300 0.3\n20 1 400 0.4\n");
        assert_eq!(collect_process_tree(&rows, 10), vec![10, 11, 12]);
    }
}
