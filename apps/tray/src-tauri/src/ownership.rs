use fs2::FileExt;
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::ChildStdin;
#[cfg(all(unix, not(test)))]
use std::process::Stdio;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);

pub const PROCESS_WATCHDOG_ARGUMENT: &str = "--soloe-process-watchdog";

pub fn run_process_watchdog_if_requested() -> bool {
    if std::env::args_os().nth(1).as_deref() != Some(PROCESS_WATCHDOG_ARGUMENT.as_ref()) {
        return false;
    }
    #[cfg(unix)]
    if let Err(error) = run_unix_process_watchdog(BufReader::new(std::io::stdin())) {
        eprintln!("[tray-watchdog] {error}");
        std::process::exit(1);
    }
    true
}

pub struct TrayInstanceGuard {
    _file: File,
}

impl TrayInstanceGuard {
    pub fn acquire(data_directory: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_directory)
            .map_err(|error| format!("failed to create Soloe data directory: {error}"))?;
        let path = data_directory.join("tray.lock");
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
        file.try_lock_exclusive().map_err(|_| {
            "another live Soloe Tray Host is already running; open or quit that instance before starting Soloe again"
                .to_string()
        })?;
        Ok(Self { _file: file })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaseRecord {
    owner_id: String,
    tray_pid: u32,
    updated_at_ms: u128,
}

pub struct OwnershipLease {
    owner_id: String,
    path: PathBuf,
    running: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl OwnershipLease {
    pub fn start(data_directory: &Path, owner_id: &str, tray_pid: u32) -> Result<Self, String> {
        let path = data_directory.join("tray-lease.json");
        write_lease(&path, owner_id, tray_pid)?;
        let running = Arc::new(AtomicBool::new(true));
        let thread_running = Arc::clone(&running);
        let thread_path = path.clone();
        let thread_owner = owner_id.to_string();
        let thread = thread::Builder::new()
            .name("soloe-tray-lease".to_string())
            .spawn(move || {
                while thread_running.load(Ordering::Acquire) {
                    if let Err(error) = write_lease(&thread_path, &thread_owner, tray_pid) {
                        eprintln!("[tray] failed to refresh Tray Host ownership lease: {error}");
                    }
                    thread::sleep(HEARTBEAT_INTERVAL);
                }
            })
            .map_err(|error| format!("failed to start ownership heartbeat: {error}"))?;
        Ok(Self {
            owner_id: owner_id.to_string(),
            path,
            running,
            thread: Some(thread),
        })
    }
}

impl Drop for OwnershipLease {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        if lease_belongs_to(&self.path, &self.owner_id) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn write_lease(path: &Path, owner_id: &str, tray_pid: u32) -> Result<(), String> {
    let record = LeaseRecord {
        owner_id: owner_id.to_string(),
        tray_pid,
        updated_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    };
    let payload = serde_json::to_vec(&record)
        .map_err(|error| format!("failed to serialize ownership lease: {error}"))?;
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, payload)
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to publish {}: {error}", path.display()))
}

fn lease_belongs_to(path: &Path, owner_id: &str) -> bool {
    fs::read(path)
        .ok()
        .and_then(|data| serde_json::from_slice::<LeaseRecord>(&data).ok())
        .is_some_and(|record| record.owner_id == owner_id)
}

#[derive(Clone)]
pub struct NativeProcessOwner {
    inner: Arc<NativeProcessOwnerInner>,
}

impl NativeProcessOwner {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            inner: Arc::new(NativeProcessOwnerInner::new()?),
        })
    }

    pub fn assign(&self, child: &Child) -> Result<(), String> {
        self.inner.assign(child)
    }

    pub fn prepare_command(&self, command: &mut Command) {
        self.inner.prepare_command(command);
    }

    pub fn owns_pid(&self, pid: u32) -> bool {
        self.inner.owns_pid(pid)
    }

    pub fn release(&self, pid: u32) -> Result<(), String> {
        self.inner.release(pid)
    }

    pub fn terminate_all(&self) -> Result<(), String> {
        self.inner.terminate_all()
    }
}

#[cfg(unix)]
struct NativeProcessOwnerInner {
    process_groups: Mutex<Vec<u32>>,
    watchdog: Option<UnixProcessWatchdog>,
}

#[cfg(unix)]
struct UnixProcessWatchdog {
    input: Mutex<ChildStdin>,
    _child: Mutex<Child>,
}

#[cfg(unix)]
impl UnixProcessWatchdog {
    #[cfg(not(test))]
    fn spawn() -> Result<Self, String> {
        use std::os::unix::process::CommandExt;

        let executable = std::env::current_exe()
            .map_err(|error| format!("failed to locate the Tray Host executable: {error}"))?;
        let mut command = Command::new(executable);
        command
            .arg(PROCESS_WATCHDOG_ARGUMENT)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| format!("failed to start the process watchdog: {error}"))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| "process watchdog input was not available".to_string())?;
        Ok(Self {
            input: Mutex::new(input),
            _child: Mutex::new(child),
        })
    }

    fn update(&self, process_group: u32, owned: bool) -> Result<(), String> {
        let mut input = self
            .input
            .lock()
            .map_err(|_| "process watchdog input lock poisoned".to_string())?;
        writeln!(input, "{}{process_group}", if owned { '+' } else { '-' })
            .and_then(|_| input.flush())
            .map_err(|error| format!("process watchdog communication failed: {error}"))
    }
}

#[cfg(unix)]
impl NativeProcessOwnerInner {
    fn new() -> Result<Self, String> {
        Ok(Self {
            process_groups: Mutex::new(Vec::new()),
            #[cfg(not(test))]
            watchdog: Some(UnixProcessWatchdog::spawn()?),
            #[cfg(test)]
            watchdog: None,
        })
    }

    fn prepare_command(&self, command: &mut Command) {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        let pid = child.id();
        let process_group = unsafe { libc::getpgid(pid as libc::pid_t) };
        if process_group != pid as libc::pid_t {
            return Err(format!(
                "PID {pid} was not started as an isolated Soloe process group"
            ));
        }
        let mut groups = self
            .process_groups
            .lock()
            .map_err(|_| "native process-group lock poisoned".to_string())?;
        let inserted = if !groups.contains(&pid) {
            groups.push(pid);
            true
        } else {
            false
        };
        drop(groups);
        if inserted
            && let Some(watchdog) = &self.watchdog
            && let Err(error) = watchdog.update(pid, true)
        {
            let mut groups = self
                .process_groups
                .lock()
                .map_err(|_| "native process-group lock poisoned".to_string())?;
            groups.retain(|group| *group != pid);
            return Err(error);
        }
        Ok(())
    }

    fn owns_pid(&self, pid: u32) -> bool {
        let process_group = unsafe { libc::getpgid(pid as libc::pid_t) };
        if process_group <= 0 {
            return false;
        }
        self.process_groups
            .lock()
            .is_ok_and(|groups| groups.contains(&(process_group as u32)))
    }

    fn release(&self, pid: u32) -> Result<(), String> {
        let mut groups = self
            .process_groups
            .lock()
            .map_err(|_| "native process-group lock poisoned".to_string())?;
        let removed = groups.contains(&pid);
        groups.retain(|group| *group != pid);
        drop(groups);
        if removed && let Some(watchdog) = &self.watchdog {
            watchdog.update(pid, false)?;
        }
        Ok(())
    }

    fn terminate_all(&self) -> Result<(), String> {
        let groups = self
            .process_groups
            .lock()
            .map_err(|_| "native process-group lock poisoned".to_string())?
            .clone();
        let mut failures = Vec::new();
        for group in &groups {
            if !unix_signal_process_group(*group, libc::SIGTERM)
                && unix_process_group_has_live_process(*group)
            {
                failures.push(format!("failed to terminate process group {group}"));
            }
        }
        thread::sleep(Duration::from_millis(150));
        for group in &groups {
            if unix_process_group_has_live_process(*group)
                && !unix_signal_process_group(*group, libc::SIGKILL)
            {
                failures.push(format!("failed to kill process group {group}"));
            }
        }
        if failures.is_empty() {
            for group in groups {
                if !unix_process_group_has_live_process(group) {
                    self.release(group)?;
                }
            }
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

#[cfg(unix)]
fn run_unix_process_watchdog(reader: impl BufRead) -> Result<(), String> {
    let mut process_groups = HashSet::new();
    for line in reader.lines() {
        let line = line.map_err(|error| format!("failed to read owner updates: {error}"))?;
        let (owned, value) = if let Some(value) = line.strip_prefix('+') {
            (true, value)
        } else if let Some(value) = line.strip_prefix('-') {
            (false, value)
        } else {
            continue;
        };
        let Ok(process_group) = value.parse::<u32>() else {
            continue;
        };
        if process_group == 0 {
            continue;
        }
        if owned {
            process_groups.insert(process_group);
        } else {
            process_groups.remove(&process_group);
        }
    }

    let groups = process_groups.into_iter().collect::<Vec<_>>();
    for group in &groups {
        let _ = unix_signal_process_group(*group, libc::SIGTERM);
    }
    thread::sleep(Duration::from_millis(150));
    let mut failures = Vec::new();
    for group in groups {
        if unix_process_group_has_live_process(group)
            && !unix_signal_process_group(group, libc::SIGKILL)
            && unix_process_group_has_live_process(group)
        {
            failures.push(format!("failed to kill orphaned process group {group}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(unix)]
fn unix_signal_process_group(process_group: u32, signal: libc::c_int) -> bool {
    unsafe { libc::kill(-(process_group as libc::pid_t), signal) == 0 }
}

#[cfg(unix)]
fn unix_process_group_has_live_process(process_group: u32) -> bool {
    Command::new("ps")
        .args(["-axo", "pgid=,stat="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .is_some_and(|output| {
            String::from_utf8_lossy(&output.stdout).lines().any(|line| {
                let mut columns = line.split_whitespace();
                columns.next().and_then(|value| value.parse::<u32>().ok()) == Some(process_group)
                    && columns
                        .next()
                        .is_some_and(|status| !status.starts_with('Z'))
            })
        })
}

#[cfg(not(any(unix, target_os = "windows")))]
struct NativeProcessOwnerInner;

#[cfg(not(any(unix, target_os = "windows")))]
impl NativeProcessOwnerInner {
    fn new() -> Result<Self, String> {
        Ok(Self)
    }
    fn prepare_command(&self, _command: &mut Command) {}
    fn assign(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }
    fn owns_pid(&self, _pid: u32) -> bool {
        false
    }
    fn release(&self, _pid: u32) -> Result<(), String> {
        Ok(())
    }
    fn terminate_all(&self) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows_job {
    use super::*;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;
    use std::ptr;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    pub(super) struct NativeProcessOwnerInner {
        handle: HANDLE,
    }

    unsafe impl Send for NativeProcessOwnerInner {}
    unsafe impl Sync for NativeProcessOwnerInner {}

    impl NativeProcessOwnerInner {
        pub(super) fn new() -> Result<Self, String> {
            let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
            if handle.is_null() {
                return Err(format!(
                    "failed to create Windows backend Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if configured == 0 {
                unsafe { CloseHandle(handle) };
                return Err(format!(
                    "failed to configure Windows backend Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self { handle })
        }

        pub(super) fn assign(&self, child: &Child) -> Result<(), String> {
            let assigned =
                unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as HANDLE) };
            if assigned == 0 {
                return Err(format!(
                    "failed to assign PID {} to the Soloe Job Object: {}",
                    child.id(),
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }

        pub(super) fn prepare_command(&self, _command: &mut Command) {}

        pub(super) fn owns_pid(&self, pid: u32) -> bool {
            let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if process.is_null() {
                return false;
            }
            let mut result = 0;
            let checked = unsafe { IsProcessInJob(process, self.handle, &mut result) };
            unsafe { CloseHandle(process) };
            checked != 0 && result != 0
        }

        pub(super) fn release(&self, _pid: u32) -> Result<(), String> {
            Ok(())
        }

        pub(super) fn terminate_all(&self) -> Result<(), String> {
            let terminated = unsafe { TerminateJobObject(self.handle, 1) };
            if terminated == 0 {
                return Err(format!(
                    "failed to terminate the Soloe process Job Object: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        }
    }

    impl Drop for NativeProcessOwnerInner {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.handle) };
        }
    }
}

#[cfg(target_os = "windows")]
use windows_job::NativeProcessOwnerInner;

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[cfg(target_os = "windows")]
    use std::process::{Command, Stdio};

    #[cfg(target_os = "windows")]
    use std::thread;

    #[cfg(target_os = "windows")]
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    use std::process::{Command, Stdio};

    #[cfg(unix)]
    use std::io::Cursor;

    #[cfg(unix)]
    use std::thread;

    #[cfg(unix)]
    use std::time::{Duration, Instant};

    #[test]
    fn a_second_tray_cannot_acquire_the_same_lock() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-instance-lock-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        let first = TrayInstanceGuard::acquire(&directory).unwrap();
        let second = TrayInstanceGuard::acquire(&directory);

        assert_eq!(
            second.err().as_deref(),
            Some(
                "another live Soloe Tray Host is already running; open or quit that instance before starting Soloe again"
            )
        );

        drop(first);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn dropping_a_lease_removes_only_its_own_record() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-lease-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        let lease = OwnershipLease::start(&directory, "owner-one", 42).unwrap();
        assert!(lease_belongs_to(
            &directory.join("tray-lease.json"),
            "owner-one"
        ));

        drop(lease);
        assert!(!directory.join("tray-lease.json").exists());
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn terminate_all_ends_an_owned_unix_process_group() {
        let owner = NativeProcessOwner::new().unwrap();
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        owner.prepare_command(&mut command);
        let mut child = command.spawn().unwrap();
        owner.assign(&child).unwrap();
        assert!(owner.owns_pid(child.id()));

        owner.terminate_all().unwrap();
        let _ = child.wait();
        let deadline = Instant::now() + Duration::from_secs(5);
        while owner.owns_pid(child.id()) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!owner.owns_pid(child.id()));
    }

    #[cfg(unix)]
    #[test]
    fn watchdog_ends_owned_process_groups_when_the_owner_pipe_closes() {
        let mut command = Command::new("sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let mut child = command.spawn().unwrap();
        let process_group = child.id();

        run_unix_process_watchdog(Cursor::new(format!("+{process_group}\n"))).unwrap();

        let _ = child.wait();
        assert!(!unix_process_group_has_live_process(process_group));
    }

    #[cfg(unix)]
    #[test]
    fn released_unix_process_group_is_no_longer_owned() {
        let owner = NativeProcessOwner::new().unwrap();
        let mut command = Command::new("sleep");
        command
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        owner.prepare_command(&mut command);
        let mut child = command.spawn().unwrap();
        owner.assign(&child).unwrap();
        assert!(owner.owns_pid(child.id()));

        owner.release(child.id()).unwrap();
        assert!(!owner.owns_pid(child.id()));
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn terminate_all_ends_descendants_after_the_launcher_exits() {
        let pid_file =
            env::temp_dir().join(format!("soloe-owned-descendant-{}.pid", std::process::id()));
        let _ = fs::remove_file(&pid_file);
        let owner = NativeProcessOwner::new().unwrap();
        let mut launcher = Command::new(env::current_exe().unwrap())
            .args([
                "--exact",
                "ownership::tests::owned_descendant_launcher",
                "--nocapture",
            ])
            .env("SOLOE_TEST_DESCENDANT_PID_FILE", &pid_file)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        owner.assign(&launcher).unwrap();
        assert!(launcher.wait().unwrap().success());

        let deadline = Instant::now() + Duration::from_secs(5);
        let descendant_pid = loop {
            if let Ok(value) = fs::read_to_string(&pid_file) {
                break value.trim().parse::<u32>().unwrap();
            }
            assert!(
                Instant::now() < deadline,
                "descendant PID was not published"
            );
            thread::sleep(Duration::from_millis(25));
        };
        assert!(owner.owns_pid(descendant_pid));

        owner.terminate_all().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while owner.owns_pid(descendant_pid) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!owner.owns_pid(descendant_pid));
        let _ = fs::remove_file(pid_file);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn owned_descendant_launcher() {
        let Some(pid_file) = env::var_os("SOLOE_TEST_DESCENDANT_PID_FILE") else {
            return;
        };
        thread::sleep(Duration::from_millis(200));
        let child = Command::new("ping")
            .args(["127.0.0.1", "-n", "60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        fs::write(pid_file, child.id().to_string()).unwrap();
    }
}
