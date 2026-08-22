use arboard::{Clipboard, ImageData};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use image::ImageFormat;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::fs;
use std::io::Cursor;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES: u64 = 30 * 1024 * 1024;
const MAX_DECODED_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardRequest {
    version: u8,
    #[serde(rename = "type")]
    request_type: String,
    mime_type: String,
    data_base64: String,
}

#[derive(Serialize)]
struct ClipboardResponse<'a> {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a str>,
}

trait ClipboardBackend: Send {
    fn write_image(&mut self, mime_type: &str, data: &[u8]) -> Result<(), String>;
}

#[derive(Default)]
struct ArboardClipboardBackend {
    clipboard: Option<Clipboard>,
}

impl ClipboardBackend for ArboardClipboardBackend {
    fn write_image(&mut self, mime_type: &str, data: &[u8]) -> Result<(), String> {
        let format = match mime_type {
            "image/png" => ImageFormat::Png,
            "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
            "image/gif" => ImageFormat::Gif,
            "image/webp" => ImageFormat::WebP,
            other => return Err(format!("unsupported clipboard image type: {other}")),
        };
        let reader = image::ImageReader::with_format(Cursor::new(data), format);
        let (width, height) = reader
            .into_dimensions()
            .map_err(|error| format!("failed to read clipboard image dimensions: {error}"))?;
        let (width, height) = (u64::from(width), u64::from(height));
        let pixels = width
            .checked_mul(height)
            .ok_or_else(|| "clipboard image dimensions overflowed".to_string())?;
        if pixels == 0 || pixels > MAX_DECODED_PIXELS {
            return Err("clipboard image dimensions exceed the native limit".to_string());
        }
        let decoded = image::load_from_memory_with_format(data, format)
            .map_err(|error| format!("failed to decode clipboard image: {error}"))?;
        let rgba = decoded.into_rgba8();
        if self.clipboard.is_none() {
            self.clipboard =
                Some(Clipboard::new().map_err(|error| {
                    format!("failed to connect to the desktop clipboard: {error}")
                })?);
        }
        let clipboard = self
            .clipboard
            .as_mut()
            .expect("clipboard was initialized immediately above");
        clipboard
            .set_image(ImageData {
                width: width as usize,
                height: height as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            })
            .map_err(|error| format!("failed to place image on the desktop clipboard: {error}"))
    }
}

pub struct NativeClipboardHost {
    endpoint: PathBuf,
    shutdown: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl NativeClipboardHost {
    pub fn start(data_directory: &Path) -> Result<Self, String> {
        Self::start_with_backend(data_directory, Box::<ArboardClipboardBackend>::default())
    }

    fn start_with_backend(
        data_directory: &Path,
        mut backend: Box<dyn ClipboardBackend>,
    ) -> Result<Self, String> {
        fs::create_dir_all(data_directory)
            .map_err(|error| format!("failed to create clipboard IPC directory: {error}"))?;
        let endpoint = data_directory.join("clipboard.sock");
        if endpoint.exists() {
            fs::remove_file(&endpoint)
                .map_err(|error| format!("failed to remove stale clipboard IPC socket: {error}"))?;
        }
        let listener = UnixListener::bind(&endpoint)
            .map_err(|error| format!("failed to bind clipboard IPC socket: {error}"))?;
        fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure clipboard IPC socket: {error}"))?;

        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = Arc::clone(&shutdown);
        let worker = thread::Builder::new()
            .name("soloe-native-clipboard".to_string())
            .spawn(move || {
                for connection in listener.incoming() {
                    if worker_shutdown.load(Ordering::Acquire) {
                        break;
                    }
                    match connection {
                        Ok(mut stream) => {
                            let timeout = Some(Duration::from_secs(5));
                            let _ = stream.set_read_timeout(timeout);
                            let _ = stream.set_write_timeout(timeout);
                            if let Err(error) = handle_connection(&mut stream, backend.as_mut()) {
                                eprintln!("[tray] native clipboard request failed: {error}");
                            }
                        }
                        Err(error) => {
                            eprintln!("[tray] native clipboard IPC accept failed: {error}");
                        }
                    }
                }
            })
            .map_err(|error| format!("failed to start clipboard IPC worker: {error}"))?;

        Ok(Self {
            endpoint,
            shutdown,
            worker: Some(worker),
        })
    }

    pub fn endpoint(&self) -> &Path {
        &self.endpoint
    }
}

impl Drop for NativeClipboardHost {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = UnixStream::connect(&self.endpoint);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = fs::remove_file(&self.endpoint);
    }
}

fn handle_connection(
    stream: &mut UnixStream,
    backend: &mut dyn ClipboardBackend,
) -> Result<(), String> {
    let mut request_bytes = Vec::new();
    let mut reader = BufReader::new(&mut *stream).take(MAX_REQUEST_BYTES + 1);
    reader
        .read_until(b'\n', &mut request_bytes)
        .map_err(|error| format!("failed to read clipboard request: {error}"))?;
    let result = parse_request(&request_bytes)
        .and_then(|request| backend.write_image(&request.mime_type, &request.data));
    let error = result.as_ref().err().map(String::as_str);
    let response = serde_json::to_vec(&ClipboardResponse {
        ok: result.is_ok(),
        error,
    })
    .map_err(|error| format!("failed to encode clipboard response: {error}"))?;
    stream
        .write_all(&response)
        .and_then(|()| stream.write_all(b"\n"))
        .map_err(|error| format!("failed to write clipboard response: {error}"))?;
    result
}

struct ValidatedClipboardRequest {
    mime_type: String,
    data: Vec<u8>,
}

fn parse_request(request_bytes: &[u8]) -> Result<ValidatedClipboardRequest, String> {
    if request_bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err("clipboard request exceeded its size limit".to_string());
    }
    if request_bytes.last() != Some(&b'\n') {
        return Err("clipboard request was not newline terminated".to_string());
    }
    let request: ClipboardRequest = serde_json::from_slice(request_bytes)
        .map_err(|error| format!("invalid clipboard request: {error}"))?;
    if request.version != 1 || request.request_type != "write_image" {
        return Err("unsupported clipboard request version or type".to_string());
    }
    let data = BASE64
        .decode(request.data_base64)
        .map_err(|error| format!("invalid clipboard image encoding: {error}"))?;
    if data.is_empty() {
        return Err("clipboard image was empty".to_string());
    }
    if data.len() > MAX_IMAGE_BYTES {
        return Err("clipboard image exceeded its size limit".to_string());
    }
    Ok(ValidatedClipboardRequest {
        mime_type: request.mime_type.to_ascii_lowercase(),
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::{ClipboardBackend, NativeClipboardHost};
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD as BASE64;
    use std::fs;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct RecordingClipboard(Arc<Mutex<Vec<(String, Vec<u8>)>>>);

    impl ClipboardBackend for RecordingClipboard {
        fn write_image(&mut self, mime_type: &str, data: &[u8]) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .push((mime_type.to_string(), data.to_vec()));
            Ok(())
        }
    }

    #[test]
    fn clipboard_host_accepts_versioned_image_requests() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("soloe-clipboard-{suffix:x}"));
        let writes = Arc::new(Mutex::new(Vec::new()));
        let host = NativeClipboardHost::start_with_backend(
            &directory,
            Box::new(RecordingClipboard(Arc::clone(&writes))),
        )
        .unwrap();
        let mut stream = UnixStream::connect(host.endpoint()).unwrap();
        writeln!(
            stream,
            r#"{{"version":1,"type":"write_image","mimeType":"image/png","dataBase64":"{}"}}"#,
            BASE64.encode(b"png bytes")
        )
        .unwrap();
        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();

        assert_eq!(response, "{\"ok\":true}\n");
        assert_eq!(
            *writes.lock().unwrap(),
            vec![("image/png".to_string(), b"png bytes".to_vec())]
        );
        drop(host);
        let _ = fs::remove_dir_all(directory);
    }
}
