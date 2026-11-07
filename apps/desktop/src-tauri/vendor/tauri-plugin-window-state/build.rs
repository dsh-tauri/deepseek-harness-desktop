const COMMANDS: &[&str] = &["save_window_state", "restore_state", "filename"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
