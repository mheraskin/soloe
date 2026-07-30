use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(1);

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
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| format!("failed to open {}: {error}", path.display()))?;
        file.try_lock_exclusive().map_err(|_| {
            "another Soloe tray instance is already supervising this backend".to_string()
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
                        eprintln!("[tray] failed to refresh backend ownership lease: {error}");
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

    pub fn owns_pid(&self, pid: u32) -> bool {
        self.inner.owns_pid(pid)
    }
}

#[cfg(not(target_os = "windows"))]
struct NativeProcessOwnerInner;

#[cfg(not(target_os = "windows"))]
impl NativeProcessOwnerInner {
    fn new() -> Result<Self, String> {
        Ok(Self)
    }

    fn assign(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }

    fn owns_pid(&self, _pid: u32) -> bool {
        true
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
        JobObjectExtendedLimitInformation, SetInformationJobObject,
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

    #[test]
    fn a_second_tray_cannot_acquire_the_same_lock() {
        let directory =
            env::temp_dir().join(format!("soloe-tray-instance-lock-{}", std::process::id()));
        let _ = fs::create_dir_all(&directory);
        let first = TrayInstanceGuard::acquire(&directory).unwrap();
        let second = TrayInstanceGuard::acquire(&directory);

        assert!(second.is_err());

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
}
