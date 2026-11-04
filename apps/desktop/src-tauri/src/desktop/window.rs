use crate::{AppHandle, Webview, Window};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}},
};
use tauri::Manager;
use tauri::{Emitter, Runtime, Url, webview::DownloadEvent};
use tauri_plugin_opener::OpenerExt;
use tauri_runtime_electron::{NewWindowFeatures, NewWindowResponse};

use crate::config;
use crate::desktop::payload::DownloadFinishedPayload;

pub fn on_new_window(
    app_handle: crate::AppHandle<tauri_runtime_electron::ElectronRuntime>,
    url: Url,
    _features: NewWindowFeatures,
) -> NewWindowResponse {
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
            let downloads = webview.path().download_dir().ok();
            match config::unique_download_path(destination, downloads.as_deref()) {
                Ok(path) => {
                    *destination = path;
                    log::info!("[download] requested {} -> {}", url, destination.display());
                    true
                }
                Err(error) => {
                    log::warn!("[download] rejected {}: {error}", url);
                    false
                }
            }
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

/// 跳转信息全局名（与 `packages/dsh-tauri/src/client/register/navigation.ts` 逐字一致）。
const NAVIGATION_GLOBAL: &str = "__DSH_NAVIGATION__";

fn harness_guest_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| error.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("HARNESS_WEBVIEW_INVALID_URL".into());
    }
    Ok(url)
}

pub(super) fn require_shell(webview: &Webview) -> Result<(), String> {
    let url = webview.url().map_err(|error| error.to_string())?;
    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let dev = cfg!(debug_assertions)
        && webview
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| dev.origin() == url.origin());
    if webview.label() != webview.window().label() || !(packaged || dev) {
        return Err("HARNESS_WEBVIEW_SHELL_REQUIRED".into());
    }
    Ok(())
}

#[derive(Clone, Default, serde::Serialize)]
struct HarnessDocument {
    label: String,
    loaded: bool,
    alive: bool,
    crashed: bool,
    #[serde(skip)]
    owner: String,
    #[serde(skip)]
    revision: u64,
    #[serde(skip)]
    closed: bool,
}

impl HarnessDocument {
    fn advance(&mut self, event: tauri_runtime_electron::WebviewLoadState) -> u64 {
        use tauri_runtime_electron::WebviewLoadState;
        self.revision += 1;
        self.loaded = event == WebviewLoadState::Finished;
        self.alive = false;
        self.crashed = matches!(
            event,
            WebviewLoadState::Failed | WebviewLoadState::ProcessGone
        );
        self.revision
    }

    fn confirm(&mut self, revision: u64, alive: bool) -> bool {
        if self.closed || self.revision != revision || !self.loaded {
            return false;
        }
        self.alive = alive;
        true
    }

    fn emit(&self, app: &AppHandle) {
        if !self.closed {
            let _ = app.emit_to(
                tauri::EventTarget::window(&self.owner),
                "harness-webview-state",
                self,
            );
        }
    }
}

#[derive(Default)]
struct HarnessDocuments(Mutex<HashMap<String, Arc<Mutex<HarnessDocument>>>>);

pub(super) fn forget_harness_documents(app: &AppHandle, owner: &str) {
    if let Some(documents) = app.try_state::<HarnessDocuments>() {
        documents.0.lock().unwrap().retain(|_, document| {
            let mut document = document.lock().unwrap();
            if document.owner != owner {
                return true;
            }
            document.closed = true;
            false
        });
    }
}

fn track_harness_document(app: &AppHandle, guest: &Webview, owner: &str, url: &Url) -> Result<(), String> {
    app.manage(HarnessDocuments::default());
    let document = Arc::new(Mutex::new(HarnessDocument {
        label: guest.label().to_owned(), owner: owner.to_owned(), ..Default::default()
    }));
    app.state::<HarnessDocuments>().0.lock().unwrap().insert(guest.label().to_owned(), document.clone());
    let app = app.clone();
    let view = guest.clone();
    let proof = format!(
        "Boolean(location.origin === {} && Array.isArray(window.__DSH_BOOT__?.entries) && window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label === {})",
        serde_json::to_string(&url.origin().ascii_serialization()).unwrap(),
        serde_json::to_string(guest.label()).unwrap()
    );
    tauri_runtime_electron::on_webview_load_state(guest, move |event| {
        let (revision, snapshot) = {
            let mut document = document.lock().unwrap();
            let revision = document.advance(event);
            (revision, document.clone())
        };
        snapshot.emit(&app);
        if event == tauri_runtime_electron::WebviewLoadState::Finished {
            let document = document.clone();
            let app = app.clone();
            if let Err(error) = view.eval_with_callback(proof.clone(), move |value| {
                let snapshot = {
                    let mut document = document.lock().unwrap();
                    document
                        .confirm(revision, value == "true")
                        .then(|| document.clone())
                };
                if let Some(snapshot) = snapshot {
                    snapshot.emit(&app);
                }
            }) {
                log::warn!("[Webview] document verification failed: {error}");
            }
        }
    })
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn capture_harness_webview(
    app: AppHandle,
    webview: Webview,
    label: String,
) -> Result<String, String> {
    require_shell(&webview)?;
    if !label.starts_with("harness-") {
        return Err("HARNESS_WEBVIEW_INVALID_LABEL".into());
    }
    let guest = app.get_webview(&label).ok_or("HARNESS_WEBVIEW_NOT_FOUND")?;
    if guest.window().label() != webview.window().label() {
        return Err("HARNESS_WEBVIEW_WINDOW_MISMATCH".into());
    }
    tauri_runtime_electron::capture_webview(&guest).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn update_harness_webview(
    app: AppHandle,
    webview: Webview,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    zoom_factor: f64,
) -> Result<(), String> {
    require_shell(&webview)?;
    if ![x, y, width, height, zoom_factor]
        .iter()
        .all(|value| value.is_finite())
        || width < 0.
        || height < 0.
        || zoom_factor <= 0.
    {
        return Err("HARNESS_WEBVIEW_INVALID_BOUNDS".into());
    }
    if !label.starts_with("harness-") {
        return Err("HARNESS_WEBVIEW_INVALID_LABEL".into());
    }
    let guest = app.get_webview(&label).ok_or("HARNESS_WEBVIEW_NOT_FOUND")?;
    if guest.window().label() != webview.window().label() {
        return Err("HARNESS_WEBVIEW_WINDOW_MISMATCH".into());
    }
    if !visible || width == 0. || height == 0. {
        guest.hide().map_err(|error| error.to_string())?;
    }
    guest
        .set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(x, y).into(),
            size: tauri::LogicalSize::new(width.max(1.), height.max(1.)).into(),
        })
        .map_err(|error| error.to_string())?;
    guest
        .set_zoom(config::normalize_zoom_factor(zoom_factor))
        .map_err(|error| error.to_string())?;
    if visible && width > 0. && height > 0. {
        guest.show().map_err(|error| error.to_string())?;
    }
    let snapshot = app.try_state::<HarnessDocuments>().and_then(|documents| {
        documents
            .0
            .lock()
            .unwrap()
            .get(&label)
            .map(|document| document.lock().unwrap().clone())
    });
    if let Some(snapshot) = snapshot {
        snapshot.emit(&app);
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_harness_webview(
    app: AppHandle,
    webview: Webview,
    url: String,
    navigation: Option<serde_json::Value>,
) -> Result<String, String> {
    require_shell(&webview)?;
    let url = harness_guest_url(&url)?;
    let remote = webview.label().starts_with("remote-");
    if !remote {
        let profile =
            crate::service::workflow::instances::window_profile(&app, webview.window().label());
        let port = crate::service::workflow::instances::scope_sync(profile.clone(), || {
            crate::service::workflow::instances::port(&app)
        });
        let expected =
            Url::parse(&config::get_dsh_service_url(port)).map_err(|error| error.to_string())?;
        if url.origin() != expected.origin() {
            return Err("HARNESS_WEBVIEW_ORIGIN_MISMATCH".into());
        }
        // 会话 Cookie 必须在子 WebView 创建前种下：子页面与壳共享同一份 Cookie
        // 库，先种后加载才能让首帧请求（以及插件自建路由）就带凭证。
        let log_path = config::service_log_path_from(&config::get_base_dir(&app), Some(&profile));
        match crate::service::workflow::auth::session_cookie(port, &log_path).await {
            Ok(cookie) => {
                if let Err(error) = crate::service::workflow::auth::inject(&webview, cookie) {
                    log::warn!("[Webview] {error}");
                }
            }
            Err(error) => log::warn!("[Webview] session cookie unavailable: {error}"),
        }
    }
    static NEXT_GUEST: AtomicU64 = AtomicU64::new(1);
    let label = format!("harness-{}", NEXT_GUEST.fetch_add(1, Ordering::Relaxed));
    let origin = url.origin();
    let mut builder = tauri::WebviewBuilder::new(&label, tauri::WebviewUrl::External(url.clone()))
        .transparent(true)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(include_str!("browser.js.inc"))
        // 「打开方式」必须由 Electron 主进程的 shell 交给系统，页内 detached spawn
        // 在 Windows 上无法激活目标窗口（issue #1346）。只注入本地 guest：远程
        // Harness 的操作不该让本机窗口让位。
        .initialization_script(if remote {
            ""
        } else {
            include_str!("open_in_app.js.inc")
        })
        .on_navigation(move |next| next.origin() == origin)
        .on_download(on_download)
        .on_permission_request(|_, kind| match kind {
            tauri::webview::PermissionKind::Microphone => tauri::webview::PermissionResponse::Allow,
            _ => tauri::webview::PermissionResponse::Default,
        });
    if let Some(navigation) = navigation {
        let session = navigation
            .get("sessionId")
            .and_then(serde_json::Value::as_str)
            .ok_or("WINDOW_CREATE_FAILED: invalid sessionId")?;
        let presentation = navigation
            .get("presentation")
            .and_then(serde_json::Value::as_str);
        builder = builder.initialization_script(session_navigation_script(session, presentation)?);
    }
    if !remote {
        // 远程 Harness 的失败由它自己的人机界面负责，壳层只接管本机 guest 的
        // 官方失败卡片（「Failed to load plugins」）；壳层据此切错误页并定位插件。
        builder = builder
            .initialization_script(format!(
                "globalThis.__DSH_SHELL__ = {};",
                serde_json::json!({ "window": webview.window().label(), "guest": label })
            ))
            .initialization_script(include_str!("plugin_boot.js.inc"));
    }
    let capability = harness_capability(&label, &url)?;
    app.add_capability(capability.to_string())
        .map_err(|error| error.to_string())?;
    // keep:effect 宿主路径只有 preload 隔离世界里的 webUtils 读得到，而远程 Harness
    // 读不到本机路径，所以桥只注入本地 guest，远程拖入回落成上传（issue #1325）。
    let setup = tauri_runtime_electron::WebviewSetup::new(&label).browser_host();
    let _setup = if remote {
        setup
    } else {
        setup.preload_script(include_str!("preload.js.inc"))
    };
    let guest = webview
        .window()
        .add_child(
            builder,
            tauri::LogicalPosition::new(-1., -1.),
            tauri::LogicalSize::new(1., 1.),
        )
        .map_err(|error| error.to_string())?;
    if let Err(error) = guest.hide() {
        let _ = guest.close();
        return Err(error.to_string());
    }
    let owner = guest.clone();
    if let Err(error) = tauri_runtime_electron::on_browser_open_requested(&guest, move |lease, url| {
        let _ = owner.emit_to(tauri::EventTarget::webview(owner.label()), "dsh-browser-open-requested", serde_json::json!({ "lease": lease, "url": url }));
    }) {
        let _ = guest.close();
        return Err(error.to_string());
    }
    let app_handle = app.clone();
    if let Err(error) = tauri_runtime_electron::on_new_window(&guest, move |url, features| {
        on_new_window(app_handle.clone(), url, features)
    }) {
        let _ = guest.close();
        return Err(error.to_string());
    }
    if let Err(error) = track_harness_document(&app, &guest, webview.window().label(), &url) {
        let _ = release_harness_webview(app.clone(), webview, label.clone()).await;
        return Err(error);
    }
    Ok(label)
}

#[tauri::command]
pub async fn acquire_browser_guest(
    webview: Webview,
    workspace: String,
) -> Result<tauri_runtime_electron::BrowserGuestReservation, String> {
    tauri_runtime_electron::acquire_browser_guest(&webview, &workspace)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn release_browser_guest(webview: Webview, lease: String) -> Result<(), String> {
    tauri_runtime_electron::release_browser_guest(&webview, &lease)
        .map_err(|error| error.to_string())
}

fn harness_capability(label: &str, url: &Url) -> Result<serde_json::Value, String> {
    let mut capability: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/default.json"))
            .map_err(|error| error.to_string())?;
    capability["identifier"] = label.into();
    capability["local"] = false.into();
    capability["windows"] = serde_json::json!([]);
    capability["webviews"] = serde_json::json!([label]);
    capability["remote"] =
        serde_json::json!({"urls": [format!("{}/*", url.origin().ascii_serialization())]});
    for permission in capability["permissions"]
        .as_array_mut()
        .ok_or("HARNESS_CAPABILITY_INVALID")?
    {
        if permission.as_str() == Some("allow-shell-commands") {
            *permission = "allow-harness-commands".into();
        }
    }
    Ok(capability)
}

#[tauri::command]
pub async fn release_harness_webview(
    app: AppHandle,
    webview: Webview,
    label: String,
) -> Result<(), String> {
    require_shell(&webview)?;
    if !label.starts_with("harness-") {
        return Err("HARNESS_WEBVIEW_INVALID_LABEL".into());
    }
    if let Some(guest) = app.get_webview(&label) {
        if guest.window().label() != webview.window().label() {
            return Err("HARNESS_WEBVIEW_WINDOW_MISMATCH".into());
        }
        guest.close().map_err(|error| error.to_string())?;
    }
    if let Some(documents) = app.try_state::<HarnessDocuments>() {
        if let Some(document) = documents.0.lock().unwrap().remove(&label) {
            document.lock().unwrap().closed = true;
        }
    }
    Ok(())
}

#[cfg(test)]
#[test]
fn harness_document_discards_proof_after_navigation_crash_and_release() {
    use tauri_runtime_electron::WebviewLoadState::{Started, Finished, Failed, ProcessGone};
    let mut document = HarnessDocument::default();
    let first = document.advance(Finished);
    assert!(document.confirm(first, true));
    assert!(document.alive);
    document.advance(Started);
    assert!(!document.loaded && !document.alive && !document.crashed);
    assert!(!document.confirm(first, true));
    for failure in [Failed, ProcessGone] {
        let revision = document.advance(Finished);
        document.advance(failure);
        assert!(document.crashed && !document.alive);
        assert!(!document.confirm(revision, true));
    }
    let current = document.advance(Finished);
    assert!(document.confirm(current, false));
    assert!(!document.alive);
    assert!(document.confirm(current, true));
    document.closed = true;
    assert!(!document.confirm(current, true));
}

#[cfg(test)]
#[test]
fn application_capabilities_separate_shell_and_harness_commands() {
    use tauri::ipc::Origin;

    let mut context = crate::application_context();
    let authority = context.runtime_authority_mut();
    let url = harness_guest_url("http://127.0.0.1:3080/?token=x").unwrap();
    authority
        .add_capability(harness_capability("harness-1", &url).unwrap().to_string())
        .unwrap();
    let allowed = |command: &str, webview: &str, origin: &Origin| {
        authority.resolve_access(command, "main", webview, origin).is_some()
    };
    let guest = Origin::Remote { url };
    let wrong_origin = Origin::Remote { url: Url::parse("http://127.0.0.1:3081/").unwrap() };
    for command in ["get_dsh_theme", "get_runtime_info", "read_service_logs", "quit_app", "update_app_config", "prepare_harness_webview", "update_harness_webview", "capture_harness_webview", "release_harness_webview"] {
        assert!(allowed(command, "main", &Origin::Local), "{command}");
        assert!(!allowed(command, "harness-1", &guest), "{command}");
    }
    for command in ["acquire_browser_guest", "release_browser_guest", "open_external_url", "get_pet_status", "get_pet_overlay_supported", "get_force_xwayland", "set_force_xwayland", "set_pet_size", "read_clipboard_text", "write_clipboard_text"] {
        assert!(allowed(command, "harness-1", &guest), "{command}");
        assert!(!allowed(command, "harness-2", &guest), "{command}");
        assert!(!allowed(command, "harness-1", &wrong_origin), "{command}");
    }
}
#[cfg(test)]
#[test]
fn harness_guest_urls_require_an_explicit_loopback_port() {
    assert!(harness_guest_url("http://127.0.0.1:3080/?token=x").is_ok());
    for url in [
        "https://example.com/",
        "http://127.0.0.1/",
        "http://localhost:3080/",
        "http://user@127.0.0.1:3080/",
        "file:///tmp/index.html",
    ] {
        assert!(harness_guest_url(url).is_err(), "{url}");
    }
}

/// 「全屏右栏」窗口形态：壳层换用 `full-sidebar-navbar`，页面把右栏展开并切进全屏。
/// 载荷值同样与插件 `sidebar-fullwindow.ts` 逐字一致。
const PRESENTATION_FULL_SIDEBAR: &str = "full-sidebar";

/// 壳层导航栏「文件 → 新建窗口」：以同一 `index.html` 再开一个独立 webview 窗口。
///
/// 传入 `session_id` 时把跳转目标注入新窗口的全部 frame，由 dsh-tauri 插件在启动后接收并
/// 打开该会话。注入而不是拼 `index.html#...`：hash 只有壳层可读，内嵌 dsh 的插件拿不到，
/// 只能退回壳层轮询转发，并把新窗口误当成 remote 视图。
///
/// `presentation` 与 `session_id` 同行：壳层读它决定导航栏形态，插件读它把右栏展开成全屏。
///
/// 传入 `profile` 时新窗口绑定到该档案（档案面板「在新窗口打开」），由新窗口自己拉起
/// 该档案的服务；缺省沿用发起窗口的档案。
///
/// 异步命令（不占用主线程）是唯一安全的调用侧：`WebviewWindowBuilder::build()`
/// 需要主线程事件循环回包，主线程调用会死锁（与 `pet::ensure_pet_window` 同约束）。
#[tauri::command]
pub async fn create_app_window(
    app_handle: AppHandle<tauri_runtime_electron::ElectronRuntime>,
    window: Window<tauri_runtime_electron::ElectronRuntime>,
    session_id: Option<String>,
    presentation: Option<String>,
    profile: Option<String>,
) -> Result<(), String> {
    if let Some(value) = presentation.as_deref() {
        if value != PRESENTATION_FULL_SIDEBAR {
            return Err("WINDOW_CREATE_FAILED: unsupported presentation".into());
        }
        if session_id.is_none() {
            return Err("WINDOW_CREATE_FAILED: presentation requires sessionId".into());
        }
    }
    log::info!(
        "[window] create_app_window from {}: profile={profile:?} session={session_id:?} presentation={presentation:?}",
        window.label()
    );
    let navigation = session_id
        .as_deref()
        .map(|session_id| session_navigation_script(session_id, presentation.as_deref()))
        .transpose()?;
    let _transition = crate::service::workflow::acquire_core_transition().await?;
    // 档案存在性必须在锁内复查：等锁期间别的窗口可能已经把它删掉，锁外校验通过后
    // 再绑定就会把新窗口挂到一个不存在的档案上。
    let target = match profile {
        Some(id) => {
            crate::service::profile::select(&app_handle, &id)
                .map_err(|error| format!("WINDOW_CREATE_FAILED: {error}"))?;
            id
        }
        None => crate::service::workflow::instances::window_profile(&app_handle, window.label()),
    };
    crate::desktop::builder::build_extra_window(
        &app_handle,
        "index.html".into(),
        &target,
        navigation.as_deref(),
    )
    .map(|_| ())
    .map_err(|error| format!("WINDOW_CREATE_FAILED: {error}"))
}

/// 校验会话 id 与窗口形态并生成跳转脚本；JSON 序列化负责转义，避免把用户输入拼成可执行代码。
fn session_navigation_script(
    session_id: &str,
    presentation: Option<&str>,
) -> Result<String, String> {
    if session_id.trim().is_empty() || session_id.len() > 512 {
        return Err("WINDOW_CREATE_FAILED: invalid sessionId".into());
    }
    let payload = match presentation {
        None => serde_json::json!({ "sessionId": session_id }),
        Some(PRESENTATION_FULL_SIDEBAR) => serde_json::json!({
            "sessionId": session_id,
            "presentation": PRESENTATION_FULL_SIDEBAR,
        }),
        Some(_) => return Err("WINDOW_CREATE_FAILED: unsupported presentation".into()),
    };
    Ok(format!("globalThis.{NAVIGATION_GLOBAL} = {payload};"))
}

#[cfg(test)]
mod session_navigation_tests {
    use super::{NAVIGATION_GLOBAL, PRESENTATION_FULL_SIDEBAR, session_navigation_script};

    fn payload_of(script: &str) -> serde_json::Value {
        let assignment = format!("globalThis.{NAVIGATION_GLOBAL} = ");
        let payload = script
            .strip_prefix(assignment.as_str())
            .and_then(|rest| rest.strip_suffix(';'))
            .expect("script is one global assignment");
        serde_json::from_str(payload).expect("payload is json")
    }

    #[test]
    fn session_navigation_script_assigns_the_session_target_to_the_shared_global() {
        assert_eq!(
            session_navigation_script("session &/?#", None).unwrap(),
            r#"globalThis.__DSH_NAVIGATION__ = {"sessionId":"session &/?#"};"#
        );
    }

    #[test]
    fn session_navigation_script_escapes_values_through_json_serialization() {
        assert_eq!(
            session_navigation_script("a\"b\\c\nd", None).unwrap(),
            r#"globalThis.__DSH_NAVIGATION__ = {"sessionId":"a\"b\\c\nd"};"#
        );
    }

    #[test]
    fn session_navigation_script_carries_the_full_sidebar_presentation() {
        let payload = payload_of(
            &session_navigation_script("session-1", Some(PRESENTATION_FULL_SIDEBAR)).unwrap(),
        );
        assert_eq!(payload["sessionId"], "session-1");
        assert_eq!(payload["presentation"], PRESENTATION_FULL_SIDEBAR);
    }

    #[test]
    fn session_navigation_script_rejects_unknown_presentations() {
        assert_eq!(
            session_navigation_script("session-1", Some("detached")),
            Err("WINDOW_CREATE_FAILED: unsupported presentation".into())
        );
    }

    #[test]
    fn session_navigation_script_rejects_empty_blank_or_oversized_identifiers() {
        for id in ["", " ", " \t\n", &"s".repeat(513)] {
            assert_eq!(
                session_navigation_script(id, None),
                Err("WINDOW_CREATE_FAILED: invalid sessionId".into())
            );
        }
        assert!(session_navigation_script(&"s".repeat(512), None).is_ok());
    }
}

/// 壳层导航栏「文件 → 退出」：与托盘「退出」同语义，走 `exit(0)` 完整退出
/// （触发 `RunEvent::ExitRequested` 的主窗口几何保存与 `RunEvent::Exit` 的进程回收）。
#[tauri::command]
pub fn quit_app(app_handle: AppHandle<tauri_runtime_electron::ElectronRuntime>) {
    app_handle.exit(0);
}

#[tauri::command]
pub fn toggle_devtools(window: Webview<tauri_runtime_electron::ElectronRuntime>) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}
