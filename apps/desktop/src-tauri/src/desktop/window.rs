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

pub(crate) fn require_shell(webview: &Webview) -> Result<(), String> {
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
    let hosted = webview.label() == webview.window().label()
        && matches!(url.scheme(), "http" | "https")
        && (crate::service::workflow::instances::dsh_service_origin(webview)
            .is_some_and(|service| service.origin() == url.origin())
            || webview.app_handle().try_state::<HostedOrigins>().is_some_and(|origins|
                origins.0.lock().unwrap_or_else(|error| error.into_inner())
                    .get(webview.label()).is_some_and(|origin| origin == &url.origin().ascii_serialization())));
    let remote = webview.label() == webview.window().label()
        && remote_shell_state(&webview.app_handle(), webview.window().label())
            .is_some_and(|state| state.trusted_origin == url.origin().ascii_serialization());
    if webview.label() != webview.window().label() || !(packaged || dev || hosted || remote) {
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteShellState {
    pub machine_id: String,
    pub trusted_origin: String,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct HarnessRestartOperation {
    id: String,
    phase: HarnessRestartPhase,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum HarnessRestartPhase {
    Leaving,
    Stopping,
    Loading,
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HarnessRestartOutcome {
    Success,
    Error,
}

struct HarnessRestart {
    operation: HarnessRestartOperation,
    profile: String,
    source_url: Url,
    bootstrap_url: Option<Url>,
    target_url: Option<Url>,
    stop_guard: Arc<tokio::sync::Mutex<()>>,
    stop_error: Option<String>,
}

static HARNESS_RESTART_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct HarnessRestarts(HashMap<String, HarnessRestart>);

impl HarnessRestarts {
    fn begin(&mut self, window: &str, profile: String, source_url: Url) -> HarnessRestartOperation {
        let operation = HarnessRestartOperation {
            id: format!("restart-{}", HARNESS_RESTART_SEQUENCE.fetch_add(1, Ordering::Relaxed)),
            phase: HarnessRestartPhase::Leaving,
        };
        self.0.insert(window.to_owned(), HarnessRestart {
            operation: operation.clone(), profile, source_url, bootstrap_url: None, target_url: None,
            stop_guard: Arc::default(), stop_error: None,
        });
        operation
    }

    fn forget(&mut self, window: &str) {
        self.0.remove(window);
    }

    fn current(&mut self, window: &str, profile: &str) -> Option<&mut HarnessRestart> {
        if self.0.get(window).is_some_and(|restart| restart.profile != profile) {
            self.0.remove(window);
        }
        self.0.get_mut(window)
    }

    fn get(&mut self, window: &str, profile: &str) -> Option<HarnessRestartOperation> {
        self.current(window, profile).map(|restart| restart.operation.clone())
    }

    fn prepare(&mut self, window: &str, profile: &str, id: &str, source: &Url, bootstrap: Url) -> bool {
        let Some(restart) = self.current(window, profile) else { return false; };
        if restart.operation.id != id || restart.source_url != *source
            || restart.operation.phase != HarnessRestartPhase::Leaving
        {
            return false;
        }
        restart.bootstrap_url = Some(bootstrap);
        true
    }

    fn claim_stop(&mut self, window: &str, profile: &str, id: &str, url: &Url) -> Result<bool, String> {
        let restart = self.current(window, profile).ok_or("HARNESS_RESTART_STALE")?;
        if restart.operation.id != id || restart.bootstrap_url.as_ref() != Some(url) {
            return Err("HARNESS_RESTART_DOCUMENT_MISMATCH".into());
        }
        if let Some(error) = &restart.stop_error {
            return Err(error.clone());
        }
        match restart.operation.phase {
            HarnessRestartPhase::Leaving => {
                restart.operation.phase = HarnessRestartPhase::Stopping;
                Ok(true)
            }
            HarnessRestartPhase::Loading => Ok(false),
            HarnessRestartPhase::Stopping => Err("HARNESS_RESTART_STOP_IN_PROGRESS".into()),
        }
    }

    fn complete_stop(&mut self, window: &str, profile: &str, id: &str, result: Result<(), String>) -> bool {
        let Some(restart) = self.current(window, profile) else { return false; };
        if restart.operation.id != id || restart.operation.phase != HarnessRestartPhase::Stopping {
            return false;
        }
        match result {
            Ok(()) => restart.operation.phase = HarnessRestartPhase::Loading,
            Err(error) => restart.stop_error = Some(error),
        }
        true
    }

    fn bind_target(&mut self, window: &str, profile: &str, id: &str, url: &Url) {
        if let Some(restart) = self.current(window, profile) {
            if restart.operation.id == id && restart.operation.phase == HarnessRestartPhase::Loading {
                restart.target_url = Some(url.clone());
            }
        }
    }

    fn finish(
        &mut self,
        window: &str,
        profile: &str,
        id: &str,
        outcome: HarnessRestartOutcome,
        url: &Url,
    ) -> bool {
        let Some(restart) = self.current(window, profile) else { return false; };
        if restart.operation.id != id {
            return false;
        }
        let target = restart.target_url.as_ref() == Some(url);
        let owned = match outcome {
            HarnessRestartOutcome::Success => target && restart.source_url != *url
                && restart.operation.phase == HarnessRestartPhase::Loading,
            HarnessRestartOutcome::Error => target || restart.source_url == *url
                || restart.bootstrap_url.as_ref() == Some(url),
        };
        if !owned {
            return false;
        }
        self.0.remove(window);
        true
    }
}

#[derive(Default)]
struct HarnessRestartState(Mutex<HarnessRestarts>);

#[derive(Default)]
struct HarnessBootstrapDocuments(Mutex<HashMap<String, Url>>);

fn harness_bootstrap_origin(url: &Url) -> Result<String, String> {
    if matches!(url.scheme(), "http" | "https") {
        return Ok(url.origin().ascii_serialization());
    }
    let host = url.host_str().ok_or("HARNESS_RESTART_BOOTSTRAP_ORIGIN_INVALID")?;
    let mut origin = format!("{}://{host}", url.scheme());
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

fn remember_harness_bootstrap(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    let url = webview.url().map_err(|error| format!("HARNESS_RESTART_URL_FAILED: {error}"))?;
    let packaged = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let dev = cfg!(debug_assertions) && app.config().build.dev_url.as_ref()
        .is_some_and(|dev| dev.origin() == url.origin());
    if packaged || dev {
        app.manage(HarnessBootstrapDocuments::default());
        app.state::<HarnessBootstrapDocuments>().0.lock().unwrap_or_else(|error| error.into_inner())
            .entry(webview.window().label().to_owned()).or_insert(url);
    }
    Ok(())
}

pub(crate) fn forget_harness_restart(app: &AppHandle, window: &str) {
    if let Some(state) = app.try_state::<HarnessRestartState>() {
        state.0.lock().unwrap_or_else(|error| error.into_inner()).forget(window);
    }
}

#[tauri::command]
pub fn begin_harness_restart(app: AppHandle, webview: Webview) -> Result<HarnessRestartOperation, String> {
    require_shell(&webview)?;
    let source_url = webview.url().map_err(|error| format!("HARNESS_RESTART_URL_FAILED: {error}"))?;
    let window = webview.window();
    let profile = crate::service::workflow::instances::window_profile(&app, window.label());
    app.manage(HarnessRestartState::default());
    let state = app.state::<HarnessRestartState>();
    Ok(state.0.lock().unwrap_or_else(|error| error.into_inner())
        .begin(window.label(), profile, source_url))
}

#[tauri::command]
pub fn get_harness_restart(app: AppHandle, webview: Webview) -> Result<Option<HarnessRestartOperation>, String> {
    require_shell(&webview)?;
    let window = webview.window();
    let profile = crate::service::workflow::instances::window_profile(&app, window.label());
    let Some(state) = app.try_state::<HarnessRestartState>() else { return Ok(None); };
    Ok(state.0.lock().unwrap_or_else(|error| error.into_inner()).get(window.label(), &profile))
}

#[tauri::command]
pub async fn prepare_harness_restart(app: AppHandle, webview: Webview, id: String) -> Result<bool, String> {
    require_shell(&webview)?;
    remember_harness_bootstrap(&app, &webview)?;
    let url = webview.url().map_err(|error| format!("HARNESS_RESTART_URL_FAILED: {error}"))?;
    let window = webview.window();
    let profile = crate::service::workflow::instances::window_profile(&app, window.label());
    let bootstrap = app.try_state::<HarnessBootstrapDocuments>().and_then(|state| {
        state.0.lock().unwrap_or_else(|error| error.into_inner()).get(window.label()).cloned()
    }).ok_or("HARNESS_RESTART_BOOTSTRAP_MISSING")?;
    let Some(state) = app.try_state::<HarnessRestartState>() else { return Ok(false); };
    if !state.0.lock().unwrap_or_else(|error| error.into_inner())
        .prepare(window.label(), &profile, &id, &url, bootstrap.clone())
    {
        return Ok(false);
    }
    if url == bootstrap {
        return Ok(true);
    }
    tauri_runtime_electron::navigate_webview_with_trusted_origin(&webview, &harness_bootstrap_origin(&bootstrap)?, bootstrap.as_str())
        .await.map_err(|error| format!("HARNESS_RESTART_NAVIGATE_FAILED: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub async fn resume_harness_restart(app: AppHandle, webview: Webview, id: String) -> Result<bool, String> {
    require_shell(&webview)?;
    let label = webview.window().label().to_owned();
    let profile = crate::service::workflow::instances::window_profile(&app, &label);
    let state = app.try_state::<HarnessRestartState>().ok_or("HARNESS_RESTART_STALE")?;
    let guard = {
        let mut restarts = state.0.lock().unwrap_or_else(|error| error.into_inner());
        let restart = restarts.current(&label, &profile).ok_or("HARNESS_RESTART_STALE")?;
        if restart.operation.id != id {
            return Err("HARNESS_RESTART_STALE".into());
        }
        Arc::clone(&restart.stop_guard)
    };
    let _stop = guard.lock().await;
    if crate::service::workflow::instances::window_profile(&app, &label) != profile {
        forget_harness_restart(&app, &label);
        return Err("HARNESS_RESTART_PROFILE_CHANGED".into());
    }
    let url = webview.url().map_err(|error| format!("HARNESS_RESTART_URL_FAILED: {error}"))?;
    let claimed = state.0.lock().unwrap_or_else(|error| error.into_inner())
        .claim_stop(&label, &profile, &id, &url)?;
    if !claimed {
        return Ok(true);
    }
    let result = crate::service::workflow::instances::scope(profile.clone(),
        crate::service::workflow::stop(app.clone()),
    ).await;
    if crate::service::workflow::instances::window_profile(&app, &label) != profile {
        forget_harness_restart(&app, &label);
        return Err("HARNESS_RESTART_PROFILE_CHANGED".into());
    }
    if !state.0.lock().unwrap_or_else(|error| error.into_inner())
        .complete_stop(&label, &profile, &id, result.clone())
    {
        return Err("HARNESS_RESTART_STALE".into());
    }
    result?;
    Ok(true)
}

#[tauri::command]
pub fn finish_harness_restart(
    app: AppHandle,
    webview: Webview,
    id: String,
    outcome: HarnessRestartOutcome,
) -> Result<bool, String> {
    require_shell(&webview)?;
    let url = webview.url().map_err(|error| format!("HARNESS_RESTART_URL_FAILED: {error}"))?;
    let window = webview.window();
    let profile = crate::service::workflow::instances::window_profile(&app, window.label());
    let Some(state) = app.try_state::<HarnessRestartState>() else { return Ok(false); };
    Ok(state.0.lock().unwrap_or_else(|error| error.into_inner())
        .finish(window.label(), &profile, &id, outcome, &url))
}

#[derive(Default)]
struct HostedOrigins(Mutex<HashMap<String, String>>);

#[derive(Default)]
struct RemoteShellWindows(Mutex<HashMap<String, RemoteShellState>>);

pub(crate) fn remote_shell_state(app: &AppHandle, label: &str) -> Option<RemoteShellState> {
    app.try_state::<RemoteShellWindows>()?
        .0.lock().unwrap_or_else(|error| error.into_inner()).get(label).cloned()
}

pub(crate) fn set_remote_shell(app: &AppHandle, label: &str, state: Option<RemoteShellState>) {
    forget_harness_restart(app, label);
    app.manage(RemoteShellWindows::default());
    let binding = app.state::<RemoteShellWindows>();
    let mut windows = binding.0.lock().unwrap_or_else(|error| error.into_inner());
    match state {
        Some(state) => { windows.insert(label.to_owned(), state); }
        None => { windows.remove(label); }
    }
}

pub(super) fn forget_harness_documents(app: &AppHandle, owner: &str) {
    set_remote_shell(app, owner, None);
    if let Some(bootstrap) = app.try_state::<HarnessBootstrapDocuments>() {
        bootstrap.0.lock().unwrap_or_else(|error| error.into_inner()).remove(owner);
    }
    if let Some(origins) = app.try_state::<HostedOrigins>() {
        origins.0.lock().unwrap_or_else(|error| error.into_inner()).remove(owner);
    }
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

#[tauri::command]
pub async fn host_harness_document(
    app: AppHandle,
    webview: Webview,
    url: String,
) -> Result<(), String> {
    require_shell(&webview)?;
    let url = harness_guest_url(&url)?;
    remember_harness_bootstrap(&app, &webview)?;
    let profile = crate::service::workflow::instances::window_profile(&app, webview.window().label());
    let restart = app.try_state::<HarnessRestartState>().and_then(|state| {
        state.0.lock().unwrap_or_else(|error| error.into_inner())
            .get(webview.window().label(), &profile)
    });
    let host = authenticate_harness_host(&app, &webview, &url).await?;
    if crate::service::workflow::instances::window_profile(&app, webview.window().label()) != profile {
        forget_harness_restart(&app, webview.window().label());
        return Err("HARNESS_DOCUMENT_PROFILE_CHANGED".into());
    }
    tauri_runtime_electron::bind_authenticated_web_host(&webview, &host)
        .map_err(|error| format!("HARNESS_AUTH_BIND_FAILED: {error}"))?;
    app.manage(HostedOrigins::default());
    app.state::<HostedOrigins>().0.lock().unwrap_or_else(|error| error.into_inner())
        .insert(webview.label().to_owned(), url.origin().ascii_serialization());
    if let Some(operation) = restart {
        if let Some(state) = app.try_state::<HarnessRestartState>() {
            state.0.lock().unwrap_or_else(|error| error.into_inner())
                .bind_target(webview.window().label(), &profile, &operation.id, &url);
        }
    }
    webview.navigate(url).map_err(|error| error.to_string())
}

async fn authenticate_harness_host(
    app: &AppHandle,
    webview: &Webview,
    url: &Url,
) -> Result<tauri_runtime_electron::AuthenticatedWebHost, String> {
    let profile = crate::service::workflow::instances::window_profile(app, webview.window().label());
    let port = crate::service::workflow::instances::scope_sync(profile.clone(), || {
        crate::service::workflow::instances::port(app)
    });
    if url.port() != Some(port) {
        return Err("HARNESS_DOCUMENT_ORIGIN_MISMATCH".into());
    }
    crate::service::workflow::instances::scope(profile,
        crate::service::workflow::auth::authenticated_host(app, port),
    ).await
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
    let host = if remote {
        None
    } else {
        Some(authenticate_harness_host(&app, &webview, &url).await?)
    };
    static NEXT_GUEST: AtomicU64 = AtomicU64::new(1);
    let label = format!("harness-{}", NEXT_GUEST.fetch_add(1, Ordering::Relaxed));
    let origin = url.origin();
    let mut builder = tauri::WebviewBuilder::new(&label, tauri::WebviewUrl::External(url.clone()))
        .transparent(true)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(include_str!("browser.js.inc"))
        .initialization_script(super::builder::native_notifications_script(&app))
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
        setup
            .authenticated_web_host(host.as_ref().ok_or("HARNESS_AUTH_HOST_MISSING")?)
            .preload_script(include_str!("preload.js.inc"))
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

pub(super) fn connect_browser_events(webview: &Webview) -> tauri::Result<()> {
    let owner = webview.clone();
    tauri_runtime_electron::on_browser_open_requested(webview, move |lease, url| {
        let _ = owner.emit_to(
            tauri::EventTarget::webview(owner.label()),
            "dsh-browser-open-requested",
            serde_json::json!({ "lease": lease, "url": url }),
        );
    })
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
mod harness_restart_tests {
    use super::{HarnessRestartOperation, HarnessRestartPhase, HarnessRestarts, Url, harness_bootstrap_origin};
    use super::HarnessRestartOutcome::{Error, Success};

    fn source() -> Url {
        Url::parse("http://127.0.0.1:3080/?startup=1").unwrap()
    }

    fn target() -> Url {
        Url::parse("http://127.0.0.1:3080/?startup=2").unwrap()
    }

    fn bootstrap() -> Url {
        Url::parse("http://localhost:1420/?shell=initial").unwrap()
    }

    fn pending() -> (HarnessRestarts, HarnessRestartOperation) {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        assert!(state.prepare("main", "profile-a", &operation.id, &source(), bootstrap()));
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(true));
        assert!(state.complete_stop("main", "profile-a", &operation.id, Ok(())));
        state.bind_target("main", "profile-a", &operation.id, &target());
        let operation = state.get("main", "profile-a").unwrap();
        (state, operation)
    }

    #[test]
    fn bootstrap_origin_preserves_custom_scheme_host_and_port_without_document_path() {
        for (document, expected) in [
            ("tauri://localhost/index.html?boot=1#shell", "tauri://localhost"),
            ("app-shell://desktop:2345/nested/index.html?boot=1#shell", "app-shell://desktop:2345"),
            ("http://localhost:1420/nested/?boot=1#shell", "http://localhost:1420"),
            ("http://tauri.localhost/index.html?boot=1", "http://tauri.localhost"),
            ("https://shell.example:8443/index.html#shell", "https://shell.example:8443"),
        ] {
            assert_eq!(harness_bootstrap_origin(&Url::parse(document).unwrap()), Ok(expected.into()));
        }
    }

    #[test]
    fn stale_id_cannot_finish_or_replace_new_operation_target() {
        let (mut state, old) = pending();
        let current = state.begin("main", "profile-a".into(), source());
        state.bind_target("main", "profile-a", &old.id, &target());
        assert!(!state.finish("main", "profile-a", &old.id, Error, &source()));
        assert!(!state.finish("main", "profile-a", &current.id, Success, &target()));
        assert_eq!(state.get("main", "profile-a"), Some(current));
    }

    #[test]
    fn profile_mismatch_drops_operation_even_after_switching_back() {
        let (mut state, operation) = pending();
        assert!(!state.finish("main", "profile-b", &operation.id, Success, &target()));
        assert_eq!(state.get("main", "profile-a"), None);
    }

    #[test]
    fn wrong_window_cannot_finish_owned_operation() {
        let (mut state, operation) = pending();
        assert!(!state.finish("extra", "profile-a", &operation.id, Success, &target()));
        assert_eq!(state.get("main", "profile-a"), Some(operation));
    }

    #[test]
    fn old_source_document_cannot_finish_success() {
        let (mut state, operation) = pending();
        assert!(!state.finish("main", "profile-a", &operation.id, Success, &source()));
        assert_eq!(state.get("main", "profile-a"), Some(operation));
    }

    #[test]
    fn success_requires_exact_target_url() {
        let (mut state, operation) = pending();
        let other = Url::parse("http://127.0.0.1:3080/?startup=3").unwrap();
        assert!(!state.finish("main", "profile-a", &operation.id, Success, &other));
        assert!(state.finish("main", "profile-a", &operation.id, Success, &target()));
    }

    #[test]
    fn source_url_reused_as_target_cannot_finish_success() {
        let (mut state, operation) = pending();
        state.bind_target("main", "profile-a", &operation.id, &source());
        assert!(!state.finish("main", "profile-a", &operation.id, Success, &source()));
    }

    #[test]
    fn success_consumes_operation_exactly_once() {
        let (mut state, operation) = pending();
        assert!(state.finish("main", "profile-a", &operation.id, Success, &target()));
        assert!(!state.finish("main", "profile-a", &operation.id, Success, &target()));
        assert_eq!(state.get("main", "profile-a"), None);
    }

    #[test]
    fn error_can_finish_only_owned_source_or_target_once() {
        for url in [source(), target()] {
            let (mut state, operation) = pending();
            assert!(state.finish("main", "profile-a", &operation.id, Error, &url));
            assert!(!state.finish("main", "profile-a", &operation.id, Error, &url));
        }
    }

    #[test]
    fn error_from_another_document_cannot_consume_operation() {
        let (mut state, operation) = pending();
        let other = Url::parse("http://127.0.0.1:3080/?startup=3").unwrap();
        assert!(!state.finish("main", "profile-a", &operation.id, Error, &other));
        assert_eq!(state.get("main", "profile-a"), Some(operation));
    }

    #[test]
    fn error_before_navigation_can_finish_from_source() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        assert!(state.finish("main", "profile-a", &operation.id, Error, &source()));
    }

    #[test]
    fn forget_drops_only_owned_window_operation() {
        let (mut state, operation) = pending();
        let extra = state.begin("extra", "profile-a".into(), source());
        state.forget("main");
        assert!(!state.finish("main", "profile-a", &operation.id, Success, &target()));
        assert_eq!(state.get("extra", "profile-a"), Some(extra));
    }

    #[test]
    fn operation_response_serializes_only_id_and_phase() {
        let (_, operation) = pending();
        assert_eq!(serde_json::to_value(&operation).unwrap(), serde_json::json!({ "id": operation.id, "phase": "loading" }));
    }

    #[test]
    fn prepare_requires_matching_source_id_window_and_profile() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        assert!(!state.prepare("main", "profile-a", "stale", &source(), bootstrap()));
        assert!(!state.prepare("other", "profile-a", &operation.id, &source(), bootstrap()));
        assert!(!state.prepare("main", "profile-a", &operation.id, &target(), bootstrap()));
        assert!(!state.prepare("main", "profile-b", &operation.id, &source(), bootstrap()));
        assert_eq!(state.get("main", "profile-a"), None);
    }

    #[test]
    fn restart_already_in_bootstrap_can_prepare_and_resume_without_document_change() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), bootstrap());
        assert!(state.prepare("main", "profile-a", &operation.id, &bootstrap(), bootstrap()));
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(true));
        assert!(state.complete_stop("main", "profile-a", &operation.id, Ok(())));
        assert_eq!(state.get("main", "profile-a").unwrap().phase, HarnessRestartPhase::Loading);
    }

    #[test]
    fn stop_can_be_claimed_only_from_prepared_bootstrap() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        assert!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()).is_err());
        assert!(state.prepare("main", "profile-a", &operation.id, &source(), bootstrap()));
        for url in [source(), target()] {
            assert!(state.claim_stop("main", "profile-a", &operation.id, &url).is_err());
        }
        assert_eq!(state.get("main", "profile-a").unwrap().phase, HarnessRestartPhase::Leaving);
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(true));
        assert_eq!(state.get("main", "profile-a").unwrap().phase, HarnessRestartPhase::Stopping);
    }

    #[test]
    fn duplicate_claim_cannot_stop_twice_before_or_after_completion() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        assert!(state.prepare("main", "profile-a", &operation.id, &source(), bootstrap()));
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(true));
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Err("HARNESS_RESTART_STOP_IN_PROGRESS".into()));
        assert!(state.complete_stop("main", "profile-a", &operation.id, Ok(())));
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(false));
    }

    #[test]
    fn failed_stop_is_replayed_without_another_claim() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        assert!(state.prepare("main", "profile-a", &operation.id, &source(), bootstrap()));
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(true));
        assert!(state.complete_stop("main", "profile-a", &operation.id, Err("STOP_FAILED: fixture".into())));
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Err("STOP_FAILED: fixture".into()));
        assert!(state.finish("main", "profile-a", &operation.id, Error, &bootstrap()));
    }

    #[test]
    fn stale_stop_completion_does_not_mutate_replacement_operation() {
        let mut state = HarnessRestarts::default();
        let old = state.begin("main", "profile-a".into(), source());
        assert!(state.prepare("main", "profile-a", &old.id, &source(), bootstrap()));
        assert_eq!(state.claim_stop("main", "profile-a", &old.id, &bootstrap()), Ok(true));
        let current = state.begin("main", "profile-a".into(), source());
        assert!(!state.complete_stop("main", "profile-a", &old.id, Ok(())));
        assert_eq!(state.get("main", "profile-a"), Some(current));
    }

    #[test]
    fn target_cannot_be_bound_before_successful_stop() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        state.bind_target("main", "profile-a", &operation.id, &target());
        assert!(!state.finish("main", "profile-a", &operation.id, Success, &target()));
    }

    #[tokio::test]
    async fn duplicate_resume_guards_wait_until_first_stop_completes() {
        let mut state = HarnessRestarts::default();
        let operation = state.begin("main", "profile-a".into(), source());
        assert!(state.prepare("main", "profile-a", &operation.id, &source(), bootstrap()));
        let first = state.current("main", "profile-a").unwrap().stop_guard.clone();
        let duplicate = state.current("main", "profile-a").unwrap().stop_guard.clone();
        let first_lock = first.lock().await;
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(true));
        assert!(duplicate.try_lock().is_err());
        assert!(state.complete_stop("main", "profile-a", &operation.id, Ok(())));
        drop(first_lock);
        let _duplicate_lock = duplicate.lock().await;
        assert_eq!(state.claim_stop("main", "profile-a", &operation.id, &bootstrap()), Ok(false));
    }
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
    for command in ["host_harness_document", "begin_harness_restart", "get_harness_restart", "prepare_harness_restart", "resume_harness_restart", "finish_harness_restart", "get_dsh_theme", "get_runtime_info", "read_service_logs", "quit_app", "update_app_config", "prepare_harness_webview", "update_harness_webview", "release_harness_webview"] {
        assert!(allowed(command, "main", &Origin::Local), "{command}");
        assert!(!allowed(command, "harness-1", &guest), "{command}");
    }
    for command in ["acquire_browser_guest", "release_browser_guest", "open_external_url", "get_force_xwayland", "set_force_xwayland", "read_clipboard_text", "write_clipboard_text"] {
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
/// 需要主线程事件循环回包，主线程调用会死锁（与窗口创建路径同约束）。
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
