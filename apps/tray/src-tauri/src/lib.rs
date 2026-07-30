mod ownership;
mod services;

use services::BackendSupervisor;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

#[derive(Debug, PartialEq, Eq)]
enum QuitIntent {
    Confirm,
    Begin,
    Ignore,
}

#[derive(Default)]
struct QuitState {
    confirmation_deadline: Option<Instant>,
    quitting: bool,
}

impl QuitState {
    fn request(&mut self, requires_confirmation: bool, now: Instant) -> QuitIntent {
        if self.quitting {
            return QuitIntent::Ignore;
        }
        if requires_confirmation
            && !self
                .confirmation_deadline
                .is_some_and(|deadline| deadline > now)
        {
            self.confirmation_deadline = Some(now + Duration::from_secs(10));
            return QuitIntent::Confirm;
        }
        self.quitting = true;
        self.confirmation_deadline = None;
        QuitIntent::Begin
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
                .unwrap_or_else(|_| "Starting…".to_string());
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
            let menu_quit = quit.clone();
            let quit_state = Arc::new(Mutex::new(QuitState::default()));
            let menu_quit_state = Arc::clone(&quit_state);
            let mut tray = TrayIconBuilder::new()
                .tooltip("Soloe service")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref().to_string();
                    let supervisor = Arc::clone(&menu_supervisor);
                    let backend_action = menu_backend_action.clone();
                    let quit = menu_quit.clone();
                    let quit_state = Arc::clone(&menu_quit_state);
                    let app = app.clone();
                    thread::spawn(move || {
                        if id == "toggle_backend" {
                            let transition = supervisor
                                .lock()
                                .map(|service| service.backend_transition_label())
                                .unwrap_or_else(|_| "Starting…".to_string());
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
                                    .map(|service| service.requires_quit_confirmation());
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
                                if intent == QuitIntent::Confirm {
                                    let _ = quit.set_text(
                                        "Confirm quit — stop active agents and all services",
                                    );
                                    return;
                                }
                                if intent == QuitIntent::Ignore {
                                    return;
                                }
                                let _ = quit.set_text("Quitting…");
                                let _ = quit.set_enabled(false);
                                let transition = supervisor
                                    .lock()
                                    .map(|service| service.backend_transition_label())
                                    .unwrap_or_else(|_| "Stopping…".to_string());
                                let _ = backend_action.set_text(transition);
                                let _ = backend_action.set_enabled(false);
                                let result = supervisor
                                    .lock()
                                    .map_err(|_| "backend supervisor lock poisoned".to_string())
                                    .and_then(|service| service.shutdown_all());
                                if let Err(error) = &result {
                                    eprintln!("[tray] {error}");
                                }
                                app.exit(if result.is_ok() { 0 } else { 1 });
                                return;
                            }
                            _ => Ok(()),
                        };
                        if let Err(error) = result {
                            eprintln!("[tray] {error}");
                        }
                        let _ = quit.set_text("Quit Soloe");
                        if let Ok(service) = supervisor.lock() {
                            let _ = backend_action.set_text(service.backend_action_label());
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
            let polling_browser = open_browser.clone();
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_secs(1));
                    let Ok(service) = polling_supervisor.lock() else {
                        break;
                    };
                    let _ = polling_backend_action.set_text(service.backend_action_label());
                    let _ = polling_backend_action.set_enabled(service.backend_action_enabled());
                    let _ = polling_browser.set_enabled(service.browser_address().is_some());
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
    use super::{QuitIntent, QuitState};
    use std::time::{Duration, Instant};

    #[test]
    fn quit_requires_confirmation_then_enters_quitting_once() {
        let now = Instant::now();
        let mut state = QuitState::default();

        assert_eq!(state.request(true, now), QuitIntent::Confirm);
        assert_eq!(
            state.request(true, now + Duration::from_secs(1)),
            QuitIntent::Begin
        );
        assert_eq!(
            state.request(true, now + Duration::from_secs(2)),
            QuitIntent::Ignore
        );
    }

    #[test]
    fn expired_quit_confirmation_must_be_requested_again() {
        let now = Instant::now();
        let mut state = QuitState::default();

        assert_eq!(state.request(true, now), QuitIntent::Confirm);
        assert_eq!(
            state.request(true, now + Duration::from_secs(11)),
            QuitIntent::Confirm
        );
    }

    #[test]
    fn quit_without_active_agents_begins_immediately() {
        let mut state = QuitState::default();

        assert_eq!(state.request(false, Instant::now()), QuitIntent::Begin);
    }
}
