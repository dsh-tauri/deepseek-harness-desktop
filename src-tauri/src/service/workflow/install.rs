//! 安装环境（Node.js 运行时 + 打包的 Harness 发行版 + pnpm；Windows 缺失
//! 系统 Git 时再自动安装免安装 MinGit）。原 `workflow::install`。

use crate::config;
use crate::service::download;
use crate::service::download::Installable;
use tauri::Manager;

use super::process::{has_owned_process, stop, terminate_stale_harness_processes};

/// 安装环境（Node.js 运行时 + 打包的 Harness 发行版 + pnpm；Windows 缺失
/// 系统 Git 时再自动安装免安装 MinGit）。
///
/// 返回是否真正落盘更新了 Harness（dsh 任务实际下载并解压）；仅重装
/// Node/pnpm/Git 或全部任务被跳过时返回 false，供调用方决定是否重启页面。
pub async fn install(
    app_handle: &tauri::AppHandle,
    mut dsh_latest: Option<download::LatestDshPkg>,
) -> Result<bool, String> {
    log::info!("Starting installation process");
    // dsh 任务实际下载解压时置 true
    let mut dsh_updated = false;

    // 安装前先停止本应用持有的 Harness 服务：运行中的 node 进程会把
    // 原生模块 DLL（如 sharp 的 libvips-42.dll）加载进内存并锁住文件，
    // 不停止的话覆盖解压必然失败（Windows os error 32）。
    // 进程归属以启动时记录的 PID 为准，不根据端口结束未知程序。
    if has_owned_process() {
        log::info!("Stopping running Harness service before installation");
        stop(app_handle.clone()).await?;
    }
    // 只停本应用持有的进程还不够：历史崩溃/强杀残留的孤儿 Harness 实例
    // （不在 .harness.pid 标记中）同样从 dependencies/dsh 启动、占用目录文件
    // 句柄，会导致更新切换目录失败（INSTALL_BACKUP_FAILED, os error 32）。
    // 按命令行路径精确清扫所有本应用 dsh 安装目录启动的进程。
    // 枚举/结束涉及 powershell 枚举与 taskkill（同步阻塞），移出 Tokio 线程。
    {
        let handle = app_handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            terminate_stale_harness_processes(&handle);
        })
        .await
        .map_err(|e| format!("STOP_FAILED: {e}"))?;
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;
    log::debug!("Main window obtained");
    // 仅 Windows 会继续 push MinGit 任务（见下方 `#[cfg(windows)]`），
    // 异平台的 `mut` 因此多余，按平台放行。
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut tasks: Vec<Box<dyn download::Installable>> = vec![
        Box::new(download::Nodejs),
        Box::new(download::Dsh),
        Box::new(download::Pnpm),
    ];
    // 必须在下载前解析 release 元数据：下载地址和摘要必须属于同一固定 tag。
    // 若先下载 latest、再因 API 限流从 Atom/HTML 解析 tag，latest 在两次请求间
    // 发生切换就会把另一份资产拿来匹配摘要，最终触发 INTEGRITY_CHECK_FAILED。
    let dsh_missing = !download::Dsh.check_installed(app_handle);
    if dsh_latest.is_none() && dsh_missing {
        for attempt in 0..3 {
            let metadata = match config::recommended_dsh_version(app_handle) {
                Some(version) => download::fetch_dsh_pkg_version(&version).await,
                None => download::fetch_latest_dsh_pkg_info().await,
            };
            match metadata {
                Ok(info) => {
                    dsh_latest = Some(info);
                    break;
                }
                Err(e) if attempt < 2 => {
                    log::warn!(
                        "Retrying dsh release metadata fetch ({}/3), will retry: {}",
                        attempt + 1,
                        e
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(
                        500 * (attempt as u64 + 1),
                    ))
                    .await;
                }
                Err(e) => {
                    return Err(format!(
                        "DSH_INTEGRITY_UNAVAILABLE: 无法获取 Harness 发行版的完整性校验信息（{}），请检查网络后重试",
                        e
                    ));
                }
            }
        }
    }
    // Windows Sandbox 等空白环境没有 Git；仅 Windows 加入第 4 项，若系统 Git
    // 可真实执行则 Installable 会跳过，不重复下载也不修改系统 PATH。
    // 离线安装包不随包分发 MinGit，也不加入该任务：内网补装必然失败，只会把整个
    // 安装流程拖到超时（Git 依赖判定见 bridge::lifecycle::git_dependency_ready）。
    #[cfg(windows)]
    if !crate::config::is_offline_bundle(app_handle) {
        tasks.push(Box::new(download::Git));
    }
    // 每项均有下载/解压两个阶段，按实际平台任务数计算，避免进度提前到 100%。
    let mut tracker = download::ProgressTracker::new(&window, tasks.len() * 2);
    log::info!("Task list created, {} tasks total", tasks.len());

    for (index, task) in tasks.iter().enumerate() {
        let kind = task.kind();
        log::debug!("Processing task {}/{}", index + 1, tasks.len());
        // 已安装但版本/commit 与最新 release 不一致时强制重新下载。
        // 版本优先（与 resolve_update 的判定完全一致）：dsh 的 rc 发布会复用
        // 同一 git commit（record_commit 不变），只比 commit 会把 rc.8 之于
        // rc.7 误判为"已最新"而跳过下载——日志表现为"All installation tasks
        // completed"但实际什么都没下载，重启后仍是旧版，且前端丢掉更新提示。
        let outdated = kind == download::InstallKind::Dsh
            && dsh_latest.as_ref().is_some_and(|info| {
                let installed_version = config::get_dsh_version(app_handle);
                let latest_version = download::parse_version_from_tag(&info.tag);
                // 版本号可解析且不同 → 必须更新；版本不可解析时退回同一发布判定
                let version_differs =
                    match (installed_version.as_deref(), latest_version.as_deref()) {
                        (Some(a), Some(b)) => a != b,
                        _ => false,
                    };
                // 「同一发布」判定与 resolve_update 完全一致：记录 tag 与最新 tag
                // 相同、或记录 commit 与 release 的任一合法标识（完整 SHA / build-id）
                // 一致。限流期安装会把 build-id 写进记录，API 恢复后解析出的完整
                // SHA 与之不等但仍是同一 release，不能据此误判为过期而重下。
                version_differs
                    || !download::record_matches_latest_release(
                        config::get_dsh_pkg_commit(app_handle).as_deref(),
                        config::get_dsh_pkg_tag(app_handle).as_deref(),
                        info,
                    )
            });
        if task.check_installed(app_handle) && !outdated {
            log::debug!(
                "Task {} already installed and up to date, skipping",
                index + 1
            );
            tracker.skip_phases(2);
            continue;
        }

        log::info!("Task {} not installed, starting installation", index + 1);

        // 1. 下载
        tracker.start_phase(
            "download",
            &format!(
                "{} {}",
                config::i18n::t("install.downloading"),
                task.title()
            ),
        );
        // 下载 URL 对 dsh 也是完全确定可算的（DSH_CORE_URL + 平台文件名），
        // 无需依赖 GitHub API 元数据；api.github.com 限流/被代理拦截时
        // （mac 首次启动常见）仍能拿到真实下载地址，避免整次安装被瞬时失败卡死。
        // dsh 核心默认先走 GitHub 官方直连，失败自动切换 ghfast.top 镜像兜底
        // （下载层会在界面上告知用户）；其余任务保持单一官方源。
        let (urls, name) = if kind == download::InstallKind::Dsh {
            // 摘要与资产必须来自同一个 release。若前面已取得 release 元数据，
            // 必须使用其中的固定 asset URL；继续请求 `releases/latest` 会在 latest
            // 发布切换或 CDN 缓存不一致时下载另一份文件，最终表现为摘要 mismatch。
            let primary = dsh_latest
                .as_ref()
                .map(|info| info.asset_url.clone())
                .filter(|url| !url.is_empty())
                .unwrap_or(config::get_dsh_download_url()?);
            let name = primary.rsplit('/').next().unwrap_or("").to_string();
            let urls = vec![primary.clone(), config::mirror_download_url(&primary)];
            (urls, name)
        } else {
            let url = task.get_download_url()?;
            let name = url.rsplit('/').next().unwrap_or("").to_string();
            (vec![url], name)
        };
        // 取文件名用于解压类型判定；下载 URL 正常必含 '/'，但这里不 panic，
        // 防御性兜底为空串（后续 ensure_extract 会因无法判定类型而报错返回，
        // 不再让进程崩溃）。
        log::debug!("Download URL: {}", urls.join(" -> "));
        log::debug!("File name: {}", name);
        let buffer = download::download_file_from_sources(&tracker, urls).await?;
        log::info!("Download completed, file size: {} bytes", buffer.len());
        let expected_digest = match kind {
            download::InstallKind::Node => {
                download::fetch_node_sha256(task.get_download_url()?.as_str()).await?
            }
            download::InstallKind::Dsh => {
                // 元数据已在安装任务开始前获取，确保下载地址与摘要来自同一 release。
                dsh_latest
                    .as_ref()
                    .and_then(|info| info.digest.clone())
                    .ok_or_else(|| {
                        "DSH_INTEGRITY_UNAVAILABLE: trusted release digest is required".to_string()
                    })?
            }
            download::InstallKind::Pnpm => config::PNPM_SHA256.to_string(),
            #[cfg(windows)]
            download::InstallKind::Git => config::get_mingit_sha256()?.to_string(),
            #[cfg(not(windows))]
            download::InstallKind::Git => {
                return Err(
                    "INSTALL_TASK_INVALID: Git task not supported on this platform".to_string(),
                )
            }
        };
        download::verify_sha256(&buffer, &expected_digest)?;
        log::info!("Download integrity verified for task {}", index + 1);
        tracker.end_phase();

        // 2. 解压
        tracker.start_phase(
            "extract",
            &format!("{} {}", config::i18n::t("install.extracting"), task.title()),
        );
        let dest = task.get_install_path(app_handle);
        log::debug!("Installation path: {:?}", dest);
        download::ensure_extract(&tracker, name, buffer, dest).await?;
        log::info!("Extraction completed");
        tracker.end_phase();

        // 记录本次安装对应的 release tag 与 commit，供下次启动比对
        if kind == download::InstallKind::Dsh {
            dsh_updated = true;
            if let Some(info) = &dsh_latest {
                config::set_dsh_pkg_commit(app_handle, info.commit.clone());
                config::set_dsh_pkg_tag(app_handle, info.tag.clone());
            }
        }
    }

    log::info!("All installation tasks completed");
    tracker.update(
        100.0,
        config::i18n::t("install.done"),
        "All tasks completed".into(),
    );

    Ok(dsh_updated)
}
