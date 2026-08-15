fn main() {
    if soloe_tray::run_process_watchdog_if_requested() {
        return;
    }
    soloe_tray::run();
}
