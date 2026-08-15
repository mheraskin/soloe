mod ownership;
mod services;

pub use ownership::run_process_watchdog_if_requested;
use services::BackendSupervisor;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

const TRAY_ID: &str = "soloe";
const DEFAULT_TOOLTIP: &str = "Soloe";

#[cfg(target_os = "macos")]
const MACOS_TRAY_ICON: tauri::image::Image<'_> =
    tauri::include_image!("../../../build/tray-icon-macos.png");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchTarget {
    Browser,
    Soloe,
}

impl LaunchTarget {
    fn from_menu_id(id: &str) -> Option<Self> {
        match id {
            "open_browser" => Some(Self::Browser),
            "open_soloe" => Some(Self::Soloe),
            _ => None,
        }
    }

    fn progress_label(self) -> &'static str {
        match self {
            Self::Browser => "Opening browser…",
            Self::Soloe => "Opening Soloe…",
        }
    }

    fn minimum_feedback(self) -> Duration {
        match self {
            Self::Browser => Duration::from_millis(900),
            Self::Soloe => Duration::from_millis(2_500),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ConfirmationIntent {
    Confirm,
    Begin,
    Ignore,
}

#[derive(Default)]
struct ConfirmationState {
    confirmation_deadline: Option<Instant>,
    in_progress: bool,
}

impl ConfirmationState {
    fn request(&mut self, requires_confirmation: bool, now: Instant) -> ConfirmationIntent {
        if self.in_progress {
            return ConfirmationIntent::Ignore;
        }
        if requires_confirmation
            && !self
                .confirmation_deadline
                .is_some_and(|deadline| deadline > now)
        {
            self.confirmation_deadline = Some(now + Duration::from_secs(10));
            return ConfirmationIntent::Confirm;
        }
        self.in_progress = true;
        self.confirmation_deadline = None;
        ConfirmationIntent::Begin
    }

    fn finish(&mut self) {
        self.in_progress = false;
        self.confirmation_deadline = None;
    }

    fn awaiting_confirmation(&self, now: Instant) -> bool {
        !self.in_progress
            && self
                .confirmation_deadline
                .is_some_and(|deadline| deadline > now)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuService {
    Server,
    Runtime,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum MenuServicePhase {
    #[default]
    Unknown,
    Startable,
    Stoppable,
    Starting,
    Stopping,
    Updating,
}

impl MenuServicePhase {
    fn from_label(label: &str) -> Self {
        if label.starts_with("Starting ") {
            Self::Starting
        } else if label.starts_with("Stopping ") {
            Self::Stopping
        } else if label.starts_with("Start ") {
            Self::Startable
        } else if label.starts_with("Stop ") {
            Self::Stoppable
        } else {
            Self::Unknown
        }
    }

    fn is_busy(self) -> bool {
        matches!(self, Self::Starting | Self::Stopping | Self::Updating)
    }

    fn transition(self, service: MenuService) -> Option<(Self, String)> {
        let label = match (self, service) {
            (Self::Startable, MenuService::Server) => "Starting Soloe server…",
            (Self::Stoppable, MenuService::Server) => "Stopping Soloe server…",
            (Self::Startable, MenuService::Runtime) => "Starting Environment Runtime…",
            (Self::Stoppable, MenuService::Runtime) => "Stopping Environment Runtime…",
            (Self::Unknown, MenuService::Server) => "Updating Soloe server…",
            (Self::Unknown, MenuService::Runtime) => "Updating Environment Runtime…",
            _ => return None,
        };
        let phase = match self {
            Self::Startable => Self::Starting,
            Self::Stoppable => Self::Stopping,
            Self::Unknown => Self::Updating,
            Self::Starting | Self::Stopping | Self::Updating => return None,
        };
        Some((phase, label.to_string()))
    }
}

#[derive(Debug, Default)]
struct MenuActionState {
    server: MenuServicePhase,
    runtime: MenuServicePhase,
}

impl MenuActionState {
    fn phase(&self, service: MenuService) -> MenuServicePhase {
        match service {
            MenuService::Server => self.server,
            MenuService::Runtime => self.runtime,
        }
    }

    fn set_phase(&mut self, service: MenuService, phase: MenuServicePhase) {
        match service {
            MenuService::Server => self.server = phase,
            MenuService::Runtime => self.runtime = phase,
        }
    }

    fn begin(&mut self, service: MenuService) -> Option<String> {
        let (phase, label) = self.phase(service).transition(service)?;
        self.set_phase(service, phase);
        Some(label)
    }

    fn update_from_label(&mut self, service: MenuService, label: &str) {
        self.set_phase(service, MenuServicePhase::from_label(label));
    }
}

pub fn run() {
    let (discovered, instance_guard) = match BackendSupervisor::discover() {
        Ok(startup) => startup,
        Err(error) => {
            eprintln!("[tray] {error}");
            return;
        }
    };

    tauri::Builder::default()
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let supervisor = Arc::new(discovered);
            let initial_server_action = supervisor.server_transition_label();
            let server_action = MenuItem::with_id(
                app,
                "toggle_server",
                initial_server_action,
                false,
                None::<&str>,
            )?;
            let initial_runtime_action = supervisor.runtime_transition_label();
            let runtime_action = MenuItem::with_id(
                app,
                "toggle_runtime",
                initial_runtime_action,
                false,
                None::<&str>,
            )?;
            let open_browser =
                MenuItem::with_id(app, "open_browser", "Open in browser", false, None::<&str>)?;
            let open_soloe =
                MenuItem::with_id(app, "open_soloe", "Open Soloe", false, None::<&str>)?;
            let open_logs =
                MenuItem::with_id(app, "open_logs", "Open Soloe logs", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Soloe", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &server_action,
                    &runtime_action,
                    &separator,
                    &open_browser,
                    &open_soloe,
                    &open_logs,
                    &separator,
                    &quit,
                ],
            )?;

            let menu_supervisor = Arc::clone(&supervisor);
            let menu_server_action = server_action.clone();
            let menu_runtime_action = runtime_action.clone();
            let menu_open_browser = open_browser.clone();
            let menu_open_soloe = open_soloe.clone();
            let menu_quit = quit.clone();
            let menu_action_state = Arc::new(Mutex::new(MenuActionState {
                server: MenuServicePhase::Starting,
                runtime: MenuServicePhase::Starting,
            }));
            let menu_lifecycle_state = Arc::clone(&menu_action_state);
            let runtime_action_state = Arc::new(Mutex::new(ConfirmationState::default()));
            let menu_runtime_action_state = Arc::clone(&runtime_action_state);
            let quit_state = Arc::new(Mutex::new(ConfirmationState::default()));
            let menu_quit_state = Arc::clone(&quit_state);
            let launch_state = Arc::new(Mutex::new(None::<LaunchTarget>));
            let menu_launch_state = Arc::clone(&launch_state);
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip(DEFAULT_TOOLTIP)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref().to_string();
                    let launch_target = LaunchTarget::from_menu_id(&id);
                    let launch_started_at = launch_target.map(|target| {
                        let Ok(mut launching) = menu_launch_state.lock() else {
                            return None;
                        };
                        if launching.is_some() {
                            return None;
                        }
                        *launching = Some(target);
                        let _ = menu_open_browser.set_enabled(false);
                        let _ = menu_open_soloe.set_enabled(false);
                        let progress_item = match target {
                            LaunchTarget::Browser => &menu_open_browser,
                            LaunchTarget::Soloe => &menu_open_soloe,
                        };
                        let _ = progress_item.set_text(target.progress_label());
                        if let Some(tray) = app.tray_by_id(TRAY_ID) {
                            let _ = tray.set_tooltip(Some(target.progress_label()));
                        }
                        Some(Instant::now())
                    });
                    if launch_target.is_some() && launch_started_at.flatten().is_none() {
                        return;
                    }
                    let supervisor = Arc::clone(&menu_supervisor);
                    let server_action = menu_server_action.clone();
                    let runtime_action = menu_runtime_action.clone();
                    let open_browser = menu_open_browser.clone();
                    let open_soloe = menu_open_soloe.clone();
                    let quit = menu_quit.clone();
                    let runtime_action_state = Arc::clone(&menu_runtime_action_state);
                    let quit_state = Arc::clone(&menu_quit_state);
                    let launch_state = Arc::clone(&menu_launch_state);
                    let lifecycle_state = Arc::clone(&menu_lifecycle_state);
                    let app = app.clone();
                    thread::spawn(move || {
                        let lifecycle_action = match id.as_str() {
                            "toggle_server" => Some(MenuService::Server),
                            "toggle_runtime" => Some(MenuService::Runtime),
                            _ => None,
                        };
                        if id == "toggle_runtime" {
                            let requires_confirmation = Ok(supervisor.requires_stop_confirmation());
                            let intent = requires_confirmation.and_then(|required| {
                                runtime_action_state
                                    .lock()
                                    .map_err(|_| "runtime action state lock poisoned".to_string())
                                    .map(|mut state| state.request(required, Instant::now()))
                            });
                            let intent = match intent {
                                Ok(intent) => intent,
                                Err(error) => {
                                    eprintln!("[tray] {error}");
                                    return;
                                }
                            };
                            if intent == ConfirmationIntent::Confirm {
                                let _ = runtime_action.set_text(
                                    "Confirm stop Environment Runtime — end active agents",
                                );
                                return;
                            }
                            if intent == ConfirmationIntent::Ignore {
                                return;
                            }
                        }
                        let transition = lifecycle_action.and_then(|service| {
                            lifecycle_state
                                .lock()
                                .ok()
                                .and_then(|mut state| state.begin(service))
                        });
                        if lifecycle_action.is_some() {
                            let Some(transition) = transition else {
                                return;
                            };
                            let action = if id == "toggle_server" {
                                &server_action
                            } else {
                                &runtime_action
                            };
                            let _ = action.set_text(&transition);
                            let _ = server_action.set_enabled(false);
                            let _ = runtime_action.set_enabled(false);
                            let _ = open_browser.set_enabled(false);
                            let _ = open_soloe.set_enabled(false);
                            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                                let _ = tray.set_tooltip(Some(transition.as_str()));
                            }
                        }
                        let result = match id.as_str() {
                            "toggle_server" => supervisor.toggle_server(),
                            "toggle_runtime" => supervisor.toggle_runtime(),
                            "open_browser" => supervisor.open_browser(),
                            "open_soloe" => supervisor.open_soloe(),
                            "open_logs" => supervisor.open_logs(),
                            "quit" => {
                                let requires_confirmation =
                                    Ok(supervisor.requires_stop_confirmation());
                                let intent = requires_confirmation.and_then(|required| {
                                    quit_state
                                        .lock()
                                        .map_err(|_| "quit state lock poisoned".to_string())
                                        .map(|mut state| state.request(required, Instant::now()))
                                });
                                let intent = match intent {
                                    Ok(intent) => intent,
                                    Err(error) => {
                                        eprintln!("[tray] {error}");
                                        return;
                                    }
                                };
                                if intent == ConfirmationIntent::Confirm {
                                    let _ = quit.set_text(
                                        "Confirm quit — stop active agents and all services",
                                    );
                                    return;
                                }
                                if intent == ConfirmationIntent::Ignore {
                                    return;
                                }
                                let _ = quit.set_text("Quitting…");
                                let _ = quit.set_enabled(false);
                                let _ = server_action.set_text("Stopping Soloe server…");
                                let _ = runtime_action.set_text("Stopping Environment Runtime…");
                                let _ = server_action.set_enabled(false);
                                let _ = runtime_action.set_enabled(false);
                                let result = supervisor.shutdown_all();
                                if let Err(error) = &result {
                                    eprintln!("[tray] {error}");
                                }
                                let exit_code = if result.is_ok() { 0 } else { 1 };
                                app.exit(exit_code);
                                return;
                            }
                            _ => Ok(()),
                        };
                        if let Err(error) = result {
                            eprintln!("[tray] {error}");
                        }
                        if id == "toggle_runtime"
                            && let Ok(mut state) = runtime_action_state.lock()
                        {
                            state.finish();
                        }
                        if lifecycle_action.is_some() {
                            let server_label = supervisor.server_action_label();
                            let server_enabled = supervisor.server_action_enabled();
                            let runtime_label = supervisor.runtime_action_label();
                            let runtime_enabled = supervisor.runtime_action_enabled();
                            if let Ok(mut state) = lifecycle_state.lock() {
                                state.update_from_label(MenuService::Server, &server_label);
                                state.update_from_label(MenuService::Runtime, &runtime_label);
                                let _ = server_action.set_text(server_label);
                                let _ = server_action.set_enabled(server_enabled);
                                let _ = runtime_action.set_text(runtime_label);
                                let _ = runtime_action.set_enabled(runtime_enabled);
                                let browser_ready = supervisor.browser_address().is_some();
                                let soloe_ready = supervisor.soloe_available();
                                let _ = open_browser.set_enabled(browser_ready);
                                let _ = open_soloe.set_enabled(soloe_ready);
                                if let Some(tray) = app.tray_by_id(TRAY_ID) {
                                    let _ = tray.set_tooltip(Some(DEFAULT_TOOLTIP));
                                }
                            }
                        }
                        if let (Some(target), Some(started_at)) =
                            (launch_target, launch_started_at.flatten())
                        {
                            let remaining = target
                                .minimum_feedback()
                                .saturating_sub(started_at.elapsed());
                            if !remaining.is_zero() {
                                thread::sleep(remaining);
                            }
                            if let Ok(mut launching) = launch_state.lock() {
                                *launching = None;
                            }
                            let _ = open_browser.set_text("Open in browser");
                            let _ = open_soloe.set_text("Open Soloe");
                            let lifecycle_busy = lifecycle_state
                                .lock()
                                .map(|state| {
                                    state.phase(MenuService::Server).is_busy()
                                        || state.phase(MenuService::Runtime).is_busy()
                                })
                                .unwrap_or(true);
                            let browser_ready =
                                !lifecycle_busy && supervisor.browser_address().is_some();
                            let _ = open_browser.set_enabled(browser_ready);
                            let _ = open_soloe.set_enabled(supervisor.soloe_available());
                            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                                let _ = tray.set_tooltip(Some(DEFAULT_TOOLTIP));
                            }
                        }
                        let _ = quit.set_text("Quit Soloe");
                    });
                });
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon(MACOS_TRAY_ICON.clone()).icon_as_template(true);
            }
            #[cfg(not(target_os = "macos"))]
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let startup_supervisor = Arc::clone(&supervisor);
            let startup_server_action = server_action.clone();
            let startup_runtime_action = runtime_action.clone();
            let startup_open_browser = open_browser.clone();
            let startup_open_soloe = open_soloe.clone();
            let startup_lifecycle_state = Arc::clone(&menu_action_state);
            thread::spawn(move || {
                match startup_supervisor.start() {
                    Ok(()) => {
                        if let Err(error) = startup_supervisor.launch_soloe_client_on_startup() {
                            eprintln!("[tray] failed to launch Soloe Client on startup: {error}");
                        }
                    }
                    Err(error) => eprintln!("[tray] Soloe startup stopped: {error}"),
                }
                let server_label = startup_supervisor.server_action_label();
                let runtime_label = startup_supervisor.runtime_action_label();
                let server_enabled = startup_supervisor.server_action_enabled();
                let runtime_enabled = startup_supervisor.runtime_action_enabled();
                let browser_ready = startup_supervisor.browser_address().is_some();
                let soloe_ready = startup_supervisor.soloe_available();
                if let Ok(mut state) = startup_lifecycle_state.lock() {
                    state.update_from_label(MenuService::Server, &server_label);
                    state.update_from_label(MenuService::Runtime, &runtime_label);
                    let _ = startup_server_action.set_text(server_label);
                    let _ = startup_server_action.set_enabled(server_enabled);
                    let _ = startup_runtime_action.set_text(runtime_label);
                    let _ = startup_runtime_action.set_enabled(runtime_enabled);
                    let _ = startup_open_browser.set_enabled(browser_ready);
                    let _ = startup_open_soloe.set_enabled(soloe_ready);
                }
            });

            let polling_supervisor = Arc::clone(&supervisor);
            let polling_server_action = server_action.clone();
            let polling_runtime_action = runtime_action.clone();
            let polling_runtime_action_state = Arc::clone(&runtime_action_state);
            let polling_lifecycle_state = Arc::clone(&menu_action_state);
            let polling_browser = open_browser.clone();
            let polling_soloe = open_soloe.clone();
            let polling_launch_state = Arc::clone(&launch_state);
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_secs(1));
                    let awaiting_confirmation = polling_runtime_action_state
                        .lock()
                        .map(|state| state.awaiting_confirmation(Instant::now()))
                        .unwrap_or(false);
                    let server_busy = polling_lifecycle_state
                        .lock()
                        .map(|state| state.phase(MenuService::Server).is_busy())
                        .unwrap_or(true);
                    let runtime_busy = polling_lifecycle_state
                        .lock()
                        .map(|state| state.phase(MenuService::Runtime).is_busy())
                        .unwrap_or(true);
                    if !server_busy {
                        let server_label = polling_supervisor.server_action_label();
                        let server_enabled = polling_supervisor.server_action_enabled();
                        if let Ok(mut state) = polling_lifecycle_state.lock()
                            && !state.phase(MenuService::Server).is_busy()
                        {
                            state.update_from_label(MenuService::Server, &server_label);
                            let _ = polling_server_action.set_text(server_label);
                            let _ = polling_server_action.set_enabled(server_enabled);
                        }
                    }
                    if !runtime_busy && !awaiting_confirmation {
                        let runtime_label = polling_supervisor.runtime_action_label();
                        let runtime_enabled = polling_supervisor.runtime_action_enabled();
                        if let Ok(mut state) = polling_lifecycle_state.lock()
                            && !state.phase(MenuService::Runtime).is_busy()
                        {
                            state.update_from_label(MenuService::Runtime, &runtime_label);
                            let _ = polling_runtime_action.set_text(runtime_label);
                            let _ = polling_runtime_action.set_enabled(runtime_enabled);
                        }
                    }
                    let launching = polling_launch_state
                        .lock()
                        .map(|state| state.is_some())
                        .unwrap_or(true);
                    if !launching {
                        let browser_ready = polling_supervisor.browser_address().is_some();
                        let soloe_ready = polling_supervisor.soloe_available();
                        let _ = polling_browser.set_enabled(browser_ready);
                        let _ = polling_soloe.set_enabled(soloe_ready);
                    }
                }
            });
            app.manage(instance_guard);
            app.manage(supervisor);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Soloe tray service");
}

#[cfg(test)]
mod tests {
    use super::{
        ConfirmationIntent, ConfirmationState, LaunchTarget, MenuActionState, MenuService,
        MenuServicePhase,
    };
    use std::time::{Duration, Instant};

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_tray_icon_has_retina_status_item_dimensions() {
        assert_eq!(super::MACOS_TRAY_ICON.width(), 36);
        assert_eq!(super::MACOS_TRAY_ICON.height(), 36);
        assert_eq!(&super::MACOS_TRAY_ICON.rgba()[0..4], &[0, 0, 0, 0]);
        assert!(
            super::MACOS_TRAY_ICON
                .rgba()
                .chunks_exact(4)
                .any(|pixel| pixel[3] > 0)
        );
    }

    #[test]
    fn quit_requires_confirmation_then_enters_quitting_once() {
        let now = Instant::now();
        let mut state = ConfirmationState::default();

        assert_eq!(state.request(true, now), ConfirmationIntent::Confirm);
        assert_eq!(
            state.request(true, now + Duration::from_secs(1)),
            ConfirmationIntent::Begin
        );
        assert_eq!(
            state.request(true, now + Duration::from_secs(2)),
            ConfirmationIntent::Ignore
        );
    }

    #[test]
    fn expired_quit_confirmation_must_be_requested_again() {
        let now = Instant::now();
        let mut state = ConfirmationState::default();

        assert_eq!(state.request(true, now), ConfirmationIntent::Confirm);
        assert_eq!(
            state.request(true, now + Duration::from_secs(11)),
            ConfirmationIntent::Confirm
        );
    }

    #[test]
    fn quit_without_active_agents_begins_immediately() {
        let mut state = ConfirmationState::default();

        assert_eq!(
            state.request(false, Instant::now()),
            ConfirmationIntent::Begin
        );
    }

    #[test]
    fn tray_quit_delegates_native_cleanup_to_the_tauri_event_loop() {
        let source = include_str!("lib.rs");
        let event_loop_exit = ["app.", "exit(exit_code);"].concat();
        let direct_cleanup = ["app.", "cleanup_before_exit();"].concat();
        let direct_process_exit = ["std::process::", "exit(exit_code);"].concat();

        assert_eq!(source.matches(&event_loop_exit).count(), 1);
        assert!(!source.contains(&direct_cleanup));
        assert!(!source.contains(&direct_process_exit));
    }

    #[test]
    fn tray_instance_lock_is_acquired_before_the_tauri_event_loop() {
        let source = include_str!("lib.rs");
        let discovery = source.find("BackendSupervisor::discover()").unwrap();
        let event_loop = source.find("tauri::Builder::default()").unwrap();

        assert!(discovery < event_loop);
    }

    #[test]
    fn service_confirmation_can_be_reused_after_an_action_finishes() {
        let now = Instant::now();
        let mut state = ConfirmationState::default();

        assert_eq!(state.request(true, now), ConfirmationIntent::Confirm);
        assert!(state.awaiting_confirmation(now + Duration::from_secs(1)));
        assert_eq!(
            state.request(true, now + Duration::from_secs(1)),
            ConfirmationIntent::Begin
        );
        state.finish();
        assert_eq!(
            state.request(true, now + Duration::from_secs(2)),
            ConfirmationIntent::Confirm
        );
    }

    #[test]
    fn launch_targets_expose_native_progress_feedback() {
        assert_eq!(
            LaunchTarget::from_menu_id("open_browser"),
            Some(LaunchTarget::Browser)
        );
        assert_eq!(
            LaunchTarget::from_menu_id("open_soloe"),
            Some(LaunchTarget::Soloe)
        );
        assert_eq!(LaunchTarget::from_menu_id("open_electron"), None);
        assert_eq!(LaunchTarget::from_menu_id("open_logs"), None);
        assert_eq!(LaunchTarget::Browser.progress_label(), "Opening browser…");
        assert_eq!(LaunchTarget::Soloe.progress_label(), "Opening Soloe…");
        assert!(LaunchTarget::Soloe.minimum_feedback() > LaunchTarget::Browser.minimum_feedback());
    }

    #[test]
    fn repeated_lifecycle_clicks_are_ignored_until_the_first_finishes() {
        let mut state = MenuActionState {
            server: MenuServicePhase::Stoppable,
            runtime: MenuServicePhase::Stoppable,
        };

        assert_eq!(
            state.begin(MenuService::Server),
            Some("Stopping Soloe server…".to_string())
        );
        assert_eq!(state.phase(MenuService::Server), MenuServicePhase::Stopping);
        assert_eq!(state.begin(MenuService::Server), None);

        state.update_from_label(MenuService::Server, "Start Soloe server (WSL)");
        assert_eq!(
            state.phase(MenuService::Server),
            MenuServicePhase::Startable
        );
        assert_eq!(
            state.begin(MenuService::Server),
            Some("Starting Soloe server…".to_string())
        );

        assert_eq!(
            state.begin(MenuService::Runtime),
            Some("Stopping Environment Runtime…".to_string())
        );
    }
}
