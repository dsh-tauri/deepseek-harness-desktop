use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tauri::{AppHandle, Manager, Url, WebviewWindow, Wry};

const PRELOAD_QUERY: &str = "_dshPreload";
const GATE_SCRIPT: &str = include_str!("frontend_preload.js.inc");
#[cfg(any(windows, test))]
const RESOURCE_FILTERS: [(&str, bool); 5] = [
    ("http://127.0.0.1:*/*", true),
    ("http://127.0.0.1:*/assets/*", false),
    ("http://127.0.0.1:*/manifest.webmanifest*", false),
    ("http://127.0.0.1:*/favicon.svg*", false),
    ("http://127.0.0.1:*/favicon-dark.svg*", false),
];

#[derive(Default)]
struct WindowPreload {
    generation: u64,
    frontend: Option<Frontend>,
    serving: bool,
}

struct Frontend {
    profile: String,
    origin: String,
    id: String,
    root: PathBuf,
    index: Vec<u8>,
}

fn windows() -> &'static Mutex<HashMap<String, Arc<Mutex<WindowPreload>>>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, Arc<Mutex<WindowPreload>>>>> = OnceLock::new();
    WINDOWS.get_or_init(Mutex::default)
}

fn frontend_root(core: &Path) -> Option<PathBuf> {
    core.ancestors().take(4).find_map(|base| {
        let package = base.join("node_modules/@deepseek-ai/dsh-web-frontend");
        let metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(package.join("package.json")).ok()?).ok()?;
        (metadata.get("name")?.as_str()? == "@deepseek-ai/dsh-web-frontend")
            .then(|| dunce::canonicalize(package.join("dist")).ok())?
    })
}

fn asset_path(root: &Path, encoded: &str) -> Option<PathBuf> {
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut bytes = encoded.bytes();
    while let Some(byte) = bytes.next() {
        decoded.push(if byte == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            ((high << 4) | low) as u8
        } else {
            byte
        });
    }
    let decoded = String::from_utf8(decoded).ok()?;
    let relative = decoded.strip_prefix('/')?;
    if relative.is_empty()
        || relative.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || part.ends_with(['.', ' '])
                || part
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '\\' | ':' | '%'))
        })
    {
        return None;
    }
    if !relative.starts_with("assets/")
        && !matches!(
            relative,
            "manifest.webmanifest" | "favicon.svg" | "favicon-dark.svg"
        )
    {
        return None;
    }
    let target = dunce::canonicalize(root.join(relative)).ok()?;
    (target.starts_with(root) && target.is_file()).then_some(target)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("json" | "map" | "webmanifest") => "application/json",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn load_frontend(
    core: &Path,
    profile: String,
    origin: String,
    id: String,
    parent_origin: String,
) -> Option<Frontend> {
    let root = frontend_root(core)?;
    let index = std::fs::read_to_string(root.join("index.html")).ok()?;
    let script =
        regex::Regex::new(r#"<script type="module" crossorigin src="([^"<>]+)"></script>"#).ok()?;
    let entry = script
        .captures(&index)?
        .get(1)?
        .as_str()
        .trim_start_matches('.');
    let source = std::fs::read_to_string(asset_path(&root, entry)?).ok()?;
    if !source.contains("await globalThis.__DSH_BOOT_READY__?.promise")
        || index.matches("<head>").count() != 1
        || index.contains("__DSH_BOOT_READY__")
    {
        return None;
    }
    let metadata =
        serde_json::json!({ "id": id, "parentOrigin": parent_origin, "template": index });
    let metadata = metadata.to_string().replace('<', "\\u003c");
    let injected = index.replacen(
        "<head>",
        &format!("<head><script>(()=>{{const preload={metadata};{GATE_SCRIPT}}})()</script>"),
        1,
    );
    Some(Frontend {
        profile,
        origin,
        id,
        root,
        index: injected.into_bytes(),
    })
}

#[tauri::command]
pub async fn prepare_frontend_preload(
    window: WebviewWindow<Wry>,
    app_handle: AppHandle,
) -> Result<Option<String>, String> {
    let slot = windows()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(window.label())
        .cloned();
    let Some(slot) = slot else { return Ok(None) };
    let generation = {
        let mut state = slot.lock().unwrap_or_else(|error| error.into_inner());
        state.generation += 1;
        state.frontend = None;
        state.serving = false;
        state.generation
    };
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    let port = crate::service::workflow::instances::scope_sync(profile.clone(), || {
        crate::service::workflow::instances::port(&app_handle)
    });
    let origin = crate::config::get_dsh_service_url(port);
    let core = crate::service::core::active_core_dir(&app_handle);
    let parent_origin = window
        .url()
        .map_err(|error| format!("FRONTEND_PRELOAD_URL: {error}"))?
        .origin()
        .ascii_serialization();
    let id = generation.to_string();
    let url = format!("{origin}/?dshDesktop&{PRELOAD_QUERY}={id}");
    let load_profile = profile.clone();
    let frontend = tauri::async_runtime::spawn_blocking(move || {
        load_frontend(&core, load_profile, origin, id, parent_origin)
    })
    .await
    .map_err(|error| format!("FRONTEND_PRELOAD_LOAD: {error}"))?;
    let current_profile =
        crate::service::workflow::instances::window_profile(&app_handle, window.label());
    let current_port =
        crate::service::workflow::instances::scope_sync(current_profile.clone(), || {
            crate::service::workflow::instances::port(&app_handle)
        });
    let mut state = slot.lock().unwrap_or_else(|error| error.into_inner());
    if state.generation != generation || profile != current_profile || port != current_port {
        return Ok(None);
    }
    if frontend.is_none() {
        log::warn!("FRONTEND_PRELOAD_UNSUPPORTED: active frontend is missing or has no boot gate");
    }
    state.frontend = frontend;
    Ok(state.frontend.as_ref().map(|_| url))
}

#[cfg(windows)]
pub fn install(
    platform: &tauri::webview::PlatformWebview,
    window: &WebviewWindow<Wry>,
) -> Result<(), String> {
    use webview2_com::{
        take_pwstr,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2WebResourceResponse, ICoreWebView2_22,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
        },
        WebResourceRequestedEventHandler,
    };
    use windows_core::{Interface, HSTRING, PWSTR};

    let label = window.label().to_string();
    if windows()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains_key(&label)
    {
        return Ok(());
    }
    let slot = Arc::new(Mutex::new(WindowPreload::default()));
    let state_for_request = slot.clone();
    let parent = window.clone();
    let result = unsafe {
        (|| -> windows_core::Result<()> {
            let webview = platform.controller().CoreWebView2()?;
            let environment = platform.environment();
            let webview22 = webview.cast::<ICoreWebView2_22>()?;
            for (pattern, document_only) in RESOURCE_FILTERS {
                webview22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                    &HSTRING::from(pattern),
                    if document_only {
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT
                    } else {
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL
                    },
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
                )?;
            }
            let mut token = 0;
            webview.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else { return Ok(()) };
                    let request = args.Request()?;
                    let mut uri = PWSTR::null();
                    request.Uri(&mut uri)?;
                    let uri = take_pwstr(uri);
                    let Ok(url) = Url::parse(&uri) else { return Ok(()) };
                    let mut method = PWSTR::null();
                    request.Method(&mut method)?;
                    let method = take_pwstr(method);
                    if !matches!(method.as_str(), "GET" | "HEAD") { return Ok(()) }
                    let profile = crate::service::workflow::instances::window_profile(parent.app_handle(), parent.label());
                    let port = crate::service::workflow::instances::scope_sync(profile.clone(), || {
                        crate::service::workflow::instances::port(parent.app_handle())
                    });
                    let mut state = state_for_request.lock().unwrap_or_else(|error| error.into_inner());
                    let Some(frontend) = state.frontend.as_ref() else { return Ok(()) };
                    if profile != frontend.profile || url.origin().ascii_serialization() != frontend.origin || url.port_or_known_default() != Some(port) {
                        return Ok(());
                    }
                    let index_request = matches!(url.path(), "/" | "/index.html");
                    let body = if index_request {
                        if !url.query_pairs().any(|(key, value)| key == PRELOAD_QUERY && value == frontend.id) {
                            state.serving = false;
                            return Ok(());
                        }
                        let body = frontend.index.clone();
                        state.serving = true;
                        Some((body, "text/html; charset=utf-8"))
                    } else if state.serving {
                        asset_path(&frontend.root, url.path())
                            .and_then(|path| std::fs::read(&path).ok().map(|body| (body, content_type(&path))))
                    } else { None };
                    let Some((body, mime)) = body else { return Ok(()) };
                    drop(state);
                    let headers = HSTRING::from(format!("Content-Type: {mime}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"));
                    let Ok(length) = u32::try_from(body.len()) else { return Ok(()) };
                    let stream = if method == "HEAD" { std::ptr::null_mut() } else {
                        windows_sys::Win32::UI::Shell::SHCreateMemStream(body.as_ptr(), length)
                    };
                    if stream.is_null() && method != "HEAD" && !body.is_empty() { return Ok(()) }
                    let mut response = std::ptr::null_mut();
                    let reason = HSTRING::from("OK");
                    let status = (environment.vtable().CreateWebResourceResponse)(
                        environment.as_raw(), stream, 200, windows_core::PCWSTR(reason.as_ptr()),
                        windows_core::PCWSTR(headers.as_ptr()), &mut response,
                    );
                    if !stream.is_null() { drop(windows_core::IUnknown::from_raw(stream)); }
                    status.ok()?;
                    args.SetResponse(&ICoreWebView2WebResourceResponse::from_raw(response))?;
                    Ok(())
                })),
                &mut token,
            )?;
            Ok(())
        })()
    };
    result.map_err(|error| format!("FRONTEND_PRELOAD_INSTALL: {error}"))?;
    windows()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(label.clone(), slot);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            windows()
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&label);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_static_subresources_reach_the_native_preload_handler() {
        assert_eq!(
            RESOURCE_FILTERS,
            [
                ("http://127.0.0.1:*/*", true),
                ("http://127.0.0.1:*/assets/*", false),
                ("http://127.0.0.1:*/manifest.webmanifest*", false),
                ("http://127.0.0.1:*/favicon.svg*", false),
                ("http://127.0.0.1:*/favicon-dark.svg*", false),
            ]
        );
    }

    #[test]
    fn static_paths_stay_inside_the_frontend_and_decode_once() {
        let directory = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(directory.path()).unwrap();
        std::fs::create_dir(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/app.js"), b"ok").unwrap();
        assert_eq!(
            asset_path(&root, "/assets/%61pp.js"),
            Some(root.join("assets/app.js"))
        );
        for path in [
            "/assets/../app.js",
            "/assets/%2e%2e/app.js",
            "/assets/%252e%252e/app.js",
            "/assets/%zz",
            "/assets/%ff",
            "/assets/app.js:secret",
            "/assets/app.js.",
            "/assets/%5capp.js",
            "/plugins/client.js",
        ] {
            assert!(asset_path(&root, path).is_none(), "{path}");
        }
    }
}
