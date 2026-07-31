use crate::ownership::{NativeProcessOwner, OwnershipLease, TrayInstanceGuard};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const WSL_STOP_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone, Debug, PartialEq, Eq)]
enum LifecycleState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Degraded(String),
    Failed(String),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceInfo {
    pub service: String,
    pub pid: u32,
    #[serde(default)]
    pub owner_id: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
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
    #[serde(default)]
    owner_id: String,
    #[serde(default)]
    tray_pid: u32,
}

impl ActiveBackend {
    fn from_settings(settings: BackendSettings, owner_id: &str) -> Self {
        Self {
            placement: settings.placement,
            wsl_distro: settings.wsl_distro,
            wsl_repository_root: settings.wsl_repository_root,
            owner_id: owner_id.to_string(),
            tray_pid: std::process::id(),
        }
    }

    fn same_location(&self, other: &Self) -> bool {
        self.placement == other.placement
            && self.wsl_distro == other.wsl_distro
            && self.wsl_repository_root == other.wsl_repository_root
    }
}

trait ProcessOperations: Send + Sync {
    fn is_running(&self, pid: u32, backend: &ActiveBackend) -> bool;
    fn has_owner(&self, pid: u32, backend: &ActiveBackend, owner_id: &str) -> bool;
    fn terminate(&self, pid: u32, force: bool, backend: &ActiveBackend) -> Result<(), String>;
}

struct SystemProcessOperations;

impl ProcessOperations for SystemProcessOperations {
    fn is_running(&self, pid: u32, backend: &ActiveBackend) -> bool {
        is_pid_running(pid, backend)
    }

    fn has_owner(&self, pid: u32, backend: &ActiveBackend, owner_id: &str) -> bool {
        process_has_owner(pid, backend, owner_id)
    }

    fn terminate(&self, pid: u32, force: bool, backend: &ActiveBackend) -> Result<(), String> {
        terminate_pid(pid, force, backend)
    }
}

pub struct BackendSupervisor {
    repository_root: PathBuf,
    data_directory: PathBuf,
    processes: Arc<dyn ProcessOperations>,
    owner_id: String,
    native_owner: NativeProcessOwner,
    lease: Mutex<Option<OwnershipLease>>,
    backend_children: Mutex<Vec<Child>>,
    client_children: Mutex<Vec<Child>>,
    lifecycle: Mutex<LifecycleState>,
}

impl BackendSupervisor {
    pub fn discover() -> Result<(Self, TrayInstanceGuard), String> {
        let data_directory = data_directory();
        let instance = TrayInstanceGuard::acquire(&data_directory)?;
        let owner_id = new_owner_id();
        Ok((
            Self {
                repository_root: repository_root(),
                data_directory,
                processes: Arc::new(SystemProcessOperations),
                owner_id,
                native_owner: NativeProcessOwner::new()?,
                lease: Mutex::new(None),
                backend_children: Mutex::new(Vec::new()),
                client_children: Mutex::new(Vec::new()),
                lifecycle: Mutex::new(LifecycleState::Stopped),
            },
            instance,
        ))
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
            owner_id: "test-owner".to_string(),
            native_owner: NativeProcessOwner::new().unwrap(),
            lease: Mutex::new(None),
            backend_children: Mutex::new(Vec::new()),
            client_children: Mutex::new(Vec::new()),
            lifecycle: Mutex::new(LifecycleState::Stopped),
        }
    }

    pub fn backend_action_label(&self) -> String {
        let backend = self.backend_for_existing_services();
        let host = match backend.placement {
            BackendPlacement::Windows => "Windows",
            BackendPlacement::Wsl => "WSL",
        };
        match self.reconciled_lifecycle(&backend) {
            LifecycleState::Starting => format!("Starting services ({host})…"),
            LifecycleState::Stopping => format!("Stopping all services ({host})…"),
            LifecycleState::Running | LifecycleState::Degraded(_) => {
                format!("Stop all services ({host})")
            }
            LifecycleState::Stopped | LifecycleState::Failed(_) => {
                format!("Start services ({host})")
            }
        }
    }

    pub fn backend_transition_label(&self) -> String {
        let backend = self.backend_for_existing_services();
        let host = match backend.placement {
            BackendPlacement::Windows => "Windows",
            BackendPlacement::Wsl => "WSL",
        };
        match self.reconciled_lifecycle(&backend) {
            LifecycleState::Running | LifecycleState::Degraded(_) | LifecycleState::Stopping => {
                format!("Stopping all services ({host})…")
            }
            LifecycleState::Starting | LifecycleState::Stopped | LifecycleState::Failed(_) => {
                format!("Starting services ({host})…")
            }
        }
    }

    pub fn backend_action_enabled(&self) -> bool {
        let backend = self.backend_for_existing_services();
        !matches!(
            self.reconciled_lifecycle(&backend),
            LifecycleState::Starting | LifecycleState::Stopping
        )
    }

    pub fn toggle_backend(&self) -> Result<(), String> {
        let backend = self.backend_for_existing_services();
        match self.reconciled_lifecycle(&backend) {
            LifecycleState::Running | LifecycleState::Degraded(_) => self.stop(),
            LifecycleState::Starting | LifecycleState::Stopping => {
                Err("backend transition already in progress".to_string())
            }
            LifecycleState::Stopped | LifecycleState::Failed(_) => self.start(),
        }
    }

    pub fn start(&self) -> Result<(), String> {
        self.set_lifecycle(LifecycleState::Starting);
        let result = self.start_inner();
        match &result {
            Ok(()) => self.set_lifecycle(LifecycleState::Running),
            Err(error) => self.set_lifecycle(LifecycleState::Failed(error.clone())),
        }
        result
    }

    fn start_inner(&self) -> Result<(), String> {
        fs::create_dir_all(&self.data_directory)
            .map_err(|error| format!("failed to create Soloe data directory: {error}"))?;
        let configured = ActiveBackend::from_settings(self.configured_backend()?, &self.owner_id);
        if let Some(active) = self.read_active_backend() {
            let has_running_service =
                self.is_running_on("runtime", &active) || self.is_running_on("server", &active);
            if has_running_service && active.owner_id != self.owner_id {
                return Err(
                    "an existing backend belongs to another tray owner; wait for its ownership cleanup or inspect the Soloe logs"
                        .to_string(),
                );
            }
            if has_running_service && !active.same_location(&configured) {
                return Err(
                    "backend placement changed while services are running; stop the backend first"
                        .to_string(),
                );
            }
        }
        let backend = configured;
        self.validate_backend(&backend)?;
        self.preflight(&backend)?;
        self.write_active_backend(&backend)?;

        if backend.placement == BackendPlacement::Wsl {
            self.start_lease()?;
            if !self.is_running_on("runtime", &backend) || !self.is_running_on("server", &backend) {
                self.spawn_wsl_supervisor(&backend)?;
            }
            self.wait_until("runtime", true, START_TIMEOUT, &backend)?;
            self.wait_until("server", true, START_TIMEOUT, &backend)?;
        } else {
            if !self.is_running_on("runtime", &backend) {
                self.spawn_workspace("@soloe/runtime", "runtime", &backend)?;
                self.wait_until("runtime", true, START_TIMEOUT, &backend)?;
            }
            if !self.is_running_on("server", &backend) {
                self.spawn_workspace("@soloe/server", "server", &backend)?;
                self.wait_until("server", true, START_TIMEOUT, &backend)?;
            }
        }
        self.start_web_host(&backend)?;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.set_lifecycle(LifecycleState::Stopping);
        let result = self.stop_inner();
        match &result {
            Ok(()) => self.set_lifecycle(LifecycleState::Stopped),
            Err(error) => self.set_lifecycle(LifecycleState::Degraded(error.clone())),
        }
        result
    }

    fn stop_inner(&self) -> Result<(), String> {
        let backend = self.backend_for_existing_services();
        let mut failures = Vec::new();
        if let Err(error) = self.stop_web_host(&backend) {
            failures.push(format!("web: {error}"));
        }

        if backend.placement == BackendPlacement::Wsl {
            if let Err(error) = self.stop_wsl_backend(&backend) {
                failures.push(error);
            }
        } else {
            for service in ["server", "runtime"] {
                if let Err(error) = self.stop_service(service, &backend) {
                    failures.push(format!("{service}: {error}"));
                }
            }
            if !self.is_running_on("server", &backend) && !self.is_running_on("runtime", &backend) {
                self.remove_active_backend();
                self.stop_lease();
            }
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

    pub fn shutdown_all(&self) -> Result<(), String> {
        let client_result = self.stop_clients();
        let backend_result = self.stop();
        let ownership_result = self.native_owner.terminate_all();
        let mut failures = Vec::new();
        if let Err(client) = client_result {
            failures.push(format!("client cleanup incomplete: {client}"));
        }
        if let Err(backend) = backend_result {
            failures.push(backend);
        }
        if let Err(ownership) = ownership_result {
            failures.push(format!("owned process cleanup incomplete: {ownership}"));
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    pub fn requires_stop_confirmation(&self) -> bool {
        let backend = self.backend_for_existing_services();
        if !self.is_running_on("runtime", &backend) {
            return false;
        }
        self.running_terminal_count()
            .map_or(true, |count| count > 0)
    }

    pub fn open_logs(&self) -> Result<(), String> {
        open_target(&self.data_directory.to_string_lossy())
    }

    fn running_terminal_count(&self) -> Option<usize> {
        let info = self.read_info("server")?;
        let address = info.address?;
        let token = info.token?;
        let authority = address.strip_prefix("http://")?.trim_end_matches('/');
        let mut stream = TcpStream::connect(authority).ok()?;
        stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
        stream
            .set_write_timeout(Some(Duration::from_secs(2)))
            .ok()?;
        write!(
            stream,
            "GET /api/runtime/sessions HTTP/1.0\r\nHost: {authority}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\n\r\n"
        )
        .ok()?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).ok()?;
        let separator = response.windows(4).position(|part| part == b"\r\n\r\n")?;
        let body = &response[separator + 4..];
        serde_json::from_slice::<Vec<serde_json::Value>>(body)
            .ok()
            .map(|sessions| sessions.len())
    }

    pub fn browser_address(&self) -> Option<String> {
        let backend = self.windows_client_target();
        self.read_info("web")
            .filter(|info| self.service_info_is_running(info, &backend))
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
        self.spawn_owned(command, true)
            .map_err(|error| format!("failed to open Electron client: {error}"))
    }

    fn configured_backend(&self) -> Result<BackendSettings, String> {
        let settings_path = self.data_directory.join("settings.json");
        let mut backend = match fs::read(&settings_path) {
            Ok(data) => {
                let json = data
                    .strip_prefix(&[0xEF, 0xBB, 0xBF])
                    .unwrap_or(data.as_slice());
                serde_json::from_slice::<StoredSettings>(json)
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

    fn preflight(&self, backend: &ActiveBackend) -> Result<(), String> {
        if !self.repository_root.join("package.json").is_file() {
            return Err(format!(
                "Windows Soloe source is incomplete at {}; expected package.json",
                self.repository_root.display()
            ));
        }
        self.preflight_windows_client()?;
        match backend.placement {
            BackendPlacement::Windows => {
                check_command(
                    Command::new("node").arg("--version"),
                    "Node.js 22 or newer is required on Windows",
                )?;
                check_command(
                    Command::new(pnpm_executable()).arg("--version"),
                    "PNPM is required on Windows; enable the pinned version with Corepack",
                )?;
                let mut dependency = Command::new(pnpm_executable());
                dependency
                    .args([
                        "--filter",
                        "@soloe/runtime",
                        "exec",
                        "node",
                        "-e",
                        "require('node-pty')",
                    ])
                    .current_dir(&self.repository_root);
                check_command(
                    &mut dependency,
                    "Windows backend dependencies are missing or incompatible; run pnpm install in the Windows checkout",
                )
            }
            BackendPlacement::Wsl => {
                let script = format!(
                    "cd -- {} && test -f package.json && \
                     command -v node >/dev/null && command -v pnpm >/dev/null && \
                     pnpm --filter @soloe/runtime exec node -e \"require('node-pty')\"",
                    shell_quote(&backend.wsl_repository_root)
                );
                let mut command = Command::new("wsl.exe");
                command.args([
                    "--distribution",
                    &backend.wsl_distro,
                    "--exec",
                    "bash",
                    "-lc",
                    &script,
                ]);
                check_command(
                    &mut command,
                    "WSL backend prerequisites are unavailable; verify the distribution, runtime path, login-shell Node/PNPM, and run pnpm install inside WSL",
                )
            }
        }
    }

    fn preflight_windows_client(&self) -> Result<(), String> {
        check_command(
            Command::new("node").arg("--version"),
            "Node.js 22 or newer is required on Windows for the browser and desktop clients",
        )?;
        check_command(
            Command::new(pnpm_executable()).arg("--version"),
            "PNPM is required on Windows; enable the pinned version with Corepack",
        )?;
        let mut dependency = Command::new(pnpm_executable());
        dependency
            .args(["--filter", "@soloe/web", "exec", "vite", "--version"])
            .current_dir(&self.repository_root);
        check_command(
            &mut dependency,
            "Windows client dependencies are missing; run pnpm install in the Windows checkout",
        )
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
                    .env("SOLOE_DATA_DIR", &self.data_directory)
                    .env("SOLOE_OWNER_ID", &self.owner_id)
                    .env("SOLOE_WEB_ROOT", "");
                command
            }
            BackendPlacement::Wsl => {
                return Err(format!(
                    "{service} must be started through the WSL ownership supervisor"
                ));
            }
        };
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        self.spawn_owned(command, false)
            .map_err(|error| format!("failed to start {workspace}: {error}"))
    }

    fn spawn_wsl_supervisor(&self, backend: &ActiveBackend) -> Result<(), String> {
        let data_directory = self.wsl_path(&backend.wsl_distro, &self.data_directory)?;
        let lease_path = self.wsl_path(
            &backend.wsl_distro,
            &self.data_directory.join("tray-lease.json"),
        )?;
        let script = wsl_supervisor_script(
            &backend.wsl_repository_root,
            &data_directory,
            &lease_path,
            &self.owner_id,
        );
        let mut command = Command::new("wsl.exe");
        command.args([
            "--distribution",
            &backend.wsl_distro,
            "--exec",
            "bash",
            "-lc",
            &script,
        ]);
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_directory.join("supervisor.log"))
            .map_err(|error| format!("failed to open supervisor log: {error}"))?;
        let error_log = log
            .try_clone()
            .map_err(|error| format!("failed to clone supervisor log: {error}"))?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        self.spawn_owned(command, false)
            .map_err(|error| format!("failed to start WSL backend supervisor: {error}"))
    }

    fn start_web_host(&self, backend: &ActiveBackend) -> Result<(), String> {
        let windows = self.windows_client_target();
        if self.is_running_on("web", &windows) {
            return Ok(());
        }
        let server = self
            .read_info("server")
            .filter(|info| self.service_info_is_running(info, backend))
            .ok_or_else(|| "application server is not ready for the browser host".to_string())?;
        let address = server
            .address
            .ok_or_else(|| "application server did not publish an address".to_string())?;
        let token = server
            .token
            .ok_or_else(|| "application server did not publish an access token".to_string())?;
        let mode = env::var("SOLOE_WEB_MODE").unwrap_or_else(|_| "dev".to_string());
        if mode != "dev" && mode != "preview" {
            return Err(format!(
                "invalid SOLOE_WEB_MODE {mode:?}; expected dev or preview"
            ));
        }

        let mut command = Command::new(pnpm_executable());
        command
            .args(["--filter", "@soloe/web", mode.as_str()])
            .current_dir(&self.repository_root)
            .env("SOLOE_DATA_DIR", &self.data_directory)
            .env("SOLOE_OWNER_ID", &self.owner_id)
            .env("SOLOE_SERVER_URL", &address)
            .env("SOLOE_SERVER_TOKEN", &token);
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_directory.join("web.log"))
            .map_err(|error| format!("failed to open web host log: {error}"))?;
        let error_log = log
            .try_clone()
            .map_err(|error| format!("failed to clone web host log: {error}"))?;
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        self.spawn_owned(command, false)
            .map_err(|error| format!("failed to start Windows browser host: {error}"))?;
        self.wait_until("web", true, START_TIMEOUT, &windows)
            .map_err(|error| {
                format!(
                    "Windows browser host did not become ready: {error}; run pnpm install in the Windows checkout"
                )
            })
    }

    fn stop_web_host(&self, _backend: &ActiveBackend) -> Result<(), String> {
        self.stop_service("web", &self.windows_client_target())
    }

    fn spawn_owned(&self, mut command: Command, client: bool) -> Result<(), String> {
        let mut child = command
            .spawn()
            .map_err(|error| format!("process spawn failed: {error}"))?;
        if let Err(error) = self.native_owner.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let children = if client {
            &self.client_children
        } else {
            &self.backend_children
        };
        let mut children = children
            .lock()
            .map_err(|_| "managed child lock poisoned".to_string())?;
        children.retain_mut(|existing| existing.try_wait().ok().flatten().is_none());
        children.push(child);
        Ok(())
    }

    fn stop_clients(&self) -> Result<(), String> {
        let mut children = self
            .client_children
            .lock()
            .map_err(|_| "client process lock poisoned".to_string())?;
        let mut failures = Vec::new();
        for child in children.iter_mut() {
            if child.try_wait().ok().flatten().is_some() {
                continue;
            }
            if let Err(error) = child.kill() {
                failures.push(format!("PID {}: {error}", child.id()));
                continue;
            }
            if let Err(error) = child.wait() {
                failures.push(format!("PID {} wait failed: {error}", child.id()));
            }
        }
        children.clear();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }

    fn stop_wsl_backend(&self, backend: &ActiveBackend) -> Result<(), String> {
        self.stop_lease();
        let mut failures = Vec::new();
        if let Some(supervisor) = self.read_info("supervisor") {
            if supervisor.owner_id.as_deref() == Some(self.owner_id.as_str()) {
                if let Err(error) = self.processes.terminate(supervisor.pid, false, backend) {
                    eprintln!(
                        "[tray] graceful WSL supervisor shutdown failed for PID {}: {error}",
                        supervisor.pid
                    );
                }
            }
        }

        let server_stopped = self
            .wait_until("server", false, WSL_STOP_TIMEOUT, backend)
            .is_ok();
        let runtime_stopped = self
            .wait_until("runtime", false, WSL_STOP_TIMEOUT, backend)
            .is_ok();
        if !server_stopped {
            if let Err(error) = self.stop_service("server", backend) {
                failures.push(format!("server: {error}"));
            }
        }
        if !runtime_stopped {
            if let Err(error) = self.stop_service("runtime", backend) {
                failures.push(format!("runtime: {error}"));
            }
        }
        if !self.is_running_on("server", backend) && !self.is_running_on("runtime", backend) {
            self.remove_stale_info("supervisor");
            self.remove_active_backend();
        } else {
            failures.push("WSL supervisor left managed processes running".to_string());
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

    fn start_lease(&self) -> Result<(), String> {
        let mut lease = self
            .lease
            .lock()
            .map_err(|_| "ownership lease lock poisoned".to_string())?;
        if lease.is_none() {
            *lease = Some(OwnershipLease::start(
                &self.data_directory,
                &self.owner_id,
                std::process::id(),
            )?);
        }
        Ok(())
    }

    fn stop_lease(&self) {
        if let Ok(mut lease) = self.lease.lock() {
            lease.take();
        }
    }

    fn reconciled_lifecycle(&self, backend: &ActiveBackend) -> LifecycleState {
        let current = self
            .lifecycle
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| LifecycleState::Failed("status lock poisoned".to_string()));
        if matches!(
            current,
            LifecycleState::Starting | LifecycleState::Stopping | LifecycleState::Failed(_)
        ) {
            return current;
        }
        let runtime = self.is_running_on("runtime", backend);
        let server = self.is_running_on("server", backend);
        let web = self.is_running_on("web", &self.windows_client_target());
        let reconciled = match (runtime, server, web) {
            (true, true, true) => LifecycleState::Running,
            (true, true, false) => {
                LifecycleState::Degraded("backend running; browser host unavailable".to_string())
            }
            (true, false, _) => LifecycleState::Degraded("runtime only".to_string()),
            (false, true, _) => LifecycleState::Degraded("server without runtime".to_string()),
            (false, false, true) => {
                LifecycleState::Degraded("browser host without backend".to_string())
            }
            (false, false, false) => LifecycleState::Stopped,
        };
        self.set_lifecycle(reconciled.clone());
        reconciled
    }

    fn set_lifecycle(&self, state: LifecycleState) {
        if let Ok(mut current) = self.lifecycle.lock() {
            if *current == state {
                return;
            }
            match &state {
                LifecycleState::Starting => eprintln!("[tray] backend starting"),
                LifecycleState::Running => eprintln!("[tray] backend running"),
                LifecycleState::Stopping => eprintln!("[tray] backend stopping"),
                LifecycleState::Stopped => eprintln!("[tray] backend stopped"),
                LifecycleState::Degraded(detail) => {
                    eprintln!("[tray] backend degraded: {detail}")
                }
                LifecycleState::Failed(detail) => eprintln!("[tray] backend failed: {detail}"),
            }
            *current = state;
        }
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
        if info.owner_id.as_deref() != Some(backend.owner_id.as_str()) {
            if self.processes.is_running(info.pid, backend) {
                return Err(format!(
                    "refusing to stop PID {} because its service record is not owned by this tray",
                    info.pid
                ));
            }
            self.remove_stale_info(service);
            return Ok(());
        }
        if info.service != service
            || !self.processes.is_running(info.pid, backend)
            || !self
                .processes
                .has_owner(info.pid, backend, &backend.owner_id)
        {
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
            info.service == service && self.service_info_is_running(&info, backend)
        })
    }

    fn service_info_is_running(&self, info: &ServiceInfo, backend: &ActiveBackend) -> bool {
        info.owner_id.as_deref() == Some(backend.owner_id.as_str())
            && self.processes.is_running(info.pid, backend)
            && self
                .processes
                .has_owner(info.pid, backend, &backend.owner_id)
            && (backend.placement == BackendPlacement::Wsl || self.owns_native_pid(info.pid))
    }

    #[cfg(not(test))]
    fn owns_native_pid(&self, pid: u32) -> bool {
        self.native_owner.owns_pid(pid)
    }

    #[cfg(test)]
    fn owns_native_pid(&self, pid: u32) -> bool {
        // Service tests use deterministic fake PIDs. Native Job membership is
        // enforced by NativeProcessOwner in production and cannot be fabricated
        // through the process-execution test seam.
        let _ = self.native_owner.owns_pid(pid);
        true
    }

    fn backend_for_existing_services(&self) -> ActiveBackend {
        self.read_active_backend().unwrap_or_else(|| {
            ActiveBackend::from_settings(
                self.configured_backend().unwrap_or_default(),
                &self.owner_id,
            )
        })
    }

    fn windows_client_target(&self) -> ActiveBackend {
        ActiveBackend {
            placement: BackendPlacement::Windows,
            wsl_distro: String::new(),
            wsl_repository_root: String::new(),
            owner_id: self.owner_id.clone(),
            tray_pid: std::process::id(),
        }
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

fn wsl_supervisor_script(
    repository_root: &str,
    data_directory: &str,
    lease_path: &str,
    owner_id: &str,
) -> String {
    let runtime_socket = format!("runtime-{owner_id}.sock");
    format!(
        "cd -- {} && test -f package.json && test -f scripts/wsl-backend-supervisor.mjs && \
         command -v node >/dev/null && command -v pnpm >/dev/null && \
         mkdir -p \"$HOME/.local/state/soloe\" && \
         export SOLOE_DATA_DIR={} && \
         export SOLOE_OWNER_ID={} && \
         export SOLOE_TRAY_LEASE={} && \
         export SOLOE_RUNTIME_ENDPOINT=\"$HOME/.local/state/soloe\"/{} && \
         exec node scripts/wsl-backend-supervisor.mjs",
        shell_quote(repository_root),
        shell_quote(data_directory),
        shell_quote(owner_id),
        shell_quote(lease_path),
        shell_quote(&runtime_socket),
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn new_owner_id() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("tray-{}-{timestamp:x}", std::process::id())
}

fn check_command(command: &mut Command, remediation: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("{remediation}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    Err(if detail.is_empty() {
        remediation.to_string()
    } else {
        format!("{remediation}: {detail}")
    })
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

fn process_has_owner(pid: u32, backend: &ActiveBackend, owner_id: &str) -> bool {
    if backend.placement == BackendPlacement::Wsl {
        let command = format!(
            "test -r /proc/{pid}/environ && tr '\\0' '\\n' < /proc/{pid}/environ | grep -Fqx -- {}",
            shell_quote(&format!("SOLOE_OWNER_ID={owner_id}"))
        );
        return Command::new("wsl.exe")
            .args([
                "--distribution",
                &backend.wsl_distro,
                "--exec",
                "bash",
                "-lc",
                &command,
            ])
            .status()
            .is_ok_and(|status| status.success());
    }

    #[cfg(target_os = "windows")]
    {
        let _ = (pid, owner_id);
        true
    }
    #[cfg(all(unix, not(target_os = "windows")))]
    {
        fs::read(format!("/proc/{pid}/environ"))
            .ok()
            .is_some_and(|environment| {
                environment
                    .split(|byte| *byte == 0)
                    .any(|entry| entry == format!("SOLOE_OWNER_ID={owner_id}").as_bytes())
            })
    }
    #[cfg(not(any(target_os = "windows", unix)))]
    {
        let _ = (pid, owner_id);
        false
    }
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

        fn has_owner(&self, _pid: u32, _backend: &ActiveBackend, _owner_id: &str) -> bool {
            true
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
                owner_id: None,
                started_at: None,
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
        assert_eq!(supervisor.backend_action_label(), "Start services (WSL)");
        assert_eq!(
            supervisor.backend_transition_label(),
            "Starting services (WSL)…"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn reads_windows_powershell_utf8_settings_with_a_bom() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-settings-bom-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        let mut settings = vec![0xEF, 0xBB, 0xBF];
        settings.extend_from_slice(
            br#"{"backend":{"placement":"wsl","wslDistro":"Ubuntu","wslRepositoryRoot":"/home/me/soloe"}}"#,
        );
        fs::write(directory.join("settings.json"), settings).unwrap();
        let supervisor = test_supervisor(
            directory.clone(),
            Arc::new(FakeProcessOperations::default()),
        );

        assert_eq!(
            supervisor.configured_backend().unwrap().placement,
            BackendPlacement::Wsl
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn wsl_launch_script_keeps_runtime_socket_inside_linux() {
        let script = wsl_supervisor_script(
            "/home/me/Soloe source",
            "/mnt/c/Users/Me/AppData/Local/Soloe",
            "/mnt/c/Users/Me/AppData/Local/Soloe/tray-lease.json",
            "tray-owner",
        );
        assert!(script.contains("cd -- '/home/me/Soloe source'"));
        assert!(script.contains("SOLOE_DATA_DIR='/mnt/c/Users/Me/AppData/Local/Soloe'"));
        assert!(script.contains("SOLOE_OWNER_ID='tray-owner'"));
        assert!(
            script
                .contains("SOLOE_TRAY_LEASE='/mnt/c/Users/Me/AppData/Local/Soloe/tray-lease.json'")
        );
        assert!(script.contains(
            "SOLOE_RUNTIME_ENDPOINT=\"$HOME/.local/state/soloe\"/'runtime-tray-owner.sock'"
        ));
        assert!(script.ends_with("exec node scripts/wsl-backend-supervisor.mjs"));
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
            r#"{"service":"server","pid":49424,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        let processes = Arc::new(FakeProcessOperations::with_running([49424]));
        processes.graceful_failures.lock().unwrap().insert(49424);
        let supervisor = test_supervisor(directory.clone(), processes.clone());

        expect_ok(supervisor.stop_service(
            "server",
            &ActiveBackend::from_settings(BackendSettings::default(), "test-owner"),
        ));
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
            r#"{"service":"server","pid":1001,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        fs::write(
            directory.join("runtime.json"),
            r#"{"service":"runtime","pid":1002,"ownerId":"test-owner"}"#,
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

    #[test]
    fn backend_action_reflects_managed_service_state() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-status-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        let processes = Arc::new(FakeProcessOperations::with_running([2001, 2002, 2003]));
        let supervisor = test_supervisor(directory.clone(), processes.clone());
        assert_eq!(
            supervisor.backend_action_label(),
            "Start services (Windows)"
        );
        assert_eq!(
            supervisor.backend_transition_label(),
            "Starting services (Windows)…"
        );
        assert!(supervisor.backend_action_enabled());
        supervisor.set_lifecycle(LifecycleState::Starting);
        assert_eq!(
            supervisor.backend_action_label(),
            "Starting services (Windows)…"
        );
        assert!(!supervisor.backend_action_enabled());
        supervisor.set_lifecycle(LifecycleState::Stopped);
        fs::write(
            directory.join("runtime.json"),
            r#"{"service":"runtime","pid":2001,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        assert_eq!(
            supervisor.backend_action_label(),
            "Stop all services (Windows)"
        );
        assert_eq!(
            supervisor.backend_transition_label(),
            "Stopping all services (Windows)…"
        );
        assert!(supervisor.backend_action_enabled());

        fs::write(
            directory.join("server.json"),
            r#"{"service":"server","pid":2002,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        assert_eq!(
            supervisor.backend_action_label(),
            "Stop all services (Windows)"
        );

        fs::write(
            directory.join("web.json"),
            r#"{"service":"web","pid":2003,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        assert_eq!(
            supervisor.backend_action_label(),
            "Stop all services (Windows)"
        );
        supervisor.set_lifecycle(LifecycleState::Stopping);
        assert_eq!(
            supervisor.backend_action_label(),
            "Stopping all services (Windows)…"
        );
        assert!(!supervisor.backend_action_enabled());
        let _ = fs::remove_dir_all(directory);
    }

    fn expect_ok(result: Result<(), String>) {
        if let Err(error) = result {
            panic!("expected success, got {error}");
        }
    }
}
