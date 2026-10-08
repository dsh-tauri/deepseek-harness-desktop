//! 浏览器/文件管理器唤起、日志捕获与健康检测。
//!
//! 对外部系统组件的交互：在系统浏览器打开链接、在文件管理器定位/打开目录与
//! 数据目录、复制服务地址到剪贴板；前端与后端日志的透传/读取/清空；以及通过
//! Rust 代理的服务健康检查与运行时环境诊断信息。

use crate::config;
use crate::logger;
use crate::service::{core, plugin, profile};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

/// 健康检查（通过 Rust 代理，避免 WebView CORS 问题）
#[tauri::command]
pub async fn proxy_health_check(app_handle: AppHandle) -> Result<String, String> {
    let port = config::get_store_dat_setting(&app_handle).port;
    crate::service::workflow::proxy_health_check(port).await
}

/// 就绪提交窗口的 ownership 复核：只读后端进程槽位与启动守卫，不发 HTTP。
///
/// 失败时返回与探测路径同一条 `HARNESS_NOT_OWNED` 信号，错误页据此识别进程退出。
#[tauri::command]
pub fn harness_ownership() -> Result<(), String> {
    crate::service::workflow::recheck_ownership()
}

/// 运行时/版本/诊断信息（侧边栏展示）
#[tauri::command]
pub async fn get_runtime_info(app_handle: AppHandle) -> Result<config::RuntimeInfo, String> {
    let port = config::get_store_dat_setting(&app_handle).port;
    let mut info = config::runtime_info(&app_handle, port);
    info.dsh_version = core::active_version(&app_handle).or(info.dsh_version);
    Ok(info)
}

/// 在系统浏览器中打开 Harness 界面
#[tauri::command]
pub async fn open_in_browser(app_handle: AppHandle) -> Result<(), String> {
    let url = config::get_dsh_service_url(config::get_store_dat_setting(&app_handle).port);
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 复制 Harness 服务地址到剪贴板
///
/// 走 `bridge::clipboard::write_clipboard_text`（惰性短期 `arboard` 句柄），规避
/// Linux Wayland 合成器不支持 data-control 时 `tauri-plugin-clipboard-manager`
/// 单例剪贴板导致的崩溃/挂死（同「复制日志」）。
#[tauri::command]
pub async fn copy_service_url(app_handle: AppHandle) -> Result<(), String> {
    let url = config::get_dsh_service_url(config::get_store_dat_setting(&app_handle).port);
    crate::bridge::write_clipboard_text(url).await
}

/// 在系统文件管理器中定位指定文件（Session 日志下载完成后的"在文件夹中显示"）
#[tauri::command]
pub fn reveal_in_folder(app_handle: AppHandle, path: String) -> Result<(), String> {
    // 安全边界：只允许定位允许根目录（下载目录/数据目录/$DSH_HOME）内的文件，
    // 防止第三方插件通过 IPC 驱动宿主打开任意路径。
    if !crate::bridge::guard::is_allowed_path(&app_handle, std::path::Path::new(&path)) {
        return Err(format!("REVEAL_PATH_REJECTED: {path}"));
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| format!("REVEAL_FAILED: {e}"))
}

/// 在系统文件管理器中打开指定目录（核心版本「打开目录」按钮；目录用 open 而非
/// reveal——reveal 是定位父目录，open 是直接打开该目录本身）。
#[tauri::command]
pub fn open_dir(app_handle: AppHandle, path: String) -> Result<(), String> {
    // 安全边界同 reveal_in_folder：仅允许打开允许根目录内的目录
    if !crate::bridge::guard::is_allowed_path(&app_handle, std::path::Path::new(&path)) {
        return Err(format!("OPEN_DIR_REJECTED: {path}"));
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| format!("OPEN_DIR_FAILED: {e}"))
}

/// 在系统文件管理器中打开数据目录（官方 $DSH_HOME，即 ~/.dsh）
#[tauri::command]
pub async fn reveal_data_dir(app_handle: AppHandle) -> Result<(), String> {
    let dsh_home = config::get_dsh_data_path(&app_handle);
    // 目录可能尚未创建（全新安装），先建好再打开，避免资源管理器报路径不存在
    std::fs::create_dir_all(&dsh_home).map_err(|e| e.to_string())?;

    tauri_plugin_opener::open_path(&dsh_home, None::<&str>).map_err(|e| e.to_string())
}

/// 前端日志透传：前端 `console.*` 劫持经此命令落盘到 `desktop.frontdesk.log`
/// （与持有后端 + `dsh` target 的 `desktop.log` 分离），见 `logger/mod.rs`。
#[tauri::command]
pub fn log_frontend(level: String, target: String, message: String) {
    let lvl = logger::FrontendLevel::from_str(&level);
    logger::log_frontend(lvl, &target, &message);
}

/// 按字节上限取 `s` 的尾部，并在裁剪起点回退到 UTF-8 字符边界。
///
/// 日志必然包含中文/ANSI 等多字节字符，直接用
/// `&s[s.len() - max_bytes..]` 在起点落在字符中间时会 panic
/// （`byte index ... is not a char boundary`），此实现保证安全。
fn tail_bytes(s: &str, max_bytes: usize) -> &str {
    let start = s.len().saturating_sub(max_bytes);
    let mut i = start;
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    &s[i..]
}

/// 读取 dsh 服务日志
#[tauri::command]
pub async fn read_service_logs(
    app_handle: AppHandle,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let log_path = config::get_service_log_path(&app_handle);
    if !log_path.exists() {
        return Ok(String::new());
    }

    let content = std::fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let max_bytes = max_bytes.unwrap_or(64 * 1024);
    if content.len() <= max_bytes {
        Ok(content)
    } else {
        Ok(tail_bytes(&content, max_bytes).to_string())
    }
}

/// 清空 dsh 服务日志
#[tauri::command]
pub async fn clear_service_logs(app_handle: AppHandle) -> Result<(), String> {
    let log_path = config::get_service_log_path(&app_handle);
    std::fs::write(&log_path, "").map_err(|e| e.to_string())
}

/// 拼装「复制日志」的环境信息段（纯函数，便于单测锁定报障格式）。
///
/// 报障时最常缺的就是「当前档案」与「装了哪些插件、什么版本」：插件问题几乎都
/// 与档案内的插件组合相关，没有这两项只能反复向用户追问。因此这里在原有的
/// app/dsh/node/os 之外补 `profile` 与 `plugins` 两块。
///
/// `dsh_version` 缺失（核心未安装）时整行省略：`dsh: -` 会让用户误以为核心在
/// 但版本不明。插件为 0 时只留 `plugins: 0 installed` 一行：计数本身已说明没有插件，
/// 再补 `(none)` 反而与「读取失败」一样无法区分，徒增噪音。
fn format_env_info(
    app_version: &str,
    dsh_version: Option<&str>,
    node_version: &str,
    os: &str,
    arch: &str,
    profile: &str,
    plugins: &[String],
) -> String {
    let mut lines = vec![format!("app: {app_version}")];
    if let Some(version) = dsh_version {
        lines.push(format!("dsh: {version}"));
    }
    lines.push(format!("node: {node_version}"));
    lines.push(format!("os: {os} ({arch})"));
    lines.push(format!("profile: {profile}"));
    lines.push(format!("plugins: {} installed", plugins.len()));
    lines.extend(plugins.iter().map(|p| format!("  - {p}")));
    lines.join("\n")
}

/// 读取运行日志（DSH 服务日志 + 桌面端 Rust 运行日志），格式化为便于
/// 反馈/报障复制的纯文本块：`### 环境信息`、`### 服务日志`、`### 前台日志`
/// 与 `### 后台日志` 四段。
///
/// 服务日志来自 `logs/dsh-web.log`（debug 构建为 `logs/dsh-web.dev.log`）；
/// 运行日志来自 `logs/desktop.log`（桌面端自身 `logger::init` 每次启动落盘，
/// 见 logger/mod.rs）。前端 `console.*` 已在 logger 的文件层按 `target: "frontend"`
/// 跳过、不会写入 `desktop.log`（见 logger/mod.rs），因此「后台日志」取的是纯后端
/// `log::*`；仅对旧版本已落盘、尚未轮转掉的 `frontend:` 行做一次兜底剔除。据此把
/// 「运行日志」拆成：
/// - `### 前台日志`：取自前端独立文件 `logs/desktop.frontdesk.log`
///   （`logger::init` 单独落盘，见 logger/mod.rs），含壳层前端 `console.*` 与
///   注入脚本从 dsh iframe 转回的帧内 console/未捕获异常（标识 `[iframe]`，
///   见 desktop/frame_log.rs）；
/// - `### 后台日志`：取自 `logs/desktop.log`，剔除残余 `target: "frontend"` 行，
///   仅保留后端 `log::*`。
/// 每段取末尾最多 `MAX_LINES` 行（前端日志量大，仅取一半 `FRONTEND_MAX_LINES`），
/// 避免粘贴内容超出 GitHub issue 长度上限。
#[tauri::command]
pub async fn read_run_logs(app_handle: AppHandle) -> Result<String, String> {
    const MAX_LINES: usize = 100;
    // 前端日志量大，复制的行数减半（避免粘贴内容过长）；后端仍取满 MAX_LINES
    const FRONTEND_MAX_LINES: usize = MAX_LINES / 2;

    let base = config::get_base_dir(&app_handle);
    let service = config::get_service_log_path(&app_handle);
    let desktop = base.join("logs").join("desktop.log");
    let frontend = base.join("logs").join("desktop.frontdesk.log");

    // 环境信息：桌面端应用版本、dsh 发行版本、Node 版本、系统平台/架构，以及当前
    // 档案名与已安装插件列表，便于报障时快速定位环境差异。
    // 插件名取 npm 包名（profile `dependencies` 的依赖键），与 `dsh plugin <cmd> <id>`
    // 及插件面板一致；版本解析不出时只留包名，避免出现读起来像被截断的 `name@`。
    let dsh_version =
        core::active_version(&app_handle).or_else(|| config::get_dsh_version(&app_handle));
    let mut plugins = plugin::watch::list(&app_handle);
    // 稳定排序：插件面板按加载顺序展示，报障块按包名字典序，便于两次日志对比差异。
    // 必须在拼上 `@version` 之前排，否则 `foo@1` 会排到 `foo-bar@1` 之后。
    plugins.sort_by(|a, b| a.id.cmp(&b.id));
    let plugin_lines: Vec<String> = plugins
        .iter()
        .map(|p| {
            if p.version.is_empty() {
                p.id.clone()
            } else {
                format!("{}@{}", p.id, p.version)
            }
        })
        .collect();
    let app_version = app_handle.package_info().version.to_string();
    let env_text = format_env_info(
        &app_version,
        dsh_version.as_deref(),
        &config::get_active_node_version(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        &profile::active_profile(&app_handle),
        &plugin_lines,
    );

    let service_text = read_tail(&service, MAX_LINES, false);
    let frontend_text = read_tail(&frontend, FRONTEND_MAX_LINES, false);
    let backend_text = read_tail(&desktop, MAX_LINES, true);

    Ok(format!(
        "### 环境信息\n\n{}\n\n### 服务日志\n\n```\n{}\n```\n\n### 前台日志\n\n```\n{}\n```\n\n### 后台日志\n\n```\n{}\n```",
        env_text,
        service_text.trim_end(),
        frontend_text.trim_end(),
        backend_text.trim_end()
    ))
}

fn read_tail(path: &std::path::Path, max_lines: usize, filter_frontend: bool) -> String {
    if !path.exists() {
        return String::new();
    }
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = content
        .lines()
        .filter(|line| !filter_frontend || !is_frontend_log_line(line))
        .collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

fn is_frontend_log_line(line: &str) -> bool {
    const LEVELS: [&str; 5] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];
    let trimmed = line.trim_start();
    LEVELS
        .iter()
        .any(|lvl| trimmed.contains(&format!("{lvl} frontend:")))
}

/// 在系统浏览器中打开任意 http(s) 链接（更新说明 / 关于对话框仓库链接等）
#[tauri::command]
pub async fn open_external_url(app_handle: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(format!("EXTERNAL_URL_INVALID: {url}"));
    }
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::format_env_info;
    use super::is_frontend_log_line;
    use super::tail_bytes;

    #[test]
    fn log_tail_filters_frontend_before_selecting_last_lines() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("dsh-shell-log-tail-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("desktop.log");
        std::fs::write(
            &path,
            "INFO dsh: first\r\nINFO frontend: noisy\r\nWARN dsh: 中文\nINFO frontend: last\n",
        )
        .unwrap();
        assert_eq!(
            super::read_tail(&path, 2, true),
            "INFO dsh: first\nWARN dsh: 中文"
        );
        assert_eq!(
            super::read_tail(&path, 2, false),
            "WARN dsh: 中文\nINFO frontend: last"
        );
        assert_eq!(super::read_tail(&path, 0, true), "");
        assert_eq!(super::read_tail(&root.join("missing"), 100, false), "");
        assert_eq!(super::read_tail(&root, 100, true), "");
        std::fs::write(&path, [0xff]).unwrap();
        assert_eq!(super::read_tail(&path, 100, false), "");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn env_info_carries_profile_and_plugins() {
        let text = format_env_info(
            "0.19.0",
            Some("0.1.7-rc.2"),
            "24.19.0",
            "windows",
            "x86_64",
            "web",
            &[
                "dshmarket@0.22.1".to_string(),
                "@scope/tool@1.2.3".to_string(),
            ],
        );
        assert_eq!(
            text,
            "app: 0.19.0\ndsh: 0.1.7-rc.2\nnode: 24.19.0\nos: windows (x86_64)\nprofile: web\nplugins: 2 installed\n  - dshmarket@0.22.1\n  - @scope/tool@1.2.3"
        );
    }

    #[test]
    fn env_info_omits_dsh_line_when_version_unknown() {
        let text = format_env_info("0.19.0", None, "24.19.0", "linux", "aarch64", "tauri", &[]);
        assert_eq!(
            text,
            "app: 0.19.0\nnode: 24.19.0\nos: linux (aarch64)\nprofile: tauri\nplugins: 0 installed"
        );
        assert!(!text.contains("dsh:"));
    }

    #[test]
    fn env_info_empty_plugin_list_is_just_a_count() {
        let text = format_env_info(
            "1.0.0",
            Some("0.1.7"),
            "22.19.0",
            "macos",
            "aarch64",
            "web",
            &[],
        );
        // 计数行自身已表达「没有插件」，不再补 `(none)` 之类的占位行
        assert!(text.ends_with("plugins: 0 installed"));
        assert!(!text.contains("(none)"));
    }

    #[test]
    fn env_info_keeps_plugin_without_version_readable() {
        // 版本解析失败时只留包名，不能出现 `name@` 这种看起来被截断的形态
        let text = format_env_info(
            "1.0.0",
            Some("0.1.7"),
            "22.19.0",
            "windows",
            "x86_64",
            "web",
            &["dsh-broken".to_string()],
        );
        assert!(text.contains("plugins: 1"));
        assert!(text.contains("dsh-broken"));
        assert!(!text.contains("dsh-broken@"));
    }

    #[test]
    fn frontend_line_detected() {
        // tracing 文件层（desktop.log）与前端独立文件（desktop.frontdesk.log）两种时间戳格式都应命中
        assert!(is_frontend_log_line(
            "2024-06-01 12:00:00.123Z INFO frontend: [tag] message"
        ));
        assert!(is_frontend_log_line(
            "[2024-06-01 12:00:00.123Z] INFO frontend: message"
        ));
        assert!(is_frontend_log_line(
            "2024-06-01 12:00:00.123Z WARN frontend: something"
        ));
        assert!(is_frontend_log_line(
            "2024-06-01 12:00:00.123Z ERROR frontend: boom"
        ));
    }

    #[test]
    fn backend_line_not_detected() {
        // 后端（dsh 等 target）不应误判为前端；消息正文里出现 "frontend" 也不应命中
        assert!(!is_frontend_log_line(
            "2024-06-01 12:00:00.123Z INFO dsh: starting server"
        ));
        assert!(!is_frontend_log_line(
            "[2024-06-01 12:00:00.123Z] INFO dsh: emit to frontend: 3"
        ));
        assert!(!is_frontend_log_line(
            "2024-06-01 12:00:00.123Z DEBUG reqwest: GET /ping"
        ));
    }

    #[test]
    fn frontend_level_padding_and_extra_spaces() {
        // 级别可能带前导空格（`{:>5}` 或 tracing 层多空格），frontend 目标仍应命中
        assert!(is_frontend_log_line(
            "2024-06-01 12:00:00.123Z  INFO frontend: padded"
        ));
    }

    #[test]
    fn tail_bytes_keeps_ascii_within_limit() {
        assert_eq!(tail_bytes("hello world", 5), "world");
        // 起点已落在字符边界时原样截取
        assert_eq!(tail_bytes("abc", 2), "bc");
    }

    #[test]
    fn tail_bytes_advances_to_char_boundary() {
        // 截取起点落在 3 字节中文中间 → 回退到字符边界，不 panic 且结果 ≤ max_bytes
        assert_eq!(tail_bytes("中a", 2), "a");
        // 4 字节 emoji 同理（非边界前缀字节会连续回退）
        assert_eq!(tail_bytes("😀x", 3), "x");
        // 多字节 + 超限，回退后长度仍不超过 max_bytes
        assert_eq!(tail_bytes("中文abc", 3), "abc");
    }

    #[test]
    fn tail_bytes_shorter_than_limit_returns_whole() {
        assert_eq!(tail_bytes("中文", 10), "中文");
        assert_eq!(tail_bytes("", 10), "");
    }
}
