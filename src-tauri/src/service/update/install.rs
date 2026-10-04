//! 安装包下载、完整性校验与交付系统处理器打开。
//!
//! 下载源策略：先取 `expanded_assets` 页面的 SHA-256 摘要作为完整性凭据，再选择
//! 下载源——镜像兜底（ghfast.top）仅在已取得可信摘要时才可使用，否则宁可失败，
//! 防止第三方镜像投毒未被察觉；官方 GitHub 直连在摘要缺失时仍可按旧行为下载，
//! 下载后若有摘要则强制校验。

use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::config;
use crate::service::workflow;

use super::meta::{fetch_latest_release, LatestRelease};
use super::version::current_version;
use super::{DOWNLOAD_TIMEOUT_SECS, UPDATES_DIR};

/// 安装包目录（AppData/updates，不存在则创建）
fn updates_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("UPDATE_DIR: {e}"))?
        .join(UPDATES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("UPDATE_DIR: {e}"))?;
    Ok(dir)
}

/// 安装包存放路径（AppData/updates/<asset_name>）
fn installer_path(app_handle: &AppHandle, asset_name: &str) -> Result<PathBuf, String> {
    Ok(updates_dir(app_handle)?.join(asset_name))
}

/// 检查是否有桌面端新版本。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateInfo {
    /// 最新可用版本号（无 `v` 前缀）
    pub version: String,
    /// 当前已安装版本号（无 `v` 前缀）
    pub current_version: String,
    pub tag: String,
    pub published_at: String,
    pub url: String,
    pub asset_name: String,
    pub path: String,
    pub downloaded: bool,
}

/// 检查是否有新版本可用（含安装包是否已下载）
pub async fn check(app_handle: &AppHandle) -> Result<Option<DesktopUpdateInfo>, String> {
    match fetch_latest_release(app_handle).await? {
        None => Ok(None),
        Some(r) => {
            let path = installer_path(app_handle, &r.asset_name)?;
            let downloaded = path.exists();
            Ok(Some(DesktopUpdateInfo {
                version: r.version,
                current_version: current_version(),
                tag: r.tag,
                published_at: r.published_at,
                url: r.url,
                asset_name: r.asset_name,
                path: path.to_string_lossy().into_owned(),
                downloaded,
            }))
        }
    }
}

/// 下载进度载荷（前端进度条展示）
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDownloadProgress {
    pub percentage: f64,
    pub downloaded: u64,
    pub total: u64,
    /// 附加提示（如切换下载源），无提示时为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 从单个下载源流式下载安装包到临时文件；失败时清理半成品（避免残留
/// 部分字节被误判为「已下载」）。
async fn download_from_source(
    client: &reqwest::Client,
    url: &str,
    tmp: &std::path::Path,
    app_handle: &AppHandle,
) -> Result<(), String> {
    log::info!("Downloading desktop installer from {}", url);
    let res = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;

    let total = res.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(tmp).map_err(|e| format!("UPDATE_FILE: {e}"))?;
    use std::io::Write;
    let mut downloaded: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("UPDATE_DOWNLOAD: {e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("UPDATE_FILE: {e}"))?;
        downloaded += chunk.len() as u64;
        let pct = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };
        let _ = app_handle.emit(
            "desktop-update-progress",
            DesktopDownloadProgress {
                percentage: pct,
                downloaded,
                total,
                message: None,
            },
        );
    }
    drop(file);
    Ok(())
}

/// 安装包下载客户端：长超时（安装包可达数百 MB，慢镜像需要更久），
/// 与检查更新用的 5s `http_client()` 区分。
fn download_client(app_handle: &AppHandle) -> Result<reqwest::Client, String> {
    config::proxy::http_client_builder(app_handle)?
        .user_agent("deepseek-harness-desktop")
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("UPDATE_CLIENT: {e}"))
}

/// 组装安装包下载源列表：官方 GitHub 直连 + （存在可信摘要时）ghfast.top 镜像。
///
/// 安全策略：第三方镜像没有独立信任根，仅在其内容可被 SHA-256 校验（摘要已取得）
/// 时才提供兜底；否则只允许官方直连，宁可在官方不可用时失败，也不冒投毒风险。
fn download_sources(release: &LatestRelease) -> Vec<String> {
    let mut urls = vec![release.url.clone()];
    if release.digest.is_some() {
        urls.push(config::mirror_download_url(&release.url));
    }
    urls
}

/// 为下载完成的安装包补充可执行权限（Linux AppImage 必需）。
///
/// 下载时 `File::create` 默认生成 `0644`，AppImage 经 `xdg-open` / 直接执行时
/// 需要可执行位，否则表现为「下载成功但无法打开安装包」（issue #79）。这里
/// 在安装包落到最终路径后再补充 `0755`，Linux 上天然生效；macOS 一并设置
/// 无害；Windows 无此概念，忽略。
#[cfg(unix)]
fn ensure_installer_executable(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)
        .map_err(|e| format!("UPDATE_FILE: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).map_err(|e| format!("UPDATE_FILE: {e}"))?;
    Ok(())
}

/// 流式校验安装包文件的 SHA-256。
///
/// 安装包可达数百 MB，先 `std::fs::read` 整块读进内存再校验会翻倍占用内存；
/// 这里按块流式喂给 `Sha256`，完成时仅保留 32 字节摘要。摘要格式接受
/// `sha256:<64hex>` 或裸 `<64hex>`（统一转小写比较）。
fn verify_installer_sha256(path: &std::path::Path, expected: &str) -> Result<(), String> {
    use sha2::Digest;
    use std::io::Read;
    let expected = expected
        .strip_prefix("sha256:")
        .unwrap_or(expected)
        .trim()
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("INTEGRITY_METADATA_INVALID: expected SHA-256 is invalid".to_string());
    }
    let mut file = std::fs::File::open(path).map_err(|e| format!("UPDATE_FILE: {e}"))?;
    let mut hasher = sha2::Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("UPDATE_FILE: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(format!(
            "INTEGRITY_CHECK_FAILED: SHA-256 mismatch, expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

/// 下载桌面端安装包；已下载则直接返回。
///
/// 下载期间通过 `desktop-update-progress` 事件推送进度；完成后返回
/// `DesktopUpdateInfo`（path/downloaded 已更新）。
///
/// 下载源策略：先取 `expanded_assets` 页面的 SHA-256 摘要作为完整性凭据，再
/// 选择下载源——**镜像兜底（ghfast.top）仅在已取得可信摘要时才可使用**，否则
/// 宁可失败，防止第三方镜像投毒未被察觉；官方 GitHub 直连在摘要缺失时仍可
/// 按旧行为下载（兼容早期未填摘要的发布），下载后若有摘要则强制校验。
pub async fn download(app_handle: &AppHandle) -> Result<DesktopUpdateInfo, String> {
    let release = fetch_latest_release(app_handle)
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())?;
    let path = installer_path(app_handle, &release.asset_name)?;

    if path.exists() {
        log::info!("Installer already downloaded: {}", path.display());
        // 已落盘的安装包同样登记为「待安装」：覆盖「上一轮下载后 store 标记丢失」
        // （store 被手工清理/旧版本尚无此标记）的场景，保证退出时仍会自动更新。
        super::pending::set(app_handle, Some((path.as_path(), &release.version)));
        return check(app_handle)
            .await?
            .ok_or_else(|| "UPDATE_NONE".to_string());
    }

    let client = download_client(app_handle)?;

    // 官方直连 → （可选）ghfast.top 镜像兜底。安装包无 SHA-256 元数据，切换源时
    // 丢弃上一源的部分字节从头下载，避免混用两个源的字节流。
    // 安全策略：镜像兜底要求已有可信摘要，否则不提供镜像（宁可失败）。
    let urls = download_sources(&release);
    if urls.len() == 1 {
        log::warn!(
            "No SHA-256 digest available for {}, mirror fallback disabled",
            release.asset_name
        );
    }
    let tmp = path.with_extension("part");
    let mut last_err = String::new();
    for (index, url) in urls.iter().enumerate() {
        if index > 0 {
            // 走镜像仅在存在可信摘要时发生（见上方 urls 组装）
            let host = reqwest::Url::parse(url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| url.clone());
            log::warn!(
                "Primary desktop update source failed, switching to fallback: {}",
                url
            );
            let _ = app_handle.emit(
                "desktop-update-progress",
                DesktopDownloadProgress {
                    percentage: 0.0,
                    downloaded: 0,
                    total: 0,
                    message: Some(format!("主下载源不可用，已切换镜像源重试（{host}）")),
                },
            );
        }
        // 先写临时文件再原子改名，避免下载中断残留半成品被误判为「已下载」
        let _ = std::fs::remove_file(&tmp);
        match download_from_source(&client, url, &tmp, app_handle).await {
            Ok(()) => {
                last_err.clear();
                break;
            }
            Err(e) => last_err = e,
        }
    }
    if !last_err.is_empty() {
        return Err(format!(
            "UPDATE_DOWNLOAD: {last_err}（已尝试 {} 个下载源）",
            urls.len()
        ));
    }

    // 完整性校验：摘要存在（镜像路径必有）则强制校验，校验失败即拒绝，
    // 不保留为可安装文件，也不能被 open_installer 打开。流式校验避免整块读入内存。
    if let Some(digest) = &release.digest {
        if let Err(e) = verify_installer_sha256(&tmp, digest) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("UPDATE_DOWNLOAD: {e}"));
        }
        log::info!("Installer SHA-256 verified for {}", release.asset_name);
    }

    std::fs::rename(&tmp, &path).map_err(|e| format!("UPDATE_FILE: {e}"))?;

    // Linux 下为安装包补充可执行位（AppImage 需要），否则会「下载成功但无法打开」
    #[cfg(unix)]
    ensure_installer_executable(&path)?;

    // 登记「待安装」：用户若没在对话框里立刻安装，关闭桌面端时会自动打开安装器
    // （见 pending::launch_pending_installer）；真正打开安装包后清除该标记。
    super::pending::set(app_handle, Some((path.as_path(), &release.version)));

    check(app_handle)
        .await?
        .ok_or_else(|| "UPDATE_NONE".to_string())
}

/// 校验已规范化的安装包路径确实位于 updates 目录内（防 `..`、符号链接、路径穿越）。
///
/// 拆成纯函数便于单测：路径判定是安全边界，必须能在不进文件系统/不起 Tauri 的
/// 情况下断言（见 tests）。
fn ensure_within_updates_dir(
    canonical: &std::path::Path,
    updates_real: &std::path::Path,
) -> Result<(), String> {
    // `Path::starts_with` 只按组件前缀比较、不做归一化：`updates/../evil.exe` 会被
    // 判为位于 `updates` 下。调用方已 canonicalize（不含 `..`），这里再显式拒绝
    // `..` 组件，避免将来有人拿未归一的路径调用它而绕过目录边界。
    let has_parent_dir = canonical
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir));
    if has_parent_dir || !canonical.starts_with(updates_real) {
        log::error!(
            "Rejecting installer outside updates dir: {} (root {})",
            canonical.display(),
            updates_real.display()
        );
        return Err(
            "UPDATE_PATH_REJECTED: installer path is outside updates directory".to_string(),
        );
    }
    Ok(())
}

/// 校验安装包路径：必须是 `AppData/updates/` 目录内的真实文件，并返回其规范化路径。
///
/// 安全边界：任意路径、绝对/相对遍历、`..`、指向目录外的符号链接都会拒绝，
/// 避免被伪装的 frame 或插件利用去执行任意文件。
fn resolve_installer_path(app_handle: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let updates_dir = updates_dir(app_handle)?;
    let p = std::path::Path::new(path);
    if !p.exists() || !p.is_file() {
        return Err(format!("UPDATE_NOT_FOUND: {path}"));
    }
    // 规范化后必须仍在 updates 目录内。用 `dunce::canonicalize`（std
    // `fs::canonicalize`）——它返回的路径不带 Windows `\\?\` verbatim 前缀，
    // `starts_with` 与日志展示更一致。
    let canonical = dunce::canonicalize(p).map_err(|e| format!("UPDATE_OPEN: {e}"))?;
    let updates_real = dunce::canonicalize(&updates_dir).map_err(|e| format!("UPDATE_DIR: {e}"))?;
    ensure_within_updates_dir(&canonical, &updates_real)?;
    Ok(canonical)
}

/// 是否为 AppImage 安装包（Linux 便携格式，自带运行时可执行）。
#[cfg(target_os = "linux")]
fn is_appimage(path: &std::path::Path) -> bool {
    path.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("AppImage"))
}

/// 安装包对应的 MIME 类型（用于解析桌面默认处理器），只认 /deb/rpm。
#[cfg(target_os = "linux")]
fn installer_mime(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "deb" => Some("application/vnd.debian.binary-package"),
        "rpm" => Some("application/x-rpm"),
        _ => None,
    }
}

/// 桌面条目的下探层数上限（id 是相对 `applications/` 的路径，理论上可嵌套任意层，
/// 实际发行版最多到 `vendor/` 一级，留 4 层足够且不会无界遍历）。
#[cfg(target_os = "linux")]
const MAX_DESKTOP_ENTRY_DEPTH: usize = 4;

/// 桌面条目搜索目录：`$XDG_DATA_HOME/applications` + `$XDG_DATA_DIRS/applications`。
///
/// 纯函数（环境值由调用方传入），空串按 XDG 规范等同未设置：`XDG_DATA_HOME` 空
/// 则退回 `$HOME/.local/share`，`XDG_DATA_DIRS` 空则退回
/// `/usr/local/share:/usr/share`，否则会把系统 applications 目录整个漏掉。
#[cfg(target_os = "linux")]
fn applications_dirs_from(
    data_home: Option<&std::ffi::OsStr>,
    data_dirs: Option<&std::ffi::OsStr>,
    home: Option<&std::ffi::OsStr>,
) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    match data_home.filter(|value| !value.is_empty()) {
        Some(dir) => roots.push(PathBuf::from(dir)),
        None => {
            if let Some(home) = home.filter(|value| !value.is_empty()) {
                roots.push(PathBuf::from(home).join(".local/share"));
            }
        }
    }
    let data_dirs = data_dirs
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".to_string());
    roots.extend(
        data_dirs
            .split(':')
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from),
    );
    roots
        .into_iter()
        .map(|dir| dir.join("applications"))
        .collect()
}

/// 当前进程环境下的桌面条目搜索目录。
#[cfg(target_os = "linux")]
fn applications_dirs() -> Vec<PathBuf> {
    applications_dirs_from(
        std::env::var_os("XDG_DATA_HOME").as_deref(),
        std::env::var_os("XDG_DATA_DIRS").as_deref(),
        std::env::var_os("HOME").as_deref(),
    )
}

/// 按目录顺序查找桌面条目。
///
/// 桌面条目的 id 是相对 `applications/` 的路径把 `/` 换成 `-`（`foo/bar.desktop`
/// 的 id 是 `foo-bar.desktop`），所以要逐层下探并按推导出的 id 比对；同一 id 命中
/// 多个时先命中的层更浅，正合「浅路径优先」的规范约定。
#[cfg(target_os = "linux")]
fn find_desktop_entry(id: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    if id.contains('/') || id.contains("..") {
        return None;
    }
    dirs.iter().find_map(|dir| find_entry_in_dir(id, dir))
}

/// 在单个 applications 目录内按层序（浅层优先）查找指定 id 的条目。
#[cfg(target_os = "linux")]
fn find_entry_in_dir(id: &str, dir: &std::path::Path) -> Option<PathBuf> {
    let mut level = vec![(dir.to_path_buf(), String::new())];
    for _ in 0..MAX_DESKTOP_ENTRY_DEPTH {
        let mut next = Vec::new();
        for (current, prefix) in level {
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                else {
                    continue;
                };
                if path.is_dir() {
                    next.push((path, format!("{prefix}{name}-")));
                } else if format!("{prefix}{name}") == id {
                    return Some(path);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        level = next;
    }
    None
}

/// 当前 MIME 类型的默认处理器 id（`xdg-mime query default`）。
#[cfg(target_os = "linux")]
fn default_handler_id(mime: &str) -> Option<String> {
    let output = std::process::Command::new("xdg-mime")
        .args(["query", "default", mime])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!id.is_empty()).then_some(id)
}

/// 按空白切分 `Exec`，双引号成组、反斜杠转义。
///
/// 切分结果直接作为 argv 交给系统调用，不经 shell 二次解释，因此引号与转义
/// 只需还原为字面量。
#[cfg(target_os = "linux")]
fn split_exec(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

/// 解析 `.desktop` 的 `[Desktop Entry]` 段：返回 `Exec` 参数与是否需要终端。
///
/// 只认主段，`[Desktop Action …]` 等其它段里的 `Exec` 不参与（动作不是文件处理器）。
#[cfg(target_os = "linux")]
fn parse_desktop_entry(text: &str) -> Option<(Vec<String>, bool)> {
    let mut group = String::new();
    let mut exec = None;
    let mut terminal = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            group = line[1..line.len() - 1].to_string();
            continue;
        }
        if group != "Desktop Entry" {
            continue;
        }
        if let Some(value) = line.strip_prefix("Exec=") {
            exec = Some(split_exec(value));
        } else if let Some(value) = line.strip_prefix("Terminal=") {
            terminal = value.trim().eq_ignore_ascii_case("true");
        }
    }
    Some((exec?, terminal))
}

/// 展开 `Exec` 字段码：首个 `%f/%F/%u/%U` 换成安装包路径，其余字段码丢弃；
/// 完全不含文件码时按处理器惯例追加路径。
#[cfg(target_os = "linux")]
fn exec_with_file(tokens: &[String], file: &str) -> Vec<String> {
    let mut used = false;
    let mut command = Vec::with_capacity(tokens.len() + 1);
    for token in tokens {
        let mut expanded = String::new();
        let mut chars = token.chars();
        while let Some(ch) = chars.next() {
            if ch != '%' {
                expanded.push(ch);
                continue;
            }
            match chars.next() {
                Some('%') => expanded.push('%'),
                Some(code) if "fFuU".contains(code) => {
                    if !used {
                        expanded.push_str(file);
                        used = true;
                    }
                }
                Some(_) => {}
                None => expanded.push('%'),
            }
        }
        if !expanded.is_empty() {
            command.push(expanded);
        }
    }
    if !used {
        command.push(file.to_string());
    }
    command
}

/// 处理器程序是否真实存在且可执行（含 `/` 的按路径判断，裸名按 `PATH` 查找）。
///
/// 桌面条目可能指向已被卸载的程序（处理器卸了、条目还在），此时 `sh` 会以 127
/// 退出，而 spawn 本身是成功的——不先验一遍就会吞掉失败、让上层错过兜底。
#[cfg(target_os = "linux")]
fn resolves_to_executable(program: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let executable = |path: &std::path::Path| {
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    };
    if program.contains('/') {
        return executable(std::path::Path::new(program));
    }
    std::env::var_os("PATH").is_some_and(|paths| {
        std::env::split_paths(&paths).any(|dir| executable(&dir.join(program)))
    })
}

/// 由一个等待子进程的 shell 启动处理器：`/bin/sh -c '"$@"' sh <命令…>`。
///
/// 返回的句柄可丢弃：子进程独立存活，丢弃只表示本进程不再回收它。
#[cfg(target_os = "linux")]
fn spawn_waited_handler(command: &[String]) -> Result<std::process::Child, String> {
    let (program, args) = command
        .split_first()
        .ok_or_else(|| "UPDATE_OPEN: empty handler command".to_string())?;
    if !resolves_to_executable(program) {
        return Err(format!("UPDATE_OPEN: handler program not found: {program}"));
    }
    let mut child = std::process::Command::new("/bin/sh");
    child
        .arg("-c")
        .arg(r#""$@""#)
        .arg("sh")
        .arg(program)
        .args(args)
        .stdin(std::process::Stdio::null());
    child.spawn().map_err(|e| format!("UPDATE_OPEN: {e}"))
}

/// 用系统默认处理器打开安装包，并保证处理器始终有活着的父进程。
///
/// `xdg-open`（opener 插件底层 `open::that_detached` 的 double-fork + `setsid`）
/// 启动处理器后立即退出，处理器被 init 收养（`PPID=1`）；而处理器（GDebi 等）的
/// 安装按钮会 `exec` `pkexec`，pkexec 在 `getppid()==1` 时拒绝运行，表现为
/// 「点了安装、窗口直接消失、什么都没装上」（issue #865）。这里自行解析默认
/// 处理器的 `Exec` 并交由一个等待子进程的 shell 启动：「对话框立即更新」路径下
/// 该 shell 是本进程的子进程，「退出时自动打开」路径下它被 init 收养但仍在等待，
/// 两条路径下处理器的父进程都活着，提权因此可用。
#[cfg(target_os = "linux")]
fn open_with_system_handler(file: &std::path::Path) -> Result<(), String> {
    let mime = installer_mime(file)
        .ok_or_else(|| "UPDATE_OPEN: unsupported installer type".to_string())?;
    let id =
        default_handler_id(mime).ok_or_else(|| "UPDATE_OPEN: no default handler".to_string())?;
    let entry = find_desktop_entry(&id, &applications_dirs())
        .ok_or_else(|| format!("UPDATE_OPEN: desktop entry not found: {id}"))?;
    let text = std::fs::read_to_string(&entry).map_err(|e| format!("UPDATE_OPEN: {e}"))?;
    let (exec, terminal) = parse_desktop_entry(&text)
        .ok_or_else(|| format!("UPDATE_OPEN: no Exec in {}", entry.display()))?;
    if terminal {
        return Err(format!("UPDATE_OPEN: handler needs a terminal: {id}"));
    }
    let command = exec_with_file(&exec, &file.to_string_lossy());
    spawn_waited_handler(&command).map(|_| ())
}

/// 校验安装包并交给系统默认处理器打开（不停服务、不动「待安装」标记）。
///
/// **调用方必须先停 Harness**（见 [`stop_for_installer`](crate::service::workflow::stop_for_installer)）：
/// 安装器会强杀桌面端进程，桌面端先消失就没人回收 Harness 子进程，它变成孤儿继续
/// 占用配置端口，更新后的新实例会撞上 EADDRINUSE。两条调用路径各自完成停服：
/// 「对话框立即更新」用 async 的 `workflow::stop`（要更新状态），「退出时自动更新」
/// 用同步的 `stop_for_installer`（退出路径没有 async 运行时可用）。停止动作不放在
/// 这里，是为了让每条路径都能按自己的时序等待端口释放。
pub(super) fn open_installer_now(app_handle: &AppHandle, path: &str) -> Result<(), String> {
    let resolved = resolve_installer_path(app_handle, path)?;
    log::info!("Opening desktop installer: {}", resolved.display());
    // 兜底补充可执行权限：兼容老版本下载的 AppImage（0644）被打包用户留存，
    // 直接打开仍会失败；此处幂等修复后再交给系统处理器。
    #[cfg(unix)]
    ensure_installer_executable(&resolved)?;

    // Linux：AppImage 自带运行时，直接执行；xdg-open 依赖桌面注册的 MIME
    // 处理器，COSMIC 等未注册的环境会静默失败（open::that_detached 只检查
    // 进程是否 spawn 成功，看不到 xdg-open 的退出码）。
    #[cfg(target_os = "linux")]
    if is_appimage(&resolved) {
        std::process::Command::new(&resolved)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("UPDATE_OPEN: {e}"))?;
        return Ok(());
    }

    // .deb/.rpm 仍交给系统默认处理器（软件中心 / 包管理器），但由本进程启动，
    // 让处理器有活着的父进程，否则其提权按钮会被 pkexec 的孤儿检查拒绝
    // （issue #865）。处理器解析失败时退回 opener 的分离式交接：至少能打开。
    #[cfg(target_os = "linux")]
    match open_with_system_handler(&resolved) {
        Ok(()) => return Ok(()),
        Err(error) => log::warn!("UPDATE_OPEN: system handler launch failed: {error}"),
    }

    app_handle
        .opener()
        .open_path(resolved.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("UPDATE_OPEN: {e}"))
}

/// 打开安装包：交给系统默认处理器（Windows 会触发 UAC 执行安装器）。
pub async fn open_installer(app_handle: &AppHandle, path: String) -> Result<(), String> {
    // 更新前先停下本应用持有的 Harness 服务：安装器在安装时会强杀桌面端进程
    // （CheckIfAppIsRunning → taskkill），跳过正常退出路径的 stop_on_exit，导致
    // Harness 子进程变成孤儿继续占用配置端口。若此刻不提前停掉，更新后新实例
    // 启动会撞上 EADDRINUSE（旧 Harness 仍占着端口），表现为「更新后进不去」。
    // 提前停止 → 端口释放并清掉 .harness.pid 标记，更新后启动即可绑定原端口。
    // 仅在确有持有进程时才停（stop 在无持有进程时也会短暂等待端口释放，白耗
    // 约 0.8s）；停止失败只告警不阻断——它是避免端口冲突的辅助手段，打开失败
    // 另有 UPDATE_OPEN 的错误提示。
    if workflow::has_owned_process() {
        if let Err(e) = workflow::stop(app_handle.clone()).await {
            log::warn!("Failed to stop Harness before opening installer: {}", e);
        }
    }
    open_installer_now(app_handle, &path)?;
    // 安装包已交给系统 → 清除「待安装」标记，避免退出应用时重复拉起安装器。
    super::pending::set(app_handle, None);

    // Linux AppImage 安装包就是新版本本体，且与当前实例共用单实例 D-Bus 锁：
    // 当前实例不退出时，新进程会转发激活后立即退出（表现为「打开安装包」无效）。
    // 释放单实例名并退出，让已拉起的新版本接管；.deb/.rpm 由包管理器处理，
    // 无需结束当前实例。
    #[cfg(target_os = "linux")]
    if is_appimage(std::path::Path::new(&path)) {
        tauri_plugin_single_instance::destroy(app_handle);
        app_handle.exit(0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 下载后补充可执行位：下载默认 0644 的文件被修复为含可执行位（issue #79）。
    #[cfg(unix)]
    #[test]
    fn ensure_installer_executable_sets_exec_bit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("dsh-update-exec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("installer.AppImage");
        std::fs::write(&file, b"payload").unwrap();
        // 模拟下载默认权限 0644
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        ensure_installer_executable(&file).unwrap();
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o111,
            0o111,
            "应包含所有者/组/其他可执行位，mode={mode:o}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// AppImage 识别按扩展名匹配且大小写不敏感；其它安装包格式不受影响。
    #[cfg(target_os = "linux")]
    #[test]
    fn appimage_detection_is_extension_based() {
        use std::path::Path;
        assert!(is_appimage(Path::new(
            "/tmp/Deepseek.Harness.Desktop_0.13.0_amd64.AppImage"
        )));
        assert!(is_appimage(Path::new("/tmp/tool.appimage")));
        assert!(!is_appimage(Path::new(
            "/tmp/Deepseek.Harness.Desktop_0.13.0_amd64.deb"
        )));
        assert!(!is_appimage(Path::new(
            "/tmp/Deepseek.Harness.Desktop_0.13.0_x86_64.rpm"
        )));
        assert!(!is_appimage(Path::new("/tmp/AppImage")));
    }

    /// 镜像兜底策略回归：无摘要时只有官方源；有摘要时才加入镜像。
    #[test]
    fn download_sources_only_mirrors_with_digest() {
        let url = "https://github.com/x/y/releases/download/v0.7.4/x.dmg";
        let base = LatestRelease {
            version: "0.7.4".into(),
            tag: "v0.7.4".into(),
            published_at: String::new(),
            url: url.into(),
            asset_name: "x.dmg".into(),
            digest: None,
        };
        // 无摘要 → 仅官方直连
        let without = download_sources(&base);
        assert_eq!(without.len(), 1);
        assert_eq!(without[0], url);
        // 有摘要 → 官方 + 镜像
        let with_digest = LatestRelease {
            digest: Some(format!("sha256:{}", "b".repeat(64))),
            ..base.clone()
        };
        let sources = download_sources(&with_digest);
        assert_eq!(sources.len(), 2);
        assert!(
            sources[1].contains("ghfast.top"),
            "镜像应为 ghfast.top 前缀: {}",
            sources[1]
        );
        assert!(
            sources[1].ends_with("/releases/download/v0.7.4/x.dmg"),
            "镜像保留完整资产路径: {}",
            sources[1]
        );
    }

    /// 流式校验：正确的文件通过、错误的摘要拒绝，且不把整个文件读进内存。
    #[test]
    fn verify_installer_sha256_streams_and_rejects_mismatch() {
        use sha2::Digest;
        let dir = std::env::temp_dir().join(format!("dsh-update-hash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("installer.part");
        let content = b"deepseek-harness-desktop installer payload";
        std::fs::write(&file, content).unwrap();
        let real = format!("sha256:{:x}", sha2::Sha256::digest(content));
        // 正确摘要通过
        assert!(verify_installer_sha256(&file, &real).is_ok());
        // 裸 64hex（无 sha256: 前缀）也接受
        assert!(verify_installer_sha256(&file, real.trim_start_matches("sha256:")).is_ok());
        // 错误摘要拒绝
        let wrong = format!("sha256:{}", "0".repeat(64));
        assert!(verify_installer_sha256(&file, &wrong).is_err());
        // 非法摘要格式拒绝
        assert!(verify_installer_sha256(&file, "sha256:zz").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 安装包路径必须是 updates 目录内的文件：同前缀的兄弟目录、目录穿越都拒绝。
    /// 退出时自动打开安装器（pending）与对话框「打开安装包」共用这条判定。
    #[test]
    fn ensure_within_updates_dir_rejects_outside_paths() {
        let root = std::path::Path::new("root").join("updates");
        // 目录内 → 通过
        assert!(ensure_within_updates_dir(&root.join("app-setup.exe"), &root).is_ok());
        // 目录外的兄弟路径（前缀相同也不能放过：`updates-evil` 不是 `updates` 的子路径）
        assert!(ensure_within_updates_dir(&root.join("..").join("evil.exe"), &root).is_err());
        let sibling = std::path::Path::new("root")
            .join("updates-evil")
            .join("x.exe");
        assert!(ensure_within_updates_dir(&sibling, &root).is_err());
    }

    /// 安装包 MIME 只认 deb/rpm 且大小写不敏感，其它格式不参与处理器解析。
    #[cfg(target_os = "linux")]
    #[test]
    fn installer_mime_maps_deb_and_rpm_only() {
        use std::path::Path;
        assert_eq!(
            installer_mime(Path::new("/tmp/App_0.21.0_amd64.deb")),
            Some("application/vnd.debian.binary-package")
        );
        assert_eq!(
            installer_mime(Path::new("/tmp/App_0.21.0_x86_64.RPM")),
            Some("application/x-rpm")
        );
        assert_eq!(installer_mime(Path::new("/tmp/App.AppImage")), None);
        assert_eq!(installer_mime(Path::new("/tmp/App")), None);
    }

    /// 桌面条目解析只取 [Desktop Entry] 段：引号参数成组，动作段的 Exec 不参与。
    #[cfg(target_os = "linux")]
    #[test]
    fn parse_desktop_entry_reads_main_group_only() {
        let text = "[Desktop Entry]\nType=Application\nTerminal=false\nExec=gdebi-gtk \"%f\" --flag\n\n[Desktop Action Other]\nExec=ignored %f\n";
        let (exec, terminal) = parse_desktop_entry(text).unwrap();
        assert_eq!(
            exec,
            vec![
                "gdebi-gtk".to_string(),
                "%f".to_string(),
                "--flag".to_string()
            ]
        );
        assert!(!terminal);
        let (_, terminal) =
            parse_desktop_entry("[Desktop Entry]\nExec=x\nTerminal=true\n").unwrap();
        assert!(terminal);
        assert!(parse_desktop_entry("[Desktop Entry]\nType=Application\n").is_none());
    }

    /// 字段码展开：首个文件码换成安装包路径、其余字段码丢弃、无文件码时追加路径。
    #[cfg(target_os = "linux")]
    #[test]
    fn exec_with_file_expands_field_codes() {
        fn tokens(list: &[&str]) -> Vec<String> {
            list.iter().map(|item| item.to_string()).collect()
        }
        assert_eq!(
            exec_with_file(&tokens(&["gdebi-gtk", "%f"]), "/tmp/a.deb"),
            tokens(&["gdebi-gtk", "/tmp/a.deb"])
        );
        assert_eq!(
            exec_with_file(&tokens(&["apt", "--file", "%F", "%i"]), "/tmp/a.deb"),
            tokens(&["apt", "--file", "/tmp/a.deb"])
        );
        assert_eq!(
            exec_with_file(&tokens(&["gdebi-gtk"]), "/tmp/a.deb"),
            tokens(&["gdebi-gtk", "/tmp/a.deb"])
        );
        assert_eq!(
            exec_with_file(&tokens(&["sh", "-c", "echo 100%%"]), "/tmp/a.deb"),
            tokens(&["sh", "-c", "echo 100%", "/tmp/a.deb"])
        );
    }

    /// 桌面条目查找按目录顺序命中第一个存在的文件，并拒绝带路径的 id。
    #[cfg(target_os = "linux")]
    #[test]
    fn find_desktop_entry_searches_dirs_in_order() {
        let dir = std::env::temp_dir().join(format!("dsh-desktop-entry-{}", std::process::id()));
        let empty = dir.join("empty");
        let hit = dir.join("hit");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&hit).unwrap();
        std::fs::write(
            hit.join("gdebi.desktop"),
            "[Desktop Entry]\nExec=gdebi-gtk %f\n",
        )
        .unwrap();
        assert_eq!(
            find_desktop_entry("gdebi.desktop", &[empty.clone(), hit.clone()]),
            Some(hit.join("gdebi.desktop"))
        );
        assert_eq!(
            find_desktop_entry("missing.desktop", &[empty, hit.clone()]),
            None
        );
        assert_eq!(find_desktop_entry("../gdebi.desktop", &[hit]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 嵌套条目的 id 是相对路径把 `/` 换成 `-`：`vendor/gdebi.desktop` 应答
    /// `vendor-gdebi.desktop`；同一 id 命中多个时浅层优先。
    #[cfg(target_os = "linux")]
    #[test]
    fn find_desktop_entry_derives_ids_for_nested_dirs() {
        let dir = std::env::temp_dir().join(format!("dsh-desktop-nested-{}", std::process::id()));
        let apps = dir.join("applications");
        std::fs::create_dir_all(apps.join("vendor")).unwrap();
        std::fs::create_dir_all(apps.join("vendor/deep")).unwrap();
        std::fs::write(apps.join("vendor/gdebi.desktop"), "nested").unwrap();
        std::fs::write(apps.join("vendor/deep/tool.desktop"), "deep").unwrap();
        std::fs::write(apps.join("flat-gdebi.desktop"), "flat").unwrap();

        assert_eq!(
            find_desktop_entry("vendor-gdebi.desktop", std::slice::from_ref(&apps)),
            Some(apps.join("vendor/gdebi.desktop"))
        );
        assert_eq!(
            find_desktop_entry("vendor-deep-tool.desktop", std::slice::from_ref(&apps)),
            Some(apps.join("vendor/deep/tool.desktop"))
        );
        assert_eq!(
            find_desktop_entry("flat-gdebi.desktop", std::slice::from_ref(&apps)),
            Some(apps.join("flat-gdebi.desktop")),
            "嵌套文件名本身不构成 id，只有推导出的 id 参与匹配"
        );
        assert_eq!(
            find_desktop_entry("gdebi.desktop", std::slice::from_ref(&apps)),
            None,
            "仅作为嵌套文件名的 gdebi.desktop 不属于顶层 id"
        );

        std::fs::write(apps.join("vendor-flat.desktop"), "shallow").unwrap();
        std::fs::write(apps.join("vendor/flat.desktop"), "deep").unwrap();
        assert_eq!(
            find_desktop_entry("vendor-flat.desktop", std::slice::from_ref(&apps)),
            Some(apps.join("vendor-flat.desktop")),
            "顶层与嵌套推出同一 id 时浅层优先"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// XDG 目录取值：空串按规范等同未设置，否则会把系统 applications 目录漏掉。
    #[cfg(target_os = "linux")]
    #[test]
    fn applications_dirs_treats_empty_xdg_values_as_unset() {
        use std::ffi::OsStr;
        let home = OsStr::new("/home/tester");
        let defaults = applications_dirs_from(None, None, Some(home));
        assert_eq!(
            defaults,
            vec![
                PathBuf::from("/home/tester/.local/share/applications"),
                PathBuf::from("/usr/local/share/applications"),
                PathBuf::from("/usr/share/applications"),
            ]
        );
        assert_eq!(
            applications_dirs_from(Some(OsStr::new("")), Some(OsStr::new("")), Some(home)),
            defaults,
            "空串应与未设置等价"
        );
        assert_eq!(
            applications_dirs_from(
                Some(OsStr::new("/opt/data")),
                Some(OsStr::new("/opt/a:/opt/b")),
                Some(home)
            ),
            vec![
                PathBuf::from("/opt/data/applications"),
                PathBuf::from("/opt/a/applications"),
                PathBuf::from("/opt/b/applications"),
            ]
        );
        assert_eq!(
            applications_dirs_from(None, None, None),
            vec![
                PathBuf::from("/usr/local/share/applications"),
                PathBuf::from("/usr/share/applications"),
            ],
            "无 HOME 时不应造出相对路径"
        );
    }

    /// 处理器必须始终有活着的父进程（issue #865）：由等待子进程的 shell 启动后，
    /// 处理器读到的 PPID 是那个 shell 且 shell 仍在运行；退回分离式启动
    /// （open::that_detached 的 double-fork + setsid）时处理器会被 init 收养、
    /// PPID=1，本用例即变红。
    #[cfg(target_os = "linux")]
    #[test]
    fn waited_handler_keeps_parent_alive() {
        let dir = std::env::temp_dir().join(format!("dsh-handler-ppid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ppid_file = dir.join("ppid.txt");
        let command = vec![
            "sh".to_string(),
            "-c".to_string(),
            format!("echo $PPID > {}; sleep 1", ppid_file.display()),
        ];
        let mut child = spawn_waited_handler(&command).unwrap();
        let mut recorded = None;
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(&ppid_file) {
                recorded = text.trim().parse::<u32>().ok();
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let parent = recorded.expect("处理器应写出自己的 PPID");
        assert_eq!(parent, child.id(), "处理器的父进程应是等待它的 shell");
        assert_ne!(parent, 1, "处理器不应被 init 收养");
        assert!(
            child.try_wait().unwrap().is_none(),
            "等待子进程的 shell 应在处理器运行期间存活"
        );
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 处理器程序缺失或不可执行时返回 Err，让 open_installer_now 走 opener 兜底，
    /// 而不是静默起一个必然失败的 shell（桌面条目可能指向已被卸载的处理器）。
    #[cfg(target_os = "linux")]
    #[test]
    fn missing_handler_program_is_rejected() {
        assert!(spawn_waited_handler(&[]).is_err());
        assert!(spawn_waited_handler(&["/nonexistent/gdebi-gtk".to_string()]).is_err());
        assert!(spawn_waited_handler(&["no-such-handler-9f3a".to_string()]).is_err());
        let dir = std::env::temp_dir().join(format!("dsh-handler-mode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plain = dir.join("plain-handler");
        std::fs::write(&plain, b"#!/bin/sh\n").unwrap();
        assert!(
            spawn_waited_handler(&[plain.to_string_lossy().into_owned()]).is_err(),
            "存在但无执行位的程序应被拒绝"
        );
        let mut child = spawn_waited_handler(&["/bin/true".to_string()]).unwrap();
        assert_eq!(child.wait().unwrap().code(), Some(0));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
