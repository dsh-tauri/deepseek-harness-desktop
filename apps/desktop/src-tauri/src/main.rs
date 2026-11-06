// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(unix)]
    if std::env::args_os().nth(1).is_some_and(|arg| arg == "--print-login-path") {
        if let Err(error) = main::desktop::login_path::print() {
            eprintln!("STARTUP_PATH_RESTORE_FAILED: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = main::run() {
        main::desktop::startup::report_failure(&error);
        std::process::exit(1);
    }
}
