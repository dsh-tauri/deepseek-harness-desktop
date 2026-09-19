//! 依赖安装、自愈与 Harness 服务生命周期管理。
//!
//! 覆盖三块：依赖（Node.js / 打包 Harness / pnpm）的安装与「记录滞后」自愈、
//! Harness 服务进程的启停与状态查询，以及运行时三件套的就绪判断。

use std::sync::OnceLock;

use crate::config;
use crate::service::cli;
use crate::service::core;
use crate::service::download::{self, Installable};
use crate::service::workflow;
use tauri::AppHandle;

/// 并发安装互斥：状态位守卫进程的“是否正在安装”判断
/// （status::Status::Installing 会被失败路径/其它流程改写，不能作为互斥依据），
/// 改用独立的进程内互斥锁覆盖完整安装生命周期，避免两路并发 install 的
/// TOCTOU 与安装失败后状态卡死导致后续请求被静默跳过。
static INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// 返回当前实际选中的核心版本，不能直接读取固定预打包目录。
fn active_dsh_version(app_handle: &AppHandle) -> Option<String> {
    core::active_version(app_handle).or_else(|| config::get_dsh_version(app_handle))
}

/// 已安装版本高于推荐版本时保留现有核心，避免依赖自愈流程触发降级。
fn preserve_newer_installed_dsh(
    installed_version: Option<&str>,
    recommended_version: Option<&str>,
) -> bool {
    match (
        installed_version.and_then(|version| semver::Version::parse(version).ok()),
        recommended_version.and_then(|version| semver::Version::parse(version).ok()),
    ) {
        (Some(installed), Some(recommended)) => installed > recommended,
        _ => false,
    }
}

fn install_lock() -> &'static tokio::sync::Mutex<()> {
    INSTALL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// 离线安装包内置核心落位互斥：`runtime_ready` 与 `install_dependencies` 会在启动
/// 路径上先后调用，避免两路并发重建同一份链接层。
static BUNDLE_LINK_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// 把离线安装包随带的内置核心以零拷贝链接层落位到应用数据目录。
///
/// 幂等：普通安装包没有 `resources/bundle.json`，直接空转；离线包只在首次启动或
/// 安装包升级（内置核心版本变化）时真正重建。失败只告警不阻断——后续
/// `Installable::check_installed` 仍为 false，会走原有下载路径。
async fn materialize_bundled_core(app_handle: &AppHandle) {
    let lock = BUNDLE_LINK_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    let handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::service::bundle::materialize(&handle)
    })
    .await;
    match result {
        Ok(Ok(true)) => log::info!("bundled core link layer materialized"),
        Ok(Ok(false)) => {}
        Ok(Err(e)) => log::warn!("bundled core materialization failed: {e}"),
        Err(e) => log::warn!("bundled core materialization task failed: {e}"),
    }
}

/// Git 依赖是否已满足。
///
/// 离线安装包**不随包分发 MinGit**：内网环境补装必然失败，把 Git 判定为「已满足」
/// 以免用户卡在启动安装界面（`workflow::install` 对离线包也不再加入 Git 任务）。
/// git 托管的插件安装会在真正使用时给出明确失败，而不是让应用起不来。
fn git_dependency_ready(app_handle: &AppHandle) -> bool {
    config::git_runtime_ready(app_handle) || config::is_offline_bundle(app_handle)
}

/// 安装失败后把状态从 Installing 复位，避免后续调用被“正在安装”卡死。
/// 仅在失败路径调用；成功路径保持原有状态语义（由前端随后 launch 续接）。
fn reset_install_status(app_handle: &AppHandle) {
    workflow::status::set_status(workflow::status::Status::Stopped);
    workflow::status::emit_status(app_handle);
}

/// 按当前设置同步命令行集成（shim + PATH 注册）。
///
/// 安装/更新流程的收尾步骤，失败只记日志、不阻断主流程。
fn sync_cli_link(app_handle: &AppHandle) {
    let setting = config::get_store_dat_setting(app_handle);
    let result = if setting.cli_link_enabled {
        cli::ensure(app_handle)
    } else {
        cli::remove(app_handle)
    };
    if let Err(e) = result {
        log::warn!("cli link sync failed: {e}");
    }
}

/// 一键安装依赖（Node.js 运行时 + 打包的 Harness 发行版）
///
/// 返回是否真正执行了安装/更新：`true` 表示本次调用落盘了运行时（前端
/// 需重启服务以加载新版本），`false` 表示未发生任何安装（已是最新、记录
/// 自愈，或 GitHub 限流无法校验完整性而保持本地安装——此时前端不应重启、
/// 也不应丢弃“有新版本”提示，而应提示稍后重试）。
///
/// 启动逻辑由前端显式调用 `launch_harness` 完成，避免重复拉起进程。
#[tauri::command]
pub async fn install_dependencies(app_handle: AppHandle) -> Result<bool, String> {
    // 并发/重入防护：使用独立互斥锁而非依赖 Status::Installing——
    // 失败路径会复位状态，若用状态判断则一次失败后所有后续调用都会被
    // “Installation process already running” 静默跳过直到重启应用。
    let Ok(_install_guard) = install_lock().try_lock() else {
        log::info!("Installation process already running, skipping");
        return Ok(false);
    };

    // 离线安装包：先把内置核心以零拷贝链接层落位，再判定「已就绪」。命中后下面的
    // node/dsh/pnpm 检查全部为 true，启动路径不会产生任何下载。
    materialize_bundled_core(&app_handle).await;

    // 以实际安装状态为准：本地安装与 GitHub 最新 release 的 commit hash
    // 不一致时，说明上游 pkg 有更新/修复，需要自动重新下载。
    let node_ok = download::Nodejs.check_installed(&app_handle);
    let dsh_files_ok = download::Dsh.check_installed(&app_handle);
    // pnpm 是 dsh plugin 子命令的运行时依赖（v0.3.0 起随环境安装）；老版本
    // 升级后 `installed` 已为 true 会跳过环境安装，捆绑 pnpm 可能从未落盘，
    // 需一并纳入"已就绪"判定，缺失时由 workflow::install 按任务补齐。
    let pnpm_ok = download::Pnpm.check_installed(&app_handle);
    // Windows 空白环境还必须有可执行的 Git，才能安装 github:/git+ssh: 插件。
    // 非 Windows 与离线包返回 true，保持原有依赖集合不变（见 git_dependency_ready）。
    let git_ok = git_dependency_ready(&app_handle);

    // 启动自愈捷径：记录显示未安装、但运行时文件已全部在盘。常见于桌面端自更新
    // 安装器强杀进程，或上次启动时核心文件短暂缺失被 workflow::start 复位
    // `installed`（一旦复位，此后每次启动都会走进安装分支）。此时直接补记
    // installed 收尾：不做联网核对、绝不整包重下——联网核对可能把「记录滞后」
    // 误判为真更新，而重下整目录在 Windows 上极易破坏 node_modules（历史 issue：
    // 重解压后启动报找不到 @deepseek-ai/dsh-client-ui-settings）。真更新一律由
    // 启动后的 check_dsh_update 提示用户手动安装，启动路径不该自行下载。
    if node_ok && dsh_files_ok && pnpm_ok && git_ok {
        let setting = config::get_store_dat_setting(&app_handle);
        if !setting.installed {
            log::info!(
                "Runtime files already present although store says not installed, healing installed flag"
            );
            let mut setting = config::get_store_dat_setting(&app_handle);
            setting.installed = true;
            config::set_store_dat_setting(&app_handle, setting);
            sync_cli_link(&app_handle);
            return Ok(false);
        }
    }

    // 老版本升级后 installed 仍为 true，但可能缺少新版新增的 Windows Git 依赖。
    // 其余三项均就绪时直接走本地任务跳过 + Git 补装，不查询 Harness 最新版本，
    // 避免一次依赖自愈意外触发核心更新。
    if node_ok && dsh_files_ok && pnpm_ok && !git_ok {
        log::info!("Git dependency missing, provisioning bundled MinGit without core update check");
        workflow::status::set_status(workflow::status::Status::Installing);
        workflow::status::emit_status(&app_handle);
        if let Err(e) = workflow::install(&app_handle, None).await {
            log::error!("Git dependency installation failed, resetting status: {e}");
            reset_install_status(&app_handle);
            return Err(e);
        }
        sync_cli_link(&app_handle);
        return Ok(false);
    }

    // 安装目标遵循应用资源中的推荐版本，而不是 GitHub 的 latest。
    // latest 可能是 alpha/beta 等超出推荐范围的预览版；并且 `/releases/latest`
    // 不保证与推荐版本的摘要属于同一 release。按推荐 SemVer 反查固定 tag，后续
    // 资产 URL 与 digest 都从该 tag 获取。
    let recommended_version = config::recommended_dsh_version(&app_handle);
    let installed_version = dsh_files_ok
        .then(|| active_dsh_version(&app_handle))
        .flatten();
    let preserve_installed =
        preserve_newer_installed_dsh(installed_version.as_deref(), recommended_version.as_deref());
    let dsh_latest = if preserve_installed {
        log::info!(
            "Keeping installed dsh version above recommendation: {}",
            installed_version.as_deref().unwrap_or_default()
        );
        None
    } else {
        Some(match recommended_version {
            Some(version) => download::fetch_dsh_pkg_version(&version).await,
            None => download::fetch_latest_dsh_pkg_info().await,
        })
    };

    // 已安装文件在盘时，用 resolve_update 甄别「记录滞后」与「真更新」：
    // 记录滞后（HealUpToDate）只修正 store 记录、绝不整包重下。否则会把一个
    // 可用的 node_modules 整目录删除重解压，Windows 上原生模块 DLL 锁/重解压
    // 很容易留下破损安装，导致启动报找不到 @deepseek-ai/dsh-client-ui-settings
    // 或 HARNESS_NOT_FOUND。仅在真更新（UpdateAvailable）时才允许重新下载。
    let dsh_need_install = match dsh_latest.as_ref() {
        None => false,
        Some(Ok(latest)) if dsh_files_ok => {
            let record_commit = config::get_dsh_pkg_commit(&app_handle);
            let record_tag = config::get_dsh_pkg_tag(&app_handle);
            // 老记录没有 tag，反查 pkg 仓库 tags 列表确认记录对应的发布版本；
            // 反查失败时由 resolve_update 回退到“以实际文件为准”的保守分支
            let legacy_tags = if record_tag.is_none() {
                download::fetch_dsh_pkg_tags().await.unwrap_or_default()
            } else {
                Vec::new()
            };
            match download::resolve_update(
                record_commit.as_deref(),
                record_tag.as_deref(),
                installed_version.as_deref(),
                latest,
                &legacy_tags,
            ) {
                // 安装文件已是最新 release，只是记录滞后：修正记录后下次
                // 启动直接走 commit 快速比对，不再误判、也绝不整包重下
                download::UpdateCheck::UpToDate | download::UpdateCheck::HealUpToDate => {
                    if record_commit.as_deref() != Some(latest.commit.as_str()) {
                        log::info!(
                            "Installed Harness files already at latest release, healing stale record: {} ({})",
                            latest.tag,
                            latest.commit
                        );
                        config::set_dsh_pkg_commit(&app_handle, latest.commit.clone());
                        config::set_dsh_pkg_tag(&app_handle, latest.tag.clone());
                    }
                    false
                }
                download::UpdateCheck::UpdateAvailable => {
                    // 有新版但 GitHub API 限流拿不到可信源码摘要时，不自动整包重下
                    // （无法校验完整性，Windows 上重解压还易损坏 node_modules）。
                    // 保持本地安装，更新提示由启动后的 check_dsh_update 给出，稍后可重试。
                    if latest.digest.is_none() {
                        log::warn!(
                            "New dsh release {} found but trusted digest unavailable (API rate-limited), keeping local install",
                            latest.tag
                        );
                        false
                    } else {
                        true
                    }
                }
            }
        }
        // 核心文件缺失（首次安装或目录被清空）→ 需要安装
        Some(Ok(_)) => true,
        Some(Err(e)) => {
            // 网络不可用或 GitHub API 限流时保留本地安装，不阻塞启动
            log::warn!(
                "Failed to check latest dsh release info, keeping local install: {}",
                e
            );
            !dsh_files_ok
        }
    };

    if node_ok && !dsh_need_install && pnpm_ok && git_ok {
        log::info!("Dependencies already installed and up to date, skipping installation");
        let mut setting = config::get_store_dat_setting(&app_handle);
        if !setting.installed {
            setting.installed = true;
            config::set_store_dat_setting(&app_handle, setting);
        }
        sync_cli_link(&app_handle);
        return Ok(false);
    }

    log::info!("Dependencies missing or outdated, starting installation process");
    workflow::status::set_status(workflow::status::Status::Installing);
    workflow::status::emit_status(&app_handle);
    // 返回 dsh 是否真正落盘更新：仅重装 Node/pnpm 或全部任务被跳过（例如
    // 版本相同仅记录滞后）时为 false，前端据此决定是否重启页面/保留更新提示
    // 高于推荐版本的核心没有 release 元数据，因此仅补装 Node/pnpm 时不会被
    // workflow 当作过期并下载较旧核心。
    let install_target = dsh_latest.and_then(Result::ok);
    let updated = match workflow::install(&app_handle, install_target).await {
        Ok(updated) => updated,
        Err(e) => {
            // 安装失败把状态复位，避免后续 install_dependencies 命中
            // “正在安装”被静默跳过（否则必须重启应用才能重试）
            log::error!("Installation failed, resetting status: {e}");
            reset_install_status(&app_handle);
            return Err(e);
        }
    };
    log::debug!("Installation completed, marked as installed");
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.installed = true;
    config::set_store_dat_setting(&app_handle, setting);
    sync_cli_link(&app_handle);
    Ok(updated)
}

/// 静默检查是否有新版 Harness 可用（只查不装，供进入页面后后台调用）
///
/// 以“实际安装文件”为准核对，而不是只看本地记录：记录可能因安装时 API
/// 失败或外围途径更新而滞后于文件，此时修正记录并免打扰；同版本热修
/// （版本相同但 commit 不同）仍正常提示。
#[tauri::command]
pub async fn check_dsh_update(
    app_handle: AppHandle,
) -> Result<Option<download::LatestDshPkg>, String> {
    // 本地没有安装时无需提示更新
    let dsh_files_ok = download::Dsh.check_installed(&app_handle);
    if !dsh_files_ok {
        return Ok(None);
    }

    // 当前运行的是预览版时不提示稳定/RC 更新：预览版可能高于当前 release，
    // 但不能把用户主动选择的 alpha/beta 版本降级成较旧的 rc。
    if config::get_store_dat_setting(&app_handle)
        .active_core
        .as_deref()
        == Some("app")
        && config::get_dsh_pkg_tag(&app_handle)
            .as_deref()
            .is_some_and(download::is_preview_tag)
    {
        log::info!("Suppressing dsh update because a preview core is active");
        return Ok(None);
    }

    let latest = download::fetch_latest_dsh_pkg_info().await?;

    // 关键修复1：最新 release 的版本号已经在已装核心列表里（含 active 和非 active
    // 槽位），就不提示更新。避免「老版本激活 + 新版已下载但未切换」场景下白点一次
    // 「立即更新」做整包重下——版本号（用户视角的版本）已经在那了，没必要再拉一遍。
    if let Some(version) = download::parse_version_from_tag(&latest.tag) {
        if core::has_installed_version(&app_handle, &version).await {
            log::info!(
                "Suppressing dsh update toast because latest version is already installed: {}",
                version
            );
            return Ok(None);
        }
    }

    // 关键修复2：最新 release 高于推荐版本时（通常是 alpha/beta/preview 序号
    // 大于稳定 RC）不自动推。stable 用户不该被打扰去装 alpha 测试版；用户想追
    // preview 自行去核心面板下载。这条规则先于「installed 比 latest 低」检查，
    // 否则装了 0.1.1-rc.1 的用户会被弹 0.1.3-alpha.1 更新。
    if let Some(version) = download::parse_version_from_tag(&latest.tag) {
        if config::is_dsh_version_above_recommended(&app_handle, &version) {
            log::info!(
                "Suppressing dsh update toast because latest is above recommended (preview/alpha): {}",
                version
            );
            return Ok(None);
        }
    }

    Ok(Some(latest))
}

/// 启动 Harness 服务
#[tauri::command]
pub async fn launch_harness(app_handle: AppHandle) -> Result<(), String> {
    workflow::launch(app_handle).await
}

/// 停止 Harness 服务
#[tauri::command]
pub async fn shutdown_harness(app_handle: AppHandle) -> Result<(), String> {
    workflow::stop(app_handle).await
}

/// 重启 Harness 服务
#[tauri::command]
pub async fn restart_harness(app_handle: AppHandle) -> Result<(), String> {
    workflow::restart(app_handle).await
}

/// 进入安全模式：确保安全档案存在并切换为当前档案（不重启，由前端走标准重启链路）。
///
/// 错误界面「安全模式」按钮的入口：安全档案只含 web 模板核心 bundles、不带
/// 用户插件/补丁层，启动失败的插件（如 pending waiting for service）被隔离，
/// 应用先恢复可用；用户在档案列表切回原档案即退出安全模式。
///
/// 档案目录一旦存在就绝不重建，因此里面可能残留此前被装进去的用户插件（内置插件
/// 自愈与首次引导安装都作用于「当时的活动档案」）；这些插件由启动前的清除流程卸载
/// （见 `service::plugin::safe::purge_user_plugins_in_safe_profile`），本命令只负责
/// 切档案——服务仍在运行时删除插件目录不安全，必须等重启后的 spawn 之前再清。
///
/// 补丁层是这里唯一的例外：**home 层（`$DSH_HOME/cordis.patch.yml`）作用于所有
/// 档案**，安全档案也不例外，因此一处手写笔误（典型是 `!!js` 表达式含 `: ` 却没加
/// 引号）会让安全模式也起不来，把兜底入口一起废掉（issue #525）。这里在切档案前把
/// 解析不了的补丁文件改名为同名 `.broken-<时间戳>` 备份（只改名、不删除），保证
/// 「安全模式一定起得来」；记录回传前端提示备份路径，用户修好语法后改回原名即可恢复。
///
/// 改名失败（权限/占用）时**不切换档案层**并返回错误：损坏文件还在原地，重启只会
/// 再次解析失败，切过去等于把「安全模式」也变成失败循环。此时让用户先处理文件，
/// 而不是假装已恢复。
#[tauri::command]
pub async fn enter_safe_mode(
    app_handle: AppHandle,
) -> Result<crate::service::plugin::PatchQuarantineReport, String> {
    crate::service::profile::ensure_safe_profile(&app_handle)?;
    let report = crate::service::plugin::quarantine_patch_layers_in(
        &crate::service::profile::profile_dir_of(
            &app_handle,
            crate::service::profile::SAFE_PROFILE,
        ),
        &config::get_dsh_data_path(&app_handle),
    );
    if report.has_failures() {
        return Err(crate::service::plugin::quarantine_failure_message(&report));
    }
    crate::service::profile::set_active(&app_handle, crate::service::profile::SAFE_PROFILE)?;
    Ok(report)
}

/// 隔离解析失败的补丁层：当前档案层 + home 层（错误页「隔离损坏的补丁文件」入口）。
///
/// 与 [`enter_safe_mode`] 共用同一套隔离逻辑，区别只在作用范围——本命令让用户留在
/// 自己的档案里恢复，不切档案、不动插件。补丁文件只改名保存，内容原样保留。
///
/// 与 [`enter_safe_mode`] 同样：只要有损坏层没能移走就返回错误，前端不重启——否则
/// 会立刻回到同一个解析失败。
#[tauri::command]
pub async fn quarantine_broken_patch_layers(
    app_handle: AppHandle,
) -> Result<crate::service::plugin::PatchQuarantineReport, String> {
    let report = crate::service::plugin::quarantine_active_patch_layers(&app_handle);
    if report.has_failures() {
        return Err(crate::service::plugin::quarantine_failure_message(&report));
    }
    Ok(report)
}

/// 移除补丁层里解析不到包的 `insert` 条目（错误页「移除悬空条目」入口）。
///
/// 与 [`quarantine_broken_patch_layers`] 的区别：语法错误只能整层隔离，悬空条目
/// 可以精确定位——只剥离判定为悬空的 insert 项，同一条目里的其它 insert、其它
/// 条目与其它配置原样保留。用户手写的补丁层绝不无声丢失：改写前先复制成
/// `<原名>.bak-<时间戳>` 备份，备份路径回传前端提示。
///
/// 判定规则与启动前预检完全一致（见 `service::plugin::patch_entries`），因此本命令
/// 移除的正是预检报出的那批条目；没有可移除项时返回空报告，前端照常重启。
#[tauri::command]
pub async fn strip_unresolved_patch_entries(
    app_handle: AppHandle,
) -> Result<crate::service::plugin::PatchEntryStripReport, String> {
    crate::service::plugin::strip_active_unresolved_entries(&app_handle)
}

/// 获取当前 Harness 服务状态
#[tauri::command]
pub fn get_dsh_status() -> workflow::status::Status {
    workflow::status::get_status()
}

/// 运行时文件是否已全部在盘（Node / Dsh / pnpm；Windows 还要求 Git 可用，
/// 纯本地检查、无网络）。
///
/// 判定条件与 `install_dependencies` 的「启动自愈」捷径完全一致：桌面端自更新
/// （MSI 强杀进程）后 store 可能被复位或损坏显示「未安装」，但运行时文件其实
/// 已就绪——此时前端跳过安装/下载界面，交给 install_dependencies 内部自愈
/// 补记 installed 后直接启动，避免自动重开时闪现误导用户的安装界面。
///
/// 离线安装包（`resources/bundle.json`）在这里先把内置核心以零拷贝链接层落位到
/// 应用数据目录：前端启动路径第一件事就是本命令，落位完成后即返回 true，用户直接
/// 进入页面、看不到下载流程。
#[tauri::command]
pub async fn runtime_ready(app_handle: AppHandle) -> bool {
    materialize_bundled_core(&app_handle).await;
    download::Nodejs.check_installed(&app_handle)
        && download::Dsh.check_installed(&app_handle)
        && download::Pnpm.check_installed(&app_handle)
        && git_dependency_ready(&app_handle)
}

#[cfg(test)]
mod tests {
    use super::{install_lock, preserve_newer_installed_dsh};

    #[test]
    fn install_lock_is_exclusive_while_held() {
        let lock = install_lock();
        // 首持获得锁
        let guard = lock.try_lock();
        assert!(guard.is_ok());
        // 未释放前再次 try_lock 应失败，排除并发/重入（这正是替换 Status::Installing 守卫的目的）
        assert!(lock.try_lock().is_err());
        // 释放后可重新获取
        drop(guard);
        assert!(lock.try_lock().is_ok());
    }

    #[test]
    fn newer_installed_dsh_is_preserved_from_recommended_downgrade() {
        assert!(preserve_newer_installed_dsh(
            Some("0.1.1-rc.3"),
            Some("0.1.1-rc.2")
        ));
        assert!(!preserve_newer_installed_dsh(
            Some("0.1.1-rc.2"),
            Some("0.1.1-rc.2")
        ));
        assert!(!preserve_newer_installed_dsh(
            Some("0.1.1-rc.1"),
            Some("0.1.1-rc.2")
        ));
    }
}
