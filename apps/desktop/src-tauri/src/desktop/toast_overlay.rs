//! 右下角更新提示的透明置顶覆盖窗口。
//!
//! Electron 架构下 Harness 页面是主窗口内容区里的原生子视图（`WebContentsView`），
//! 永远画在壳层 DOM 之上：壳层右下角的更新 toast 会被整块页面盖住，用户在 DSH 页面
//! 里根本看不到。这里用一个独立、透明、置顶、不抢焦点的小窗口承载更新提示——它是
//! 顶层窗口，天然盖在原生子视图之上，窗口只紧贴提示卡片，页面其余部分照常可点。

use crate::{AppHandle, Webview, Window};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// 覆盖窗口 label（Tauri 窗口标识；能力配置以此引用）。
pub const TOAST_OVERLAY_WINDOW_LABEL: &str = "toast-overlay";

/// 覆盖窗口逻辑尺寸：与更新提示卡片（标题 + 一行描述 + 按钮）贴合，只占右下角一小块。
const TOAST_OVERLAY_WIDTH: f64 = 420.0;
const TOAST_OVERLAY_HEIGHT: f64 = 112.0;
/// 距主窗口内容区右下角的内边距（逻辑像素）。
const TOAST_OVERLAY_MARGIN: f64 = 16.0;

/// 覆盖窗口要显示的更新提示内容。
///
/// 由壳层窗口算好文案后传入：覆盖窗口是独立 webview，读不到主窗口的 i18n 与 store，
/// 只能靠这份载荷渲染。`source` 是发起窗口的 label，用户点「立即更新」时据此把
/// 事件送回正确的窗口处理安装。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToastOverlayContent {
    pub title: String,
    pub description: String,
    pub action_label: String,
    pub source: String,
}

/// 覆盖窗口内容的共享状态：窗口挂载时据此渲染，壳层每次展示时覆盖写入。
#[derive(Default)]
pub struct ToastOverlayState(pub Mutex<Option<ToastOverlayContent>>);

/// 确保覆盖窗口存在（隐藏、透明、置顶、无边框、不占任务栏、不抢焦点）。幂等。
fn ensure_toast_overlay_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Window<R>> {
    if let Some(window) = app.get_window(TOAST_OVERLAY_WINDOW_LABEL) {
        return Ok(window);
    }
    let builder = WebviewWindowBuilder::new(
        app,
        TOAST_OVERLAY_WINDOW_LABEL,
        WebviewUrl::App("toast.html".into()),
    )
    .title("")
    .inner_size(TOAST_OVERLAY_WIDTH, TOAST_OVERLAY_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .transparent(true)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .accept_first_mouse(true)
    .visible(false);
    Ok(builder.build()?.as_ref().window())
}

/// 把覆盖窗口贴到主窗口内容区的右下角。
///
/// 主窗口随时可能被移动/缩放，因此每次显示都按当前几何重新定位。位置与尺寸都按主
/// 窗口的物理像素换算（`set_position` / `set_size` 的单位）。
fn place_toast_overlay<R: Runtime>(app: &AppHandle<R>, overlay: &Window<R>) -> Result<(), String> {
    let Some(main) = app.get_window(crate::desktop::builder::MAIN_WINDOW_LABEL) else {
        return Err("TOAST_OVERLAY_NO_MAIN: main window not found".into());
    };
    let position = main.inner_position().map_err(|error| error.to_string())?;
    let size = main.inner_size().map_err(|error| error.to_string())?;
    let scale = main.scale_factor().map_err(|error| error.to_string())?;
    let (x, y, w, h) = toast_overlay_bounds(position.x, position.y, size.width, size.height, scale);
    overlay
        .set_size(tauri::PhysicalSize::new(w, h))
        .map_err(|error| error.to_string())?;
    overlay
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 计算覆盖窗口在屏幕上的物理像素矩形：贴住主窗口内容区右下角，留 `MARGIN` 内边距。
///
/// 抽成纯函数便于单测（原生窗口 API 在 Linux CI 上不可用），入参单位均为物理像素。
fn toast_overlay_bounds(
    main_x: i32,
    main_y: i32,
    main_width: u32,
    main_height: u32,
    scale: f64,
) -> (i32, i32, u32, u32) {
    let w = (TOAST_OVERLAY_WIDTH * scale).round().max(1.0) as u32;
    let h = (TOAST_OVERLAY_HEIGHT * scale).round().max(1.0) as u32;
    let margin = (TOAST_OVERLAY_MARGIN * scale).round() as i32;
    let x = main_x + main_width as i32 - w as i32 - margin;
    let y = main_y + main_height as i32 - h as i32 - margin;
    (x, y, w, h)
}

/// 显示（或重新定位）覆盖窗口并推入提示内容。由壳层窗口在更新提示出现时调用。
#[tauri::command]
pub async fn show_toast_overlay(
    app: AppHandle,
    webview: Webview,
    state: tauri::State<'_, ToastOverlayState>,
    content: ToastOverlayContent,
) -> Result<(), String> {
    crate::desktop::window::require_shell(&webview)?;
    *state.0.lock().unwrap() = Some(content.clone());
    let overlay = ensure_toast_overlay_window(&app).map_err(|error| error.to_string())?;
    place_toast_overlay(&app, &overlay)?;
    overlay.show().map_err(|error| error.to_string())?;
    // 窗口已存在时（二次展示）挂载时不会重新读取状态，靠这条事件推最新内容；
    // 首次展示时 webview 可能还没加载完，它在挂载时会主动 `get_toast_overlay_content`。
    let _ = app.emit_to(
        TOAST_OVERLAY_WINDOW_LABEL,
        "dsh://toast-overlay:content",
        &content,
    );
    Ok(())
}

/// 覆盖窗口可见时重新贴合主窗口右下角（主窗口移动/缩放时调用）。
///
/// 只在可见时动作：隐藏的覆盖窗口不必跟随，省掉一次 set_position/set_size 往返。
pub(crate) fn reposition_if_visible<R: Runtime>(app: &AppHandle<R>) {
    let Some(overlay) = app.get_window(TOAST_OVERLAY_WINDOW_LABEL) else {
        return;
    };
    if overlay.is_visible().unwrap_or(false) {
        if let Err(error) = place_toast_overlay(app, &overlay) {
            log::warn!("[toast-overlay] reposition failed: {error}");
        }
    }
}

/// 隐藏覆盖窗口（更新提示消失时调用）。窗口不存在时静默成功。
#[tauri::command]
pub async fn hide_toast_overlay(app: AppHandle, webview: Webview) -> Result<(), String> {
    crate::desktop::window::require_shell(&webview)?;
    if let Some(overlay) = app.get_window(TOAST_OVERLAY_WINDOW_LABEL) {
        overlay.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 覆盖窗口挂载时读取当前内容（首次展示时事件可能早于 webview 就绪）。
#[tauri::command]
pub fn get_toast_overlay_content(
    state: tauri::State<'_, ToastOverlayState>,
) -> Option<ToastOverlayContent> {
    state.0.lock().unwrap().clone()
}

/// 用户点击覆盖窗口里的「立即更新」时调用：把请求转发给发起窗口处理安装。
#[tauri::command]
pub fn toast_overlay_request_update(app: AppHandle, window: Window) -> Result<(), String> {
    if window.label() != TOAST_OVERLAY_WINDOW_LABEL {
        return Err(
            "TOAST_OVERLAY_LABEL_MISMATCH: this command is restricted to the toast overlay".into(),
        );
    }
    let source = app
        .try_state::<ToastOverlayState>()
        .and_then(|state| {
            state
                .0
                .lock()
                .unwrap()
                .as_ref()
                .map(|content| content.source.clone())
        })
        .unwrap_or_else(|| crate::desktop::builder::MAIN_WINDOW_LABEL.to_string());
    if let Some(overlay) = app.get_window(TOAST_OVERLAY_WINDOW_LABEL) {
        let _ = overlay.hide();
    }
    let _ = app.emit_to(source.as_str(), "dsh://toast-overlay:update", ());
    Ok(())
}

/// 覆盖窗口「关闭」按钮：立即隐藏自己，并把 `dismissed` 回传发起窗口。
///
/// 关闭原因要回传：发起窗口据此同步 updateInfo（下次轮询前不再重复弹），与壳层
/// toast 的 onClose 语义一致。
#[tauri::command]
pub fn toast_overlay_dismiss(app: AppHandle, window: Window) -> Result<(), String> {
    if window.label() != TOAST_OVERLAY_WINDOW_LABEL {
        return Err(
            "TOAST_OVERLAY_LABEL_MISMATCH: this command is restricted to the toast overlay".into(),
        );
    }
    let Some(state) = app.try_state::<ToastOverlayState>() else {
        return Ok(());
    };
    let source = state
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|content| content.source.clone())
        .unwrap_or_else(|| crate::desktop::builder::MAIN_WINDOW_LABEL.to_string());
    if let Some(overlay) = app.get_window(TOAST_OVERLAY_WINDOW_LABEL) {
        let _ = overlay.hide();
    }
    let _ = app.emit_to(source.as_str(), "dsh://toast-overlay:dismissed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_sits_in_the_bottom_right_of_the_main_content_area() {
        // 100% 缩放：窗口 1000x800 @ (200, 100)，覆盖窗口 420x112、内边距 16。
        let (x, y, w, h) = toast_overlay_bounds(200, 100, 1000, 800, 1.0);
        assert_eq!((w, h), (420, 112));
        assert_eq!(x, 200 + 1000 - 420 - 16);
        assert_eq!(y, 100 + 800 - 112 - 16);
    }

    #[test]
    fn overlay_bounds_scale_with_the_main_window_dpi() {
        // 200% 缩放：尺寸与内边距都翻倍，位置仍贴右下角。
        let (x, y, w, h) = toast_overlay_bounds(0, 0, 2000, 1600, 2.0);
        assert_eq!((w, h), (840, 224));
        assert_eq!(x, 2000 - 840 - 32);
        assert_eq!(y, 1600 - 224 - 32);
    }
}
