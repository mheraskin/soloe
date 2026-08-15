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

fn tailscale_dns_name_from_status(status: &[u8]) -> Result<String, String> {
    let status: serde_json::Value = serde_json::from_slice(status)
        .map_err(|error| format!("invalid Tailscale status JSON: {error}"))?;
    let hostname = status
        .get("Self")
        .and_then(|value| value.get("DNSName"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Tailscale status did not include Self.DNSName".to_string())?
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if !is_explicit_tailscale_hostname(&hostname) {
        return Err(format!("invalid Tailscale MagicDNS hostname: {hostname:?}"));
    }
    Ok(hostname)
}

fn detect_tailscale_dns_name() -> Option<String> {
    if let Ok(hostname) = env::var("SOLOE_TAILSCALE_HOSTNAME") {
        let hostname = hostname.trim().trim_end_matches('.').to_ascii_lowercase();
        return is_explicit_tailscale_hostname(&hostname).then_some(hostname);
    }

    let executable = env::var_os("SOLOE_TAILSCALE_CLI").unwrap_or_else(|| "tailscale".into());
    let output = Command::new(executable)
        .args(["status", "--json"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    tailscale_dns_name_from_status(&output.stdout).ok()
}

fn is_explicit_tailscale_hostname(hostname: &str) -> bool {
    hostname.len() <= 253
        && hostname.ends_with(".ts.net")
        && hostname.split('.').count() >= 4
        && hostname.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                && !label.starts_with('-')
                && !label.ends_with('-')
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum LifecycleState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Degraded(String),
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LifecycleScope {
    All,
    Runtime,
    Server,
}

impl LifecycleScope {
    fn includes_runtime(self) -> bool {
        matches!(self, Self::All | Self::Runtime)
    }

    fn includes_server(self) -> bool {
        matches!(self, Self::All | Self::Server)
    }
}

fn service_label(service: &str) -> &str {
    match service {
        "runtime" => "Environment Runtime",
        "server" => "Soloe Server",
        "web" => "Soloe browser host",
        "supervisor" => "WSL service supervisor",
        _ => service,
    }
}

fn lifecycle_log_messages(
    state: &LifecycleState,
    scope: LifecycleScope,
    runtime_running: bool,
    server_running: bool,
    web_running: bool,
) -> Vec<String> {
    let mut messages = Vec::with_capacity(2);
    if scope.includes_runtime() {
        let status = match state {
            LifecycleState::Starting => "starting".to_string(),
            LifecycleState::Running => "running".to_string(),
            LifecycleState::Stopping => "stopping".to_string(),
            LifecycleState::Stopped => "stopped".to_string(),
            LifecycleState::Degraded(_) => {
                if runtime_running {
                    "running".to_string()
                } else {
                    "unavailable".to_string()
                }
            }
            LifecycleState::Failed(detail) => {
                if runtime_running {
                    "running".to_string()
                } else {
                    format!("failed: {detail}")
                }
            }
        };
        messages.push(format!("[tray] Environment Runtime {status}"));
    }
    if scope.includes_server() {
        let status = match state {
            LifecycleState::Starting => "starting".to_string(),
            LifecycleState::Running => "running".to_string(),
            LifecycleState::Stopping => "stopping".to_string(),
            LifecycleState::Stopped => "stopped".to_string(),
            LifecycleState::Degraded(_) if server_running && !web_running => {
                "degraded: browser host unavailable".to_string()
            }
            LifecycleState::Degraded(_) if server_running => "running".to_string(),
            LifecycleState::Degraded(_) if runtime_running => "stopped".to_string(),
            LifecycleState::Degraded(_) => "unavailable".to_string(),
            LifecycleState::Failed(_) if server_running && web_running => "running".to_string(),
            LifecycleState::Failed(_) if server_running => {
                "degraded: browser host unavailable".to_string()
            }
            LifecycleState::Failed(detail) if runtime_running => format!("failed: {detail}"),
            LifecycleState::Failed(_) => "not started".to_string(),
        };
        messages.push(format!("[tray] Soloe Server {status}"));
    }
    messages
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
    #[serde(default)]
    startup: StartupSettings,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StartupSettings {
    #[serde(default = "default_true")]
    launch_soloe_client: bool,
}

impl Default for StartupSettings {
    fn default() -> Self {
        Self {
            launch_soloe_client: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum BackendPlacement {
    Windows,
    Macos,
    Wsl,
}

impl Default for BackendPlacement {
    fn default() -> Self {
        native_backend_placement()
    }
}

fn native_backend_placement() -> BackendPlacement {
    if cfg!(target_os = "macos") {
        BackendPlacement::Macos
    } else {
        BackendPlacement::Windows
    }
}

impl BackendPlacement {
    fn host_label(&self) -> &'static str {
        match self {
            Self::Windows => "Windows",
            Self::Macos => "macOS",
            Self::Wsl => "WSL",
        }
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WslSupervisorControl<'a> {
    owner_id: &'a str,
    server_running: bool,
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

    fn host_label(&self) -> &'static str {
        self.placement.host_label()
    }

    fn menu_host_suffix(&self) -> String {
        if cfg!(target_os = "windows") {
            format!(" ({})", self.host_label())
        } else {
            String::new()
        }
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
    transition: Mutex<()>,
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
                transition: Mutex::new(()),
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
            transition: Mutex::new(()),
        }
    }

    fn try_lock_transition(&self) -> Result<std::sync::MutexGuard<'_, ()>, String> {
        match self.transition.try_lock() {
            Ok(guard) => Ok(guard),
            Err(std::sync::TryLockError::WouldBlock) => {
                Err("service transition already in progress".to_string())
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                Err("service transition lock poisoned".to_string())
            }
        }
    }

    pub fn server_action_label(&self) -> String {
        let backend = self.backend_for_existing_services();
        let host = backend.menu_host_suffix();
        let lifecycle = self.reconciled_lifecycle(&backend);
        if matches!(
            &lifecycle,
            LifecycleState::Starting | LifecycleState::Stopping
        ) {
            return match lifecycle {
                LifecycleState::Starting => format!("Starting Soloe server{host}…"),
                LifecycleState::Stopping => format!("Stopping Soloe server{host}…"),
                _ => unreachable!(),
            };
        }
        let running = self.is_running_on("server", &backend)
            || self.is_running_on("web", &self.native_client_target());
        match (lifecycle, running) {
            (_, true) => format!("Stop Soloe server{host}"),
            (_, false) => format!("Start Soloe server{host}"),
        }
    }

    pub fn server_transition_label(&self) -> String {
        let backend = self.backend_for_existing_services();
        let host = backend.menu_host_suffix();
        if self.is_running_on("server", &backend)
            || self.is_running_on("web", &self.native_client_target())
        {
            format!("Stopping Soloe server{host}…")
        } else {
            format!("Starting Soloe server{host}…")
        }
    }

    pub fn server_action_enabled(&self) -> bool {
        let backend = self.backend_for_existing_services();
        let lifecycle = self.reconciled_lifecycle(&backend);
        if matches!(
            &lifecycle,
            LifecycleState::Starting | LifecycleState::Stopping
        ) {
            return false;
        }
        let server_running = self.is_running_on("server", &backend)
            || self.is_running_on("web", &self.native_client_target());
        server_running || self.is_running_on("runtime", &backend)
    }

    pub fn runtime_action_label(&self) -> String {
        let backend = self.backend_for_existing_services();
        let host = backend.menu_host_suffix();
        let lifecycle = self.reconciled_lifecycle(&backend);
        if matches!(
            &lifecycle,
            LifecycleState::Starting | LifecycleState::Stopping
        ) {
            return match lifecycle {
                LifecycleState::Starting => format!("Starting Environment Runtime{host}…"),
                LifecycleState::Stopping => format!("Stopping Environment Runtime{host}…"),
                _ => unreachable!(),
            };
        }
        let running = self.is_running_on("runtime", &backend);
        match (lifecycle, running) {
            (_, true) => format!("Stop Environment Runtime{host}"),
            (_, false) => format!("Start Environment Runtime{host}"),
        }
    }

    pub fn runtime_transition_label(&self) -> String {
        let backend = self.backend_for_existing_services();
        let host = backend.menu_host_suffix();
        if self.is_running_on("runtime", &backend) {
            format!("Stopping Environment Runtime{host}…")
        } else {
            format!("Starting Environment Runtime{host}…")
        }
    }

    pub fn runtime_action_enabled(&self) -> bool {
        let backend = self.backend_for_existing_services();
        !matches!(
            &self.reconciled_lifecycle(&backend),
            LifecycleState::Starting | LifecycleState::Stopping
        )
    }

    pub fn toggle_server(&self) -> Result<(), String> {
        let _transition = self.try_lock_transition()?;
        self.toggle_server_unlocked()
    }

    fn toggle_server_unlocked(&self) -> Result<(), String> {
        let backend = self.backend_for_existing_services();
        let transitioning = self
            .lifecycle
            .lock()
            .map(|state| matches!(*state, LifecycleState::Starting | LifecycleState::Stopping))
            .unwrap_or(true);
        if transitioning {
            return Err(
                "service transition already in progress or Environment Runtime is stopped"
                    .to_string(),
            );
        }
        if self.is_running_on("server", &backend)
            || self.is_running_on("web", &self.native_client_target())
        {
            self.stop_server_unlocked()
        } else {
            self.start_server_unlocked()
        }
    }

    pub fn toggle_runtime(&self) -> Result<(), String> {
        let _transition = self.try_lock_transition()?;
        self.toggle_runtime_unlocked()
    }

    fn toggle_runtime_unlocked(&self) -> Result<(), String> {
        let backend = self.backend_for_existing_services();
        let transitioning = self
            .lifecycle
            .lock()
            .map(|state| matches!(*state, LifecycleState::Starting | LifecycleState::Stopping))
            .unwrap_or(true);
        if transitioning {
            return Err("service transition already in progress".to_string());
        }
        if self.is_running_on("runtime", &backend) {
            self.stop_unlocked()
        } else {
            self.start_runtime_unlocked()
        }
    }

    pub fn start(&self) -> Result<(), String> {
        let _transition = self.try_lock_transition()?;
        self.start_unlocked()
    }

    fn start_unlocked(&self) -> Result<(), String> {
        self.set_lifecycle_for(LifecycleState::Starting, LifecycleScope::All);
        let result = self.start_inner();
        match &result {
            Ok(()) => self.set_lifecycle_for(LifecycleState::Running, LifecycleScope::All),
            Err(error) => {
                self.set_lifecycle_for(LifecycleState::Failed(error.clone()), LifecycleScope::All)
            }
        }
        result
    }

    fn start_inner(&self) -> Result<(), String> {
        let backend = self.prepare_backend()?;

        if let Some(layout) = bundled_macos_layout() {
            if !self.is_running_on("runtime", &backend) {
                self.spawn_packaged_runtime(&layout)?;
                self.wait_until("runtime", true, START_TIMEOUT, &backend)?;
            }
            if !self.is_running_on("server", &backend) {
                self.spawn_packaged_server(&layout)?;
                self.wait_until("server", true, START_TIMEOUT, &backend)?;
            }
            return Ok(());
        }

        if backend.placement == BackendPlacement::Wsl {
            self.write_wsl_control(true)?;
            self.start_lease()?;
            if !self.is_running_on("supervisor", &backend) {
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

    #[allow(dead_code)]
    pub fn start_runtime(&self) -> Result<(), String> {
        let _transition = self.try_lock_transition()?;
        self.start_runtime_unlocked()
    }

    fn start_runtime_unlocked(&self) -> Result<(), String> {
        self.set_lifecycle_for(LifecycleState::Starting, LifecycleScope::Runtime);
        let result = self.start_runtime_inner();
        match &result {
            Ok(()) => self.set_lifecycle_for(
                LifecycleState::Degraded("runtime only".to_string()),
                LifecycleScope::Runtime,
            ),
            Err(error) => self.set_lifecycle_for(
                LifecycleState::Failed(error.clone()),
                LifecycleScope::Runtime,
            ),
        }
        result
    }

    fn start_runtime_inner(&self) -> Result<(), String> {
        let backend = self.prepare_backend()?;
        if self.is_running_on("runtime", &backend) {
            return Ok(());
        }
        if let Some(layout) = bundled_macos_layout() {
            self.spawn_packaged_runtime(&layout)?;
            return self.wait_until("runtime", true, START_TIMEOUT, &backend);
        }
        if backend.placement == BackendPlacement::Wsl {
            self.write_wsl_control(false)?;
            self.start_lease()?;
            if !self.is_running_on("supervisor", &backend) {
                self.spawn_wsl_supervisor(&backend)?;
            }
        } else {
            self.spawn_workspace("@soloe/runtime", "runtime", &backend)?;
        }
        self.wait_until("runtime", true, START_TIMEOUT, &backend)
    }

    #[allow(dead_code)]
    pub fn start_server(&self) -> Result<(), String> {
        let _transition = self.try_lock_transition()?;
        self.start_server_unlocked()
    }

    fn start_server_unlocked(&self) -> Result<(), String> {
        self.set_lifecycle_for(LifecycleState::Starting, LifecycleScope::Server);
        let result = self.start_server_inner();
        match &result {
            Ok(()) => self.set_lifecycle_for(LifecycleState::Running, LifecycleScope::Server),
            Err(error) => self.set_lifecycle_for(
                LifecycleState::Failed(error.clone()),
                LifecycleScope::Server,
            ),
        }
        result
    }

    fn start_server_inner(&self) -> Result<(), String> {
        let backend = self.prepare_backend()?;
        if !self.is_running_on("runtime", &backend) {
            return Err(
                "start the Environment Runtime before starting the Soloe server".to_string(),
            );
        }
        if backend.placement == BackendPlacement::Wsl {
            if !self.is_running_on("supervisor", &backend) {
                return Err(
                    "WSL runtime supervisor is not running; restart the Environment Runtime"
                        .to_string(),
                );
            }
            self.write_wsl_control(true)?;
            self.wait_until("server", true, START_TIMEOUT, &backend)?;
        } else if let Some(layout) = bundled_macos_layout() {
            if !self.is_running_on("server", &backend) {
                self.spawn_packaged_server(&layout)?;
                self.wait_until("server", true, START_TIMEOUT, &backend)?;
            }
            return Ok(());
        } else if !self.is_running_on("server", &backend) {
            self.spawn_workspace("@soloe/server", "server", &backend)?;
            self.wait_until("server", true, START_TIMEOUT, &backend)?;
        }
        self.start_web_host(&backend)
    }

    fn prepare_backend(&self) -> Result<ActiveBackend, String> {
        fs::create_dir_all(&self.data_directory)
            .map_err(|error| format!("failed to create Soloe data directory: {error}"))?;
        let configured = ActiveBackend::from_settings(self.configured_backend()?, &self.owner_id);
        let active = self.read_active_backend();
        let existing_location = active.as_ref().unwrap_or(&configured);
        let live_services = ["runtime", "server"]
            .into_iter()
            .filter_map(|service| {
                self.live_service_info_for_location(service, existing_location)
                    .map(|info| (service, info))
            })
            .collect::<Vec<_>>();
        let foreign_services = live_services
            .iter()
            .filter(|(_, info)| info.owner_id.as_deref() != Some(self.owner_id.as_str()))
            .map(|(service, info)| (*service, info.clone()))
            .collect::<Vec<_>>();
        if !foreign_services.is_empty() {
            let names = foreign_services
                .iter()
                .map(|(service, _)| service_label(service))
                .collect::<Vec<_>>()
                .join(" and ");
            eprintln!("[tray] reclaiming {names} left behind by a previous Tray Host");
            for (service, info) in foreign_services.iter().rev() {
                let mut recorded_owner = existing_location.clone();
                recorded_owner.owner_id = info
                    .owner_id
                    .clone()
                    .ok_or_else(|| format!("{names} has no recorded owner"))?;
                self.stop_service(service, &recorded_owner)
                    .map_err(|error| {
                        format!(
                            "failed to reclaim {} after its Tray Host exited: {error}",
                            service_label(service)
                        )
                    })?;
            }
        }
        let live_services = ["runtime", "server"]
            .into_iter()
            .filter_map(|service| {
                self.live_service_info_for_location(service, existing_location)
                    .map(|info| (service, info))
            })
            .collect::<Vec<_>>();
        if let Some(active) = active
            && !live_services.is_empty()
            && !active.same_location(&configured)
        {
            return Err(
                "Backend Placement changed while Environment Runtime or Soloe Server is running; stop the services first"
                    .to_string(),
            );
        }
        let backend = configured;
        self.validate_backend(&backend)?;
        self.preflight(&backend)?;
        self.write_active_backend(&backend)?;
        Ok(backend)
    }

    #[allow(dead_code)]
    pub fn stop(&self) -> Result<(), String> {
        let _transition = self.try_lock_transition()?;
        self.stop_unlocked()
    }

    fn stop_unlocked(&self) -> Result<(), String> {
        self.set_lifecycle_for(LifecycleState::Stopping, LifecycleScope::All);
        let result = self.stop_inner();
        match &result {
            Ok(()) => self.set_lifecycle_for(LifecycleState::Stopped, LifecycleScope::All),
            Err(error) => {
                self.set_lifecycle_for(LifecycleState::Degraded(error.clone()), LifecycleScope::All)
            }
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
                "Soloe service cleanup incomplete; {}",
                failures.join("; ")
            ))
        }
    }

    #[allow(dead_code)]
    pub fn stop_server(&self) -> Result<(), String> {
        let _transition = self.try_lock_transition()?;
        self.stop_server_unlocked()
    }

    fn stop_server_unlocked(&self) -> Result<(), String> {
        self.set_lifecycle_for(LifecycleState::Stopping, LifecycleScope::Server);
        let result = self.stop_server_inner();
        match &result {
            Ok(()) => self.set_lifecycle_for(
                LifecycleState::Degraded("runtime only".to_string()),
                LifecycleScope::Server,
            ),
            Err(error) => self.set_lifecycle_for(
                LifecycleState::Degraded(error.clone()),
                LifecycleScope::Server,
            ),
        }
        result
    }

    fn stop_server_inner(&self) -> Result<(), String> {
        let backend = self.backend_for_existing_services();
        let mut failures = Vec::new();
        if let Err(error) = self.stop_web_host(&backend) {
            failures.push(format!("web: {error}"));
        }
        if backend.placement == BackendPlacement::Wsl && self.is_running_on("supervisor", &backend)
        {
            if let Err(error) = self.write_wsl_control(false) {
                failures.push(format!("server control: {error}"));
            } else if let Err(error) = self.wait_until("server", false, WSL_STOP_TIMEOUT, &backend)
            {
                failures.push(format!("server: {error}"));
            }
        } else if let Err(error) = self.stop_service("server", &backend) {
            failures.push(format!("server: {error}"));
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "server cleanup incomplete; {}",
                failures.join("; ")
            ))
        }
    }

    pub fn shutdown_all(&self) -> Result<(), String> {
        let _transition = self
            .transition
            .lock()
            .map_err(|_| "service transition lock poisoned".to_string())?;
        let client_result = self.stop_clients();
        let backend_result = self.stop_unlocked();
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
        self.running_terminal_count().is_none_or(|count| count > 0)
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
        if bundled_macos_layout().is_some() {
            let backend = self.backend_for_existing_services();
            return self
                .read_info("server")
                .filter(|info| self.service_info_is_running(info, &backend))
                .and_then(|info| {
                    let address = info.address?;
                    let token = info.token?;
                    Some(format!("{address}/?token={token}"))
                });
        }
        let backend = self.native_client_target();
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

    pub fn open_soloe(&self) -> Result<(), String> {
        if let Some(layout) = bundled_macos_layout() {
            let backend = self.backend_for_existing_services();
            let server = self
                .read_info("server")
                .filter(|info| self.service_info_is_running(info, &backend))
                .ok_or_else(|| "Soloe server is not running".to_string())?;
            let address = server
                .address
                .ok_or_else(|| "Soloe server did not publish an address".to_string())?;
            let token = server
                .token
                .ok_or_else(|| "Soloe server did not publish an access token".to_string())?;
            let mut command = layout
                .ui_spec(&self.data_directory, &address, &token)
                .command();
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            return self
                .spawn_owned(command, true)
                .map_err(|error| format!("failed to open Soloe: {error}"));
        }

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
            .map_err(|error| format!("failed to open Soloe: {error}"))
    }

    pub fn soloe_available(&self) -> bool {
        if let Err(error) = self.reap_clients() {
            eprintln!("[tray] failed to reap a closed Soloe UI: {error}");
        }
        if bundled_macos_layout().is_some() {
            let backend = self.backend_for_existing_services();
            return self.is_running_on("server", &backend);
        }
        self.browser_address().is_some()
    }

    pub fn launch_soloe_client_on_startup(&self) -> Result<(), String> {
        if self.configured_startup()?.launch_soloe_client {
            self.open_soloe()?;
        }
        Ok(())
    }

    fn read_stored_settings(&self) -> Result<StoredSettings, String> {
        let settings_path = self.data_directory.join("settings.json");
        match fs::read(&settings_path) {
            Ok(data) => {
                let json = data
                    .strip_prefix(&[0xEF, 0xBB, 0xBF])
                    .unwrap_or(data.as_slice());
                serde_json::from_slice::<StoredSettings>(json)
                    .map_err(|error| format!("failed to read {}: {error}", settings_path.display()))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(StoredSettings::default())
            }
            Err(error) => Err(format!(
                "failed to read {}: {error}",
                settings_path.display()
            )),
        }
    }

    fn configured_startup(&self) -> Result<StartupSettings, String> {
        Ok(self.read_stored_settings()?.startup)
    }

    fn configured_backend(&self) -> Result<BackendSettings, String> {
        let mut backend = self.read_stored_settings()?.backend;
        if let Some(value) = env::var_os("SOLOE_BACKEND_PLACEMENT") {
            backend.placement = match value.to_string_lossy().to_ascii_lowercase().as_str() {
                "windows" => BackendPlacement::Windows,
                "macos" => BackendPlacement::Macos,
                "wsl" => BackendPlacement::Wsl,
                other => return Err(format!("invalid SOLOE_BACKEND_PLACEMENT: {other}")),
            };
        }
        if let Ok(value) = env::var("SOLOE_WSL_DISTRO")
            && !value.trim().is_empty()
        {
            backend.wsl_distro = value.trim().to_string();
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
        if let Some(layout) = bundled_macos_layout() {
            if !layout.electron_executable.is_file() {
                return Err(format!(
                    "Soloe UI is missing at {}",
                    layout.electron_executable.display()
                ));
            }
            if !layout.payload_archive.is_file() {
                return Err(format!(
                    "Soloe payload is missing at {}",
                    layout.payload_archive.display()
                ));
            }
            return Ok(());
        }
        if !self.repository_root.join("package.json").is_file() {
            return Err(format!(
                "Soloe source is incomplete at {}; expected package.json",
                self.repository_root.display()
            ));
        }
        self.preflight_native_client()?;
        match backend.placement {
            BackendPlacement::Windows | BackendPlacement::Macos => {
                let host = backend.host_label();
                check_command(
                    Command::new("node").arg("--version"),
                    &format!("Node.js 22 or newer is required on {host}"),
                )?;
                check_command(
                    Command::new(pnpm_executable()).arg("--version"),
                    &format!("PNPM is required on {host}; enable the pinned version with Corepack"),
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
                    &format!(
                        "{host} backend dependencies are missing or incompatible; run pnpm install in this checkout"
                    ),
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

    fn preflight_native_client(&self) -> Result<(), String> {
        let host = native_backend_placement().host_label();
        check_command(
            Command::new("node").arg("--version"),
            &format!(
                "Node.js 22 or newer is required on {host} for the browser and desktop clients"
            ),
        )?;
        check_command(
            Command::new(pnpm_executable()).arg("--version"),
            &format!("PNPM is required on {host}; enable the pinned version with Corepack"),
        )?;
        let mut dependency = Command::new(pnpm_executable());
        dependency
            .args(["--filter", "@soloe/web", "exec", "vite", "--version"])
            .current_dir(&self.repository_root);
        check_command(
            &mut dependency,
            &format!("{host} client dependencies are missing; run pnpm install in this checkout"),
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
            BackendPlacement::Windows | BackendPlacement::Macos => {
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

    fn spawn_packaged_runtime(&self, layout: &BundledMacosLayout) -> Result<(), String> {
        let endpoint = self.data_directory.join("runtime.sock");
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_directory.join("runtime.log"))
            .map_err(|error| format!("failed to open runtime log: {error}"))?;
        let error_log = log
            .try_clone()
            .map_err(|error| format!("failed to clone runtime log: {error}"))?;
        let mut command = layout
            .runtime_spec(
                &self.data_directory,
                &endpoint.to_string_lossy(),
                &self.owner_id,
            )
            .command();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        self.spawn_owned(command, false)
            .map_err(|error| format!("failed to start packaged Soloe runtime: {error}"))
    }

    fn spawn_packaged_server(&self, layout: &BundledMacosLayout) -> Result<(), String> {
        let endpoint = self.data_directory.join("runtime.sock");
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.data_directory.join("server.log"))
            .map_err(|error| format!("failed to open server log: {error}"))?;
        let error_log = log
            .try_clone()
            .map_err(|error| format!("failed to clone server log: {error}"))?;
        let mut command = layout
            .server_spec(
                &self.data_directory,
                &endpoint.to_string_lossy(),
                &self.owner_id,
            )
            .command();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(error_log));
        self.spawn_owned(command, false)
            .map_err(|error| format!("failed to start packaged Soloe server: {error}"))
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
        let native = self.native_client_target();
        if self.is_running_on("web", &native) {
            return Ok(());
        }
        self.stop_orphaned_web_host()?;
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
        if let Some(hostname) = detect_tailscale_dns_name() {
            let allowed_hosts = match env::var("SOLOE_WEB_ALLOWED_HOSTS") {
                Ok(configured) if !configured.trim().is_empty() => {
                    format!("{configured},{hostname}")
                }
                _ => hostname,
            };
            command.env("SOLOE_WEB_ALLOWED_HOSTS", allowed_hosts);
        }
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
            .map_err(|error| format!("failed to start native browser host: {error}"))?;
        self.wait_until("web", true, START_TIMEOUT, &native)
            .map_err(|error| {
                format!(
                    "native browser host did not become ready: {error}; run pnpm install in this checkout"
                )
            })
    }

    fn stop_web_host(&self, _backend: &ActiveBackend) -> Result<(), String> {
        if self.stop_orphaned_web_host()? {
            return Ok(());
        }
        self.stop_service("web", &self.native_client_target())
    }

    fn stop_orphaned_web_host(&self) -> Result<bool, String> {
        let Some(info) = self.read_info("web") else {
            return Ok(false);
        };
        let Some(owner_id) = info.owner_id.clone() else {
            return Ok(false);
        };
        if owner_id == self.owner_id {
            return Ok(false);
        }
        let mut recorded_owner = self.native_client_target();
        recorded_owner.owner_id = owner_id;
        if !self.service_info_is_live_for_backend(&info, &recorded_owner) {
            return Ok(false);
        }
        eprintln!("[tray] stopping orphaned Soloe browser host from a previous Tray Host");
        self.stop_service("web", &recorded_owner)?;
        Ok(true)
    }

    fn spawn_owned(&self, mut command: Command, client: bool) -> Result<(), String> {
        let children = if client {
            &self.client_children
        } else {
            &self.backend_children
        };
        self.reap_children(children, "managed process")?;
        self.native_owner.prepare_command(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("process spawn failed: {error}"))?;
        if let Err(error) = self.native_owner.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let mut children = children
            .lock()
            .map_err(|_| "managed child lock poisoned".to_string())?;
        children.push(child);
        Ok(())
    }

    fn reap_clients(&self) -> Result<(), String> {
        self.reap_children(&self.client_children, "client process")
    }

    fn reap_children(&self, children: &Mutex<Vec<Child>>, label: &str) -> Result<(), String> {
        let mut children = children
            .lock()
            .map_err(|_| format!("{label} lock poisoned"))?;
        let mut running = Vec::with_capacity(children.len());
        let mut failures = Vec::new();
        for mut child in children.drain(..) {
            match child.try_wait() {
                Ok(Some(_)) => {
                    if let Err(error) = self.native_owner.release(child.id()) {
                        failures.push(format!(
                            "PID {} ownership release failed: {error}",
                            child.id()
                        ));
                    }
                }
                Ok(None) => running.push(child),
                Err(error) => {
                    failures.push(format!("PID {} status failed: {error}", child.id()));
                    running.push(child);
                }
            }
        }
        *children = running;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
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
        if let Some(supervisor) = self.read_info("supervisor")
            && supervisor.owner_id.as_deref() == Some(self.owner_id.as_str())
            && let Err(error) = self.processes.terminate(supervisor.pid, false, backend)
        {
            eprintln!(
                "[tray] graceful WSL supervisor shutdown failed for PID {}: {error}",
                supervisor.pid
            );
        }

        let server_stopped = self
            .wait_until("server", false, WSL_STOP_TIMEOUT, backend)
            .is_ok();
        let runtime_stopped = self
            .wait_until("runtime", false, WSL_STOP_TIMEOUT, backend)
            .is_ok();
        if !server_stopped && let Err(error) = self.stop_service("server", backend) {
            failures.push(format!("server: {error}"));
        }
        if !runtime_stopped && let Err(error) = self.stop_service("runtime", backend) {
            failures.push(format!("runtime: {error}"));
        }
        if !self.is_running_on("server", backend) && !self.is_running_on("runtime", backend) {
            self.remove_stale_info("supervisor");
            self.remove_stale_info("supervisor-control");
            self.remove_active_backend();
        } else {
            failures.push("WSL supervisor left managed processes running".to_string());
        }

        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Soloe service cleanup incomplete; {}",
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
        let web = if bundled_macos_layout().is_some() {
            server
        } else {
            self.is_running_on("web", &self.native_client_target())
        };
        let reconciled = match (runtime, server, web) {
            (true, true, true) => LifecycleState::Running,
            (true, true, false) => LifecycleState::Degraded("browser host unavailable".to_string()),
            (true, false, _) => LifecycleState::Degraded("runtime only".to_string()),
            (false, true, _) => LifecycleState::Degraded("server without runtime".to_string()),
            (false, false, true) => LifecycleState::Degraded(
                "browser host running without Environment Runtime or Soloe Server".to_string(),
            ),
            (false, false, false) => LifecycleState::Stopped,
        };
        if let Ok(mut current_state) = self.lifecycle.lock() {
            if *current_state != current {
                return current_state.clone();
            }
            if *current_state != reconciled {
                for message in
                    lifecycle_log_messages(&reconciled, LifecycleScope::All, runtime, server, web)
                {
                    eprintln!("{message}");
                }
                *current_state = reconciled.clone();
            }
        }
        reconciled
    }

    #[cfg(test)]
    fn set_lifecycle(&self, state: LifecycleState) {
        self.set_lifecycle_for(state, LifecycleScope::All);
    }

    fn set_lifecycle_for(&self, state: LifecycleState, scope: LifecycleScope) {
        if let Ok(mut current) = self.lifecycle.lock() {
            if *current == state {
                return;
            }
            let backend = self.backend_for_existing_services();
            let runtime = self.is_running_on("runtime", &backend);
            let server = self.is_running_on("server", &backend);
            let web = if bundled_macos_layout().is_some() {
                server
            } else {
                self.is_running_on("web", &self.native_client_target())
            };
            for message in lifecycle_log_messages(&state, scope, runtime, server, web) {
                eprintln!("{message}");
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
            if !self.processes.is_running(info.pid, backend) {
                self.remove_stale_info(service);
                return Ok(());
            }
            eprintln!(
                "[tray] graceful shutdown failed for {service} (PID {}): {error}; forcing cleanup",
                info.pid
            );
        } else if self.wait_until_pid_stopped(info.pid, STOP_TIMEOUT, backend) {
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
        if !self.wait_until_pid_stopped(info.pid, STOP_TIMEOUT, backend) {
            return Err(format!(
                "timed out waiting for {} to stop; see {}",
                service_label(service),
                self.data_directory.join(format!("{service}.log")).display()
            ));
        }
        self.remove_stale_info(service);
        Ok(())
    }

    fn wait_until_pid_stopped(&self, pid: u32, timeout: Duration, backend: &ActiveBackend) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if !self.processes.is_running(pid, backend) {
                return true;
            }
            thread::sleep(Duration::from_millis(100));
        }
        false
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
            "timed out waiting for {} to become {}; see {}",
            service_label(service),
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
        self.service_info_is_live_for_backend(info, backend)
            && (backend.placement == BackendPlacement::Wsl || self.owns_native_pid(info.pid))
    }

    fn service_info_is_live_for_backend(
        &self,
        info: &ServiceInfo,
        backend: &ActiveBackend,
    ) -> bool {
        info.owner_id.as_deref() == Some(backend.owner_id.as_str())
            && self.processes.is_running(info.pid, backend)
            && self
                .processes
                .has_owner(info.pid, backend, &backend.owner_id)
    }

    fn live_service_info_for_location(
        &self,
        service: &str,
        location: &ActiveBackend,
    ) -> Option<ServiceInfo> {
        let info = self.read_info(service)?;
        if info.service != service {
            return None;
        }
        let owner_id = info.owner_id.clone()?;
        let mut recorded_backend = location.clone();
        recorded_backend.owner_id = owner_id;
        self.service_info_is_live_for_backend(&info, &recorded_backend)
            .then_some(info)
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

    fn native_client_target(&self) -> ActiveBackend {
        ActiveBackend {
            placement: native_backend_placement(),
            wsl_distro: String::new(),
            wsl_repository_root: String::new(),
            owner_id: self.owner_id.clone(),
            tray_pid: std::process::id(),
        }
    }

    fn active_backend_path(&self) -> PathBuf {
        self.data_directory.join("active-backend.json")
    }

    fn write_wsl_control(&self, server_running: bool) -> Result<(), String> {
        let payload = serde_json::to_vec_pretty(&WslSupervisorControl {
            owner_id: &self.owner_id,
            server_running,
        })
        .map_err(|error| format!("failed to serialize WSL supervisor control: {error}"))?;
        fs::write(self.data_directory.join("supervisor-control.json"), payload)
            .map_err(|error| format!("failed to update WSL supervisor control: {error}"))
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

fn default_true() -> bool {
    true
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct BundledMacosLayout {
    electron_executable: PathBuf,
    payload_archive: PathBuf,
    runtime_script: PathBuf,
    server_script: PathBuf,
    web_root: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PackagedProcessSpec {
    executable: PathBuf,
    args: Vec<PathBuf>,
    env: Vec<(String, String)>,
}

impl PackagedProcessSpec {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.executable);
        command.args(&self.args).envs(self.env.iter().cloned());
        command
    }
}

impl BundledMacosLayout {
    fn runtime_spec(
        &self,
        data_directory: &Path,
        endpoint: &str,
        owner_id: &str,
    ) -> PackagedProcessSpec {
        PackagedProcessSpec {
            executable: self.electron_executable.clone(),
            args: vec![self.runtime_script.clone()],
            env: vec![
                ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
                (
                    "SOLOE_DATA_DIR".to_string(),
                    data_directory.to_string_lossy().into_owned(),
                ),
                ("SOLOE_OWNER_ID".to_string(), owner_id.to_string()),
                ("SOLOE_RUNTIME_ENDPOINT".to_string(), endpoint.to_string()),
            ],
        }
    }

    fn server_spec(
        &self,
        data_directory: &Path,
        endpoint: &str,
        owner_id: &str,
    ) -> PackagedProcessSpec {
        PackagedProcessSpec {
            executable: self.electron_executable.clone(),
            args: vec![self.server_script.clone()],
            env: vec![
                ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
                (
                    "SOLOE_DATA_DIR".to_string(),
                    data_directory.to_string_lossy().into_owned(),
                ),
                ("SOLOE_OWNER_ID".to_string(), owner_id.to_string()),
                ("SOLOE_RUNTIME_ENDPOINT".to_string(), endpoint.to_string()),
                (
                    "SOLOE_WEB_ROOT".to_string(),
                    self.web_root.to_string_lossy().into_owned(),
                ),
            ],
        }
    }

    fn ui_spec(
        &self,
        data_directory: &Path,
        server_address: &str,
        token: &str,
    ) -> PackagedProcessSpec {
        PackagedProcessSpec {
            executable: self.electron_executable.clone(),
            args: Vec::new(),
            env: vec![
                (
                    "SOLOE_DATA_DIR".to_string(),
                    data_directory.to_string_lossy().into_owned(),
                ),
                (
                    "SOLOE_CLIENT_SERVER_URL".to_string(),
                    format!("{server_address}/?token={token}"),
                ),
                ("SOLOE_SERVER_TOKEN".to_string(), token.to_string()),
                ("SOLOE_SUPERVISED_UI".to_string(), "1".to_string()),
            ],
        }
    }
}

#[cfg(any(target_os = "macos", all(test, not(target_os = "windows"))))]
fn bundled_macos_layout_from_executable(executable: &Path) -> Option<BundledMacosLayout> {
    let contents = executable.parent()?.parent()?;
    if contents.file_name()?.to_str()? != "Contents" {
        return None;
    }
    let embedded_app = contents.join("Resources").join("Soloe.app");
    let payload_archive = embedded_app.join("Contents/Resources/app.asar");
    Some(BundledMacosLayout {
        electron_executable: embedded_app.join("Contents/MacOS/Soloe"),
        runtime_script: payload_archive.join("out/main/runtime-host.js"),
        server_script: payload_archive.join("out/main/server-host.js"),
        web_root: payload_archive.join("out/web"),
        payload_archive,
    })
}

fn bundled_macos_layout() -> Option<BundledMacosLayout> {
    #[cfg(target_os = "macos")]
    {
        return bundled_macos_layout_from_executable(&env::current_exe().ok()?);
    }
    #[allow(unreachable_code)]
    None
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
        PathBuf::from(env::var_os("HOME").unwrap_or_else(|| ".".into()))
            .join("Library")
            .join("Application Support")
            .join("Soloe")
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
            .output()
            .is_ok_and(|output| output.status.success());
    }

    #[cfg(target_os = "windows")]
    let status = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .ok()
        .is_some_and(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()));
    #[cfg(not(target_os = "windows"))]
    let status = libc::pid_t::try_from(pid).is_ok_and(|native_pid| {
        // SAFETY: `native_pid` is range-checked and signal 0 only probes process existence.
        if unsafe { libc::kill(native_pid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    });
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

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let _ = (pid, owner_id);
        true
    }
    #[cfg(all(unix, not(any(target_os = "windows", target_os = "macos"))))]
    {
        fs::read(format!("/proc/{pid}/environ"))
            .ok()
            .is_some_and(|environment| {
                environment
                    .split(|byte| *byte == 0)
                    .any(|entry| entry == format!("SOLOE_OWNER_ID={owner_id}").as_bytes())
            })
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", unix)))]
    {
        let _ = (pid, owner_id);
        false
    }
}

fn terminate_pid(pid: u32, force: bool, backend: &ActiveBackend) -> Result<(), String> {
    if backend.placement != BackendPlacement::Wsl {
        #[cfg(not(target_os = "windows"))]
        {
            let native_pid = libc::pid_t::try_from(pid)
                .map_err(|_| format!("process ID {pid} is outside the native PID range"))?;
            let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
            // SAFETY: `native_pid` is range-checked and `signal` is a valid libc signal constant.
            let result = unsafe { libc::kill(native_pid, signal) };
            if result == 0 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                return Ok(());
            }
            return Err(format!("failed to stop process {pid}: {error}"));
        }
    }

    let output = if backend.placement == BackendPlacement::Wsl {
        Command::new("wsl.exe")
            .args([
                "--distribution",
                &backend.wsl_distro,
                "--exec",
                "kill",
                if force { "-KILL" } else { "-TERM" },
                &pid.to_string(),
            ])
            .output()
    } else {
        #[cfg(target_os = "windows")]
        {
            let mut command = Command::new("taskkill");
            command.args(["/PID", &pid.to_string(), "/T"]);
            if force {
                command.arg("/F");
            }
            command.output()
        }
        #[cfg(not(target_os = "windows"))]
        {
            unreachable!("native Unix termination returns before command dispatch")
        }
    };
    let output = output.map_err(|error| format!("failed to stop process {pid}: {error}"))?;
    if output.status.success() || !is_pid_running(pid, backend) {
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
        format!("process stop command failed for {pid}")
    } else {
        format!("process stop command failed for {pid}: {detail}")
    })
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

    #[test]
    fn reads_the_exact_magicdns_hostname_from_tailscale_status() {
        let status = br#"{
            "Self": {
                "DNSName": "LaptopLores.tail1ab873.ts.net."
            }
        }"#;

        assert_eq!(
            tailscale_dns_name_from_status(status).unwrap(),
            "laptoplores.tail1ab873.ts.net"
        );
        assert!(tailscale_dns_name_from_status(br#"{"Self":{"DNSName":".ts.net"}}"#).is_err());
    }

    #[derive(Default)]
    struct FakeProcessOperations {
        running: Mutex<HashSet<u32>>,
        disappears_before_graceful_signal: Mutex<HashSet<u32>>,
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
            if !force
                && self
                    .disappears_before_graceful_signal
                    .lock()
                    .unwrap()
                    .contains(&pid)
            {
                self.running.lock().unwrap().remove(&pid);
                return Err("process exited before the graceful signal arrived".to_string());
            }
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
    fn lifecycle_transition_rejects_a_second_action_without_reversing() {
        let supervisor = test_supervisor(
            PathBuf::from("/unused"),
            Arc::new(FakeProcessOperations::default()),
        );
        let _transition = supervisor.transition.lock().unwrap();

        let error = supervisor.toggle_server().unwrap_err();

        assert_eq!(error, "service transition already in progress");
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
        let suffix = if cfg!(target_os = "windows") {
            " (WSL)"
        } else {
            ""
        };
        assert_eq!(
            supervisor.server_action_label(),
            format!("Start Soloe server{suffix}")
        );
        assert_eq!(
            supervisor.runtime_action_label(),
            format!("Start Environment Runtime{suffix}")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn reads_macos_backend_placement_from_shared_settings() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-macos-settings-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("settings.json"),
            r#"{"backend":{"placement":"macos"}}"#,
        )
        .unwrap();
        let supervisor = test_supervisor(
            directory.clone(),
            Arc::new(FakeProcessOperations::default()),
        );

        assert_eq!(
            supervisor.configured_backend().unwrap().placement,
            BackendPlacement::Macos
        );
        let suffix = if cfg!(target_os = "windows") {
            " (macOS)"
        } else {
            ""
        };
        assert_eq!(
            supervisor.server_action_label(),
            format!("Start Soloe server{suffix}")
        );
        assert_eq!(
            supervisor.runtime_action_label(),
            format!("Start Environment Runtime{suffix}")
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn launches_the_soloe_client_on_startup_by_default_and_honors_opt_out() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-startup-settings-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        let supervisor = test_supervisor(
            directory.clone(),
            Arc::new(FakeProcessOperations::default()),
        );

        assert!(supervisor.configured_startup().unwrap().launch_soloe_client);

        fs::write(
            directory.join("settings.json"),
            r#"{"startup":{"launchSoloeClient":false}}"#,
        )
        .unwrap();
        assert!(!supervisor.configured_startup().unwrap().launch_soloe_client);
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_uses_native_process_group_membership_as_the_owner_boundary() {
        let backend = ActiveBackend {
            placement: BackendPlacement::Macos,
            wsl_distro: String::new(),
            wsl_repository_root: String::new(),
            owner_id: "tray-owner".to_string(),
            tray_pid: std::process::id(),
        };

        assert!(process_has_owner(
            std::process::id(),
            &backend,
            "tray-owner"
        ));
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
    #[cfg(not(target_os = "windows"))]
    fn installed_macos_product_resolves_its_private_runtime_server_web_and_ui() {
        let layout = bundled_macos_layout_from_executable(Path::new(
            "/Applications/Soloe.app/Contents/MacOS/soloe-tray",
        ))
        .unwrap();

        assert_eq!(
            layout.electron_executable,
            PathBuf::from(
                "/Applications/Soloe.app/Contents/Resources/Soloe.app/Contents/MacOS/Soloe"
            )
        );
        assert_eq!(
            layout.runtime_script,
            PathBuf::from(
                "/Applications/Soloe.app/Contents/Resources/Soloe.app/Contents/Resources/app.asar/out/main/runtime-host.js"
            )
        );
        assert_eq!(
            layout.server_script,
            PathBuf::from(
                "/Applications/Soloe.app/Contents/Resources/Soloe.app/Contents/Resources/app.asar/out/main/server-host.js"
            )
        );
        assert_eq!(
            layout.web_root,
            PathBuf::from(
                "/Applications/Soloe.app/Contents/Resources/Soloe.app/Contents/Resources/app.asar/out/web"
            )
        );
        assert_eq!(
            layout.payload_archive,
            PathBuf::from(
                "/Applications/Soloe.app/Contents/Resources/Soloe.app/Contents/Resources/app.asar"
            )
        );

        let runtime = layout.runtime_spec(
            Path::new("/Users/ada/Library/Application Support/Soloe"),
            "/tmp/soloe.sock",
            "tray-owner",
        );
        assert_eq!(runtime.executable, layout.electron_executable);
        assert_eq!(runtime.args, vec![layout.runtime_script.clone()]);
        assert_eq!(
            runtime.env,
            vec![
                ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
                (
                    "SOLOE_DATA_DIR".to_string(),
                    "/Users/ada/Library/Application Support/Soloe".to_string()
                ),
                ("SOLOE_OWNER_ID".to_string(), "tray-owner".to_string()),
                (
                    "SOLOE_RUNTIME_ENDPOINT".to_string(),
                    "/tmp/soloe.sock".to_string()
                )
            ]
        );

        let server = layout.server_spec(
            Path::new("/Users/ada/Library/Application Support/Soloe"),
            "/tmp/soloe.sock",
            "tray-owner",
        );
        assert_eq!(server.executable, layout.electron_executable);
        assert_eq!(server.args, vec![layout.server_script.clone()]);
        assert_eq!(
            server.env,
            vec![
                ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
                (
                    "SOLOE_DATA_DIR".to_string(),
                    "/Users/ada/Library/Application Support/Soloe".to_string()
                ),
                ("SOLOE_OWNER_ID".to_string(), "tray-owner".to_string()),
                (
                    "SOLOE_RUNTIME_ENDPOINT".to_string(),
                    "/tmp/soloe.sock".to_string()
                ),
                (
                    "SOLOE_WEB_ROOT".to_string(),
                    concat!(
                        "/Applications/Soloe.app/Contents/Resources/Soloe.app/Contents/",
                        "Resources/app.asar/out/web"
                    )
                    .to_string()
                )
            ]
        );

        let ui = layout.ui_spec(
            Path::new("/Users/ada/Library/Application Support/Soloe"),
            "http://127.0.0.1:4317",
            "secret-token",
        );
        assert_eq!(ui.executable, layout.electron_executable);
        assert!(ui.args.is_empty());
        assert_eq!(
            ui.env,
            vec![
                (
                    "SOLOE_DATA_DIR".to_string(),
                    "/Users/ada/Library/Application Support/Soloe".to_string()
                ),
                (
                    "SOLOE_CLIENT_SERVER_URL".to_string(),
                    "http://127.0.0.1:4317/?token=secret-token".to_string()
                ),
                ("SOLOE_SERVER_TOKEN".to_string(), "secret-token".to_string()),
                ("SOLOE_SUPERVISED_UI".to_string(), "1".to_string())
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn exited_ui_children_are_reaped_without_waiting_for_another_launch() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-client-reap-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let supervisor = test_supervisor(
            directory.clone(),
            Arc::new(FakeProcessOperations::default()),
        );
        let mut command = Command::new("sh");
        command.args(["-c", "exit 0"]);
        supervisor.spawn_owned(command, true).unwrap();

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            supervisor.reap_clients().unwrap();
            if supervisor.client_children.lock().unwrap().is_empty() {
                break;
            }
            assert!(Instant::now() < deadline, "exited UI child was not reaped");
            thread::sleep(Duration::from_millis(25));
        }
        fs::remove_dir_all(directory).unwrap();
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
    fn shutdown_reclaims_an_orphaned_development_web_host() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-orphaned-web-shutdown-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("runtime.json"),
            r#"{"service":"runtime","pid":4001,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        fs::write(
            directory.join("server.json"),
            r#"{"service":"server","pid":4002,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        fs::write(
            directory.join("web.json"),
            r#"{"service":"web","pid":4003,"ownerId":"previous-tray-owner"}"#,
        )
        .unwrap();
        let processes = Arc::new(FakeProcessOperations::with_running([4001, 4002, 4003]));
        let supervisor = test_supervisor(directory.clone(), processes.clone());

        expect_ok(supervisor.shutdown_all());

        assert!(processes.running.lock().unwrap().is_empty());
        assert!(!directory.join("runtime.json").exists());
        assert!(!directory.join("server.json").exists());
        assert!(!directory.join("web.json").exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn shutdown_treats_an_orphaned_web_host_that_exits_during_cleanup_as_stopped() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-orphaned-web-exit-race-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("web.json"),
            r#"{"service":"web","pid":4103,"ownerId":"previous-tray-owner"}"#,
        )
        .unwrap();
        let processes = Arc::new(FakeProcessOperations::with_running([4103]));
        processes
            .disappears_before_graceful_signal
            .lock()
            .unwrap()
            .insert(4103);
        let supervisor = test_supervisor(directory.clone(), processes.clone());

        expect_ok(supervisor.shutdown_all());

        assert_eq!(processes.calls.lock().unwrap().as_slice(), &[(4103, false)]);
        assert!(!directory.join("web.json").exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn stopping_server_preserves_the_environment_runtime() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-server-only-stop-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        fs::write(
            directory.join("runtime.json"),
            r#"{"service":"runtime","pid":3001,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        fs::write(
            directory.join("server.json"),
            r#"{"service":"server","pid":3002,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        fs::write(
            directory.join("web.json"),
            r#"{"service":"web","pid":3003,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        let processes = Arc::new(FakeProcessOperations::with_running([3001, 3002, 3003]));
        let supervisor = test_supervisor(directory.clone(), processes.clone());

        expect_ok(supervisor.stop_server());

        assert_eq!(
            processes.calls.lock().unwrap().as_slice(),
            &[(3003, false), (3002, false)]
        );
        assert!(processes.running.lock().unwrap().contains(&3001));
        assert!(!processes.running.lock().unwrap().contains(&3002));
        assert!(!processes.running.lock().unwrap().contains(&3003));
        assert!(directory.join("runtime.json").exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn wsl_control_records_server_intent_for_the_current_owner() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-wsl-control-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        let supervisor = test_supervisor(
            directory.clone(),
            Arc::new(FakeProcessOperations::default()),
        );

        expect_ok(supervisor.write_wsl_control(false));

        let control: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join("supervisor-control.json")).unwrap())
                .unwrap();
        assert_eq!(control["ownerId"], "test-owner");
        assert_eq!(control["serverRunning"], false);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn service_actions_reflect_independent_server_and_runtime_state() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-status-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        let processes = Arc::new(FakeProcessOperations::with_running([2001, 2002, 2003]));
        let supervisor = test_supervisor(directory.clone(), processes.clone());
        let host = native_backend_placement().host_label();
        let suffix = if cfg!(target_os = "windows") {
            format!(" ({host})")
        } else {
            String::new()
        };
        assert_eq!(
            supervisor.server_action_label(),
            format!("Start Soloe server{suffix}")
        );
        assert_eq!(
            supervisor.runtime_action_label(),
            format!("Start Environment Runtime{suffix}")
        );
        assert!(!supervisor.server_action_enabled());
        assert!(supervisor.runtime_action_enabled());
        supervisor.set_lifecycle(LifecycleState::Starting);
        assert_eq!(
            supervisor.server_action_label(),
            format!("Starting Soloe server{suffix}…")
        );
        assert_eq!(
            supervisor.runtime_action_label(),
            format!("Starting Environment Runtime{suffix}…")
        );
        assert!(!supervisor.server_action_enabled());
        assert!(!supervisor.runtime_action_enabled());
        supervisor.set_lifecycle(LifecycleState::Stopped);
        fs::write(
            directory.join("runtime.json"),
            r#"{"service":"runtime","pid":2001,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        assert_eq!(
            supervisor.server_action_label(),
            format!("Start Soloe server{suffix}")
        );
        assert_eq!(
            supervisor.runtime_action_label(),
            format!("Stop Environment Runtime{suffix}")
        );
        assert!(supervisor.server_action_enabled());
        assert!(supervisor.runtime_action_enabled());

        fs::write(
            directory.join("server.json"),
            r#"{"service":"server","pid":2002,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        assert_eq!(
            supervisor.server_action_label(),
            format!("Stop Soloe server{suffix}")
        );

        fs::write(
            directory.join("web.json"),
            r#"{"service":"web","pid":2003,"ownerId":"test-owner"}"#,
        )
        .unwrap();
        assert_eq!(
            supervisor.server_action_label(),
            format!("Stop Soloe server{suffix}")
        );
        supervisor.set_lifecycle(LifecycleState::Stopping);
        assert_eq!(
            supervisor.server_action_label(),
            format!("Stopping Soloe server{suffix}…")
        );
        assert_eq!(
            supervisor.runtime_action_label(),
            format!("Stopping Environment Runtime{suffix}…")
        );
        assert!(!supervisor.server_action_enabled());
        assert!(!supervisor.runtime_action_enabled());
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn lifecycle_logs_name_runtime_and_server_independently() {
        assert_eq!(
            lifecycle_log_messages(
                &LifecycleState::Starting,
                LifecycleScope::Runtime,
                false,
                false,
                false,
            ),
            vec!["[tray] Environment Runtime starting"]
        );
        assert_eq!(
            lifecycle_log_messages(
                &LifecycleState::Starting,
                LifecycleScope::Server,
                true,
                false,
                false,
            ),
            vec!["[tray] Soloe Server starting"]
        );
        assert_eq!(
            lifecycle_log_messages(
                &LifecycleState::Degraded("browser host unavailable".to_string()),
                LifecycleScope::All,
                true,
                true,
                false,
            ),
            vec![
                "[tray] Environment Runtime running",
                "[tray] Soloe Server degraded: browser host unavailable",
            ]
        );
        assert_eq!(
            lifecycle_log_messages(
                &LifecycleState::Failed(
                    "timed out waiting for Environment Runtime to become ready".to_string(),
                ),
                LifecycleScope::All,
                false,
                false,
                false,
            ),
            vec![
                "[tray] Environment Runtime failed: timed out waiting for Environment Runtime to become ready",
                "[tray] Soloe Server not started",
            ]
        );
    }

    #[test]
    fn reclaims_live_services_after_their_owning_tray_exits() {
        let directory = env::temp_dir().join(format!(
            "soloe-tray-previous-owner-test-{}",
            std::process::id()
        ));
        let _ = fs::create_dir_all(&directory);
        let _instance_guard = TrayInstanceGuard::acquire(&directory).unwrap();
        let processes = Arc::new(FakeProcessOperations::with_running([30453, 30508]));
        let supervisor = test_supervisor(directory.clone(), processes.clone());
        let previous_backend =
            ActiveBackend::from_settings(BackendSettings::default(), "previous-tray-owner");
        let runtime = ServiceInfo {
            service: "runtime".to_string(),
            pid: 30453,
            owner_id: Some("previous-tray-owner".to_string()),
            started_at: None,
            endpoint: Some("/tmp/soloe-runtime.sock".to_string()),
            address: None,
            token: None,
        };
        let server = ServiceInfo {
            service: "server".to_string(),
            pid: 30508,
            owner_id: Some("previous-tray-owner".to_string()),
            started_at: None,
            endpoint: None,
            address: Some("http://127.0.0.1:4317".to_string()),
            token: None,
        };

        assert!(supervisor.service_info_is_live_for_backend(&runtime, &previous_backend));
        assert!(supervisor.service_info_is_live_for_backend(&server, &previous_backend));
        supervisor.write_active_backend(&previous_backend).unwrap();
        fs::write(
            directory.join("runtime.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "service": "runtime",
                "pid": 30453,
                "ownerId": "previous-tray-owner",
                "endpoint": "/tmp/soloe-runtime.sock",
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("server.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "service": "server",
                "pid": 30508,
                "ownerId": "previous-tray-owner",
                "address": "http://127.0.0.1:4317",
            }))
            .unwrap(),
        )
        .unwrap();

        let error = supervisor.prepare_backend().unwrap_err();

        assert_eq!(
            error,
            "Soloe source is incomplete at /repo; expected package.json"
        );
        assert_eq!(
            processes.calls.lock().unwrap().as_slice(),
            &[(30508, false), (30453, false)]
        );
        assert!(!directory.join("runtime.json").exists());
        assert!(!directory.join("server.json").exists());

        let _ = fs::remove_dir_all(directory);
    }

    fn expect_ok(result: Result<(), String>) {
        if let Err(error) = result {
            panic!("expected success, got {error}");
        }
    }
}
