use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct ServiceInfo {
    pub service: String,
    pub pid: u32,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
struct StoredSettings {
    #[serde(default)]
    backend: BackendSettings,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum BackendPlacement {
    Windows,
    Wsl,
}

impl Default for BackendPlacement {
    fn default() -> Self {
        Self::Windows
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BackendSettings {
    #[serde(default)]
    placement: BackendPlacement,
    #[serde(default = "default_wsl_distro")]
    wsl_distro: String,
    #[serde(default)]
    wsl_repository_root: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ActiveBackend {
    placement: BackendPlacement,
    #[serde(default)]
    wsl_distro: String,
    #[serde(default)]
    wsl_repository_root: String,
}

impl From<BackendSettings> for ActiveBackend {
    fn from(settings: BackendSettings) -> Self {
        Self {
            placement: settings.placement,
            wsl_distro: settings.wsl_distro,
            wsl_repository_root: settings.wsl_repository_root,
        }
    }
}

trait ProcessOperations: Send + Sync {
    fn is_running(&self, pid: u32, backend: &ActiveBackend) -> bool;
    fn terminate(&self, pid: u32, force: bool, backend: &ActiveBackend) -> Result<(), String>;
}

struct SystemProcessOperations;

impl ProcessOperations for SystemProcessOperations {
    fn is_running(&self, pid: u32, backend: &ActiveBackend) -> bool {
        is_pid_running(pid, backend)
    }

    fn terminate(&self, pid: u32, force: bool, backend: &ActiveBackend) -> Result<(), String> {
        terminate_pid(pid, force, backend)
    }
}

#[derive(Clone)]
pub struct BackendSupervisor {
    repository_root: PathBuf,
    data_directory: PathBuf,
    processes: Arc<dyn ProcessOperations>,
}

impl BackendSupervisor {
    pub fn discover() -> Self {
        Self {
            repository_root: repository_root(),
            data_directory: data_directory(),
            processes: Arc::new(SystemProcessOperations),
        }
    }

    #[cfg(test)]
    fn new(
        repository_root: PathBuf,
        data_directory: PathBuf,
        processes: Arc<dyn ProcessOperations>,
    ) -> Self {
        Self {
            repository_root,
            data_directory,
            processes,
        }
    }

    pub fn status_label(&self) -> String {
        let backend = self.backend_for_existing_services();
        let host = match backend.placement {
            BackendPlacement::Windows => "Windows",
            BackendPlacement::Wsl => "WSL",
        };
        if self.is_running_on("runtime", &backend) && self.is_running_on("server", &backend) {
            format!("Backend: running on {host}")
        } else if self.is_running_on("runtime", &backend) {
            format!("Backend: runtime only on {host}")
        } else {
            format!("Backend: stopped ({host} selected)")
        }
    }

    pub fn start(&self) -> Result<(), String> {
        fs::create_dir_all(&self.data_directory)
            .map_err(|error| format!("failed to create Soloe data directory: {error}"))?;
        let configured: ActiveBackend = self.configured_backend()?.into();
        if let Some(active) = self.read_active_backend() {
            let has_running_service =
                self.is_running_on("runtime", &active) || self.is_running_on("server", &active);
            if has_running_service && active != configured {
                return Err(
                    "backend placement changed while services are running; stop the backend first"
                        .to_string(),
                );
            }
        }
        let backend = configured;
        self.validate_backend(&backend)?;
        self.write_active_backend(&backend)?;

        if !self.is_running_on("runtime", &backend) {
            self.spawn_workspace("@soloe/runtime", "runtime", &backend)?;
            self.wait_until("runtime", true, START_TIMEOUT, &backend)?;
        }
        if !self.is_running_on("server", &backend) {
            self.spawn_workspace("@soloe/server", "server", &backend)?;
            self.wait_until("server", true, START_TIMEOUT, &backend)?;
        }
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let backend = self.backend_for_existing_services();
        let mut failures = Vec::new();
        for service in ["server", "runtime"] {
            if let Err(error) = self.stop_service(service, &backend) {
                failures.push(format!("{service}: {error}"));
            }
        }
        if !self.is_running_on("server", &backend) && !self.is_running_on("runtime", &backend) {
            self.remove_active_backend();
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "backend cleanup incomplete; {}",
                failures.join("; ")
            ))
        }
    }

    pub fn browser_address(&self) -> Option<String> {
        let backend = self.backend_for_existing_services();
        self.read_info("server")
            .filter(|info| is_pid_running(info.pid, &backend))
            .and_then(|info| {
                let address = info.address?;
                let token = info.token?;
                Some(format!("{address}/?token={token}"))
            })
    }

    pub fn open_browser(&self) -> Result<(), String> {
        let address = self
            .browser_address()
            .ok_or_else(|| "Soloe server is not running".to_string())?;
        open_target(&address)
    }

    pub fn open_electron(&self) -> Result<(), String> {
        let info = self
            .read_info("server")
            .ok_or_else(|| "Soloe server is not running".to_string())?;
        let address = info
            .address
            .ok_or_else(|| "Soloe server did not publish an address".to_string())?;
        let token = info
            .token
            .ok_or_else(|| "Soloe server did not publish an access token".to_string())?;
        let client_url = format!("{address}/?token={token}");

        let mut command = Command::new(pnpm_executable());
        command
            .args(["--filter", "@soloe/desktop-electron", "dev"])
            .current_dir(&self.repository_root)
            .env("SOLOE_CLIENT_SERVER_URL", client_url)
            .env("SOLOE_SERVER_TOKEN", token)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to open Electron client: {error}"))
    }

    fn configured_backend(&self) -> Result<BackendSettings, String> {
        let settings_path = self.data_directory.join("settings.json");
        let mut backend = match fs::read(&settings_path) {
            Ok(data) => {
                serde_json::from_slice::<StoredSettings>(&data)
                    .map_err(|error| {
                        format!("failed to read {}: {error}", settings_path.display())
                    })?
                    .backend
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                BackendSettings::default()
            }
            Err(error) => {
                return Err(format!(
                    "failed to read {}: {error}",
                    settings_path.display()
                ));
            }
        };
        if let Some(value) = env::var_os("SOLOE_BACKEND_PLACEMENT") {
            backend.placement = match value.to_string_lossy().to_ascii_lowercase().as_str() {
                "windows" => BackendPlacement::Windows,
                "wsl" => BackendPlacement::Wsl,
                other => return Err(format!("invalid SOLOE_BACKEND_PLACEMENT: {other}")),
            };
        }
        if let Ok(value) = env::var("SOLOE_WSL_DISTRO") {
            if !value.trim().is_empty() {
                backend.wsl_distro = value.trim().to_string();
            }
        }
        if let Ok(value) = env::var("SOLOE_WSL_REPO_ROOT") {
            backend.wsl_repository_root = value.trim().to_string();
        }
        Ok(backend)
    }

    fn validate_backend(&self, backend: &ActiveBackend) -> Result<(), String> {
        if backend.placement == BackendPlacement::Wsl {
            if backend.wsl_distro.trim().is_empty() {
                return Err("WSL backend requires a distribution name".to_string());
            }
            if !backend.wsl_repository_root.starts_with('/') {
                return Err(
                    "WSL backend requires an absolute repository path in Settings".to_string(),
                );
            }
        }
        Ok(())
    }

    fn spawn_workspace(
        &self,
        workspace: &str,
        service: &str,
        backend: &ActiveBackend,
    ) -> Result<(), String> {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_directory.join(format!("{service}.log")))
            .map_err(|error| format!("failed to open {service} log: {error}"))?;
        let error_log = log
            .try_clone()
            .map_err(|error| format!("failed to clone {service} log: {error}"))?;

        let mut command = match backend.placement {
            BackendPlacement::Windows => {
                let mut command = Command::new(pnpm_executable());
                command
                    .args(["--filter", workspace, "start"])
                    .current_dir(&self.repository_root)
                    .env("SOLOE_DATA_DIR", &self.data_directory);
                command
            }
            BackendPlacement::Wsl => {
                let data_directory = self.wsl_path(&backend.wsl_distro, &self.data_directory)?;
                let script =
                    wsl_start_script(&backend.wsl_repository_root, &data_directory, workspace);
                let mut command = Command::new("wsl.exe");
                command.args([
                    "--distribution",
                    &backend.wsl_distro,
                    "--exec",
                    "bash",
                    "-lc",
                    &script,
                ]);
                command
            }
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to start {workspace}: {error}"))
    }

    fn wsl_path(&self, distro: &str, windows_path: &Path) -> Result<String, String> {
        let output = Command::new("wsl.exe")
            .args([
                "--distribution",
                distro,
                "--exec",
                "wslpath",
                "-a",
                &windows_path.to_string_lossy(),
            ])
            .output()
            .map_err(|error| format!("failed to translate the Soloe data path for WSL: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "WSL could not translate the Soloe data path: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let translated = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if translated.is_empty() {
            return Err("WSL returned an empty Soloe data path".to_string());
        }
        Ok(translated)
    }

    fn stop_service(&self, service: &str, backend: &ActiveBackend) -> Result<(), String> {
        let Some(info) = self.read_info(service) else {
            return Ok(());
        };
        if info.service != service || !self.processes.is_running(info.pid, backend) {
            self.remove_stale_info(service);
            return Ok(());
        }

        let graceful = self.processes.terminate(info.pid, false, backend);
        if let Err(error) = &graceful {
            eprintln!(
                "[tray] graceful shutdown failed for {service} (PID {}): {error}; forcing cleanup",
                info.pid
            );
        } else if self
            .wait_until(service, false, STOP_TIMEOUT, backend)
            .is_ok()
        {
            self.remove_stale_info(service);
            return Ok(());
        }

        let forced = self.processes.terminate(info.pid, true, backend);
        if let Err(error) = forced
            && self.processes.is_running(info.pid, backend)
        {
            return Err(format!(
                "forced shutdown failed for PID {} after graceful shutdown {}: {error}",
                info.pid,
                if graceful.is_ok() {
                    "timed out"
                } else {
                    "failed"
                }
            ));
        }
        self.wait_until(service, false, STOP_TIMEOUT, backend)?;
        self.remove_stale_info(service);
        Ok(())
    }

    fn wait_until(
        &self,
        service: &str,
        expected_running: bool,
        timeout: Duration,
        backend: &ActiveBackend,
    ) -> Result<(), String> {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if self.is_running_on(service, backend) == expected_running {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(100));
        }
        Err(format!(
            "timed out waiting for {service} to become {}; see {}",
            if expected_running { "ready" } else { "stopped" },
            self.data_directory.join(format!("{service}.log")).display()
        ))
    }

    fn is_running_on(&self, service: &str, backend: &ActiveBackend) -> bool {
        self.read_info(service).is_some_and(|info| {
            info.service == service && self.processes.is_running(info.pid, backend)
        })
    }

    fn backend_for_existing_services(&self) -> ActiveBackend {
        self.read_active_backend()
            .unwrap_or_else(|| self.configured_backend().unwrap_or_default().into())
    }

    fn active_backend_path(&self) -> PathBuf {
        self.data_directory.join("active-backend.json")
    }

    fn read_active_backend(&self) -> Option<ActiveBackend> {
        serde_json::from_slice(&fs::read(self.active_backend_path()).ok()?).ok()
    }

    fn write_active_backend(&self, backend: &ActiveBackend) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(backend)
            .map_err(|error| format!("failed to serialize active backend: {error}"))?;
        fs::write(self.active_backend_path(), payload)
            .map_err(|error| format!("failed to remember active backend: {error}"))
    }

    fn remove_active_backend(&self) {
        let _ = fs::remove_file(self.active_backend_path());
    }

    fn read_info(&self, service: &str) -> Option<ServiceInfo> {
        let data = fs::read(self.data_directory.join(format!("{service}.json"))).ok()?;
        serde_json::from_slice(&data).ok()
    }

    fn remove_stale_info(&self, service: &str) {
        let _ = fs::remove_file(self.data_directory.join(format!("{service}.json")));
    }
}

fn default_wsl_distro() -> String {
    "Ubuntu".to_string()
}

fn wsl_start_script(repository_root: &str, data_directory: &str, workspace: &str) -> String {
    format!(
        "cd -- {} && mkdir -p \"$HOME/.local/state/soloe\" && \
         export SOLOE_DATA_DIR={} && \
         export SOLOE_RUNTIME_ENDPOINT=\"$HOME/.local/state/soloe/runtime.sock\" && \
         exec pnpm --filter {} start",
        shell_quote(repository_root),
        shell_quote(data_directory),
        shell_quote(workspace),
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn repository_root() -> PathBuf {
    env::var_os("SOLOE_REPO_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(3)
                .expect("tray crate must live under apps/tray/src-tauri")
                .to_path_buf()
        })
}

fn data_directory() -> PathBuf {
    if let Some(directory) = env::var_os("SOLOE_DATA_DIR") {
        return PathBuf::from(directory);
    }
    #[cfg(target_os = "windows")]
    {
        return PathBuf::from(env::var_os("LOCALAPPDATA").unwrap_or_else(|| ".".into()))
            .join("Soloe");
    }
    #[cfg(target_os = "macos")]
    {
        return PathBuf::from(env::var_os("HOME").unwrap_or_else(|| ".".into()))
            .join("Library")
            .join("Application Support")
            .join("Soloe");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env::var_os("HOME").unwrap_or_else(|| ".".into()))
                    .join(".local")
                    .join("state")
            })
            .join("soloe")
    }
}

fn pnpm_executable() -> &'static str {
    if cfg!(target_os = "windows") {
        "pnpm.cmd"
    } else {
        "pnpm"
    }
}

fn is_pid_running(pid: u32, backend: &ActiveBackend) -> bool {
    if backend.placement == BackendPlacement::Wsl {
        return Command::new("wsl.exe")
            .args([
                "--distribution",
                &backend.wsl_distro,
                "--exec",
                "kill",
                "-0",
                &pid.to_string(),
            ])
            .status()
            .is_ok_and(|status| status.success());
    }

    #[cfg(target_os = "windows")]
    let status = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .ok()
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()));
    #[cfg(not(target_os = "windows"))]
    let status = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .is_ok_and(|status| status.success());
    status
}

fn terminate_pid(pid: u32, force: bool, backend: &ActiveBackend) -> Result<(), String> {
    let status = if backend.placement == BackendPlacement::Wsl {
        Command::new("wsl.exe")
            .args([
                "--distribution",
                &backend.wsl_distro,
                "--exec",
                "kill",
                if force { "-KILL" } else { "-TERM" },
                &pid.to_string(),
            ])
            .status()
    } else {
        #[cfg(target_os = "windows")]
        {
            let mut command = Command::new("taskkill");
            command.args(["/PID", &pid.to_string(), "/T"]);
            if force {
                command.arg("/F");
            }
            command.status()
        }
        #[cfg(not(target_os = "windows"))]
        {
            Command::new("kill")
                .args([if force { "-KILL" } else { "-TERM" }, &pid.to_string()])
                .status()
        }
    };
    status
        .map_err(|error| format!("failed to stop process {pid}: {error}"))?
        .success()
        .then_some(())
        .ok_or_else(|| format!("process stop command failed for {pid}"))
}

fn open_target(target: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd")
        .args(["/C", "start", "", target])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(target).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(target).spawn();
    result
        .map(|_| ())
        .map_err(|error| format!("failed to open {target}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeProcessOperations {
        running: Mutex<HashSet<u32>>,
        graceful_failures: Mutex<HashSet<u32>>,
        forced_failures: Mutex<HashSet<u32>>,
        calls: Mutex<Vec<(u32, bool)>>,
    }

    impl FakeProcessOperations {
        fn with_running(pids: impl IntoIterator<Item = u32>) -> Self {
            Self {
                running: Mutex::new(pids.into_iter().collect()),
                ..Self::default()
            }
        }
    }

    impl ProcessOperations for FakeProcessOperations {
        fn is_running(&self, pid: u32, _backend: &ActiveBackend) -> bool {
            self.running.lock().unwrap().contains(&pid)
        }

        fn terminate(&self, pid: u32, force: bool, _backend: &ActiveBackend) -> Result<(), String> {
            self.calls.lock().unwrap().push((pid, force));
            let failures = if force {
                &self.forced_failures
            } else {
                &self.graceful_failures
            };
            if failures.lock().unwrap().contains(&pid) {
                return Err(if force {
                    "forced termination failed".to_string()
                } else {
                    "graceful termination failed".to_string()
                });
            }
            self.running.lock().unwrap().remove(&pid);
            Ok(())
        }
    }

    fn test_supervisor(
        directory: PathBuf,
        processes: Arc<dyn ProcessOperations>,
    ) -> BackendSupervisor {
        BackendSupervisor::new(PathBuf::from("/repo"), directory, processes)
    }

    #[test]
    fn reads_only_the_requested_service_record() {
        let directory = env::temp_dir().join(format!("soloe-tray-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("server.json"),
            r#"{"service":"server","pid":42,"address":"http://127.0.0.1:4317"}"#,
        )
        .unwrap();
        let supervisor = test_supervisor(
            directory.clone(),
            Arc::new(FakeProcessOperations::default()),
        );

        assert_eq!(
            supervisor.read_info("server"),
            Some(ServiceInfo {
                service: "server".to_string(),
                pid: 42,
                endpoint: None,
                address: Some("http://127.0.0.1:4317".to_string()),
                token: None,
            })
        );
        assert_eq!(supervisor.read_info("runtime"), None);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn reads_backend_placement_from_shared_settings() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-settings-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("settings.json"),
            r#"{"backend":{"placement":"wsl","wslDistro":"Debian","wslRepositoryRoot":"/home/me/soloe"}}"#,
        )
        .unwrap();
        let supervisor = test_supervisor(
            directory.clone(),
            Arc::new(FakeProcessOperations::default()),
        );

        assert_eq!(
            supervisor.configured_backend().unwrap(),
            BackendSettings {
                placement: BackendPlacement::Wsl,
                wsl_distro: "Debian".to_string(),
                wsl_repository_root: "/home/me/soloe".to_string(),
            }
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn wsl_launch_script_keeps_runtime_socket_inside_linux() {
        let script = wsl_start_script(
            "/home/me/Soloe source",
            "/mnt/c/Users/Me/AppData/Local/Soloe",
            "@soloe/runtime",
        );
        assert!(script.contains("cd -- '/home/me/Soloe source'"));
        assert!(script.contains("SOLOE_DATA_DIR='/mnt/c/Users/Me/AppData/Local/Soloe'"));
        assert!(
            script.contains("SOLOE_RUNTIME_ENDPOINT=\"$HOME/.local/state/soloe/runtime.sock\"")
        );
        assert!(script.ends_with("exec pnpm --filter '@soloe/runtime' start"));
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(
            shell_quote("/home/o'brien/app"),
            "'/home/o'\"'\"'brien/app'"
        );
    }

    #[test]
    fn development_repository_root_contains_the_workspace_manifest() {
        assert!(repository_root().join("package.json").is_file());
    }

    #[test]
    fn graceful_failure_falls_back_to_forced_termination() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-stop-fallback-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("server.json"),
            r#"{"service":"server","pid":49424}"#,
        )
        .unwrap();
        let processes = Arc::new(FakeProcessOperations::with_running([49424]));
        processes.graceful_failures.lock().unwrap().insert(49424);
        let supervisor = test_supervisor(directory.clone(), processes.clone());

        expect_ok(supervisor.stop_service("server", &BackendSettings::default().into()));
        assert_eq!(
            processes.calls.lock().unwrap().as_slice(),
            &[(49424, false), (49424, true)]
        );
        assert!(!directory.join("server.json").exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn stop_attempts_runtime_cleanup_after_server_failure() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-stop-order-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("server.json"),
            r#"{"service":"server","pid":1001}"#,
        )
        .unwrap();
        fs::write(
            directory.join("runtime.json"),
            r#"{"service":"runtime","pid":1002}"#,
        )
        .unwrap();
        let processes = Arc::new(FakeProcessOperations::with_running([1001, 1002]));
        processes
            .graceful_failures
            .lock()
            .unwrap()
            .extend([1001, 1002]);
        processes.forced_failures.lock().unwrap().insert(1001);
        let supervisor = test_supervisor(directory.clone(), processes.clone());

        let error = supervisor.stop().unwrap_err();

        assert!(error.contains("server"));
        assert_eq!(
            processes.calls.lock().unwrap().as_slice(),
            &[(1001, false), (1001, true), (1002, false), (1002, true)]
        );
        assert!(processes.running.lock().unwrap().contains(&1001));
        assert!(!processes.running.lock().unwrap().contains(&1002));
        let _ = fs::remove_dir_all(directory);
    }

    fn expect_ok(result: Result<(), String>) {
        if let Err(error) = result {
            panic!("expected success, got {error}");
        }
    }
}
