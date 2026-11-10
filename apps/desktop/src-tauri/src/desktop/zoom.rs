use crate::{AppHandle, WebviewWindow};
use tauri::Runtime;
use tauri_runtime_electron::{WebviewLoadState, on_webview_load_state};

pub fn apply_native_zoom<R: Runtime>(
    window: &WebviewWindow<R>,
    zoom_factor: f64,
) -> Result<(), String> {
    window
        .set_zoom(zoom_factor)
        .map_err(|error| format!("ZOOM_APPLY_FAILED: {error}"))
}

/// 每次文档加载完成后重新写回缩放。
///
/// Electron 的缩放按 host 记账：导航到 DSH 文档、或切回先前缩放过的 host 时都
/// 会丢掉当前值，只有加载完成时重新设置才稳定；默认缩放同样要写回，用来清掉该
/// host 之前记住的缩放。
pub fn apply_zoom_on_load(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let app = app.clone();
    let target = window.clone();
    on_webview_load_state(window.as_ref(), move |state| {
        if state != WebviewLoadState::Finished {
            return;
        }
        let zoom_factor = crate::config::get_store_dat_setting(&app).zoom_factor;
        if let Err(error) = apply_native_zoom(&target, zoom_factor) {
            log::warn!("[zoom] document zoom was not applied: {error}");
        }
    })
    .map_err(|error| error.to_string())
}
