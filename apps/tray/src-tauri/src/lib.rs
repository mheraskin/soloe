mod services;

use services::BackendSupervisor;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let supervisor = Arc::new(Mutex::new(BackendSupervisor::discover()));
            let initial_status = supervisor
                .lock()
                .map(|service| service.status_label())
                .unwrap_or_else(|_| "Backend: unavailable".to_string());
            let status = MenuItem::with_id(app, "status", initial_status, false, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "Start backend", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop backend", true, None::<&str>)?;
            let open_browser =
                MenuItem::with_id(app, "open_browser", "Open in browser", true, None::<&str>)?;
            let open_electron = MenuItem::with_id(
                app,
                "open_electron",
                "Open Electron client",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Soloe", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status,
                    &start,
                    &stop,
                    &separator,
                    &open_browser,
                    &open_electron,
                    &separator,
                    &quit,
                ],
            )?;

            let menu_supervisor = Arc::clone(&supervisor);
            let menu_status = status.clone();
            let mut tray = TrayIconBuilder::new()
                .tooltip("Soloe service")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    let id = event.id().as_ref().to_string();
                    let supervisor = Arc::clone(&menu_supervisor);
                    let status = menu_status.clone();
                    let app = app.clone();
                    thread::spawn(move || {
                        let result = match id.as_str() {
                            "start" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.start()),
                            "stop" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.stop()),
                            "open_browser" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.open_browser()),
                            "open_electron" => supervisor
                                .lock()
                                .map_err(|_| "backend supervisor lock poisoned".to_string())
                                .and_then(|service| service.open_electron()),
                            "quit" => {
                                let result = supervisor
                                    .lock()
                                    .map_err(|_| "backend supervisor lock poisoned".to_string())
                                    .and_then(|service| service.stop());
                                app.exit(if result.is_ok() { 0 } else { 1 });
                                result
                            }
                            _ => Ok(()),
                        };
                        if let Err(error) = result {
                            eprintln!("[tray] {error}");
                        }
                        if let Ok(service) = supervisor.lock() {
                            let _ = status.set_text(service.status_label());
                        }
                    });
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            let startup_supervisor = Arc::clone(&supervisor);
            let startup_status = status.clone();
            thread::spawn(move || {
                if let Ok(service) = startup_supervisor.lock() {
                    if let Err(error) = service.start() {
                        eprintln!("[tray] failed to start backend: {error}");
                    }
                    let _ = startup_status.set_text(service.status_label());
                }
            });
            app.manage(supervisor);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Soloe tray service");
}
