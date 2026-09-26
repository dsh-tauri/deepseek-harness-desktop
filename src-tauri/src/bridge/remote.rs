//! bridge/remote.rs — SSH 远端机器的桌面集成命令（S5 桥契约 C-BRIDGE）。
//!
//! 引擎（机器存储/连接/隧道）全部住在 `dsh-tauri-ssh` 插件里，桌面壳不持有
//! 任何机器状态；这里只暴露 iframe 内插件做不了的两件事：
//!
//! - `remote_open_window { machineId, url }`：打开（已开则聚焦）label 为
//!   `remote-<machineId>` 的专用 WebviewWindow。窗口加载的是壳层应用本体
//!   （与主窗口同一套导航栏/切换器），前端按自身 label 解析出 machineId
//!   并在启动时切到该机器——远端界面嵌在壳内呈现，而不是裸加载隧道页。
//!   `url`（隧道 URL）仍做回环校验（纵深防御：桥白名单之外的输入不可信，
//!   且未连接机器的调用在第一道就被挡掉）。
//! - `remote_bridge_ping`：无参探测。iframe 内的插件（S4 面板）用它判定
//!   自己运行在桌面壳内；纯 web 环境下该调用超时/被拒，弹窗按钮自隐藏。
//!
//! 两个命令都被 `src/hooks/use-iframe-invoke.ts` 的白名单登记，且弹窗窗口
//! label（`remote-*`）已列入 `capabilities/default.json` 的窗口 glob，其
//! remote URL 面与主窗口一致（仅 loopback）。错误遵循仓库约定：
//! `Result<_, String>`，Err 以大写协议前缀开头（如 `REMOTE_URL_INVALID:`）。

use tauri::{AppHandle, Manager};

/// 弹窗窗口 label 前缀（与 capability 的 `remote-*` glob 对应）。
const REMOTE_WINDOW_LABEL_PREFIX: &str = "remote-";

/// 窗口 label 里仅允许的字符（Tauri label 字符集：字母数字与 `- _ / :`），
/// 其余字符一律折叠为 `-`，避免任意 machineId 注入非法 label。
fn sanitize_label_part(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/' | ':') { c } else { '-' })
        .collect()
}

/// 校验隧道 URL：仅接受 `127.0.0.1` host 的明文 http（隧道由引擎建在
/// `127.0.0.1:<port>`，见插件 `SshLink`；与 capability `remote.urls`
/// `http://127.0.0.1:*` 精确对齐——`localhost`/`[::1]` 过守卫却命不中
/// capability，弹窗会静默退化为无 IPC 的纯 web，故在命令侧一并拒绝）。
fn validate_loopback_http_url(raw: &str) -> Result<tauri::Url, String> {
    let url: tauri::Url = raw
        .parse()
        .map_err(|err| format!("REMOTE_URL_INVALID: {err}"))?;
    if url.scheme() != "http" {
        return Err(format!(
            "REMOTE_URL_INVALID: scheme must be http, got {:?}",
            url.scheme()
        ));
    }
    if url.host_str() != Some("127.0.0.1") {
        return Err(format!(
            "REMOTE_URL_INVALID: only http://127.0.0.1:<port> tunnel URLs are allowed, got {:?}",
            url.host_str()
        ));
    }
    Ok(url)
}

/// 桥探测命令：iframe 内插件据此判定处于桌面壳（无参、恒成功）。
#[tauri::command]
pub fn remote_bridge_ping() -> String {
    "ok".to_string()
}

/// 校验弹窗入参并生成 (label, url)；抽成纯函数便于单测。`url` 允许为空
/// ——未连接机器也可先开窗（窗口内壳层会发起标准连接流程），仅在非空时
/// 做回环校验。
fn open_window_args(machine_id: &str, url: &str) -> Result<(String, Option<tauri::Url>), String> {
    if machine_id.trim().is_empty() {
        return Err("REMOTE_WINDOW_FAILED: machineId must not be empty".to_string());
    }
    let parsed_url = if url.trim().is_empty() {
        None
    } else {
        Some(validate_loopback_http_url(url)?)
    };
    let label = format!(
        "{}{}",
        REMOTE_WINDOW_LABEL_PREFIX,
        sanitize_label_part(machine_id)
    );
    Ok((label, parsed_url))
}

/// 打开（已开则聚焦）`remote-<machineId>` 弹窗窗口，加载壳层应用。
///
/// 壳不自存机器状态：前端按窗口 label 自解析目标机器并切换（机器状态经
/// `/api-ssh` 轮询获取）；`url` 只做回环校验。重复调用聚焦已有窗口（不
/// 重复建窗）；失败返回带前缀的可读错误，由调用方（S4 面板按钮）呈现。
#[tauri::command]
pub fn remote_open_window(
    app_handle: AppHandle,
    machine_id: String,
    url: String,
) -> Result<(), String> {
    let (label, _validated_url) = open_window_args(&machine_id, &url)?;
    // 已有窗口：聚焦即可（再次「打开」同一机器的语义）。
    if let Some(existing) = app_handle.get_webview_window(&label) {
        let _ = existing.set_focus();
        return Ok(());
    }
    // 建窗 chrome 全部取壳层建窗真值（`build_shell_window`）：52px 导航栏交通灯、
    // 桥脚本按窗口注入、（Windows）WebView2 共用数据目录等，远端窗口与本体
    // 唯一区别是连接的后端。label 即机器寻址：前端 remote-<id> 自切换。
    let title = format!("DSH Remote · {machine_id}");
    crate::desktop::builder::build_shell_window(&app_handle, label, &title)
        .map(|_| ())
        .map_err(|err| format!("REMOTE_WINDOW_FAILED: {err}"))
}

#[cfg(test)]
mod tests {
    use super::{sanitize_label_part, validate_loopback_http_url};

    #[test]
    fn label_part_keeps_tauri_charset_and_folds_the_rest() {
        assert_eq!(sanitize_label_part("abc-123"), "abc-123");
        assert_eq!(sanitize_label_part("a_b/c:d"), "a_b/c:d");
        // 空格、点、@ 等非法字符折叠为 '-'，防止注入越权 label
        assert_eq!(sanitize_label_part("a b.c@d"), "a-b-c-d");
        assert_eq!(sanitize_label_part("机器"), "--");
    }

    #[test]
    fn loopback_http_urls_pass_validation() {
        for raw in [
            "http://127.0.0.1:3080",
            "http://127.0.0.1:49152/",
        ] {
            let url = validate_loopback_http_url(raw)
                .unwrap_or_else(|err| panic!("{raw} should pass: {err}"));
            assert_eq!(url.scheme(), "http");
        }
    }

    #[test]
    fn non_loopback_or_non_http_urls_are_rejected() {
        for raw in [
            "https://127.0.0.1:3080",   // https 不允许（隧道是明文回环）
            "http://192.168.1.5:3080",  // 非回环
            "http://example.com",       // 公网域名
            "http://localhost:3080",    // 命不中 capability remote.urls，命令侧一并拒绝
            "http://[::1]:3080",        // 同上：与 127.0.0.1 精确对齐
            "file:///etc/passwd",       // 非 http scheme
            "not a url",                // 解析失败
            "",                         // 空
        ] {
            let err = validate_loopback_http_url(raw)
                .err()
                .unwrap_or_else(|| panic!("{raw:?} should be rejected"));
            assert!(
                err.starts_with("REMOTE_URL_INVALID:"),
                "error should carry the protocol prefix: {err}"
            );
        }
    }

    #[test]
    fn empty_machine_id_is_rejected_before_url_validation() {
        // 空白 machineId 直接拒绝（label 无法生成），错误前缀与窗口失败族一致
        let err = super::open_window_args("  ", "http://127.0.0.1:3080")
            .err()
            .expect("blank machineId should be rejected");
        assert!(err.starts_with("REMOTE_WINDOW_FAILED:"));
    }
}
