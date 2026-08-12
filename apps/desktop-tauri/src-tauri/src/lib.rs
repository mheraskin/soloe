use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, Webview, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

mod native_terminal_host;

#[derive(Default)]
struct BrowserHostState {
    next_id: AtomicU32,
    surfaces: Mutex<HashMap<u32, String>>,
}

impl BrowserHostState {
    fn allocate(&self) -> Result<(u32, String), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let label = format!("browser-surface-{id}");
        self.surfaces
            .lock()
            .map_err(|_| "browser surface registry lock poisoned".to_string())?
            .insert(id, label.clone());
        Ok((id, label))
    }

    fn label(&self, id: u32) -> Result<String, String> {
        self.surfaces
            .lock()
            .map_err(|_| "browser surface registry lock poisoned".to_string())?
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("browser surface {id} does not exist"))
    }

    fn remove(&self, id: u32) -> Result<String, String> {
        self.surfaces
            .lock()
            .map_err(|_| "browser surface registry lock poisoned".to_string())?
            .remove(&id)
            .ok_or_else(|| format!("browser surface {id} does not exist"))
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl SurfaceBounds {
    fn position(self) -> LogicalPosition<f64> {
        LogicalPosition::new(self.x.max(0.0), self.y.max(0.0))
    }

    fn size(self) -> LogicalSize<f64> {
        LogicalSize::new(self.width.max(1.0), self.height.max(1.0))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSurfaceCreateRequest {
    url: String,
    bounds: SurfaceBounds,
    visible: bool,
    user_agent: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSurfaceDescriptor {
    surface_id: u32,
    web_contents_id: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPageLoadEvent {
    surface_id: u32,
    url: String,
    phase: &'static str,
}

fn external_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("invalid URL: {error}"))?;
    match url.scheme() {
        "http" | "https" | "about" => Ok(url),
        scheme => Err(format!("URL scheme {scheme} is not allowed")),
    }
}

fn browser_webview(
    app: &tauri::AppHandle,
    state: &BrowserHostState,
    id: u32,
) -> Result<Webview, String> {
    let label = state.label(id)?;
    app.get_webview(&label)
        .ok_or_else(|| format!("browser surface {id} is not attached"))
}

#[tauri::command]
async fn browser_surface_create(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    request: BrowserSurfaceCreateRequest,
) -> Result<BrowserSurfaceDescriptor, String> {
    let url = external_url(&request.url)?;
    let (id, label) = state.allocate()?;
    let event_app = app.clone();
    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(url)).on_page_load(
        move |_webview, payload| {
            let phase = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            let _ = event_app.emit_to(
                "main",
                "soloe://browser-page-load",
                BrowserPageLoadEvent {
                    surface_id: id,
                    url: payload.url().to_string(),
                    phase,
                },
            );
        },
    );
    let builder = if let Some(user_agent) = request.user_agent.filter(|value| !value.is_empty()) {
        builder.user_agent(&user_agent)
    } else {
        builder
    };
    let window = app
        .get_window("main")
        .ok_or_else(|| "main Tauri window is unavailable".to_string())?;
    let webview = window
        .add_child(builder, request.bounds.position(), request.bounds.size())
        .map_err(|error| format!("failed to create browser surface: {error}"));
    let webview = match webview {
        Ok(webview) => webview,
        Err(error) => {
            let _ = state.remove(id);
            return Err(error);
        }
    };
    if !request.visible {
        webview
            .hide()
            .map_err(|error| format!("failed to hide browser surface: {error}"))?;
    }
    Ok(BrowserSurfaceDescriptor {
        surface_id: id,
        web_contents_id: id,
    })
}

#[tauri::command]
fn browser_surface_navigate(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    surface_id: u32,
    url: String,
) -> Result<(), String> {
    browser_webview(&app, &state, surface_id)?
        .navigate(external_url(&url)?)
        .map_err(|error| format!("failed to navigate browser surface: {error}"))
}

#[tauri::command]
fn browser_surface_set_bounds(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    surface_id: u32,
    bounds: SurfaceBounds,
) -> Result<(), String> {
    let webview = browser_webview(&app, &state, surface_id)?;
    webview
        .set_position(bounds.position())
        .and_then(|_| webview.set_size(bounds.size()))
        .map_err(|error| format!("failed to resize browser surface: {error}"))
}

#[tauri::command]
fn browser_surface_set_visible(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    surface_id: u32,
    visible: bool,
) -> Result<(), String> {
    let webview = browser_webview(&app, &state, surface_id)?;
    let result = if visible {
        webview.show()
    } else {
        webview.hide()
    };
    result.map_err(|error| format!("failed to change browser surface visibility: {error}"))
}

#[tauri::command]
fn browser_surface_reload(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    surface_id: u32,
) -> Result<(), String> {
    browser_webview(&app, &state, surface_id)?
        .reload()
        .map_err(|error| format!("failed to reload browser surface: {error}"))
}

#[tauri::command]
fn browser_surface_set_zoom(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    surface_id: u32,
    factor: f64,
) -> Result<(), String> {
    browser_webview(&app, &state, surface_id)?
        .set_zoom(factor.clamp(0.25, 5.0))
        .map_err(|error| format!("failed to zoom browser surface: {error}"))
}

#[tauri::command]
fn browser_surface_dispose(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    surface_id: u32,
) -> Result<(), String> {
    let label = state.remove(surface_id)?;
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    webview
        .close()
        .map_err(|error| format!("failed to dispose browser surface: {error}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebContentsRequest {
    web_contents_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceEmulationRequest {
    web_contents_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserAgentRequest {
    web_contents_id: u32,
    user_agent: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevToolsLayoutRequest {
    web_contents_id: u32,
    visible: Option<bool>,
}

fn ipc_success() -> serde_json::Value {
    serde_json::json!({ "ok": true, "value": true })
}

fn ipc_unsupported(message: &str) -> serde_json::Value {
    serde_json::json!({
        "ok": false,
        "code": "native_operation_not_supported",
        "error": message
    })
}

#[tauri::command]
fn browser_enable_device_emulation(request: DeviceEmulationRequest) -> serde_json::Value {
    let _ = request.web_contents_id;
    ipc_unsupported(
        "Tauri device sizing is available, but WebView device emulation is not implemented",
    )
}

#[tauri::command]
fn browser_disable_device_emulation(request: WebContentsRequest) -> serde_json::Value {
    let _ = request.web_contents_id;
    ipc_success()
}

#[tauri::command]
fn browser_set_user_agent(request: UserAgentRequest) -> serde_json::Value {
    let _ = (request.web_contents_id, request.user_agent);
    ipc_unsupported("a Tauri browser surface user agent can only be set during creation")
}

#[tauri::command]
fn browser_open_dev_tools(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    request: WebContentsRequest,
) -> serde_json::Value {
    match browser_webview(&app, &state, request.web_contents_id) {
        Ok(webview) => {
            webview.open_devtools();
            ipc_success()
        }
        Err(error) => ipc_unsupported(&format!("failed to open external DevTools: {error}")),
    }
}

#[tauri::command]
fn browser_set_dev_tools_layout(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    request: DevToolsLayoutRequest,
) -> serde_json::Value {
    let result = browser_webview(&app, &state, request.web_contents_id).and_then(|webview| {
        if request.visible == Some(false) {
            webview.close_devtools();
        }
        Ok(())
    });
    match result {
        Ok(()) => ipc_success(),
        Err(error) => ipc_unsupported(&format!("failed to update external DevTools: {error}")),
    }
}

#[tauri::command]
fn browser_close_dev_tools(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserHostState>,
    request: WebContentsRequest,
) -> serde_json::Value {
    match browser_webview(&app, &state, request.web_contents_id) {
        Ok(webview) => {
            webview.close_devtools();
            ipc_success()
        }
        Err(error) => ipc_unsupported(&format!("failed to close external DevTools: {error}")),
    }
}

#[tauri::command]
fn native_terminal_capabilities() -> native_terminal_host::Capabilities {
    native_terminal_host::capabilities()
}

#[tauri::command]
fn native_terminal_create(
    app: tauri::AppHandle,
    request: native_terminal_host::CreateRequest,
) -> Result<String, String> {
    native_terminal_host::create(&app, request)
}

#[tauri::command]
fn native_terminal_write(surface_id: String, data: String) -> Result<(), String> {
    native_terminal_host::write(&surface_id, &data)
}

#[tauri::command]
fn native_terminal_replace(surface_id: String, data: String) -> Result<(), String> {
    native_terminal_host::replace(&surface_id, &data)
}

#[tauri::command]
fn native_terminal_set_visible(surface_id: String, visible: bool) -> Result<(), String> {
    native_terminal_host::set_visible(&surface_id, visible)
}

#[tauri::command]
fn native_terminal_set_focused(surface_id: String, focused: bool) -> Result<(), String> {
    native_terminal_host::set_focused(&surface_id, focused)
}

#[tauri::command]
fn native_terminal_set_bounds(
    surface_id: String,
    bounds: native_terminal_host::Bounds,
) -> Result<native_terminal_host::TerminalSize, String> {
    native_terminal_host::set_bounds(&surface_id, bounds)
}

#[tauri::command]
fn native_terminal_set_configuration(
    surface_id: String,
    configuration: native_terminal_host::Configuration,
) -> Result<(), String> {
    native_terminal_host::set_configuration(&surface_id, configuration)
}

#[tauri::command]
fn native_terminal_paste(
    app: tauri::AppHandle,
    surface_id: String,
    text: String,
) -> Result<(), String> {
    native_terminal_host::paste(&app, &surface_id, &text)
}

#[tauri::command]
fn native_terminal_clear_selection(surface_id: String) -> Result<(), String> {
    native_terminal_host::clear_selection(&surface_id)
}

#[tauri::command]
fn native_terminal_find(
    surface_id: String,
    query: String,
    direction: String,
) -> Result<bool, String> {
    native_terminal_host::find(&surface_id, &query, &direction)
}

#[tauri::command]
fn native_terminal_export_buffer(surface_id: String) -> Result<String, String> {
    native_terminal_host::export_buffer(&surface_id)
}

#[tauri::command]
fn native_terminal_scroll_to_bottom(surface_id: String) -> Result<(), String> {
    native_terminal_host::scroll_to_bottom(&surface_id)
}

#[tauri::command]
fn native_terminal_dispose(surface_id: String) -> Result<(), String> {
    native_terminal_host::dispose(&surface_id)
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let target = external_url(&url)?;
    let status = platform_open_external(target.as_str())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("system URL opener exited with {status}"))
    }
}

#[cfg(target_os = "windows")]
fn platform_open_external(url: &str) -> Result<std::process::ExitStatus, String> {
    Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url])
        .status()
        .map_err(|error| format!("failed to open URL: {error}"))
}

#[cfg(target_os = "macos")]
fn platform_open_external(url: &str) -> Result<std::process::ExitStatus, String> {
    Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| format!("failed to open URL: {error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_open_external(url: &str) -> Result<std::process::ExitStatus, String> {
    Command::new("xdg-open")
        .arg(url)
        .status()
        .map_err(|error| format!("failed to open URL: {error}"))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
struct WebServiceRecord {
    address: String,
    token: String,
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

fn client_url_record(value: &str, fallback_token: Option<&str>) -> Option<WebServiceRecord> {
    let mut url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let token = url
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()))
        .or_else(|| fallback_token.map(str::to_owned))?;
    url.set_query(None);
    url.set_fragment(None);
    Some(WebServiceRecord {
        address: url.to_string(),
        token,
    })
}

fn backend_record() -> Option<WebServiceRecord> {
    if let Ok(value) = env::var("SOLOE_CLIENT_URL") {
        let fallback_token = env::var("SOLOE_SERVER_TOKEN").ok();
        if let Some(record) = client_url_record(&value, fallback_token.as_deref()) {
            return Some(record);
        }
    }
    fs::read(data_directory().join("web.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<WebServiceRecord>(&bytes).ok())
}

fn backend_initialization_script(record: Option<&WebServiceRecord>) -> String {
    let serialized = serde_json::to_string(&record).unwrap_or_else(|_| "null".to_string());
    format!("window.__SOLOE_TAURI_BACKEND__ = {serialized};")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BrowserHostState::default())
        .invoke_handler(tauri::generate_handler![
            browser_surface_create,
            browser_surface_navigate,
            browser_surface_set_bounds,
            browser_surface_set_visible,
            browser_surface_reload,
            browser_surface_set_zoom,
            browser_surface_dispose,
            browser_enable_device_emulation,
            browser_disable_device_emulation,
            browser_set_user_agent,
            browser_open_dev_tools,
            browser_set_dev_tools_layout,
            browser_close_dev_tools,
            native_terminal_capabilities,
            native_terminal_create,
            native_terminal_write,
            native_terminal_replace,
            native_terminal_set_visible,
            native_terminal_set_focused,
            native_terminal_set_bounds,
            native_terminal_set_configuration,
            native_terminal_paste,
            native_terminal_clear_selection,
            native_terminal_find,
            native_terminal_export_buffer,
            native_terminal_scroll_to_bottom,
            native_terminal_dispose,
            open_external,
        ])
        .setup(|app| {
            let backend = backend_record();
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("tauri.html".into()))
                    .title("Soloe — Tauri experimental")
                    .decorations(cfg!(target_os = "macos"))
                    .initialization_script(backend_initialization_script(backend.as_ref()))
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(720.0, 480.0)
                    .build()?;
            if let Err(error) = native_terminal_host::initialize(&window) {
                eprintln!("failed to initialize native terminal host: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Soloe Tauri desktop client");
}

#[cfg(test)]
mod tests {
    use super::{WebServiceRecord, backend_initialization_script, client_url_record};

    #[test]
    fn client_url_becomes_a_token_authenticated_backend_record() {
        assert_eq!(
            client_url_record("http://127.0.0.1:4318/?token=test-token#ignored", None),
            Some(WebServiceRecord {
                address: "http://127.0.0.1:4318/".to_string(),
                token: "test-token".to_string(),
            })
        );
        assert_eq!(
            client_url_record("https://example.test/", Some("fallback-token")),
            Some(WebServiceRecord {
                address: "https://example.test/".to_string(),
                token: "fallback-token".to_string(),
            })
        );
        assert_eq!(client_url_record("file:///tmp/soloe", Some("token")), None);
    }

    #[test]
    fn backend_bootstrap_is_serialized_as_data() {
        let script = backend_initialization_script(Some(&WebServiceRecord {
            address: "http://127.0.0.1:4318/".to_string(),
            token: "quote-\"-and-newline-\n".to_string(),
        }));

        assert_eq!(
            script,
            "window.__SOLOE_TAURI_BACKEND__ = {\"address\":\"http://127.0.0.1:4318/\",\"token\":\"quote-\\\"-and-newline-\\n\"};"
        );
        assert_eq!(
            backend_initialization_script(None),
            "window.__SOLOE_TAURI_BACKEND__ = null;"
        );
    }
}
