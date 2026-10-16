#[cfg(windows)]
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::sync::Arc;

#[cfg(windows)]
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{
    webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse},
    AppHandle, Emitter, Runtime, Url, Webview, WebviewWindow, Wry,
};
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::desktop::payload::DownloadFinishedPayload;

/// 接管内嵌 iframe 的 `window.open()` / `target=_blank` 新窗口请求：
/// WebView2 里这类请求走 NewWindowRequested，wry 在没有 handler 时直接吞掉。
/// 这里把 http(s) 链接交给系统浏览器打开，其余协议一律拒绝。
pub fn on_new_window<R: Runtime>(
    app_handle: tauri::AppHandle<R>,
    url: Url,
    _features: NewWindowFeatures,
) -> NewWindowResponse<R> {
    if matches!(url.scheme(), "http" | "https") {
        if let Err(e) = app_handle.opener().open_url(url.to_string(), None::<&str>) {
            log::warn!("[new-window] open in browser failed {e}");
        }
    } else {
        log::debug!("[new-window] denied {url}");
    }
    NewWindowResponse::Deny
}

/// 接管下载：保存到系统下载目录，重名时自动加 " (n)" 后缀，
/// 完成后向前端 emit `harness-download-finished`。
pub fn on_download<R: Runtime>(webview: Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            *destination = config::unique_download_path(destination);
            log::info!("[download] requested {} -> {}", url, destination.display());
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let path_str = path.as_ref().map(|p| p.to_string_lossy().to_string());
            let payload = DownloadFinishedPayload {
                url: url.to_string(),
                path: path_str,
                success,
            };
            let _ = webview.emit("harness-download-finished", payload);
            log::info!(
                "[download] finished {} success={} path={:?}",
                url,
                success,
                path
            );
            true
        }
        // DownloadEvent 为 #[non_exhaustive]，预留未来变体
        _ => true,
    }
}

/// 关掉 WebView2 的外部拖放（`AllowExternalDrop`）。
///
/// wry 只在它自己接管拖放时才关闭该开关（`drop_handler` 为空就跳过）；本项目用
/// `disable_drag_drop_handler()` 关掉了那份接管以恢复 iframe 内的 HTML5 拖拽，
/// 于是开关留在默认开启状态。而开启时，在页面内拖放文本会让 WebView2 卡在失效的
/// 鼠标捕获上：选中无法取消、点击与输入失效、滚轮仍可用（WebView2Feedback #5141 /
/// #5613）。这里补回这道防护——它只影响外部拖放，页面内 HTML5 拖拽不受影响。
#[cfg(windows)]
pub fn disable_external_drop(webview: &tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller4;
    use windows_core::Interface;

    unsafe {
        match webview.controller().cast::<ICoreWebView2Controller4>() {
            Ok(controller) => {
                if let Err(e) = controller.SetAllowExternalDrop(false) {
                    log::warn!("[webview] failed to disable external drop: {e}");
                }
            }
            Err(e) => log::warn!("[webview] ICoreWebView2Controller4 unavailable: {e}"),
        }
    }
}

#[cfg(windows)]
pub fn on_page_load(
    webview_window: WebviewWindow<Wry>,
    payload: PageLoadPayload<'_>,
    notification_handlers_registered_for_page: Arc<AtomicBool>,
) {
    // Windows 依赖 WebView2 的 FramePermissionRequested / FrameCreated 机制，
    // 需要在页面加载时注册；非 Windows 已在 build_main_window 里通过
    // initialization_script_for_all_frames 注入，这里不需要再做处理。
    if payload.event() != PageLoadEvent::Started {
        return;
    }
    log::info!("[webview] on_page_load started");
    if !notification_handlers_registered_for_page.swap(true, std::sync::atomic::Ordering::SeqCst) {
        log::info!("[notification] top-level page load started; scheduling handler registration");
        let parent = webview_window.clone();
        if let Err(e) = webview_window.with_webview(move |platform| {
            disable_external_drop(&platform);
            if let Err(error) = crate::desktop::frontend_preload::install(&platform, &parent) {
                log::warn!("FRONTEND_PRELOAD_UNAVAILABLE: {error}");
            }
            if let Err(e) =
                crate::desktop::notification::enable_notification_permissions(platform, parent)
            {
                log::warn!("[webview] failed to enable notification permission: {e}");
            }
        }) {
            log::warn!("[webview] failed to schedule notification permission setup: {e}");
        }
    }
}

/// 壳层导航栏「文件 → 新建窗口」：以同一 `index.html` 再开一个独立 webview 窗口。
///
/// 异步命令（不占用主线程）是唯一安全的调用侧：`WebviewWindowBuilder::build()`
/// 需要主线程事件循环回包，主线程调用会死锁（与 `pet::ensure_pet_window` 同约束）。
#[tauri::command]
pub async fn create_app_window(
    app_handle: AppHandle<Wry>,
    window: WebviewWindow<Wry>,
    session_id: Option<String>,
    iframe_url: Option<String>,
) -> Result<(), String> {
    let _transition = crate::service::workflow::acquire_core_transition().await?;
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    let path = crate::service::workflow::instances::scope_sync(profile.clone(), || {
        let origin =
            config::get_dsh_service_url(crate::service::workflow::instances::port(&app_handle));
        session_window_path(
            session_id.as_deref(),
            session_id.as_ref().map(|_| origin.as_str()),
        )
    })?;
    let _ = iframe_url;
    crate::desktop::builder::build_extra_window(&app_handle, path, &profile)
        .map(|_| ())
        .map_err(|error| format!("WINDOW_CREATE_FAILED: {error}"))
}

fn session_window_path(
    session_id: Option<&str>,
    iframe_url: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let Some(session_id) = session_id else {
        return Ok("index.html".into());
    };
    if session_id.trim().is_empty() || session_id.len() > 512 {
        return Err("WINDOW_CREATE_FAILED: invalid sessionId".into());
    }
    let url = Url::parse(iframe_url.unwrap_or_default())
        .map_err(|error| format!("WINDOW_CREATE_FAILED: invalid iframeUrl: {error}"))?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("WINDOW_CREATE_FAILED: iframeUrl must be a loopback HTTP origin".into());
    }
    let mut target = url.clone();
    target
        .query_pairs_mut()
        .append_pair("sessionId", session_id)
        .append_pair("iframeUrl", url.as_str());
    Ok(format!("index.html#{}", target.query().unwrap_or_default()).into())
}

#[cfg(test)]
mod session_window_tests {
    use super::session_window_path;

    #[test]
    fn session_target_is_encoded_and_rejects_untrusted_urls() {
        assert_eq!(
            session_window_path(None, None).unwrap().to_str(),
            Some("index.html")
        );
        assert_eq!(
            session_window_path(Some("session &/?#"), Some("http://127.0.0.1:3080")).unwrap().to_str(),
            Some("index.html#sessionId=session+%26%2F%3F%23&iframeUrl=http%3A%2F%2F127.0.0.1%3A3080%2F")
        );
        for url in [
            "https://example.com",
            "file:///x",
            "http://localhost/api",
            "http://u@localhost",
            "http://localhost/?token=x",
        ] {
            assert!(session_window_path(Some("s1"), Some(url)).is_err());
        }
        assert!(session_window_path(Some(" "), Some("http://localhost:3080")).is_err());
    }
}

/// 壳层导航栏「文件 → 退出」：与托盘「退出」同语义，走 `exit(0)` 完整退出
/// （触发 `RunEvent::ExitRequested` 的主窗口几何保存与 `RunEvent::Exit` 的进程回收）。
#[tauri::command]
pub fn quit_app(app_handle: AppHandle<Wry>) {
    app_handle.exit(0);
}

/// 壳层「帮助 → 切换开发者工具」：开/关调用方所在窗口的 WebView 检查器。
///
/// 「切换」只能做到近似：只有 macOS 的 wkwebview 如实回报检查器状态；
/// Windows 侧（wry 0.57 + WebView2）`is_devtools_open()` 恒为 false 且
/// `close_devtools()` 是空实现，重复调用等价于再次打开/聚焦，不会误关。
#[tauri::command]
pub fn toggle_devtools(window: WebviewWindow<Wry>) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}
