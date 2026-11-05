//! 透明 toast 覆盖窗口（issue #1408）。
//!
//! Electron 架构下 Harness 页面是主窗口里的原生 `WebContentsView`，永远画在壳层 DOM
//! 之上：壳层右下角的 toast 被整块盖住，用户停在 DSH 页面时必然错过更新提示。
//!
//! 这里给壳层窗口配一个透明、无边框、置顶、不占任务栏的独立窗口承载 toast。窗口
//! **只包住卡片本身**（宽度固定、高度由页面按内容自报），所以不需要整窗命中测试与
//! 逐像素穿透：卡片之外根本没有窗口，点击天然落到下方的 DSH 窗口上。
//!
//! 位置由 Rust 维护（跟随壳层窗口的移动 / 缩放 / 收起），内容与按钮回调则由壳层与
//! toast 页面直接互发事件完成，不经 Rust 中转。

use crate::{AppHandle, Webview, Window};
use tauri::{Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// 透明 toast 窗口的 label（能力配置与前端常量都以此引用）。
pub const TOAST_WINDOW_LABEL: &str = "toast";

/// 窗口宽度（逻辑像素）：与页面布局宽度一致。
const TOAST_WIDTH: f64 = 400.0;
/// 初始高度：页面加载后会按卡片实际高度回调 `toast_view_resize` 收紧。
const TOAST_HEIGHT: f64 = 120.0;
/// 距壳层窗口内容区右下角的内边距（逻辑像素）。
const TOAST_MARGIN: f64 = 16.0;

/// 把 toast 窗口贴到壳层窗口内容区右下角。
fn place<R: Runtime>(app: &AppHandle<R>, toast: &Window<R>) -> Result<(), String> {
    let owner = app
        .get_window(crate::desktop::builder::MAIN_WINDOW_LABEL)
        .ok_or("TOAST_VIEW_NO_MAIN: shell window not found")?;
    let position = owner.inner_position().map_err(|error| error.to_string())?;
    let size = owner.inner_size().map_err(|error| error.to_string())?;
    let scale = owner.scale_factor().map_err(|error| error.to_string())?;
    let toast_size = toast.inner_size().map_err(|error| error.to_string())?;
    let (x, y) = toast_bounds(
        position.x,
        position.y,
        size.width,
        size.height,
        toast_size.width,
        toast_size.height,
        scale,
    );
    toast
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())
}

/// 计算 toast 窗口在屏幕上的物理像素坐标：贴住壳层内容区右下角，留 `TOAST_MARGIN`。
///
/// 抽成纯函数便于单测（原生窗口 API 在 CI 上不可用）。
#[allow(clippy::too_many_arguments)]
fn toast_bounds(
    owner_x: i32,
    owner_y: i32,
    owner_width: u32,
    owner_height: u32,
    toast_width: u32,
    toast_height: u32,
    scale: f64,
) -> (i32, i32) {
    let margin = (TOAST_MARGIN * scale).round() as i32;
    (
        owner_x + owner_width as i32 - toast_width as i32 - margin,
        owner_y + owner_height as i32 - toast_height as i32 - margin,
    )
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>) -> Result<Window<R>, String> {
    if let Some(window) = app.get_window(TOAST_WINDOW_LABEL) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        TOAST_WINDOW_LABEL,
        WebviewUrl::App("toast.html".into()),
    )
    .title(crate::desktop::product_name(app))
    .inner_size(TOAST_WIDTH, TOAST_HEIGHT)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .transparent(true)
    .always_on_top(true)
    .decorations(false)
    .skip_taskbar(true)
    .shadow(false)
    .accept_first_mouse(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?
    .as_ref()
    .window();
    Ok(window)
}

/// 显示 toast 窗口（首次调用时创建）。内容随后由壳层直接推给页面。
#[tauri::command]
pub async fn toast_view_show(app: AppHandle, webview: Webview) -> Result<(), String> {
    crate::desktop::window::require_shell(&webview)?;
    let toast = ensure_window(&app)?;
    place(&app, &toast)?;
    toast.show().map_err(|error| error.to_string())?;
    // show() 在 Windows 上会激活新窗口，把焦点还给壳层，避免输入焦点被 toast 抢走。
    let _ = webview.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn toast_view_hide(app: AppHandle, webview: Webview) -> Result<(), String> {
    crate::desktop::window::require_shell(&webview)?;
    if let Some(toast) = app.get_window(TOAST_WINDOW_LABEL) {
        toast.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// 页面按卡片实际高度调整窗口后，重新贴合右下角。
#[tauri::command]
pub async fn toast_view_resize(app: AppHandle, webview: Webview, height: f64) -> Result<(), String> {
    if webview.label() != TOAST_WINDOW_LABEL {
        return Err("TOAST_VIEW_LABEL_MISMATCH: this command is restricted to the toast window".into());
    }
    if !height.is_finite() || height <= 0. {
        return Err("TOAST_VIEW_INVALID_HEIGHT: height must be positive".into());
    }
    let window = webview.window();
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(
            (TOAST_WIDTH * scale).round().max(1.) as u32,
            (height * scale).round().max(1.) as u32,
        ))
        .map_err(|error| error.to_string())?;
    place(&app, &window)
}

/// 壳层窗口移动 / 缩放 / 全屏切换时重新贴合；toast 不可见时直接跳过。
pub(crate) fn reposition<R: Runtime>(app: &AppHandle<R>) {
    let Some(toast) = app.get_window(TOAST_WINDOW_LABEL) else {
        return;
    };
    if !toast.is_visible().unwrap_or(false) {
        return;
    }
    if let Err(error) = place(app, &toast) {
        log::warn!("[toast] TOAST_VIEW_PLACE_FAILED: {error}");
    }
}

/// 壳层窗口显隐变化时同步 toast：收起即隐藏，恢复则重新贴合。
///
/// 兄弟窗口之间没有父子关系，主窗口收起不会带走 toast；不显式同步就会在桌面上留下
/// 一块孤立的置顶透明层（issue #1408 中已实测到）。
pub(crate) fn sync_visibility<R: Runtime>(app: &AppHandle<R>) {
    let Some(owner) = app.get_window(crate::desktop::builder::MAIN_WINDOW_LABEL) else {
        return;
    };
    let Some(toast) = app.get_window(TOAST_WINDOW_LABEL) else {
        return;
    };
    match owner.is_visible() {
        Ok(true) => {
            if let Err(error) = place(app, &toast) {
                log::warn!("[toast] TOAST_VIEW_PLACE_FAILED: {error}");
            }
        }
        Ok(false) => {
            if let Err(error) = toast.hide() {
                log::warn!("[toast] TOAST_VIEW_HIDE_FAILED: {error}");
            }
        }
        Err(error) => log::warn!("[toast] TOAST_VIEW_STATE_FAILED: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{toast_bounds, TOAST_MARGIN};

    #[test]
    fn toast_view_hugs_the_bottom_end_corner_of_the_shell_content() {
        // 900 宽的内容区放 400 宽的提示，右边留 16：100 + 900 - 400 - 16 = 584。
        assert_eq!(toast_bounds(100, 100, 900, 600, 400, 120, 1.0), (584, 564));
    }

    #[test]
    fn toast_view_margin_scales_with_the_display() {
        // 高 DPI 下窗口尺寸本身就是物理像素，边距必须按同一比例放大（16 * 2 = 32）。
        assert_eq!(toast_bounds(100, 100, 1800, 1200, 800, 240, 2.0), (1068, 1028));
    }

    #[test]
    fn toast_view_margin_is_shared_with_the_frontend_layout() {
        assert_eq!(TOAST_MARGIN, 16.0);
    }
}
