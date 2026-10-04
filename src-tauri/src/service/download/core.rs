//! 文件下载（断点续传 + 多源回退）、SHA-256 完整性校验与原子解压落盘。
//! GitHub 发行版元数据与更新判定见 [`super::github`]。

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::service::download::ProgressTracker;
use tauri::{Manager, Runtime};

/// 下载文件到内存
///
/// # 参数
/// - `tracker`: 进度追踪器
/// - `url`: 要下载的文件 URL
///
/// # 返回
/// 成功返回文件内容 `Ok(Vec<u8>)`，失败返回错误信息
pub async fn download_file<'a, R: Runtime>(
    tracker: &'a ProgressTracker<'a, R>,
    url: String,
) -> Result<Vec<u8>, String> {
    download_file_from_sources(tracker, vec![url]).await
}

/// 按顺序依次尝试多个下载源（如 GitHub 官方直连 → ghfast.top 镜像兜底），
/// 某个源全部重试失败后自动切换下一个源，并通过 `tracker` 在界面上告知用户
/// 当前使用的下载源；全部源均失败时返回最后一个源的错误并注明尝试过的源数。
///
/// 每个源内部仍走 `download_with_retry` 的断点续传重试；切换源时保留已下载
/// 的字节续传（镜像透传同一文件，内容一致，且最终有 SHA-256 完整性校验兜底；
/// 服务端不支持 Range 时 `download_attempt` 会自动清空从头下载）。
pub async fn download_file_from_sources<'a, R: Runtime>(
    tracker: &'a ProgressTracker<'a, R>,
    urls: Vec<String>,
) -> Result<Vec<u8>, String> {
    if urls.is_empty() {
        return Err("DOWNLOAD_URL_EMPTY: no download source provided".to_string());
    }
    let mut last_err = String::new();
    for (index, url) in urls.iter().enumerate() {
        // 切换下载源时告知用户（detail 展示在进度面板，log 进入日志流）
        if index > 0 {
            let host = reqwest::Url::parse(url)
                .ok()
                .and_then(|parsed| parsed.host_str().map(|h| h.to_string()))
                .unwrap_or_else(|| url.clone());
            log::warn!(
                "Primary download source failed, switching to fallback source: {}",
                url
            );
            tracker.update(
                0.0,
                format!("主下载源不可用，已切换镜像源重试（{host}）"),
                format!("Switch to fallback download source: {url}"),
            );
        }
        match download_with_retry(tracker, url).await {
            Ok(buffer) => return Ok(buffer),
            Err(e) => last_err = e,
        }
    }
    Err(if urls.len() > 1 {
        format!("{last_err}（已尝试 {} 个下载源）", urls.len())
    } else {
        last_err
    })
}

/// 对单个 URL 执行断点续传重试，全部尝试失败返回中文可读错误。
async fn download_with_retry<'a, R: Runtime>(
    tracker: &'a ProgressTracker<'a, R>,
    url: &str,
) -> Result<Vec<u8>, String> {
    log::info!("Starting file download: {}", url);
    validate_download_url(url)?;

    // 只在整个下载开始时写一次 "Download <url>" 日志，之后进度由 detail/percentage
    // 驱动：同一 URL 若随每个 50ms 进度 tick 重复写入，日志面板会把同一文件刷成
    // 多条完全相同行（历史 issue：一个文件的下载任务却出现多条日志）。
    tracker.update(0.0, String::new(), format!("Download {}", url));

    // 创建具备 User-Agent 的客户端
    let client = crate::config::proxy::http_client_builder(tracker.window.app_handle())?
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (deepseek-harness-desktop)")
        .connect_timeout(std::time::Duration::from_secs(20))
        .read_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| {
            log::error!("Failed to create HTTP client: {}", e);
            e.to_string()
        })?;

    // GitHub CDN（objects/release-assets.githubusercontent.com）的大文件传输
    // 偶发中途断流（连接被重置、chunked body 提前结束，表现为"error decoding
    // response body"），这类瞬时错误重试通常即可成功。重试时带 Range 头从
    // 上次断点续传（CDN 支持 206），避免每次都从头下载 38MB。
    // 最多 MAX_DOWNLOAD_ATTEMPTS 次，失败退避递增（2s/4s/8s/8s）。
    const MAX_DOWNLOAD_ATTEMPTS: usize = 5;
    // buffer 由外层持有：每次尝试在已有字节基础上续传/追加，成功后整体返回
    let mut buffer: Vec<u8> = Vec::new();
    for attempt in 1..=MAX_DOWNLOAD_ATTEMPTS {
        if attempt > 1 {
            let delay = Duration::from_secs((1 << (attempt - 1)).min(8));
            log::warn!(
                "Download attempt {}/{} failed, retrying in {}s (resume from {} bytes)",
                attempt - 1,
                MAX_DOWNLOAD_ATTEMPTS,
                delay.as_secs(),
                buffer.len()
            );
            tokio::time::sleep(delay).await;
        }
        match download_attempt(
            &client,
            tracker,
            url,
            attempt,
            MAX_DOWNLOAD_ATTEMPTS,
            &mut buffer,
        )
        .await
        {
            Ok(()) => {
                log::info!("Download completed, {} bytes total", buffer.len());
                return Ok(buffer);
            }
            Err(e) => {
                log::warn!(
                    "Download attempt {}/{} failed: {}",
                    attempt,
                    MAX_DOWNLOAD_ATTEMPTS,
                    e
                );
            }
        }
    }
    // 全部尝试失败：只把可读的中文提示暴露给界面（原始传输错误保留在日志，
    // 避免 "error decoding response body" 这类底层信息直接糊在界面上）。
    Err(format!(
        "DOWNLOAD_INTERRUPTED: 下载中断（网络传输被重置），已自动重试 {MAX_DOWNLOAD_ATTEMPTS} 次仍失败，已下载约 {:.1} MB，请检查网络后重试",
        buffer.len() as f64 / 1_000_000.0
    ))
}

/// 下载进度百分比（0.0–100.0）；总长未知（0）时返回 -1 表示「不确定进度」，
/// 避免除零产生 +inf/NaN 污染前端进度条。
fn download_progress_percent(received_total: u64, total_size: u64) -> f64 {
    if total_size > 0 {
        (received_total as f64 / total_size as f64) * 100.0
    } else {
        -1.0
    }
}

/// 单次下载尝试：发起 GET 请求并把响应体流式读入 `buffer`。
///
/// 已有部分数据时自动带 `Range: bytes=<已有>-` 续传；服务端返回 200（不支持
/// Range）则清空从头下载。续传成功不代表整体完成——调用方必须比对摘要校验，
/// 任何中途断流都会以 Err 返回并触发外层重试。
async fn download_attempt<'a, R: Runtime>(
    client: &reqwest::Client,
    tracker: &'a ProgressTracker<'a, R>,
    url: &str,
    attempt: usize,
    max_attempts: usize,
    buffer: &mut Vec<u8>,
) -> Result<(), String> {
    let resume_from = buffer.len() as u64;
    log::debug!(
        "Download attempt {}/{}: {} (resume from {})",
        attempt,
        max_attempts,
        url,
        resume_from
    );

    let mut req = client.get(url);
    if resume_from > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={resume_from}-"));
    }
    let res = req.send().await.map_err(|e| {
        log::error!("Download request failed: {}", e);
        e.to_string()
    })?;
    validate_download_url(res.url().as_str())?;

    // 416 属防御分支：理论上不会发生（断流说明还没收完，resume_from 必然
    // 小于文件总长），若出现则清空 buffer 让下一次尝试从头下载，避免死循环。
    if res.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        log::warn!("Server returned 416 for range request, restarting from zero");
        buffer.clear();
        return Err(format!("Download failed: HTTP {}", res.status()));
    }
    if !res.status().is_success() {
        log::error!("Download failed with HTTP status: {}", res.status());
        return Err(format!("Download failed: HTTP {}", res.status()));
    }

    // 206 = 续传成功，保留已有字节只追加后续分片；200 = 服务端不支持 Range
    // （或首次下载），整体从头开始。
    let range_accepted = res.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if !range_accepted && resume_from > 0 {
        log::warn!("Server ignored Range request, restarting download from zero");
        buffer.clear();
    }

    // 进度按"已收字节 + 本次分片"计算；总长 = 断点偏移 + 本次 Content-Length
    let total_size = if range_accepted {
        resume_from + res.content_length().unwrap_or(0)
    } else {
        res.content_length().unwrap_or(0)
    };
    log::debug!("File size: {} bytes", total_size);
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            log::error!("Download stream read error: {}", e);
            e.to_string()
        })?;
        buffer.extend_from_slice(&chunk);
        let received_total = buffer.len() as u64;
        // 未知总长（服务器未给 Content-Length/分块传输）时进度取 -1，
        // 避免 `received / 0 = +inf` 或 NaN 进度传给前端
        let progress_pct = download_progress_percent(received_total, total_size);
        tracker.update(
            progress_pct,
            format!(
                "已下载 {:.1} MB / {:.1} MB",
                received_total as f64 / 1_000_000.0,
                total_size as f64 / 1_000_000.0
            ),
            // 进度阶段不再重复写 URL：仅由上面的 "Download <url>" 一行标识本次
            // 下载，避免随进度 tick 产生大量重复日志（前端对空 log 直接忽略）。
            String::new(),
        );
    }

    log::info!(
        "Download attempt {}/{} succeeded, {} bytes in buffer",
        attempt,
        max_attempts,
        buffer.len()
    );
    Ok(())
}

fn validate_download_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("DOWNLOAD_URL_INVALID: {e}"))?;
    let trusted_host = matches!(
        parsed.host_str(),
        Some(
            "nodejs.org"
                | "registry.npmjs.org"
                | "github.com"
                | "release-assets.githubusercontent.com"
                | "objects.githubusercontent.com"
                // 国内镜像：npmmirror 系列（node dist 会 302 到 cdn.npmmirror.com）
                // 与 ghfast.top 中转（GitHub Release 内容原样透传）
                | "npmmirror.com"
                | "cdn.npmmirror.com"
                | "registry.npmmirror.com"
                | "ghfast.top"
        )
    );
    if parsed.scheme() != "https" || !trusted_host {
        return Err(format!("DOWNLOAD_SOURCE_UNTRUSTED: {url}"));
    }
    Ok(())
}

/// 校验下载内容的 SHA-256，拒绝未通过完整性校验的运行时与核心包。
pub fn verify_sha256(buffer: &[u8], expected: &str) -> Result<(), String> {
    let expected = expected
        .strip_prefix("sha256:")
        .unwrap_or(expected)
        .trim()
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("INTEGRITY_METADATA_INVALID: expected SHA-256 is invalid".to_string());
    }
    let actual = format!("{:x}", Sha256::digest(buffer));
    if actual != expected {
        return Err(format!(
            "INTEGRITY_CHECK_FAILED: SHA-256 mismatch, expected {expected}, got {actual}"
        ));
    }
    Ok(())
}

/// 从 Node.js 官方同版本 SHASUMS256.txt 中读取当前平台包的摘要。
pub async fn fetch_node_sha256(app_handle: &tauri::AppHandle, download_url: &str) -> Result<String, String> {
    let (base, filename) = download_url.rsplit_once('/').ok_or_else(|| {
        "INTEGRITY_METADATA_INVALID: Node.js download URL has no filename".to_string()
    })?;
    let checksums_url = format!("{base}/SHASUMS256.txt");
    let checksums = crate::config::proxy::http_client_builder(app_handle)?
        .user_agent("deepseek-harness-desktop")
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("INTEGRITY_METADATA_FAILED: {e}"))?
        .get(&checksums_url)
        .send()
        .await
        .map_err(|e| format!("INTEGRITY_METADATA_FAILED: {e}"))?
        .error_for_status()
        .map_err(|e| format!("INTEGRITY_METADATA_FAILED: {e}"))?
        .text()
        .await
        .map_err(|e| format!("INTEGRITY_METADATA_FAILED: {e}"))?;

    checksums
        .lines()
        .filter_map(|line| line.split_once(char::is_whitespace))
        .find_map(|(digest, name)| {
            (name.trim_start_matches([' ', '*']) == filename).then(|| digest.to_string())
        })
        .ok_or_else(|| format!("INTEGRITY_METADATA_MISSING: no checksum for {filename}"))
}

/// 删除目录并等待 Windows 文件锁释放。
///
/// 结束 dsh/node 进程后，加载进内存的 DLL 句柄不会立即释放，删除目录可能
/// 短暂失败（os error 32）。这里轮询等待，最长约 10 秒。
///
/// # 性能
/// 锁等待期间用 `tokio::time::sleep` 让出异步运行时，而不是阻塞占用一个
/// Tokio worker：安装流程的进度事件与其它异步任务（健康检查、日志轮转）
/// 不会因一次长锁等待而被一并冻结。
pub(crate) async fn remove_dir_with_retry(dest: &Path) -> bool {
    const MAX_ATTEMPTS: u32 = 40;
    const RETRY_DELAY: Duration = Duration::from_millis(250);

    for attempt in 1..=MAX_ATTEMPTS {
        match fs::remove_dir_all(dest) {
            Ok(()) => return true,
            Err(e) => {
                if attempt < MAX_ATTEMPTS {
                    log::warn!(
                        "Failed to clean {:?} (attempt {}/{}), file may be locked: {}",
                        dest,
                        attempt,
                        MAX_ATTEMPTS,
                        e
                    );
                    tokio::time::sleep(RETRY_DELAY).await;
                } else {
                    log::error!(
                        "Failed to clean {:?} after {} attempts: {}",
                        dest,
                        MAX_ATTEMPTS,
                        e
                    );
                }
            }
        }
    }
    false
}

async fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        if remove_dir_with_retry(path).await {
            Ok(())
        } else {
            Err(format!(
                "INSTALL_PATH_LOCKED: cannot remove {}",
                path.display()
            ))
        }
    } else {
        fs::remove_file(path)
            .map_err(|e| format!("INSTALL_PATH_REMOVE_FAILED: {}: {e}", path.display()))
    }
}

/// 重试式重命名：等待 Windows 文件锁释放（os error 32 随进程句柄释放而消失）。
///
/// 结束 dsh/node 进程树后，子进程加载进内存的 DLL 句柄释放存在短暂滞后
/// （与 remove_dir_with_retry 相同的场景），紧跟其后的目录重命名可能一次失败。
/// 这里轮询重试，最长约 30 秒；除进程句柄外，Windows 杀毒/索引服务也可能
/// 在大规模解压后短暂持有目录句柄，10 秒窗口不足以等待其释放。
/// 重试仍失败才返回底层错误交由调用方映射。
pub(crate) async fn rename_with_retry(from: &Path, to: &Path) -> Result<(), std::io::Error> {
    const MAX_ATTEMPTS: u32 = 60;
    const RETRY_DELAY: Duration = Duration::from_millis(500);

    for attempt in 1..=MAX_ATTEMPTS {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < MAX_ATTEMPTS => {
                log::warn!(
                    "Rename {:?} -> {:?} failed (attempt {attempt}/{MAX_ATTEMPTS}), file may be locked: {e}",
                    from,
                    to
                );
                tokio::time::sleep(RETRY_DELAY).await;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!("rename_with_retry loop always returns")
}

/// 将已经完整解压并验证结构的临时目录切换为正式目录；切换失败时恢复旧版本。
async fn commit_staged_install(staging: &Path, dest: &Path, backup: &Path) -> Result<(), String> {
    // 上次若恰好在“旧目录改名为备份”后崩溃，先恢复旧版本再进行本次切换。
    if !dest.exists() && backup.exists() {
        rename_with_retry(backup, dest).await.map_err(|e| {
            format!(
                "INSTALL_RECOVERY_FAILED: {} -> {}: {e}",
                backup.display(),
                dest.display()
            )
        })?;
    }
    remove_path_if_exists(backup).await?;
    let had_previous = dest.exists();
    if had_previous {
        rename_with_retry(dest, backup).await.map_err(|e| {
            format!(
                "INSTALL_BACKUP_FAILED: {} -> {}: {e}",
                dest.display(),
                backup.display()
            )
        })?;
    }
    if let Err(e) = rename_with_retry(staging, dest).await {
        if had_previous {
            let _ = fs::rename(backup, dest);
        }
        return Err(format!(
            "INSTALL_COMMIT_FAILED: {} -> {}: {e}",
            staging.display(),
            dest.display()
        ));
    }
    if had_previous {
        if let Err(e) = remove_path_if_exists(backup).await {
            // 新版本已经切换成功，备份清理失败不应把成功安装误报为失败。
            log::warn!("Failed to remove previous installation backup: {e}");
        }
    }
    Ok(())
}

/// 确保解压文件到指定目录
///
/// # 参数
/// - `tracker`: 进度追踪器
/// - `name`: 文件名
/// - `buffer`: 压缩文件内容
/// - `dest`: 解压目标目录
///
/// # 返回
/// 成功返回 `Ok(())`，失败返回错误信息
pub async fn ensure_extract<'a, R: Runtime>(
    tracker: &'a ProgressTracker<'a, R>,
    name: String,
    buffer: Vec<u8>,
    dest: PathBuf,
) -> Result<(), String> {
    log::info!("Starting file extraction: {} -> {:?}", name, dest);
    use super::extractor::{extract_tgz, extract_zip};
    use super::utils::flatten_directory;

    // 始终先落到同盘临时路径，全部成功后再原子切换，避免更新失败破坏旧版本。
    let parent = dest.parent().unwrap_or(Path::new("."));
    let leaf = dest
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("package");
    let staging = parent.join(format!(".{leaf}.installing-{}", std::process::id()));
    let backup = parent.join(format!(".{leaf}.backup"));
    remove_path_if_exists(&staging).await?;

    // 判断文件类型
    let pure_name = name.split('?').next().unwrap_or(&name).to_lowercase();
    let is_tgz = pure_name.ends_with(".tar.gz") || pure_name.ends_with(".tgz");
    let is_zip = pure_name.ends_with(".zip");
    log::debug!("File type: tgz={}, zip={}", is_tgz, is_zip);

    // 目标是文件，跳过，直接写入文件
    if !is_tgz && !is_zip {
        log::debug!("Non-compressed file, writing directly");
        if let Some(parent) = staging.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                log::error!("Failed to create parent directory: {}", e);
                e.to_string()
            })?;
        }
        fs::write(&staging, &buffer).map_err(|e| {
            log::error!("Failed to write file: {}", e);
            e.to_string()
        })?;
        tracker.update(
            100.0,
            format!("已写入: {}", "100%"),
            format!("File written: {}", staging.display()),
        );
        commit_staged_install(&staging, &dest, &backup).await?;
        log::info!("File write completed: {}", dest.display());
        return Ok(());
    }

    fs::create_dir_all(&staging).map_err(|e| {
        log::error!("Failed to create destination directory: {}", e);
        e.to_string()
    })?;

    // 根据文件类型解压
    if is_tgz {
        log::debug!("Using tgz extractor");
        extract_tgz(tracker, &buffer, &staging)?;
    } else {
        log::debug!("Using zip extractor");
        extract_zip(tracker, &buffer, &staging)?;
    }

    // 处理解压后的"套娃"文件夹
    log::debug!("Flattening directory structure");
    flatten_directory(&staging).map_err(|e| {
        log::error!("Failed to flatten directory: {}", e);
        e.to_string()
    })?;

    // 权限修复与隔离属性移除 (仅限 Unix/macOS)
    #[cfg(unix)]
    {
        use super::utils::fix_recursive_permissions;
        // 递归赋予可执行权限 (755)
        log::debug!("Fixing file permissions");
        fix_recursive_permissions(&staging).map_err(|e| {
            log::error!("Failed to fix permissions: {}", e);
            format!("Failed to fix permissions: {}", e)
        })?;

        // macOS 移除 quarantine 属性
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            log::debug!("Removing macOS quarantine attribute");
            if let Some(path_str) = staging.to_str() {
                let _ = Command::new("xattr").args(["-cr", path_str]).output();
            }
        }
    }

    commit_staged_install(&staging, &dest, &backup).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_percent_never_emits_nan_or_inf() {
        // 总长已知：常规百分比
        assert_eq!(download_progress_percent(50, 100), 50.0);
        assert_eq!(download_progress_percent(0, 100), 0.0);
        // 总长未知（0）：返回 -1 而非 inf/NaN（除零保护）
        assert_eq!(download_progress_percent(50, 0), -1.0);
        // 尚未开始且总长未知也不产生 NaN
        assert_eq!(download_progress_percent(0, 0), -1.0);
        // 数值绝对不出现非有限值
        for pct in [
            download_progress_percent(50, 0),
            download_progress_percent(0, 0),
        ] {
            assert!(pct.is_finite(), "progress must be finite, got {pct}");
        }
    }

    #[test]
    fn sha256_verification_accepts_only_matching_digest() {
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(verify_sha256(b"abc", expected).is_ok());
        assert!(verify_sha256(b"changed", expected).is_err());
        assert!(verify_sha256(b"abc", "not-a-digest").is_err());
    }

    #[test]
    fn download_sources_are_https_and_allowlisted() {
        assert!(validate_download_url("https://nodejs.org/dist/v22/file.zip").is_ok());
        assert!(validate_download_url("https://registry.npmjs.org/pnpm/-/pnpm.tgz").is_ok());
        assert!(validate_download_url(
            "https://github.com/git-for-windows/git/releases/download/v2.53.0.windows.2/MinGit-2.53.0.2-64-bit.zip"
        )
        .is_ok());
        assert!(validate_download_url("http://nodejs.org/dist/file.zip").is_err());
        assert!(validate_download_url("https://example.com/file.zip").is_err());
        // 国内镜像源（含 npmmirror 302 后的最终落地域名）
        assert!(validate_download_url("https://npmmirror.com/mirrors/node/v22/file.zip").is_ok());
        assert!(
            validate_download_url("https://cdn.npmmirror.com/binaries/node/v22/file.zip").is_ok()
        );
        assert!(validate_download_url("https://registry.npmmirror.com/pnpm/-/pnpm.tgz").is_ok());
        assert!(validate_download_url(
            "https://ghfast.top/https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/latest/download/deepseek-harness-pkg-windows.zip"
        )
        .is_ok());
    }

    #[tokio::test]
    async fn staged_install_replaces_previous_version_and_cleans_backup() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("dsh-atomic-install-{unique}"));
        let dest = root.join("package");
        let staging = root.join("package.installing");
        let backup = root.join("package.backup");
        fs::create_dir_all(&dest).expect("create previous install");
        fs::create_dir_all(&staging).expect("create staged install");
        fs::write(dest.join("version.txt"), "old").expect("write previous version");
        fs::write(staging.join("version.txt"), "new").expect("write staged version");

        commit_staged_install(&staging, &dest, &backup)
            .await
            .expect("commit staged install");

        assert_eq!(fs::read_to_string(dest.join("version.txt")).unwrap(), "new");
        assert!(!staging.exists());
        assert!(!backup.exists());

        // 模拟上次切换在 dest -> backup 后崩溃，本次应先恢复再安全切换。
        fs::rename(&dest, &backup).expect("simulate interrupted switch");
        fs::create_dir_all(&staging).expect("create next staged install");
        fs::write(staging.join("version.txt"), "next").expect("write next version");
        commit_staged_install(&staging, &dest, &backup)
            .await
            .expect("recover and commit");
        assert_eq!(
            fs::read_to_string(dest.join("version.txt")).unwrap(),
            "next"
        );
        assert!(!backup.exists());
        fs::remove_dir_all(root).ok();
    }
}
