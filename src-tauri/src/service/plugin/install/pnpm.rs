//! pnpm 选版与版本探测：store 主版本感知（pnpm 10 与 11 的 store 布局互不兼容）、
//! 用户 pnpm 探测（注入桌面端选定 Node 的 PATH，见 issue #182；stdin 关闭、wait/
//! cleanup 全程有界监控，见 probe 机制）、捆绑版按需补齐下载，以及服务启动时的
//! `DSH_PREFER_BUNDLED_PNPM` 决策（启动阶段不触发下载）。
//!
//! 探测只是「优先复用用户 pnpm」的优化：探测进程被强杀并回收干净后的失败
//! （超时/读管道失败/broken shim）一律降级为 `Ok(None)`，由 [`ensure_pnpm`] 回退
//! 捆绑版 pnpm；只有进程状态无法确认时才 fail-closed 返回 `Err`（issue #449）。

use crate::config;
use crate::service::cli;
use crate::service::download;
use crate::service::download::Installable;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, WebviewWindow};

use super::acquire_process_lock;
use super::profile_dir;
use super::PidGuard;
use super::PreinstallLogPayload;
use super::ProcessOwner;
use super::PREINSTALL_LOG_EVENT;

const MIN_TRUSTED_PNPM_MAJOR: u32 = 10;
const PNPM_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PNPM_PROBE_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
const PNPM_PROBE_REAP_RETRY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1);
const PNPM_PROBE_REAP_RETRY_INTERVAL: std::time::Duration = std::time::Duration::from_millis(25);
const PNPM_PROBE_LIVENESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

pub(super) async fn ensure_pnpm(
    app_handle: &AppHandle,
    window: &WebviewWindow,
    owner: ProcessOwner,
) -> Result<bool, String> {
    // 档案的 node_modules 由哪个 pnpm 主版本创建（.modules.yaml 的 storeDir 段）
    let store_major = profile_store_major(app_handle);
    let user_major = user_pnpm_major_version_bounded(app_handle, owner).await?;

    // 1) store 主版本已知 → 优先选与 store 一致的 pnpm（用户版或捆绑版）
    if let Some(store) = store_major {
        if user_major == Some(store) {
            log::info!("Reusing user-installed pnpm (major {store}) matching profile store");
            return Ok(false);
        }
        if bundled_pnpm_major(app_handle) == Some(store) {
            log::info!("Using bundled pnpm (major {store}) matching profile store");
            return Ok(true);
        }
        // 本机没有该 store 主版本的 pnpm（捆绑版与用户版都不匹配）：档案的安装
        // 元数据已无法与将要使用的 pnpm 兼容，继续跑只会以
        // `ERR_PNPM_UNEXPECTED_STORE` 失败。删掉元数据，让下面选出的 pnpm 以自身
        // 主版本布局重建安装树，而不是明知必败仍发车。
        log::warn!(
            "No pnpm matches profile store major {store} (user {user_major:?}), resetting profile modules metadata"
        );
        if reset_incompatible_modules_metadata(app_handle) {
            let _ = window.emit(
                PREINSTALL_LOG_EVENT,
                PreinstallLogPayload {
                    line: format!(
                        "[pnpm] no pnpm matches this profile's store major {store}; rebuilt the profile modules metadata for the pnpm in use"
                    ),
                },
            );
        }
    }

    // 2) store 未知（全新档案/未装过依赖）或无可匹配版本 → 用户 pnpm ≥ 10 优先
    match user_major {
        Some(major) if major >= MIN_TRUSTED_PNPM_MAJOR => {
            log::info!("Reusing user-installed pnpm (major {major}) for plugin install");
            return Ok(false);
        }
        Some(major) => {
            log::warn!(
                "User pnpm major {major} < {MIN_TRUSTED_PNPM_MAJOR} (missing autoInstallPeers/workspace-root semantics), using bundled pnpm"
            );
        }
        None => {
            log::warn!(
                "User pnpm version not detectable (broken/blocked shim?), using bundled pnpm"
            );
        }
    }

    // 捆绑版已存在 → 直接用（零额外下载）；否则下载。
    if config::get_pnpm_binary_path(app_handle).exists() {
        return Ok(true);
    }

    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: "[pnpm] bundled pnpm not found, downloading before plugin install".to_string(),
        },
    );

    let tracker = download::ProgressTracker::new(window, 2);
    let url = download::Pnpm.get_download_url()?;
    let name = url.split('/').next_back().unwrap_or(&url).to_string();
    let buffer = download::download_file(&tracker, url)
        .await
        .map_err(|e| format!("PNPM_DOWNLOAD_FAILED: {e}"))?;
    download::verify_sha256(&buffer, config::PNPM_SHA256)
        .map_err(|e| format!("PNPM_INTEGRITY_FAILED: {e}"))?;
    let dest = download::Pnpm.get_install_path(app_handle);

    download::ensure_extract(&tracker, name, buffer, dest)
        .await
        .map_err(|e| format!("PNPM_EXTRACT_FAILED: {e}"))?;

    let _ = window.emit(
        PREINSTALL_LOG_EVENT,
        PreinstallLogPayload {
            line: "[pnpm] bundled pnpm ready".to_string(),
        },
    );
    Ok(true)
}

async fn user_pnpm_major_version_bounded(
    app_handle: &AppHandle,
    owner: ProcessOwner,
) -> Result<Option<u32>, String> {
    let Some(pnpm) = cli::find_user_pnpm(app_handle) else {
        return Ok(None);
    };
    let node = config::get_node_binary_path(app_handle);
    let mut command = pnpm_probe_command(&pnpm, Some(&node));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let process_guard = acquire_process_lock().await?;
    let child = match command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log::warn!(
                "pnpm version probe failed to spawn {}: {error}",
                pnpm.display()
            );
            return Ok(None);
        }
    };
    let pid = child.id();
    let pid_guard = PidGuard::set(owner, pid);
    let mut waiter = tauri::async_runtime::spawn_blocking(move || {
        let mut child = child;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            wait_for_probe_output(&mut child)
        }))
        .unwrap_or_else(|_| {
            super::super::cancel::terminate_pid_tree(pid);
            ProbeWaitResult::CleanupPending {
                pid,
                reason: format!(
                    "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe pid {pid} panicked before cleanup completed"
                ),
            }
        });
        match result {
            ProbeWaitResult::Finished(result) => ProbeTaskResult::Finished(result),
            ProbeWaitResult::CleanupPending { pid, reason } => {
                ProbeTaskResult::CleanupPending { child, pid, reason }
            }
        }
    });

    let output = match tokio::time::timeout(PNPM_PROBE_TIMEOUT, &mut waiter).await {
        Ok(joined) => {
            let Some(task) = probe_task_or_fallback(&pnpm, joined) else {
                let reason =
                    "PNPM_PROBE_WAIT_TASK_FAILED: pnpm version probe wait task failed".to_string();
                monitor_orphaned_probe_pid(owner, pid, reason, process_guard, pid_guard);
                return Ok(None);
            };
            match task {
                ProbeTaskResult::Finished(waited) => {
                    match probe_output_or_fallback(&pnpm, waited)? {
                        Some(output) => output,
                        None => return Ok(None),
                    }
                }
                ProbeTaskResult::CleanupPending { child, pid, reason } => {
                    let pending = ProbeCleanupPending {
                        child,
                        pid,
                        reason,
                        owner,
                        _process_guard: process_guard,
                        _pid_guard: pid_guard,
                    };
                    let reason = pending.reason.clone();
                    monitor_probe_cleanup(pending);
                    return Err(reason);
                }
            }
        }
        Err(_) => {
            let reason = format!(
                "PNPM_PROBE_TIMEOUT: pnpm version probe exceeded {} seconds",
                PNPM_PROBE_TIMEOUT.as_secs()
            );
            log::error!("{reason}");
            super::super::process::mark_process_cleanup_failed(owner, reason.clone());
            super::super::cancel::terminate_owned_install(owner).await;
            let cleanup = match tokio::time::timeout(PNPM_PROBE_CLEANUP_TIMEOUT, &mut waiter).await
            {
                Ok(cleanup) => cleanup,
                Err(_) => {
                    let cleanup_reason =
                        "PNPM_PROBE_CLEANUP_TIMEOUT: pnpm version probe did not exit after forced termination"
                            .to_string();
                    monitor_probe_wait_task(
                        waiter,
                        owner,
                        pid,
                        cleanup_reason.clone(),
                        process_guard,
                        pid_guard,
                    );
                    return Err(cleanup_reason);
                }
            };
            match cleanup {
                Ok(ProbeTaskResult::Finished(_)) => {
                    // 强杀 + 回收完成意味着没有遗留进程，只是这次探测没拿到结果：
                    // 按「用户 pnpm 不可用」降级，由 ensure_pnpm 回退捆绑版，
                    // 而不是把慢探测升级成整次插件安装失败（issue #449）。
                    super::super::process::clear_process_cleanup_failed(owner);
                    return Ok(probe_timeout_or_fallback(&pnpm, reason));
                }
                Ok(ProbeTaskResult::CleanupPending { child, pid, reason }) => {
                    let pending = ProbeCleanupPending {
                        child,
                        pid,
                        reason,
                        owner,
                        _process_guard: process_guard,
                        _pid_guard: pid_guard,
                    };
                    let cleanup_reason = pending.reason.clone();
                    monitor_probe_cleanup(pending);
                    return Err(cleanup_reason);
                }
                Err(error) => {
                    monitor_orphaned_probe_pid(
                        owner,
                        pid,
                        format!(
                            "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe wait task failed during cleanup: {error}"
                        ),
                        process_guard,
                        pid_guard,
                    );
                    return Err(format!(
                        "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe wait task failed during cleanup: {error}"
                    ));
                }
            }
        }
    };
    Ok(parse_pnpm_major_output(&pnpm, &output))
}

enum ProbeWaitResult {
    Finished(std::io::Result<std::process::Output>),
    CleanupPending { pid: u32, reason: String },
}

enum ProbeTaskResult {
    Finished(std::io::Result<std::process::Output>),
    CleanupPending {
        child: std::process::Child,
        pid: u32,
        reason: String,
    },
}

struct ProbeCleanupPending {
    child: std::process::Child,
    pid: u32,
    reason: String,
    owner: ProcessOwner,
    _process_guard: tokio::sync::OwnedMutexGuard<()>,
    _pid_guard: PidGuard,
}

impl ProbeCleanupPending {
    fn release(self) {
        let Self {
            child,
            owner,
            _process_guard,
            _pid_guard,
            ..
        } = self;
        super::super::process::release_process_cleanup(owner, _pid_guard, _process_guard);
        drop(child);
    }
}

fn wait_for_probe_output(child: &mut std::process::Child) -> ProbeWaitResult {
    let pid = child.id();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_reader = match std::thread::Builder::new()
        .name("pnpm-probe-stdout".to_string())
        .spawn(move || read_probe_pipe(stdout))
    {
        Ok(reader) => reader,
        Err(error) => return reap_probe_after_wait_failure(child, pid, error),
    };
    let stderr_reader = match std::thread::Builder::new()
        .name("pnpm-probe-stderr".to_string())
        .spawn(move || read_probe_pipe(stderr))
    {
        Ok(reader) => reader,
        Err(error) => return reap_probe_after_wait_failure(child, pid, error),
    };

    let status = match child.wait() {
        Ok(status) => status,
        Err(error) => return reap_probe_after_wait_failure(child, pid, error),
    };
    let stdout = match join_probe_reader(stdout_reader) {
        Ok(stdout) => stdout,
        Err(error) => return ProbeWaitResult::Finished(Err(error)),
    };
    let stderr = match join_probe_reader(stderr_reader) {
        Ok(stderr) => stderr,
        Err(error) => return ProbeWaitResult::Finished(Err(error)),
    };
    ProbeWaitResult::Finished(Ok(std::process::Output {
        status,
        stdout,
        stderr,
    }))
}

fn reap_probe_after_wait_failure(
    child: &mut std::process::Child,
    pid: u32,
    error: std::io::Error,
) -> ProbeWaitResult {
    super::super::cancel::terminate_pid_tree(pid);
    if let Err(kill_error) = child.kill() {
        log::warn!("pnpm version probe kill after wait failure failed: {kill_error}");
    }
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return ProbeWaitResult::Finished(Err(error)),
            Ok(None) => {}
            Err(cleanup_error) => {
                log::warn!("pnpm version probe reap after wait failure failed: {cleanup_error}");
                if super::super::process::plugin_process_has_exited(pid) {
                    return ProbeWaitResult::Finished(Err(error));
                }
            }
        }
        if started.elapsed() >= PNPM_PROBE_REAP_RETRY_TIMEOUT {
            return ProbeWaitResult::CleanupPending {
                pid,
                reason: format!(
                    "PNPM_PROBE_CLEANUP_FAILED: pnpm version probe pid {pid} could not be reaped after wait failure: {error}"
                ),
            };
        }
        std::thread::sleep(PNPM_PROBE_REAP_RETRY_INTERVAL);
    }
}

fn monitor_probe_cleanup(mut pending: ProbeCleanupPending) {
    super::super::process::mark_process_cleanup_failed(pending.owner, pending.reason.clone());
    tauri::async_runtime::spawn(async move {
        wait_for_probe_cleanup(&mut pending).await;
        pending.release();
    });
}

fn monitor_probe_wait_task(
    waiter: tauri::async_runtime::JoinHandle<ProbeTaskResult>,
    owner: ProcessOwner,
    pid: u32,
    reason: String,
    process_guard: tokio::sync::OwnedMutexGuard<()>,
    pid_guard: PidGuard,
) {
    super::super::process::mark_process_cleanup_failed(owner, reason);
    tauri::async_runtime::spawn(async move {
        match waiter.await {
            Ok(ProbeTaskResult::CleanupPending { child, pid, reason }) => {
                let mut pending = ProbeCleanupPending {
                    child,
                    pid,
                    reason,
                    owner,
                    _process_guard: process_guard,
                    _pid_guard: pid_guard,
                };
                wait_for_probe_cleanup(&mut pending).await;
                pending.release();
            }
            Ok(ProbeTaskResult::Finished(_)) => {
                super::super::process::release_process_cleanup(owner, pid_guard, process_guard);
            }
            Err(error) => {
                log::error!("pnpm version probe cleanup wait task failed: {error}");
                wait_for_probe_cleanup_with(
                    || !super::super::process::plugin_process_has_exited(pid),
                    PNPM_PROBE_LIVENESS_INTERVAL,
                )
                .await;
                super::super::process::release_process_cleanup(owner, pid_guard, process_guard);
            }
        }
    });
}

fn monitor_orphaned_probe_pid(
    owner: ProcessOwner,
    pid: u32,
    reason: String,
    process_guard: tokio::sync::OwnedMutexGuard<()>,
    pid_guard: PidGuard,
) {
    super::super::process::mark_process_cleanup_failed(owner, reason);
    super::super::cancel::terminate_pid_tree(pid);
    tauri::async_runtime::spawn(async move {
        wait_for_probe_cleanup_with(
            || !super::super::process::plugin_process_has_exited(pid),
            PNPM_PROBE_LIVENESS_INTERVAL,
        )
        .await;
        super::super::process::release_process_cleanup(owner, pid_guard, process_guard);
    });
}

async fn wait_for_probe_cleanup(pending: &mut ProbeCleanupPending) {
    wait_for_probe_cleanup_with(
        || match pending.child.try_wait() {
            Ok(Some(_)) => false,
            Ok(None) => true,
            Err(error) => {
                log::warn!(
                    "pnpm version probe cleanup monitor wait failed for pid {}: {error}",
                    pending.pid
                );
                !super::super::process::plugin_process_has_exited(pending.pid)
            }
        },
        PNPM_PROBE_LIVENESS_INTERVAL,
    )
    .await;
    log::info!(
        "pnpm version probe cleanup monitor released pid {}",
        pending.pid
    );
}

async fn wait_for_probe_cleanup_with<F>(mut remains_active: F, interval: std::time::Duration)
where
    F: FnMut() -> bool,
{
    while remains_active() {
        tokio::time::sleep(interval).await;
    }
}

fn read_probe_pipe<R: Read>(pipe: Option<R>) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    if let Some(mut pipe) = pipe {
        pipe.read_to_end(&mut output)?;
    }
    Ok(output)
}

fn join_probe_reader(
    reader: std::thread::JoinHandle<std::io::Result<Vec<u8>>>,
) -> std::io::Result<Vec<u8>> {
    reader
        .join()
        .map_err(|_| std::io::Error::other("pnpm version probe output reader thread panicked"))?
}

fn log_probe_fallback(pnpm: &Path, phase: &str, error: impl std::fmt::Display) {
    log::warn!(
        "pnpm version probe {phase} failed for {}: {error}; falling back to bundled pnpm",
        pnpm.display()
    );
}

fn probe_task_or_fallback<T, E: std::fmt::Display>(pnpm: &Path, result: Result<T, E>) -> Option<T> {
    match result {
        Ok(task) => Some(task),
        Err(error) => {
            log_probe_fallback(pnpm, "wait task", error);
            None
        }
    }
}

fn probe_output_or_fallback(
    pnpm: &Path,
    result: std::io::Result<std::process::Output>,
) -> Result<Option<std::process::Output>, String> {
    match result {
        Ok(output) => Ok(Some(output)),
        Err(error) => {
            log_probe_fallback(pnpm, "output", error);
            Ok(None)
        }
    }
}

/// 探测超时后进程已被强杀并回收干净时的处置：记降级日志并返回「用户 pnpm
/// 不可用」（`None`），让 [`ensure_pnpm`] 回退捆绑版 pnpm。
///
/// 版本探测只是「优先复用用户 pnpm」的优化，慢探测（corepack 首次下载确认、
/// 杀软扫描等）不该中断整次插件安装（issue #449）。只有清理未确认（进程可能
/// 仍在、锁未释放）的分支才保持 fail-closed 的 `Err`。
fn probe_timeout_or_fallback(pnpm: &Path, reason: String) -> Option<u32> {
    log_probe_fallback(pnpm, "timeout", reason);
    None
}

/// 用户 pnpm 主版本号（解析 `pnpm --version` 首个点分字段）；不存在或不可运行
/// （corepack shim 在 Node 24 上 ERR_INVALID_THIS 崩溃等）返回 None。
///
/// 供 [`ensure_pnpm`] 选版与 [`crate::service::plugin::verify`] 的修复选版共用（store 主版本匹配）。
pub(crate) fn user_pnpm_major_version(app_handle: &AppHandle) -> Option<u32> {
    let pnpm = cli::find_user_pnpm(app_handle)?;
    let node = config::get_node_binary_path(app_handle);
    pnpm_major_version_at_with_node(&pnpm, Some(&node))
}

/// 探测精确 pnpm 可执行路径的主版本，供直接执行路径校验实际将运行的文件。
pub(crate) fn pnpm_major_version_at(pnpm: &Path) -> Option<u32> {
    pnpm_major_version_at_with_node(pnpm, None)
}

/// 在受控 Node 环境中探测 pnpm 主版本。Windows GUI 进程继承的 PATH 可能早于
/// Node/pnpm 安装，而 corepack 的 `pnpm.cmd` 需要通过 PATH 调用 `node`；探测时
/// 必须注入桌面端已经选定的 Node 目录，否则会把健康 pnpm 误判为不可用（issue #182）。
fn pnpm_major_version_at_with_node(pnpm: &Path, node: Option<&Path>) -> Option<u32> {
    let output = match pnpm_probe_command(pnpm, node).output() {
        Ok(output) => output,
        Err(error) => {
            log::warn!(
                "pnpm version probe failed to spawn {}: {error}",
                pnpm.display()
            );
            return None;
        }
    };
    parse_pnpm_major_output(pnpm, &output)
}

/// 构建 pnpm 版本探测命令：`--version`、注入选定 Node 的 PATH（issue #182）、
/// Windows 无窗口，并**显式关闭 stdin**。
///
/// 探测只需要 `--version` 的标准输出，绝不该等待输入：corepack 在 pnpm 版本
/// 未缓存时会先问 "Do you want to continue? [Y/n]"，而 GUI 进程继承的 stdin
/// 句柄无控制台可读，子进程读它会一直挂起——探测只能靠 10 秒超时强杀，用户
/// 看到的是「pnpm 不能在这台电脑上运行」的安装失败（issue #449）。关闭 stdin
/// 让这类读取立刻拿到 EOF，探测必定有界结束。有界探测（子进程 + 超时强杀）与
/// 无界探测（[`user_pnpm_major_version`] 的 `output()`）共用本函数，避免两套
/// 探测策略再次分叉。
fn pnpm_probe_command(pnpm: &Path, node: Option<&Path>) -> std::process::Command {
    let mut command = std::process::Command::new(pnpm);
    command.arg("--version");
    if let Some(path) = pnpm_probe_path(pnpm, node) {
        command.env("PATH", path);
    }
    command.stdin(std::process::Stdio::null());
    // 打包版是 GUI 进程（无控制台）：版本探测不能弹出可见黑窗。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn parse_pnpm_major_output(pnpm: &Path, output: &std::process::Output) -> Option<u32> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        log::warn!(
            "pnpm version probe failed for {} with status {}: {}",
            pnpm.display(),
            output.status,
            stderr.trim()
        );
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.split('.').next()?.trim().parse::<u32>().ok()
}

/// 构建 pnpm 探测专用 PATH：用户 pnpm 所在目录和选定 Node 目录前置，其余环境保留。
fn pnpm_probe_path(pnpm: &Path, node: Option<&Path>) -> Option<OsString> {
    let mut paths = Vec::new();
    // 选定 Node 必须位于 pnpm shim 目录之前：corepack 目录可能残留另一份 node，
    // bare `node` 应与桌面端预检和后续插件命令使用同一运行时。
    if let Some(parent) = node.and_then(Path::parent) {
        paths.push(parent.to_path_buf());
    }
    if let Some(parent) = pnpm.parent() {
        paths.push(parent.to_path_buf());
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    std::env::join_paths(paths).ok()
}

/// 档案 `node_modules` 使用的 pnpm store 主版本（`<profile>/node_modules/.modules.yaml`
/// 的 `storeDir` 路径段，如 `...\store\v10` → 10）。
///
/// pnpm 10 与 11 的 store 布局互不兼容：用与 store 主版本不一致的 pnpm 更新
/// 已装插件会 `ERR_PNPM_UNEXPECTED_STORE` 退出。档案尚未安装过依赖（没有
/// node_modules）时返回 `None`，由调用方走"全新档案"逻辑。
/// 供 [`ensure_pnpm`] 选版与 [`crate::service::plugin::verify`] 的修复选版共用。
pub(crate) fn profile_store_major(app_handle: &AppHandle) -> Option<u32> {
    parse_store_major_from_modules_yaml(&read_modules_yaml(app_handle)?)
}

/// 档案 `node_modules/.modules.yaml` 记录的 pnpm store 基目录（去掉 `v10` 版本段）。
///
/// 与 [`profile_store_major`] 同源，但给出整条路径：pnpm 只在「解析出的 store」与
/// `node_modules/.modules.yaml` 记录的一致时才继续安装，否则 `ERR_PNPM_UNEXPECTED_STORE`。
/// 用户的 pnpm 用户级/全局配置（或 `npm_config_store_dir` 环境变量）可能把 store 指到
/// 别处，而档案早已按自己那份 store 装好——此时任何 `dsh plugin` 安装/升级都会失败，
/// 与插件本身无关。把这个基目录下传给子进程（见 [`super::env::build_plugin_envs`]）即可
/// 保证子进程落在与档案一致的那份 store 上。
///
/// 下传的必须是基目录而非记录原文（含版本段）：版本段由 pnpm 按自身主版本追加，见
/// [`strip_store_version`]。
pub(crate) fn profile_store_base_dir(app_handle: &AppHandle) -> Option<String> {
    let store_dir = parse_store_dir_from_modules_yaml(&read_modules_yaml(app_handle)?)?;
    Some(strip_store_version(&store_dir))
}

/// 去掉 store 目录末尾的 pnpm 版本段（`...\store\v10` → `...\store`）。
///
/// pnpm 计算实际 store 时只在「传入路径已以自身 `STORE_VERSION` 结尾」时原样使用，
/// 否则追加自己的版本段（`getStorePath`）。下传带版本段的路径只在 pnpm 主版本与
/// 档案一致时才等价：主版本不一致时会拼出不存在的嵌套路径（`store\v10\v11`），
/// 与 `.modules.yaml` 的记录必然失配。去掉版本段后由 pnpm 自行补齐 —— 一致时结果
/// 完全相同，不一致时也落在同一份 store 的兄弟目录，不会多出一个位置。末尾不是
/// `v<数字>` 段（包含路径本身就是版本段名）时原样返回。
fn strip_store_version(store_dir: &str) -> String {
    let trimmed = store_dir.trim_end_matches(['\\', '/']);
    let last = trimmed.rsplit(['\\', '/']).next().unwrap_or_default();
    let keep = trimmed.len() - last.len();
    let digits = last.strip_prefix('v').unwrap_or_default();
    if keep == 0 || digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return store_dir.to_string();
    }
    trimmed[..keep].trim_end_matches(['\\', '/']).to_string()
}

/// 删除档案的 pnpm 安装元数据（`node_modules/.modules.yaml`），让 pnpm 以当前
/// 主版本重建安装树；返回是否真的删掉了文件。
///
/// pnpm 只在 `.modules.yaml` 存在时做兼容性校验（`checkCompatibility`：先
/// `layoutVersion`，再 `storeDir`、`virtualStoreDir`），而 `storeDir` 记的是解析后的
/// **完整**路径（含 `v10`/`v11` 版本段）。档案由 pnpm 10 安装、本机只剩 pnpm 11
/// 时，pnpm 11 解析出的 store 与记录必然不同，任何安装/升级都以
/// `ERR_PNPM_UNEXPECTED_STORE` 失败 —— 档案本身健康，用户看到的却只是「插件安装
/// 失败」。该文件是纯元数据，删掉后 pnpm 跳过校验、按当前 pnpm 的 store 布局重新
/// 链接（与 `service::migrate` 处理 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE` 的做法一致）。
pub(crate) fn reset_incompatible_modules_metadata(app_handle: &AppHandle) -> bool {
    let modules_yaml = profile_dir(app_handle)
        .join("node_modules")
        .join(".modules.yaml");
    if !modules_yaml.is_file() {
        return false;
    }
    match std::fs::remove_file(&modules_yaml) {
        Ok(()) => {
            log::info!(
                "reset incompatible pnpm modules metadata: {}",
                modules_yaml.display()
            );
            true
        }
        Err(e) => {
            log::warn!("reset {} failed: {e}", modules_yaml.display());
            false
        }
    }
}

/// 读取档案的 `node_modules/.modules.yaml`；文件缺失（全新档案）返回 `None`。
fn read_modules_yaml(app_handle: &AppHandle) -> Option<String> {
    std::fs::read_to_string(
        profile_dir(app_handle)
            .join("node_modules")
            .join(".modules.yaml"),
    )
    .ok()
}

/// 从 `.modules.yaml` 文本解析 `storeDir`（纯函数，便于单测）。
///
/// 兼容 pnpm 的两种写法：未加引号的裸路径（Windows 反斜杠、Unix 正斜杠），以及
/// 含特殊字符时 YAML 双引号包裹 + `\\` 转义的形式。
fn parse_store_dir_from_modules_yaml(content: &str) -> Option<String> {
    let raw = content
        .lines()
        .find_map(|line| line.trim().strip_prefix("storeDir:").map(str::trim))?
        .trim_matches(['"', '\''])
        .trim();
    if raw.is_empty() {
        return None;
    }
    // YAML 双引号标量里的 `\\` 表示单个反斜杠；裸路径不会出现连续反斜杠，替换是安全的。
    Some(raw.replace("\\\\", "\\"))
}

/// 从 `.modules.yaml` 文本解析 store 主版本（纯函数，便于单测）。
fn parse_store_major_from_modules_yaml(content: &str) -> Option<u32> {
    // storeDir 形如 `C:\Users\xx\AppData\Local\pnpm\store\v10`，取末段 `v10` 的数字
    let store_dir = parse_store_dir_from_modules_yaml(content)?;
    let major = store_dir.rsplit(['\\', '/']).next()?.strip_prefix('v')?;
    major.parse().ok()
}

/// 捆绑版 pnpm 的主版本（读 pnpm 目录 `package.json` 的 version 字段，离线安装包
/// 为随包 `resources/pnpm`）；未安装或清单缺失返回 None。
///
/// 供 [`ensure_pnpm`] 选版与 [`crate::service::plugin::verify`] 的修复选版共用（store 主版本匹配）。
pub(crate) fn bundled_pnpm_major(app_handle: &AppHandle) -> Option<u32> {
    let manifest = config::get_pnpm_runtime_dir(app_handle).join("package.json");
    let content = std::fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    value
        .get("version")?
        .as_str()?
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// 服务启动阶段的 `DSH_PREFER_BUNDLED_PNPM` 决策：store 主版本已知时只在捆绑版
/// 匹配且用户版不匹配时强制捆绑版（否则用户版会 `ERR_PNPM_UNEXPECTED_STORE`）；
/// store 未知时用户 pnpm ≥ 10 优先，否则强制捆绑版。启动阶段绝不触发下载，
/// 捆绑版未安装即返回 false（交由用户 pnpm）。
pub(crate) fn harness_prefer_bundled_pnpm(app_handle: &AppHandle) -> bool {
    let store_major = profile_store_major(app_handle);
    let user_major = user_pnpm_major_version(app_handle);
    let bundled_major = bundled_pnpm_major(app_handle);
    // 捆绑版未安装 → 无法强制，交还用户 pnpm（shim 默认用户优先）
    if !config::get_pnpm_binary_path(app_handle).exists() {
        return false;
    }
    match store_major {
        Some(store) => bundled_major == Some(store) && user_major != Some(store),
        None => match user_major {
            Some(major) if major >= MIN_TRUSTED_PNPM_MAJOR => false,
            _ => true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pnpm_probe_wait_and_output_failures_fall_back_to_bundled() {
        let pnpm = PathBuf::from("broken-pnpm");
        let output = probe_output_or_fallback(
            &pnpm,
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "output pipe closed",
            )),
        )
        .unwrap();

        assert!(output.is_none());
    }

    #[test]
    fn pnpm_probe_wait_task_join_failure_falls_back_to_bundled() {
        let pnpm = PathBuf::from("broken-pnpm");
        let task: Option<()> = probe_task_or_fallback(&pnpm, Err("blocking worker dropped"));
        assert!(task.is_none());
    }

    /// issue #449 回归：探测超时、但进程已被强杀并回收干净时，必须降级为
    /// 「用户 pnpm 不可用」（`None` → `ensure_pnpm` 回退捆绑版），而不是把
    /// `PNPM_PROBE_TIMEOUT` 当成整次插件安装的失败。
    #[test]
    fn pnpm_probe_timeout_after_recycled_cleanup_falls_back_to_bundled() {
        let pnpm = PathBuf::from("slow-pnpm");
        let fallback = probe_timeout_or_fallback(
            &pnpm,
            "PNPM_PROBE_TIMEOUT: pnpm version probe exceeded 10 seconds".to_string(),
        );

        assert!(
            fallback.is_none(),
            "recovered probe timeout must degrade to bundled pnpm, not fail the install"
        );
    }

    /// issue #449 根因：探测命令必须显式关闭 stdin。corepack 版本未缓存时会先
    /// 等待 "Do you want to continue? [Y/n]" 输入，继承 GUI 进程的 stdin 会让
    /// 探测挂到超时（随后只能强杀）；这里用「读 stdin 才结束」的假 pnpm 走真实
    /// 的有界探测启动方式（`spawn` + 管道），验证 stdin 关闭后立即拿到版本输出。
    ///
    /// 兜底等待：即使回归（stdin 被继承）也只是超时失败并强杀子进程，不会挂住
    /// 测试进程；stdin 恰好是 /dev/null 的非交互环境无法区分两者，此测试在该
    /// 环境下退化为「探测可用性」检查。
    #[cfg(unix)]
    #[test]
    fn pnpm_probe_command_closes_stdin_for_interactive_shims() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "dsh-pnpm-probe-stdin-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // stdin 关闭 → `read` 立即 EOF；stdin 被继承 → `read` 阻塞。
        let pnpm = root.join("interactive-pnpm");
        std::fs::write(&pnpm, "#!/bin/sh\nread _\nprintf '11.0.0\\n'\n").unwrap();
        let mut permissions = std::fs::metadata(&pnpm).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&pnpm, permissions).unwrap();

        let mut child = pnpm_probe_command(&pnpm, None)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut buffer = String::new();
            let _ = std::io::BufReader::new(stdout).read_to_string(&mut buffer);
            let _ = sender.send(buffer);
        });

        let output = match receiver.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(output) => output,
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("pnpm version probe must not inherit stdin (it blocks on input)");
            }
        };
        let status = child.wait().unwrap();
        let _ = reader.join();

        assert!(status.success());
        assert_eq!(output, "11.0.0\n");
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn pnpm_probe_cleanup_monitor_releases_after_process_disappears() {
        let polls = std::sync::atomic::AtomicUsize::new(0);
        tokio::time::timeout(
            std::time::Duration::from_millis(50),
            wait_for_probe_cleanup_with(
                || polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < 2,
                std::time::Duration::from_millis(1),
            ),
        )
        .await
        .expect("cleanup monitor should release after liveness turns false");
        assert_eq!(polls.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn pnpm_probe_cleanup_monitor_stays_fail_closed_while_process_lives() {
        let pending = tokio::time::timeout(
            std::time::Duration::from_millis(5),
            wait_for_probe_cleanup_with(|| true, std::time::Duration::from_millis(1)),
        )
        .await;
        assert!(pending.is_err());
    }

    struct BrokenPipeReader;

    impl std::io::Read for BrokenPipeReader {
        fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "probe output pipe closed",
            ))
        }
    }

    #[test]
    fn pnpm_probe_broken_output_pipe_is_reported_as_fallback_failure() {
        let error = read_probe_pipe(Some(BrokenPipeReader)).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
    }

    #[cfg(unix)]
    #[test]
    fn pnpm_major_version_at_probes_the_exact_selected_path() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("dsh-pnpm-major-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let selected = root.join("selected-pnpm");
        let other = root.join("other-pnpm");
        std::fs::write(&selected, "#!/bin/sh\nprintf '11.2.0\\n'\n").unwrap();
        std::fs::write(&other, "#!/bin/sh\nprintf '10.9.0\\n'\n").unwrap();
        for path in [&selected, &other] {
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(path, permissions).unwrap();
        }

        assert_eq!(pnpm_major_version_at(&selected), Some(11));
        assert_eq!(pnpm_major_version_at(&other), Some(10));
        let _ = std::fs::remove_dir_all(root);
    }

    /// 回归 Windows GUI 的陈旧 PATH：pnpm shim 必须解析到桌面端选定的 Node，
    /// 即使 shim 同目录存在冲突的 node，且路径包含空格和 shell 元字符。
    #[cfg(windows)]
    #[test]
    fn pnpm_major_version_probe_injects_selected_node_for_cmd_shim() {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("dsh pnpm cmd major {} {nonce}", std::process::id()));
        let pnpm_dir = root.join("pnpm & corepack");
        let node_dir = root.join("selected node");
        std::fs::create_dir_all(&pnpm_dir).unwrap();
        std::fs::create_dir_all(&node_dir).unwrap();
        let selected = pnpm_dir.join("pnpm.cmd");
        let node = node_dir.join("node.cmd");
        std::fs::write(&selected, "@echo off\r\nnode --version\r\n").unwrap();
        // shim 目录里的冲突运行时若优先会输出 9；选定 Node 必须抢在它前面。
        std::fs::write(pnpm_dir.join("node.cmd"), "@echo off\r\necho 9.0.0\r\n").unwrap();
        std::fs::write(&node, "@echo off\r\necho 11.24.0\r\n").unwrap();

        assert_eq!(
            pnpm_major_version_at_with_node(&selected, Some(&node)),
            Some(11)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn store_major_parsed_from_modules_yaml() {
        // 真实 pnpm v10 写入的 .modules.yaml：storeDir 指向 store\v10
        let content = "\
lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
dependencies:
  '@deepseek-ai/dsh-base': 0.0.4
  '@deepseek-ai/dsh-web-app': 0.0.4
storeDir: C:\\Users\\test\\AppData\\Local\\pnpm\\store\\v10
virtualStoreDir: node_modules/.pnpm
";
        assert_eq!(parse_store_major_from_modules_yaml(content), Some(10));
    }

    #[test]
    fn store_major_supports_unix_and_quoted_paths() {
        assert_eq!(
            parse_store_major_from_modules_yaml(
                "storeDir: /home/test/.local/share/pnpm/store/v11\n"
            ),
            Some(11)
        );
        assert_eq!(
            parse_store_major_from_modules_yaml("storeDir: \"C:\\\\pnpm store\\\\v3\"\n"),
            Some(3)
        );
    }

    #[test]
    fn store_major_missing_when_no_store_dir() {
        // 档案尚未装过依赖：无 storeDir 段 → None
        assert_eq!(
            parse_store_major_from_modules_yaml("lockfileVersion: '9.0'\n"),
            None
        );
        assert_eq!(parse_store_major_from_modules_yaml(""), None);
        // storeDir 存在但没有版本段（理论上不该出现）→ 无法判定主版本
        assert_eq!(
            parse_store_major_from_modules_yaml("storeDir: C:\\Users\\x\\pnpm\\store\n"),
            None
        );
    }

    #[test]
    fn store_dir_parsed_for_handoff_to_pnpm() {
        // 解析必须保留记录原文（含 v10 版本段），由 strip_store_version 决定下传什么
        let content = "\
hoistPattern:
  - '*'
storeDir: C:\\Users\\test\\AppData\\Local\\pnpm\\store\\v10
virtualStoreDir: node_modules/.pnpm
";
        assert_eq!(
            parse_store_dir_from_modules_yaml(content).as_deref(),
            Some("C:\\Users\\test\\AppData\\Local\\pnpm\\store\\v10")
        );
        assert_eq!(
            parse_store_dir_from_modules_yaml("storeDir: /home/test/.local/share/pnpm/store/v11\n")
                .as_deref(),
            Some("/home/test/.local/share/pnpm/store/v11")
        );
        // YAML 双引号形式：去引号并把 `\\` 还原成单个反斜杠
        assert_eq!(
            parse_store_dir_from_modules_yaml("storeDir: \"C:\\\\pnpm store\\\\v3\"\n").as_deref(),
            Some("C:\\pnpm store\\v3")
        );
        assert_eq!(
            parse_store_dir_from_modules_yaml("storeDir: 'D:\\.pnpm-store\\v10'\n").as_deref(),
            Some("D:\\.pnpm-store\\v10")
        );
        // 缺失 / 空值 → None（全新档案不注入环境变量）
        assert_eq!(parse_store_dir_from_modules_yaml("storeDir:\n"), None);
        assert_eq!(
            parse_store_dir_from_modules_yaml("lockfileVersion: '9.0'\n"),
            None
        );
    }

    #[test]
    fn store_base_dir_strips_trailing_pnpm_version_segment() {
        assert_eq!(
            strip_store_version("C:\\Users\\test\\AppData\\Local\\pnpm\\store\\v10"),
            "C:\\Users\\test\\AppData\\Local\\pnpm\\store"
        );
        assert_eq!(
            strip_store_version("/home/test/.local/share/pnpm/store/v11"),
            "/home/test/.local/share/pnpm/store"
        );
        // 含空格/以分隔符结尾的写法
        assert_eq!(
            strip_store_version("/Users/gao/Library/pnpm/store/v10/"),
            "/Users/gao/Library/pnpm/store"
        );
        assert_eq!(strip_store_version("D:\\.pnpm-store\\v3"), "D:\\.pnpm-store");
    }

    #[test]
    fn store_base_dir_keeps_paths_without_version_segment() {
        // 末尾不是 v<数字>：原样返回，避免把用户自定的 store 目录名吃掉
        assert_eq!(
            strip_store_version("C:\\Users\\x\\pnpm\\store"),
            "C:\\Users\\x\\pnpm\\store"
        );
        assert_eq!(strip_store_version("/mnt/pnpm-store-v10"), "/mnt/pnpm-store-v10");
        assert_eq!(strip_store_version("/mnt/v-store"), "/mnt/v-store");
        assert_eq!(strip_store_version("v10"), "v10");
        assert_eq!(strip_store_version(""), "");
    }
}
