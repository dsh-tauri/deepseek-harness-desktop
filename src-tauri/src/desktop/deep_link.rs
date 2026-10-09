//! 正式版使用官方 `dsh://open`；夜间版单独注册 `dsh-nightly`，不覆盖正式版协议。

use tauri::AppHandle;
use tauri_plugin_deep_link::DeepLinkExt;

pub fn is_open_request(url: &str) -> bool {
    let scheme = if crate::config::APP_IDENTIFIER == "dsh-tauri-nightly" {
        "dsh-nightly"
    } else {
        "dsh"
    };
    url == format!("{scheme}://open") || url == format!("{scheme}://open/")
}

/// 协议注册失败只告警，不阻断启动。
pub fn init(app: &AppHandle) {
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(e) = app.deep_link().register_all() {
        log::warn!("deep link register_all failed: {e}");
    }

    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            if is_open_request(url.as_str()) {
                crate::utils::show_main_window(&handle);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::is_open_request;

    #[test]
    fn recognizes_only_the_current_build_open_requests() {
        let nightly = crate::config::APP_IDENTIFIER == "dsh-tauri-nightly";
        assert_eq!(is_open_request("dsh://open"), !nightly);
        assert_eq!(is_open_request("dsh://open/"), !nightly);
        assert_eq!(is_open_request("dsh-nightly://open"), nightly);
        assert_eq!(is_open_request("dsh-nightly://open/"), nightly);
    }

    #[test]
    fn ignores_other_urls() {
        assert!(!is_open_request("dsh://oauth/callback"));
        assert!(!is_open_request("dsh-nightly://oauth/callback"));
        assert!(!is_open_request("dsh-nightly://open?extra=1"));
        assert!(!is_open_request(
            "https://platform.deepseek.com/dsh/authorized?login_source=desktop"
        ));
        assert!(!is_open_request(""));
    }
}
