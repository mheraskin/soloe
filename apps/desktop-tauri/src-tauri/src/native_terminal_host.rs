#![cfg_attr(
    not(any(
        all(target_os = "linux", feature = "libghostty-linux-prototype"),
        all(target_os = "macos", feature = "libghostty-macos-surface"),
        all(target_os = "windows", feature = "libghostty-windows-surface")
    )),
    allow(dead_code)
)]

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

#[cfg_attr(
    any(
        all(target_os = "macos", feature = "libghostty-macos-surface"),
        all(target_os = "windows", feature = "libghostty-windows-surface")
    ),
    allow(dead_code)
)]
pub const LIBGHOSTTY_REVISION: &str = "426386b8579d5e558aa5d4cfdfb003ad06bc4fc5";
#[cfg_attr(
    not(any(
        all(target_os = "macos", feature = "libghostty-macos-surface"),
        all(target_os = "windows", feature = "libghostty-windows-surface")
    )),
    allow(dead_code)
)]
pub const GHOSTTY_SURFACE_REVISION: &str = "f76c132e526f124fe4aaebd39f516751656844bc";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub available: bool,
    pub complete: bool,
    pub platform: &'static str,
    pub implementation: &'static str,
    pub revision: &'static str,
    pub vertical_slice: bool,
    pub reason: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub background: String,
    pub foreground: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    #[serde(default = "default_scrollback")]
    #[allow(dead_code)]
    pub scrollback: usize,
    pub theme: Theme,
}

fn default_scrollback() -> usize {
    10_000
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub terminal_id: String,
    pub session_id: String,
    pub bounds: Bounds,
    pub configuration: Configuration,
    pub visible: bool,
    pub focused: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

pub fn initialize(window: &WebviewWindow) -> Result<(), String> {
    platform::initialize(window)
}

pub fn capabilities() -> Capabilities {
    platform::capabilities()
}

pub fn create(app: &AppHandle, request: CreateRequest) -> Result<String, String> {
    platform::create(app, request)
}

pub fn write(surface_id: &str, data: &str) -> Result<(), String> {
    platform::write(surface_id, data)
}

pub fn replace(surface_id: &str, data: &str) -> Result<(), String> {
    platform::replace(surface_id, data)
}

pub fn set_visible(surface_id: &str, visible: bool) -> Result<(), String> {
    platform::set_visible(surface_id, visible)
}

pub fn set_focused(surface_id: &str, focused: bool) -> Result<(), String> {
    platform::set_focused(surface_id, focused)
}

pub fn set_bounds(surface_id: &str, bounds: Bounds) -> Result<TerminalSize, String> {
    platform::set_bounds(surface_id, bounds)
}

pub fn set_configuration(surface_id: &str, configuration: Configuration) -> Result<(), String> {
    platform::set_configuration(surface_id, configuration)
}

pub fn paste(app: &AppHandle, surface_id: &str, text: &str) -> Result<(), String> {
    platform::paste(app, surface_id, text)
}

pub fn clear_selection(surface_id: &str) -> Result<(), String> {
    platform::clear_selection(surface_id)
}

pub fn find(surface_id: &str, query: &str, direction: &str) -> Result<bool, String> {
    platform::find(surface_id, query, direction)
}

pub fn export_buffer(surface_id: &str) -> Result<String, String> {
    platform::export_buffer(surface_id)
}

pub fn scroll_to_bottom(surface_id: &str) -> Result<(), String> {
    platform::scroll_to_bottom(surface_id)
}

pub fn dispose(surface_id: &str) -> Result<(), String> {
    platform::dispose(surface_id)
}

#[cfg(all(target_os = "linux", feature = "libghostty-linux-prototype"))]
mod platform {
    use super::*;
    use gtk::cairo::{Context, FontSlant, FontWeight};
    use gtk::gdk;
    use gtk::prelude::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::ptr;
    use std::rc::{Rc, Weak};
    use std::sync::atomic::{AtomicU32, Ordering};
    use tauri::Emitter;

    const DEFAULT_COLS: u16 = 80;
    const DEFAULT_ROWS: u16 = 24;

    #[repr(C)]
    struct SoloeGhosttyTerminal {
        _private: [u8; 0],
    }

    unsafe extern "C" {
        fn soloe_ghostty_terminal_new(cols: u16, rows: u16) -> *mut SoloeGhosttyTerminal;
        fn soloe_ghostty_terminal_free(terminal: *mut SoloeGhosttyTerminal);
        fn soloe_ghostty_terminal_write(
            terminal: *mut SoloeGhosttyTerminal,
            data: *const u8,
            len: usize,
        );
        fn soloe_ghostty_terminal_replace(
            terminal: *mut SoloeGhosttyTerminal,
            data: *const u8,
            len: usize,
        );
        fn soloe_ghostty_terminal_resize(
            terminal: *mut SoloeGhosttyTerminal,
            cols: u16,
            rows: u16,
            cell_width_px: u32,
            cell_height_px: u32,
        ) -> bool;
        fn soloe_ghostty_terminal_export(
            terminal: *mut SoloeGhosttyTerminal,
            data: *mut *mut u8,
            len: *mut usize,
        ) -> bool;
        fn soloe_ghostty_terminal_free_export(data: *mut u8, len: usize);
    }

    struct GhosttyTerminal {
        raw: *mut SoloeGhosttyTerminal,
    }

    impl GhosttyTerminal {
        fn new() -> Result<Self, String> {
            let raw = unsafe { soloe_ghostty_terminal_new(DEFAULT_COLS, DEFAULT_ROWS) };
            if raw.is_null() {
                Err("libghostty-vt failed to create terminal state".to_string())
            } else {
                Ok(Self { raw })
            }
        }

        fn write(&mut self, data: &str) {
            unsafe { soloe_ghostty_terminal_write(self.raw, data.as_ptr(), data.len()) };
        }

        fn replace(&mut self, data: &str) {
            unsafe { soloe_ghostty_terminal_replace(self.raw, data.as_ptr(), data.len()) };
        }

        fn resize(&mut self, size: TerminalSize, cell_width: u32, cell_height: u32) -> bool {
            unsafe {
                soloe_ghostty_terminal_resize(
                    self.raw,
                    size.cols,
                    size.rows,
                    cell_width,
                    cell_height,
                )
            }
        }

        fn export(&self) -> Result<String, String> {
            let mut data = ptr::null_mut();
            let mut len = 0;
            if !unsafe { soloe_ghostty_terminal_export(self.raw, &mut data, &mut len) } {
                return Err("libghostty-vt failed to export terminal state".to_string());
            }
            let text = if data.is_null() || len == 0 {
                String::new()
            } else {
                String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(data, len) })
                    .into_owned()
            };
            unsafe { soloe_ghostty_terminal_free_export(data, len) };
            Ok(text)
        }
    }

    impl Drop for GhosttyTerminal {
        fn drop(&mut self) {
            unsafe { soloe_ghostty_terminal_free(self.raw) };
        }
    }

    struct Surface {
        terminal_id: String,
        session_id: String,
        popup: gtk::Window,
        drawing_area: gtk::DrawingArea,
        terminal: GhosttyTerminal,
        configuration: Configuration,
        bounds: Bounds,
        size: TerminalSize,
    }

    struct Host {
        main_window: gtk::ApplicationWindow,
        surfaces: HashMap<String, Rc<RefCell<Surface>>>,
    }

    thread_local! {
        static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
    }

    static NEXT_SURFACE_ID: AtomicU32 = AtomicU32::new(1);

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct InputEvent {
        surface_id: String,
        data: String,
    }

    pub fn initialize(window: &WebviewWindow) -> Result<(), String> {
        let main_window = window
            .gtk_window()
            .map_err(|error| format!("failed to access Tauri GTK window: {error}"))?;
        HOST.with(|slot| {
            *slot.borrow_mut() = Some(Host {
                main_window,
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
            platform: "linux",
            implementation: "tauri-libghostty-vt-gtk3-prototype",
            revision: LIBGHOSTTY_REVISION,
            vertical_slice: initialized,
            reason: if initialized {
                "official libghostty-vt with a Soloe-owned GTK3 surface; experimental parity"
                    .to_string()
            } else {
                "the GTK native terminal host did not initialize".to_string()
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
            let popup = gtk::Window::new(gtk::WindowType::Toplevel);
            popup.set_title("Soloe native terminal surface");
            popup.set_decorated(false);
            popup.set_skip_pager_hint(true);
            popup.set_skip_taskbar_hint(true);
            popup.set_keep_above(true);
            popup.set_transient_for(Some(&host.main_window));
            let drawing_area = gtk::DrawingArea::new();
            drawing_area.set_can_focus(true);
            popup.add(&drawing_area);

            let terminal = GhosttyTerminal::new()?;
            let size = terminal_size(request.bounds, &request.configuration);
            let surface = Rc::new(RefCell::new(Surface {
                terminal_id: request.terminal_id,
                session_id: request.session_id,
                popup,
                drawing_area: drawing_area.clone(),
                terminal,
                configuration: request.configuration,
                bounds: request.bounds,
                size,
            }));

            connect_draw(&drawing_area, Rc::downgrade(&surface));
            connect_input(&drawing_area, app.clone(), id.clone());
            position_surface(&host.main_window, &mut surface.borrow_mut())?;
            if request.visible {
                surface.borrow().popup.show_all();
            }
            if request.focused {
                surface.borrow().drawing_area.grab_focus();
            }
            host.surfaces.insert(id.clone(), surface);
            Ok(id)
        })
    }

    pub fn write(surface_id: &str, data: &str) -> Result<(), String> {
        with_surface(surface_id, |surface| {
            surface.terminal.write(data);
            surface.drawing_area.queue_draw();
            Ok(())
        })
    }

    pub fn replace(surface_id: &str, data: &str) -> Result<(), String> {
        with_surface(surface_id, |surface| {
            surface.terminal.replace(data);
            surface.drawing_area.queue_draw();
            Ok(())
        })
    }

    pub fn set_visible(surface_id: &str, visible: bool) -> Result<(), String> {
        with_surface(surface_id, |surface| {
            if visible {
                surface.popup.show_all();
            } else {
                surface.popup.hide();
            }
            Ok(())
        })
    }

    pub fn set_focused(surface_id: &str, focused: bool) -> Result<(), String> {
        with_surface(surface_id, |surface| {
            if focused {
                surface.popup.present();
                surface.drawing_area.grab_focus();
            }
            Ok(())
        })
    }

    pub fn set_bounds(surface_id: &str, bounds: Bounds) -> Result<TerminalSize, String> {
        HOST.with(|slot| {
            let host_slot = slot.borrow();
            let host = host_slot
                .as_ref()
                .ok_or_else(|| "native terminal host is not initialized".to_string())?;
            let surface = host
                .surfaces
                .get(surface_id)
                .ok_or_else(|| format!("native terminal surface {surface_id} does not exist"))?;
            let mut surface = surface.borrow_mut();
            surface.bounds = bounds;
            position_surface(&host.main_window, &mut surface)?;
            Ok(surface.size)
        })
    }

    pub fn set_configuration(surface_id: &str, configuration: Configuration) -> Result<(), String> {
        HOST.with(|slot| {
            let host_slot = slot.borrow();
            let host = host_slot
                .as_ref()
                .ok_or_else(|| "native terminal host is not initialized".to_string())?;
            let surface = host
                .surfaces
                .get(surface_id)
                .ok_or_else(|| format!("native terminal surface {surface_id} does not exist"))?;
            let mut surface = surface.borrow_mut();
            surface.configuration = configuration;
            position_surface(&host.main_window, &mut surface)?;
            surface.drawing_area.queue_draw();
            Ok(())
        })
    }

    pub fn paste(app: &AppHandle, surface_id: &str, text: &str) -> Result<(), String> {
        emit_input(app, surface_id, text)
    }

    pub fn clear_selection(surface_id: &str) -> Result<(), String> {
        with_surface(surface_id, |_surface| Ok(()))
    }

    pub fn find(surface_id: &str, query: &str, _direction: &str) -> Result<bool, String> {
        with_surface(surface_id, |surface| {
            Ok(surface.terminal.export()?.contains(query))
        })
    }

    pub fn export_buffer(surface_id: &str) -> Result<String, String> {
        with_surface(surface_id, |surface| surface.terminal.export())
    }

    pub fn scroll_to_bottom(surface_id: &str) -> Result<(), String> {
        with_surface(surface_id, |_surface| Ok(()))
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
            surface.borrow().popup.close();
            Ok(())
        })
    }

    fn with_surface<T>(
        surface_id: &str,
        operation: impl FnOnce(&mut Surface) -> Result<T, String>,
    ) -> Result<T, String> {
        HOST.with(|slot| {
            let host_slot = slot.borrow();
            let host = host_slot
                .as_ref()
                .ok_or_else(|| "native terminal host is not initialized".to_string())?;
            let surface = host
                .surfaces
                .get(surface_id)
                .ok_or_else(|| format!("native terminal surface {surface_id} does not exist"))?;
            operation(&mut surface.borrow_mut())
        })
    }

    fn position_surface(
        main_window: &gtk::ApplicationWindow,
        surface: &mut Surface,
    ) -> Result<(), String> {
        let (window_x, window_y) = main_window.position();
        let width = surface.bounds.width.max(1.0).round() as i32;
        let height = surface.bounds.height.max(1.0).round() as i32;
        surface.popup.move_(
            window_x + surface.bounds.x.max(0.0).round() as i32,
            window_y + surface.bounds.y.max(0.0).round() as i32,
        );
        surface.popup.resize(width, height);
        surface.drawing_area.set_size_request(width, height);

        let next_size = terminal_size(surface.bounds, &surface.configuration);
        let (cell_width, cell_height) = cell_metrics(&surface.configuration);
        if !surface.terminal.resize(
            next_size,
            cell_width.round() as u32,
            cell_height.round() as u32,
        ) {
            return Err("libghostty-vt rejected the terminal resize".to_string());
        }
        surface.size = next_size;
        Ok(())
    }

    fn terminal_size(bounds: Bounds, configuration: &Configuration) -> TerminalSize {
        let (cell_width, cell_height) = cell_metrics(configuration);
        TerminalSize {
            cols: ((bounds.width / cell_width).floor() as u64).clamp(1, u16::MAX as u64) as u16,
            rows: ((bounds.height / cell_height).floor() as u64).clamp(1, u16::MAX as u64) as u16,
        }
    }

    fn cell_metrics(configuration: &Configuration) -> (f64, f64) {
        let font_size = configuration.font_size.max(6.0);
        let line_height = configuration.line_height.max(1.0);
        (
            (font_size * 0.62).max(4.0),
            (font_size * 1.3 * line_height).max(8.0),
        )
    }

    fn connect_draw(area: &gtk::DrawingArea, surface: Weak<RefCell<Surface>>) {
        area.connect_draw(move |_area, context| {
            let Some(surface) = surface.upgrade() else {
                return gtk::glib::Propagation::Proceed;
            };
            let surface = surface.borrow();
            draw_surface(context, &surface);
            gtk::glib::Propagation::Proceed
        });
    }

    fn draw_surface(context: &Context, surface: &Surface) {
        let background = parse_color(
            &surface.configuration.theme.background,
            (0.059, 0.059, 0.063),
        );
        let foreground = parse_color(
            &surface.configuration.theme.foreground,
            (0.902, 0.902, 0.902),
        );
        context.set_source_rgb(background.0, background.1, background.2);
        let _ = context.paint();
        context.set_source_rgb(foreground.0, foreground.1, foreground.2);
        let family = surface
            .configuration
            .font_family
            .split(',')
            .next()
            .unwrap_or("monospace")
            .trim();
        context.select_font_face(family, FontSlant::Normal, FontWeight::Normal);
        context.set_font_size(surface.configuration.font_size.max(6.0));
        let (_, line_height) = cell_metrics(&surface.configuration);
        if let Ok(text) = surface.terminal.export() {
            for (row, line) in text.lines().take(surface.size.rows as usize).enumerate() {
                context.move_to(4.0, 3.0 + line_height * (row as f64 + 0.8));
                let _ = context.show_text(line);
            }
        }
    }

    fn parse_color(value: &str, fallback: (f64, f64, f64)) -> (f64, f64, f64) {
        let value = value.strip_prefix('#').unwrap_or(value);
        if value.len() != 6 {
            return fallback;
        }
        let parsed = u32::from_str_radix(value, 16).ok();
        parsed.map_or(fallback, |rgb| {
            (
                ((rgb >> 16) & 0xff) as f64 / 255.0,
                ((rgb >> 8) & 0xff) as f64 / 255.0,
                (rgb & 0xff) as f64 / 255.0,
            )
        })
    }

    fn connect_input(area: &gtk::DrawingArea, app: AppHandle, surface_id: String) {
        area.connect_key_press_event(move |_area, event| {
            if let Some(data) = key_input(event) {
                let _ = emit_input(&app, &surface_id, &data);
                gtk::glib::Propagation::Stop
            } else {
                gtk::glib::Propagation::Proceed
            }
        });
    }

    fn key_input(event: &gdk::EventKey) -> Option<String> {
        use gdk::keys::constants;
        let key = event.keyval();
        let special = match key {
            constants::Return => Some("\r"),
            constants::BackSpace => Some("\x7f"),
            constants::Tab => Some("\t"),
            constants::Escape => Some("\x1b"),
            constants::Up => Some("\x1b[A"),
            constants::Down => Some("\x1b[B"),
            constants::Right => Some("\x1b[C"),
            constants::Left => Some("\x1b[D"),
            constants::Home => Some("\x1b[H"),
            constants::End => Some("\x1b[F"),
            constants::Delete => Some("\x1b[3~"),
            constants::Page_Up => Some("\x1b[5~"),
            constants::Page_Down => Some("\x1b[6~"),
            _ => None,
        };
        if let Some(value) = special {
            return Some(value.to_string());
        }
        let character = key.to_unicode()?;
        if event.state().contains(gdk::ModifierType::CONTROL_MASK) {
            let lower = character.to_ascii_lowercase();
            if lower.is_ascii_lowercase() {
                return Some(((lower as u8 - b'a' + 1) as char).to_string());
            }
        }
        Some(character.to_string())
    }

    fn emit_input(app: &AppHandle, surface_id: &str, data: &str) -> Result<(), String> {
        app.emit_to(
            "main",
            "soloe://native-terminal-input",
            InputEvent {
                surface_id: surface_id.to_string(),
                data: data.to_string(),
            },
        )
        .map_err(|error| format!("failed to emit native terminal input: {error}"))
    }

    #[allow(dead_code)]
    fn _assert_surface_identity(surface: &Surface) -> (&str, &str, *mut c_void) {
        (
            &surface.terminal_id,
            &surface.session_id,
            surface.terminal.raw.cast(),
        )
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn pinned_libghostty_state_writes_resizes_replaces_and_exports() {
            let mut terminal = GhosttyTerminal::new().expect("create terminal");
            terminal.write("first\r\n\x1b[32mgreen\x1b[0m");
            let initial = terminal.export().expect("export initial buffer");
            assert!(initial.contains("first"));
            assert!(initial.contains("green"));

            assert!(terminal.resize(TerminalSize { cols: 40, rows: 10 }, 8, 16,));
            terminal.replace("replacement");
            let replaced = terminal.export().expect("export replaced buffer");
            assert!(replaced.contains("replacement"));
            assert!(!replaced.contains("first"));
        }

        #[test]
        fn terminal_size_uses_shell_neutral_bounds_and_configuration() {
            let configuration = Configuration {
                font_family: "monospace".to_string(),
                font_size: 10.0,
                line_height: 1.0,
                scrollback: 10_000,
                theme: Theme {
                    background: "#000000".to_string(),
                    foreground: "#ffffff".to_string(),
                },
            };
            let size = terminal_size(
                Bounds {
                    x: 0.0,
                    y: 0.0,
                    width: 620.0,
                    height: 260.0,
                },
                &configuration,
            );
            assert_eq!(size.cols, 100);
            assert_eq!(size.rows, 20);
        }

        #[test]
        #[ignore = "requires a graphical GTK session"]
        fn gtk_surface_lifecycle_smoke() {
            gtk::init().expect("initialize GTK");
            let popup = gtk::Window::new(gtk::WindowType::Toplevel);
            popup.set_decorated(false);
            let drawing_area = gtk::DrawingArea::new();
            drawing_area.set_can_focus(true);
            popup.add(&drawing_area);

            let mut surface = Surface {
                terminal_id: "terminal-smoke".to_string(),
                session_id: "session-smoke".to_string(),
                popup,
                drawing_area,
                terminal: GhosttyTerminal::new().expect("create terminal"),
                configuration: Configuration {
                    font_family: "monospace".to_string(),
                    font_size: 12.0,
                    line_height: 1.0,
                    scrollback: 10_000,
                    theme: Theme {
                        background: "#000000".to_string(),
                        foreground: "#ffffff".to_string(),
                    },
                },
                bounds: Bounds {
                    x: 20.0,
                    y: 20.0,
                    width: 480.0,
                    height: 240.0,
                },
                size: TerminalSize { cols: 80, rows: 24 },
            };

            surface.terminal.write("native GTK surface\r\n");
            surface.popup.resize(480, 240);
            surface.popup.show_all();
            surface.drawing_area.grab_focus();
            while gtk::events_pending() {
                gtk::main_iteration();
            }
            assert!(
                surface
                    .terminal
                    .export()
                    .expect("export surface")
                    .contains("native GTK surface")
            );
            surface.popup.hide();
            surface.popup.show_all();
            surface.popup.close();
        }
    }
}

#[cfg(all(target_os = "macos", feature = "libghostty-macos-surface"))]
#[path = "native_terminal_host/ghostty_surface.rs"]
mod platform;

#[cfg(all(target_os = "windows", feature = "libghostty-windows-surface"))]
#[path = "native_terminal_host/ghostty_surface.rs"]
mod platform;

#[cfg(not(any(
    all(target_os = "linux", feature = "libghostty-linux-prototype"),
    all(target_os = "macos", feature = "libghostty-macos-surface"),
    all(target_os = "windows", feature = "libghostty-windows-surface")
)))]
mod platform {
    use super::*;

    const DISABLED: &str =
        "libghostty native surface is not enabled in this build; xterm fallback is active";

    pub fn initialize(_window: &WebviewWindow) -> Result<(), String> {
        Ok(())
    }

    pub fn capabilities() -> Capabilities {
        Capabilities {
            available: false,
            complete: false,
            platform: std::env::consts::OS,
            implementation: "tauri-libghostty",
            revision: LIBGHOSTTY_REVISION,
            vertical_slice: false,
            reason: DISABLED.to_string(),
        }
    }

    pub fn create(_app: &AppHandle, _request: CreateRequest) -> Result<String, String> {
        Err(DISABLED.to_string())
    }

    macro_rules! disabled {
        ($name:ident($($argument:ident: $type:ty),*) -> $return:ty) => {
            pub fn $name($($argument: $type),*) -> Result<$return, String> {
                $(let _ = $argument;)*
                Err(DISABLED.to_string())
            }
        };
    }

    disabled!(write(surface_id: &str, data: &str) -> ());
    disabled!(replace(surface_id: &str, data: &str) -> ());
    disabled!(set_visible(surface_id: &str, visible: bool) -> ());
    disabled!(set_focused(surface_id: &str, focused: bool) -> ());
    disabled!(set_bounds(surface_id: &str, bounds: Bounds) -> TerminalSize);
    disabled!(set_configuration(surface_id: &str, configuration: Configuration) -> ());
    disabled!(paste(app: &AppHandle, surface_id: &str, text: &str) -> ());
    disabled!(clear_selection(surface_id: &str) -> ());
    disabled!(find(surface_id: &str, query: &str, direction: &str) -> bool);
    disabled!(export_buffer(surface_id: &str) -> String);
    disabled!(scroll_to_bottom(surface_id: &str) -> ());
    disabled!(dispose(surface_id: &str) -> ());
}

#[cfg(test)]
mod source_metadata_tests {
    use super::*;

    #[test]
    fn full_surface_source_is_pinned_to_the_compiled_revision() {
        let metadata: serde_json::Value =
            serde_json::from_str(include_str!("../ghostty-surface-source.json"))
                .expect("valid Ghostty surface source metadata");
        assert_eq!(metadata["revision"], GHOSTTY_SURFACE_REVISION);
        assert_eq!(metadata["license"], "MIT");
        assert_eq!(metadata["repository"], "manaflow-ai/ghostty");
        assert!(
            metadata["releaseTag"]
                .as_str()
                .expect("release tag")
                .contains(GHOSTTY_SURFACE_REVISION)
        );
        assert_eq!(metadata["cargoFeature"], "libghostty-macos-surface");
        assert_eq!(
            metadata["windowsCargoFeature"],
            "libghostty-windows-surface"
        );
        assert_eq!(metadata["windowsZigVersion"], "0.16.0");
        assert_eq!(
            metadata["windowsSourceEnvironmentVariable"],
            "SOLOE_GHOSTTY_WINDOWS_SOURCE"
        );
        assert_eq!(metadata["windowsDll"], "zig-out/lib/ghostty-internal.dll");
        assert_eq!(
            metadata["sha256"],
            "af9f8f12e6f41ffe00b5b65f150bb887b19dc752e47d20d3c351696c803509af"
        );
    }
}
