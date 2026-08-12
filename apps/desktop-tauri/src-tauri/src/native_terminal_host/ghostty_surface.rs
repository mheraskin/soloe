use super::*;
use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CString, c_char, c_void};
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::Emitter;

#[repr(C)]
struct SoloeGhosttyHost {
    _private: [u8; 0],
}

#[repr(C)]
struct SoloeGhosttySurface {
    _private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct NativeBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[repr(C)]
struct NativeConfiguration {
    font_family: *const c_char,
    font_size: f64,
    line_height: f64,
    background: *const c_char,
    foreground: *const c_char,
    scrollback: usize,
}

#[repr(C)]
#[derive(Default)]
struct NativeSize {
    columns: u16,
    rows: u16,
}

type BytesCallback = unsafe extern "C" fn(*mut c_void, *const u8, usize);
type TextCallback = unsafe extern "C" fn(*mut c_void, *const c_char, usize);

unsafe extern "C" {
    fn soloe_ghostty_host_new() -> *mut SoloeGhosttyHost;
    fn soloe_ghostty_host_free(host: *mut SoloeGhosttyHost);
    fn soloe_ghostty_surface_new(
        host: *mut SoloeGhosttyHost,
        parent_nsview: *mut c_void,
        bounds: NativeBounds,
        configuration: NativeConfiguration,
        visible: bool,
        focused: bool,
        event_userdata: *mut c_void,
        input_cb: BytesCallback,
        selection_cb: TextCallback,
        link_cb: TextCallback,
    ) -> *mut SoloeGhosttySurface;
    fn soloe_ghostty_surface_free(surface: *mut SoloeGhosttySurface);
    fn soloe_ghostty_surface_write(
        surface: *mut SoloeGhosttySurface,
        bytes: *const u8,
        len: usize,
    ) -> bool;
    fn soloe_ghostty_surface_replace(
        surface: *mut SoloeGhosttySurface,
        bytes: *const u8,
        len: usize,
    ) -> bool;
    fn soloe_ghostty_surface_set_visible(surface: *mut SoloeGhosttySurface, visible: bool) -> bool;
    fn soloe_ghostty_surface_set_focused(surface: *mut SoloeGhosttySurface, focused: bool) -> bool;
    fn soloe_ghostty_surface_set_bounds(
        surface: *mut SoloeGhosttySurface,
        bounds: NativeBounds,
        size: *mut NativeSize,
    ) -> bool;
    fn soloe_ghostty_surface_set_configuration(
        surface: *mut SoloeGhosttySurface,
        configuration: NativeConfiguration,
    ) -> bool;
    fn soloe_ghostty_surface_paste(
        surface: *mut SoloeGhosttySurface,
        bytes: *const u8,
        len: usize,
    ) -> bool;
    fn soloe_ghostty_surface_clear_selection(surface: *mut SoloeGhosttySurface) -> bool;
    fn soloe_ghostty_surface_find(
        surface: *mut SoloeGhosttySurface,
        query: *const c_char,
        len: usize,
    ) -> bool;
    fn soloe_ghostty_surface_export(
        surface: *mut SoloeGhosttySurface,
        len: *mut usize,
    ) -> *mut c_char;
    fn soloe_ghostty_surface_free_export(text: *mut c_char);
    fn soloe_ghostty_surface_scroll_to_bottom(surface: *mut SoloeGhosttySurface) -> bool;
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InputEvent {
    surface_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TextEvent {
    surface_id: String,
    text: String,
}

struct CallbackContext {
    app: AppHandle,
    surface_id: String,
}

struct Surface {
    raw: NonNull<SoloeGhosttySurface>,
    _callbacks: Box<CallbackContext>,
    terminal_id: String,
    session_id: String,
}

struct Host {
    raw: NonNull<SoloeGhosttyHost>,
    parent_view: *mut c_void,
    surfaces: HashMap<String, Surface>,
}

impl Drop for Host {
    fn drop(&mut self) {
        for (_, surface) in self.surfaces.drain() {
            unsafe { soloe_ghostty_surface_free(surface.raw.as_ptr()) };
        }
        unsafe { soloe_ghostty_host_free(self.raw.as_ptr()) };
    }
}

thread_local! {
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

static NEXT_SURFACE_ID: AtomicU32 = AtomicU32::new(1);

#[cfg(target_os = "macos")]
fn parent_view(window: &WebviewWindow) -> Result<*mut c_void, String> {
    window
        .ns_view()
        .map_err(|error| format!("failed to access Tauri AppKit view: {error}"))
}

#[cfg(target_os = "windows")]
fn parent_view(window: &WebviewWindow) -> Result<*mut c_void, String> {
    window
        .hwnd()
        .map(|handle| handle.0.cast())
        .map_err(|error| format!("failed to access Tauri Win32 window: {error}"))
}

#[cfg(target_os = "macos")]
fn platform_name() -> &'static str {
    "macos"
}

#[cfg(target_os = "windows")]
fn platform_name() -> &'static str {
    "windows"
}

#[cfg(target_os = "macos")]
fn implementation_name() -> &'static str {
    "tauri-ghostty-appkit-metal-manual-io"
}

#[cfg(target_os = "windows")]
fn implementation_name() -> &'static str {
    "tauri-ghostty-win32-wgl-manual-io"
}

#[cfg(target_os = "macos")]
fn success_reason() -> &'static str {
    "full Ghostty AppKit/Metal surface with Environment Runtime-owned PTY"
}

#[cfg(target_os = "windows")]
fn success_reason() -> &'static str {
    "full Ghostty Win32/WGL surface with Environment Runtime-owned PTY"
}

pub fn initialize(window: &WebviewWindow) -> Result<(), String> {
    let parent_view = parent_view(window)?;
    let raw = NonNull::new(unsafe { soloe_ghostty_host_new() })
        .ok_or_else(|| "failed to initialize the pinned Ghostty surface runtime".to_string())?;
    HOST.with(|slot| {
        *slot.borrow_mut() = Some(Host {
            raw,
            parent_view,
            surfaces: HashMap::new(),
        });
    });
    Ok(())
}

pub fn capabilities() -> Capabilities {
    let initialized = HOST.with(|slot| slot.borrow().is_some());
    Capabilities {
        available: initialized,
        complete: initialized,
        platform: platform_name(),
        implementation: implementation_name(),
        revision: GHOSTTY_SURFACE_REVISION,
        vertical_slice: initialized,
        reason: if initialized {
            success_reason().to_string()
        } else {
            "the full Ghostty surface runtime did not initialize".to_string()
        },
    }
}

pub fn create(app: &AppHandle, request: CreateRequest) -> Result<String, String> {
    let id = format!(
        "native-terminal-{}",
        NEXT_SURFACE_ID.fetch_add(1, Ordering::Relaxed)
    );
    HOST.with(|slot| {
        let mut host_slot = slot.borrow_mut();
        let host = host_slot
            .as_mut()
            .ok_or_else(|| "native terminal host is not initialized".to_string())?;
        let mut callbacks = Box::new(CallbackContext {
            app: app.clone(),
            surface_id: id.clone(),
        });
        let event_userdata = (&mut *callbacks as *mut CallbackContext).cast::<c_void>();
        let raw = with_native_configuration(&request.configuration, |configuration| unsafe {
            soloe_ghostty_surface_new(
                host.raw.as_ptr(),
                host.parent_view,
                request.bounds.into(),
                configuration,
                request.visible,
                request.focused,
                event_userdata,
                emit_input,
                emit_selection,
                emit_link,
            )
        })?;
        let raw = NonNull::new(raw)
            .ok_or_else(|| "Ghostty failed to create a manual-I/O native surface".to_string())?;
        host.surfaces.insert(
            id.clone(),
            Surface {
                raw,
                _callbacks: callbacks,
                terminal_id: request.terminal_id,
                session_id: request.session_id,
            },
        );
        Ok(id)
    })
}

pub fn write(surface_id: &str, data: &str) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        checked(
            unsafe { soloe_ghostty_surface_write(surface.raw.as_ptr(), data.as_ptr(), data.len()) },
            "Ghostty rejected terminal output",
        )
    })
}

pub fn replace(surface_id: &str, data: &str) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        checked(
            unsafe {
                soloe_ghostty_surface_replace(surface.raw.as_ptr(), data.as_ptr(), data.len())
            },
            "Ghostty failed to recreate the surface for replay replacement",
        )
    })
}

pub fn set_visible(surface_id: &str, visible: bool) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        checked(
            unsafe { soloe_ghostty_surface_set_visible(surface.raw.as_ptr(), visible) },
            "Ghostty failed to change surface visibility",
        )
    })
}

pub fn set_focused(surface_id: &str, focused: bool) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        checked(
            unsafe { soloe_ghostty_surface_set_focused(surface.raw.as_ptr(), focused) },
            "Ghostty failed to change surface focus",
        )
    })
}

pub fn set_bounds(surface_id: &str, bounds: Bounds) -> Result<TerminalSize, String> {
    with_surface(surface_id, |surface| {
        let mut size = NativeSize::default();
        checked(
            unsafe {
                soloe_ghostty_surface_set_bounds(surface.raw.as_ptr(), bounds.into(), &mut size)
            },
            "Ghostty failed to resize the native surface",
        )?;
        Ok(TerminalSize {
            cols: size.columns.max(1),
            rows: size.rows.max(1),
        })
    })
}

pub fn set_configuration(surface_id: &str, configuration: Configuration) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        with_native_configuration(&configuration, |native| {
            checked(
                unsafe { soloe_ghostty_surface_set_configuration(surface.raw.as_ptr(), native) },
                "Ghostty failed to apply terminal presentation configuration",
            )
        })?
    })
}

pub fn paste(_app: &AppHandle, surface_id: &str, text: &str) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        checked(
            unsafe { soloe_ghostty_surface_paste(surface.raw.as_ptr(), text.as_ptr(), text.len()) },
            "Ghostty failed to encode pasted text",
        )
    })
}

pub fn clear_selection(surface_id: &str) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        checked(
            unsafe { soloe_ghostty_surface_clear_selection(surface.raw.as_ptr()) },
            "Ghostty failed to clear the selection",
        )
    })
}

pub fn find(surface_id: &str, query: &str, _direction: &str) -> Result<bool, String> {
    let query = CString::new(query).map_err(|_| "search query contains a null byte".to_string())?;
    with_surface(surface_id, |surface| {
        Ok(unsafe {
            soloe_ghostty_surface_find(surface.raw.as_ptr(), query.as_ptr(), query.as_bytes().len())
        })
    })
}

pub fn export_buffer(surface_id: &str) -> Result<String, String> {
    with_surface(surface_id, |surface| {
        let mut len = 0;
        let text = unsafe { soloe_ghostty_surface_export(surface.raw.as_ptr(), &mut len) };
        if text.is_null() {
            return Err("Ghostty failed to export the complete terminal buffer".to_string());
        }
        let value =
            String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(text.cast::<u8>(), len) })
                .into_owned();
        unsafe { soloe_ghostty_surface_free_export(text) };
        Ok(value)
    })
}

pub fn scroll_to_bottom(surface_id: &str) -> Result<(), String> {
    with_surface(surface_id, |surface| {
        checked(
            unsafe { soloe_ghostty_surface_scroll_to_bottom(surface.raw.as_ptr()) },
            "Ghostty failed to scroll to the bottom",
        )
    })
}

pub fn dispose(surface_id: &str) -> Result<(), String> {
    HOST.with(|slot| {
        let mut host_slot = slot.borrow_mut();
        let host = host_slot
            .as_mut()
            .ok_or_else(|| "native terminal host is not initialized".to_string())?;
        let surface = host
            .surfaces
            .remove(surface_id)
            .ok_or_else(|| format!("native terminal surface {surface_id} does not exist"))?;
        unsafe { soloe_ghostty_surface_free(surface.raw.as_ptr()) };
        Ok(())
    })
}

fn with_surface<T>(
    surface_id: &str,
    operation: impl FnOnce(&mut Surface) -> Result<T, String>,
) -> Result<T, String> {
    HOST.with(|slot| {
        let mut host_slot = slot.borrow_mut();
        let host = host_slot
            .as_mut()
            .ok_or_else(|| "native terminal host is not initialized".to_string())?;
        let surface = host
            .surfaces
            .get_mut(surface_id)
            .ok_or_else(|| format!("native terminal surface {surface_id} does not exist"))?;
        operation(surface)
    })
}

fn with_native_configuration<T>(
    configuration: &Configuration,
    operation: impl FnOnce(NativeConfiguration) -> T,
) -> Result<T, String> {
    let font_family = CString::new(configuration.font_family.as_str())
        .map_err(|_| "font family contains a null byte".to_string())?;
    let background = CString::new(configuration.theme.background.as_str())
        .map_err(|_| "background color contains a null byte".to_string())?;
    let foreground = CString::new(configuration.theme.foreground.as_str())
        .map_err(|_| "foreground color contains a null byte".to_string())?;
    Ok(operation(NativeConfiguration {
        font_family: font_family.as_ptr(),
        font_size: configuration.font_size,
        line_height: configuration.line_height,
        background: background.as_ptr(),
        foreground: foreground.as_ptr(),
        scrollback: configuration.scrollback,
    }))
}

fn checked(value: bool, message: &str) -> Result<(), String> {
    value.then_some(()).ok_or_else(|| message.to_string())
}

impl From<Bounds> for NativeBounds {
    fn from(value: Bounds) -> Self {
        Self {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

unsafe extern "C" fn emit_input(userdata: *mut c_void, bytes: *const u8, len: usize) {
    let Some(context) = (unsafe { (userdata as *mut CallbackContext).as_ref() }) else {
        return;
    };
    if bytes.is_null() || len == 0 {
        return;
    }
    let data =
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(bytes, len) }).into_owned();
    let _ = context.app.emit_to(
        "main",
        "soloe://native-terminal-input",
        InputEvent {
            surface_id: context.surface_id.clone(),
            data,
        },
    );
}

unsafe extern "C" fn emit_selection(userdata: *mut c_void, text: *const c_char, len: usize) {
    emit_text_event(userdata, text, len, "soloe://native-terminal-selection");
}

unsafe extern "C" fn emit_link(userdata: *mut c_void, text: *const c_char, len: usize) {
    emit_text_event(userdata, text, len, "soloe://native-terminal-link");
}

fn emit_text_event(userdata: *mut c_void, text: *const c_char, len: usize, event: &'static str) {
    let Some(context) = (unsafe { (userdata as *mut CallbackContext).as_ref() }) else {
        return;
    };
    let value = if text.is_null() || len == 0 {
        String::new()
    } else {
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(text.cast::<u8>(), len) })
            .into_owned()
    };
    let _ = context.app.emit_to(
        "main",
        event,
        TextEvent {
            surface_id: context.surface_id.clone(),
            text: value,
        },
    );
}

#[allow(dead_code)]
fn _assert_surface_identity(surface: &Surface) -> (&str, &str, *mut SoloeGhosttySurface) {
    (
        &surface.terminal_id,
        &surface.session_id,
        surface.raw.as_ptr(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_neutral_bounds_preserve_dom_coordinates_for_the_native_bridge() {
        let native: NativeBounds = Bounds {
            x: 12.5,
            y: 24.0,
            width: 640.0,
            height: 360.0,
        }
        .into();
        assert_eq!(native.x, 12.5);
        assert_eq!(native.y, 24.0);
        assert_eq!(native.width, 640.0);
        assert_eq!(native.height, 360.0);
    }

    #[test]
    fn exact_manual_surface_revision_is_compiled_into_capabilities() {
        assert_eq!(
            GHOSTTY_SURFACE_REVISION,
            "f76c132e526f124fe4aaebd39f516751656844bc"
        );
    }
}
