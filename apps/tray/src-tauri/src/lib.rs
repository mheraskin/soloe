mod ownership;
mod services;

use services::BackendSupervisor;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

const TRAY_ID: &str = "soloe-service";
const DEFAULT_TOOLTIP: &str = "Soloe service";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LaunchTarget {
    Browser,
    Electron,
}

impl LaunchTarget {
    fn from_menu_id(id: &str) -> Option<Self> {
        match id {
            "open_browser" => Some(Self::Browser),
            "open_electron" => Some(Self::Electron),
            _ => None,
        }
    }

    fn progress_label(self) -> &'static str {
        match self {
            Self::Browser => "Opening browser…",
            Self::Electron => "Opening Electron client…",
        }
    }

    fn minimum_feedback(self) -> Duration {
        match self {
            Self::Browser => Duration::from_millis(900),
            Self::Electron => Duration::from_millis(2_500),
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

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let (discovered, instance_guard) =
                BackendSupervisor::discover().map_err(std::io::Error::other)?;
            let supervisor = Arc::new(Mutex::new(discovered));
            let initial_action = supervisor
                .lock()
                .map(|service| service.backend_transition_label())
                .unwrap_or_else(|_| "Starting services…".to_string());
            let backend_action =
                MenuItem::with_id(app, "toggle_backend", initial_action, false, None::<&str>)?;
            let open_browser =
                MenuItem::with_id(app, "open_browser", "Open in browser", false, None::<&str>)?;
            let open_electron = MenuItem::with_id(
                app,
                "open_electron",
                "Open Electron client",
                true,
                None::<&str>,
            )?;
            let open_logs =
                MenuItem::with_id(app, "open_logs", "Open Soloe logs", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Soloe", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &backend_action,
                    &separator,
                    &open_browser,
                    &open_electron,
                    &open_logs,
                    &separator,
                    &quit,
                ],
            )?;

            let menu_supervisor = Arc::clone(&supervisor);
            let menu_backend_action = backend_action.clone();
            let menu_open_browser = open_browser.clone();
            let menu_open_electron = open_electron.clone();
            let menu_quit = quit.clone();
            let backend_action_state = Arc::new(Mutex::new(ConfirmationState::default()));
            let menu_backend_action_state = Arc::clone(&backend_action_state);
            let quit_state = Arc::new(Mutex::new(ConfirmationState::default()));
            let menu_quit_state = Arc::clone(&quit_state);
            let launch_state = Arc::new(Mutex::new(None::<LaunchTarget>));
            let menu_launch_state = Arc::clone(&launch_state);
            let mut tray = TrayIconBuilder::with_id(TRAY_ID)
                .tooltip(DEFAULT_TOOLTIP)
                .menu(&menu)
                .show_menu_on_left_click(false)
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
                        let _ = menu_open_electron.set_enabled(false);
                        let progress_item = match target {
                            LaunchTarget::Browser => &menu_open_browser,
                            LaunchTarget::Electron => &menu_open_electron,
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
                    let backend_action = menu_backend_action.clone();
                    let open_browser = menu_open_browser.clone();
                    let open_electron = menu_open_electron.clone();
                    let quit = menu_quit.clone();
                    let backend_action_state = Arc::clone(&menu_backend_action_state);
                    let quit_state = Arc::clone(&menu_quit_state);
                    let launch_state = Arc::clone(&menu_launch_state);
                    let app = app.clone();
                    thread::spawn(move || {
                        if id == "toggle_backend" {
                            let requires_confirmation = supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .map(|service| service.requires_stop_confirmation());
                            let intent = requires_confirmation.and_then(|required| {
                                backend_action_state
                                    .lock()
                                    .map_err(|_| "service action state lock poisoned".to_string())
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
                                let _ = backend_action
                                    .set_text("Confirm stop all services — end active agents");
                                return;
                            }
                            if intent == ConfirmationIntent::Ignore {
                                return;
                            }
                            let transition = supervisor
                                .lock()
                                .map(|service| service.backend_transition_label())
                                .unwrap_or_else(|_| "Updating services…".to_string());
                            let _ = backend_action.set_text(transition);
                            let _ = backend_action.set_enabled(false);
                        }
                        let result = match id.as_str() {
                            "toggle_backend" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.toggle_backend()),
                            "open_browser" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.open_browser()),
                            "open_electron" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.open_electron()),
                            "open_logs" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.open_logs()),
                            "quit" => {
                                let requires_confirmation = supervisor
                                    .lock()
                                    .map_err(|_| "backend supervisor lock poisoned".to_string())
                                    .map(|service| service.requires_stop_confirmation());
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
                                let transition = supervisor
                                    .lock()
                                    .map(|service| service.backend_transition_label())
                                    .unwrap_or_else(|_| "Stopping all services…".to_string());
                                let _ = backend_action.set_text(transition);
                                let _ = backend_action.set_enabled(false);
                                let result = supervisor
                                    .lock()
                                    .map_err(|_| "backend supervisor lock poisoned".to_string())
                                    .and_then(|service| service.shutdown_all());
                                if let Err(error) = &result {
                                    eprintln!("[tray] {error}");
                                }
                                let exit_code = if result.is_ok() { 0 } else { 1 };
                                app.cleanup_before_exit();
                                std::process::exit(exit_code);
                            }
                            _ => Ok(()),
                        };
                        if let Err(error) = result {
                            eprintln!("[tray] {error}");
                        }
                        if id == "toggle_backend" {
                            if let Ok(mut state) = backend_action_state.lock() {
                                state.finish();
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
                            let _ = open_electron.set_text("Open Electron client");
                            let browser_ready = supervisor
                                .lock()
                                .map(|service| service.browser_address().is_some())
                                .unwrap_or(false);
                            let _ = open_browser.set_enabled(browser_ready);
                            let _ = open_electron.set_enabled(true);
                            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                                let _ = tray.set_tooltip(Some(DEFAULT_TOOLTIP));
                            }
                        }
                        let _ = quit.set_text("Quit Soloe");
                        if let Ok(service) = supervisor.lock() {
                            let awaiting_confirmation = backend_action_state
                                .lock()
                                .map(|state| state.awaiting_confirmation(Instant::now()))
                                .unwrap_or(false);
                            if !awaiting_confirmation {
                                let _ = backend_action.set_text(service.backend_action_label());
                            }
                            let _ = backend_action.set_enabled(service.backend_action_enabled());
                        }
                    });
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let startup_supervisor = Arc::clone(&supervisor);
            let startup_backend_action = backend_action.clone();
            thread::spawn(move || {
                if let Ok(service) = startup_supervisor.lock() {
                    if let Err(error) = service.start() {
                        eprintln!("[tray] failed to start backend: {error}");
                    }
                    let _ = startup_backend_action.set_text(service.backend_action_label());
                    let _ = startup_backend_action.set_enabled(service.backend_action_enabled());
                }
            });

            let polling_supervisor = Arc::clone(&supervisor);
            let polling_backend_action = backend_action.clone();
            let polling_backend_action_state = Arc::clone(&backend_action_state);
            let polling_browser = open_browser.clone();
            let polling_launch_state = Arc::clone(&launch_state);
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_secs(1));
                    let Ok(service) = polling_supervisor.lock() else {
                        break;
                    };
                    let awaiting_confirmation = polling_backend_action_state
                        .lock()
                        .map(|state| state.awaiting_confirmation(Instant::now()))
                        .unwrap_or(false);
                    if !awaiting_confirmation {
                        let _ = polling_backend_action.set_text(service.backend_action_label());
                    }
                    let _ = polling_backend_action.set_enabled(service.backend_action_enabled());
                    let launching = polling_launch_state
                        .lock()
                        .map(|state| state.is_some())
                        .unwrap_or(true);
                    if !launching {
                        let _ = polling_browser.set_enabled(service.browser_address().is_some());
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
    use super::{ConfirmationIntent, ConfirmationState, LaunchTarget};
    use std::time::{Duration, Instant};

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
            LaunchTarget::from_menu_id("open_electron"),
            Some(LaunchTarget::Electron)
        );
        assert_eq!(LaunchTarget::from_menu_id("open_logs"), None);
        assert_eq!(LaunchTarget::Browser.progress_label(), "Opening browser…");
        assert_eq!(
            LaunchTarget::Electron.progress_label(),
            "Opening Electron client…"
        );
        assert!(
            LaunchTarget::Electron.minimum_feedback() > LaunchTarget::Browser.minimum_feedback()
        );
    }
}
