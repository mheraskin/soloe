mod ownership;
mod services;

use services::BackendSupervisor;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let (discovered, instance_guard) =
                BackendSupervisor::discover().map_err(std::io::Error::other)?;
            let supervisor = Arc::new(Mutex::new(discovered));
            let initial_action = supervisor
                .lock()
                .map(|service| service.backend_action_label())
                .unwrap_or_else(|_| "Start backend (unavailable)".to_string());
            let backend_action =
                MenuItem::with_id(app, "toggle_backend", initial_action, true, None::<&str>)?;
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
            let quit_confirmation = Arc::new(Mutex::new(None::<Instant>));
            let menu_quit_confirmation = Arc::clone(&quit_confirmation);
            let mut tray = TrayIconBuilder::new()
                .tooltip("Soloe service")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref().to_string();
                    let supervisor = Arc::clone(&menu_supervisor);
                    let backend_action = menu_backend_action.clone();
                    let quit = menu_quit.clone();
                    let quit_confirmation = Arc::clone(&menu_quit_confirmation);
                    let app = app.clone();
                    thread::spawn(move || {
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
                                let confirmed = quit_confirmation
                                    .lock()
                                    .map_err(|_| "quit confirmation lock poisoned".to_string())
                                    .map(|mut deadline| {
                                        if deadline.is_some_and(|until| until > Instant::now()) {
                                            true
                                        } else {
                                            *deadline =
                                                Some(Instant::now() + Duration::from_secs(10));
                                            false
                                        }
                                    });
                                if requires_confirmation == Ok(true) && confirmed == Ok(false) {
                                    let _ = quit.set_text(
                                        "Confirm quit — stop active agents and all services",
                                    );
                                    return;
                                }
                                let result = supervisor
                                    .lock()
                                    .map_err(|_| "backend supervisor lock poisoned".to_string())
                                    .and_then(|service| service.shutdown_all());
                                app.exit(if result.is_ok() { 0 } else { 1 });
                                result
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
