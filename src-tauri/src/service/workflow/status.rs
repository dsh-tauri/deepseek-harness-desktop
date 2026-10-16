use tauri::AppHandle;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub enum Status {
    Initial,
    Installing,
    Starting,
    Running,
    Stopped,
}

pub fn set_status(status: Status) {
    *super::instances::instance()
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = status;
}

pub fn emit_status<R: tauri::Runtime>(app_handle: &AppHandle<R>) {
    super::instances::emit(app_handle, "dsh-status-updated", get_status());
}

pub fn get_status() -> Status {
    super::instances::instance()
        .status
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
}
