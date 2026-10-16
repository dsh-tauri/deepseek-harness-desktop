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
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, WebviewWindow};

use super::acquire_process_lock;
use super::new_process_owner;
use super::profile_dir;
use super::PidGuard;
use super::PreinstallLogPayload;
use super::ProcessOwner;
use super::PREINSTALL_LOG_EVENT;

const MIN_TRUSTED_PNPM_MAJOR: u32 = 10;
const PNPM_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const PNPM_PROBE_CLEANUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
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

    download::ensure_extract(&tracker, name, buffer, dest.clone())
        .await
        .map_err(|e| format!("PNPM_EXTRACT_FAILED: {e}"))?;
    // 捆绑 pnpm 落盘后，该依赖的安装根即托管根（映射表随之更新）。
    config::dependencies::record(app_handle, config::dependencies::DEP_PNPM, Some(dest));

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
    pnpm_major_version_at_bounded(
        &pnpm,
        Some(&config::get_node_binary_path(app_handle)),
        Some(&cli::get_bin_dir(app_handle)),
        owner,
    )
    .await
}

pub(crate) async fn pnpm_major_version_at_bounded(
    pnpm: &Path,
    node: Option<&Path>,
    bin_dir: Option<&Path>,
    owner: ProcessOwner,
) -> Result<Option<u32>, String> {
    let deadline = tokio::time::Instant::now() + PNPM_PROBE_TIMEOUT;
    let mut command = pnpm_probe_command(pnpm, node, bin_dir);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let process_guard = tokio::time::timeout_at(deadline, acquire_process_lock())
        .await
        .map_err(|_| {
            "PNPM_PROBE_LOCK_TIMEOUT: timed out waiting for the process lock".to_string()
        })??;
    let child = match command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            log_probe_fallback(pnpm, "spawn", error);
            return Ok(None);
        }
    };
    let child = Arc::new(Mutex::new(child));
    let pid_guard = PidGuard::set_child(owner, &child);
    let pending = ProbeCleanupPending {
        child,
        owner,
        _process_guard: process_guard,
        _pid_guard: pid_guard,
    };
    let pnpm = pnpm.to_path_buf();
    // 调用方取消只脱离等待；进程与守卫由独立任务持有到回收完成。
    tauri::async_runtime::spawn(async move {
        let child = pending.child.clone();
        let mut waiter =
            tauri::async_runtime::spawn_blocking(move || wait_for_probe_output(&child));
        let (reason, waiter) = match tokio::time::timeout_at(deadline, &mut waiter).await {
            Ok(Ok(Ok(output))) => {
                if let Some(reason) = super::super::process::process_cleanup_failure(pending.owner)
                {
                    (reason, None)
                } else {
                    pending.release();
                    return Ok(parse_pnpm_major_output(&pnpm, &output));
                }
            }
            Ok(joined) => {
                let reason = match joined {
                    Ok(Err(error)) => format!("PNPM_PROBE_OUTPUT_FAILED: {error}"),
                    Err(error) => format!("PNPM_PROBE_WAIT_TASK_FAILED: {error}"),
                    Ok(Ok(_)) => unreachable!(),
                };
                (reason, None)
            }
            Err(_) => (
                format!(
                    "PNPM_PROBE_TIMEOUT: pnpm version probe exceeded {} seconds",
                    PNPM_PROBE_TIMEOUT.as_secs()
                ),
                Some(waiter),
            ),
        };
        cleanup_probe(pending, waiter, reason.clone()).await?;
        Ok(probe_timeout_or_fallback(&pnpm, reason))
    })
    .await
    .map_err(|error| format!("PNPM_PROBE_TASK_FAILED: {error}"))?
}

struct ProbeCleanupPending {
    child: Arc<Mutex<std::process::Child>>,
    owner: ProcessOwner,
    _process_guard: tokio::sync::OwnedMutexGuard<()>,
    _pid_guard: PidGuard,
}

impl ProbeCleanupPending {
    fn release(self) {
        let Self {
            owner,
            _process_guard,
            _pid_guard,
            ..
        } = self;
        super::super::process::release_process_cleanup(owner, _pid_guard, _process_guard);
    }
}

fn wait_for_probe_output(
    child: &Arc<Mutex<std::process::Child>>,
) -> std::io::Result<std::process::Output> {
    let (stdout, stderr) = {
        let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
        (child.stdout.take(), child.stderr.take())
    };
    std::thread::scope(|scope| {
        let stdout_reader = std::thread::Builder::new()
            .name("pnpm-probe-stdout".to_string())
            .spawn_scoped(scope, move || read_probe_pipe(stdout))?;
        let stderr_reader = std::thread::Builder::new()
            .name("pnpm-probe-stderr".to_string())
            .spawn_scoped(scope, move || read_probe_pipe(stderr))?;
        let stdout = stdout_reader
            .join()
            .map_err(|_| std::io::Error::other("pnpm version probe stdout reader panicked"))??;
        let stderr = stderr_reader
            .join()
            .map_err(|_| std::io::Error::other("pnpm version probe stderr reader panicked"))??;
        let status = loop {
            if let Some(status) = child
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .try_wait()?
            {
                break status;
            }
            std::thread::sleep(PNPM_PROBE_REAP_RETRY_INTERVAL);
        };
        Ok(std::process::Output {
            status,
            stdout,
            stderr,
        })
    })
}

use super::super::cancel::terminate_probe_tree;

fn terminate_probe(
    child: &Arc<Mutex<std::process::Child>>,
    terminate_tree: fn(u32) -> bool,
) -> std::io::Result<()> {
    let mut child = child.lock().unwrap_or_else(|error| error.into_inner());
    // 同一锁内确认存活并强杀；waiter 不得先回收后再按可能复用的 PID 杀进程。
    if child.try_wait()?.is_none() {
        let tree_killed = terminate_tree(child.id());
        let root_killed = child.kill();
        if !tree_killed {
            return Err(std::io::Error::other(
                "PNPM_PROBE_TREE_CLEANUP_FAILED: pnpm version probe process tree termination was not confirmed",
            ));
        }
        if let Err(error) = root_killed {
            if child.try_wait()?.is_none() {
                return Err(error);
            }
        }
    }
    Ok(())
}

async fn cleanup_probe(
    pending: ProbeCleanupPending,
    waiter: Option<tauri::async_runtime::JoinHandle<std::io::Result<std::process::Output>>>,
    reason: String,
) -> Result<(), String> {
    let mut cleanup = monitor_probe_cleanup(pending, waiter, reason, terminate_probe_tree);
    match tokio::time::timeout(PNPM_PROBE_CLEANUP_TIMEOUT, &mut cleanup).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(format!("PNPM_PROBE_CLEANUP_FAILED: {error}")),
        Err(_) => Err(
            "PNPM_PROBE_CLEANUP_TIMEOUT: pnpm version probe cleanup did not finish within 5 seconds"
                .to_string(),
        ),
    }
}

fn monitor_probe_cleanup(
    pending: ProbeCleanupPending,
    waiter: Option<tauri::async_runtime::JoinHandle<std::io::Result<std::process::Output>>>,
    reason: String,
    terminate_tree: fn(u32) -> bool,
) -> tauri::async_runtime::JoinHandle<()> {
    super::super::process::mark_process_cleanup_failed(pending.owner, reason);
    tauri::async_runtime::spawn(async move {
        let child = pending.child.clone();
        let killer =
            tauri::async_runtime::spawn_blocking(move || terminate_probe(&child, terminate_tree));
        let wait = async move {
            if let Some(waiter) = waiter {
                if let Err(error) = waiter.await {
                    log::error!("pnpm version probe cleanup wait task failed: {error}");
                }
            }
        };
        let (killed, ()) = tokio::join!(killer, wait);
        if !matches!(killed, Ok(Ok(()))) {
            let reason = format!(
                "PNPM_PROBE_TREE_CLEANUP_FAILED: pnpm version probe process tree termination was not confirmed: {killed:?}"
            );
            log::error!("{reason}");
            super::super::process::mark_process_cleanup_failed(pending.owner, reason);
            // ponytail: 未确认整树清理仅重启恢复；需自动恢复再跟踪可靠进程树身份。
            std::future::pending::<()>().await;
        }
        wait_for_probe_cleanup(&pending).await;
        if super::super::process::process_cleanup_failure(pending.owner)
            .is_some_and(|reason| reason.starts_with("PNPM_PROBE_TREE_CLEANUP_FAILED:"))
        {
            std::future::pending::<()>().await;
        }
        pending.release();
    })
}

async fn wait_for_probe_cleanup(pending: &ProbeCleanupPending) {
    wait_for_probe_cleanup_with(
        || {
            !matches!(
                pending
                    .child
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .try_wait(),
                Ok(Some(_))
            )
        },
        PNPM_PROBE_LIVENESS_INTERVAL,
    )
    .await;
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

fn log_probe_fallback(pnpm: &Path, phase: &str, error: impl std::fmt::Display) {
    log::warn!(
        "pnpm version probe {phase} failed for {}: {error}; falling back to bundled pnpm",
        pnpm.display()
    );
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

/// 关闭 stdin 避免 Corepack 交互挂起（issue #449），注入选定 Node 避免陈旧 PATH（issue #182）。
fn pnpm_probe_command(
    pnpm: &Path,
    node: Option<&Path>,
    bin_dir: Option<&Path>,
) -> std::process::Command {
    let mut command = std::process::Command::new(pnpm);
    command.arg("--version");
    if let Some(path) = pnpm_probe_path(pnpm, node, bin_dir) {
        command.env("PATH", path);
    }
    // 探测必须与安装走同一套解析：`build_plugin_envs` 会把候选路径写进 `DSH_PNPM`
    // 并把桌面端 shim 目录前置，`dsh plugin` 经 PATH 命中的正是那个 shim。只测
    // 候选自身会漏掉这条间接层——探测顺利拿到版本，实际安装却在两个 shim 之间
    // 反复 exec 永不返回（症状：日志停在 `dsh plugin install started` 再无下文）。
    if bin_dir.is_some() {
        command.env("DSH_PNPM", pnpm);
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

/// 构建 pnpm 探测专用 PATH：**与 `build_plugin_envs` 同序**——桌面端 shim 目录
/// 首位，随后选定 Node 目录、用户 pnpm 所在目录，其余环境保留。
///
/// 顺序必须一致：安装子进程的 PATH 就是 `[bin_dir, node_dir, ...]`，`dsh plugin`
/// 的 `spawnSync("pnpm")` 命中的是 `bin_dir/pnpm`，而该 shim 只会按 `DSH_PNPM`
/// 或 PATH 继续转发。探测若把 `bin_dir` 排到用户 pnpm 之后，就可能解析出与真实
/// 安装不同的 pnpm（Corepack / 转发型 shim 尤其明显），使选出的主版本与实际安装
/// 的不一致；反过来，少了 `bin_dir` 这一层就会漏掉「按 PATH 解析回桌面 shim」的
/// 间接层，得出与安装相反的结论。
fn pnpm_probe_path(pnpm: &Path, node: Option<&Path>, bin_dir: Option<&Path>) -> Option<OsString> {
    let mut paths = Vec::new();
    if let Some(bin_dir) = bin_dir {
        paths.push(bin_dir.to_path_buf());
    }
    // 选定 Node 仍须位于 pnpm shim 目录之前：corepack 目录可能残留另一份 node，
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
    profile_store_major_at(&profile_dir(app_handle))
}

pub(crate) fn profile_store_major_at(profile_dir: &Path) -> Option<u32> {
    parse_store_major_from_modules_yaml(&read_modules_yaml_at(profile_dir)?)
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
    profile_store_base_dir_at(&profile_dir(app_handle))
}

pub(crate) fn profile_store_base_dir_at(profile_dir: &Path) -> Option<String> {
    let store_dir = parse_store_dir_from_modules_yaml(&read_modules_yaml_at(profile_dir)?)?;
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
fn read_modules_yaml_at(profile_dir: &Path) -> Option<String> {
    std::fs::read_to_string(profile_dir.join("node_modules").join(".modules.yaml")).ok()
}

/// 从 `.modules.yaml` 文本解析 `storeDir`（纯函数，便于单测）。
///
/// pnpm 落盘该文件可能是 YAML 块结构，也可能是 **JSON 流结构**（pnpm 11 实测输出
/// `{ "storeDir": "..." }`）。旧实现按行前缀匹配裸 `storeDir:`，遇到 JSON 形态
/// 恒定返回 None，于是 `profile_store_major` 永远未知：store 主版本选版、
/// `reset_incompatible_modules_metadata` 与 `pnpm_config_store_dir` 下传全部静默
/// 失效（症状是 `ensure_pnpm` 打「for plugin install」而不是「matching profile
/// store」、`build_plugin_envs` 从不打 store 固定日志）。JSON 是 YAML 的子集，
/// 统一按 YAML 解析即可覆盖两种形态；转义也交给解析器，不再手工替换 `\\`。
fn parse_store_dir_from_modules_yaml(content: &str) -> Option<String> {
    let value: serde_yaml::Value = serde_yaml::from_str(content).ok()?;
    let raw = value.get("storeDir")?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    Some(raw.to_string())
}

/// 从 `.modules.yaml` 文本解析 store 主版本（纯函数，便于单测）。
fn parse_store_major_from_modules_yaml(content: &str) -> Option<u32> {
    // storeDir 形如 `C:\Users\xx\AppData\Local\pnpm\store\v10`，取末段 `v10` 的数字
    let store_dir = parse_store_dir_from_modules_yaml(content)?;
    let major = store_dir.rsplit(['\\', '/']).next()?.strip_prefix('v')?;
    major.parse().ok()
}

/// 捆绑版 pnpm 的主版本（读 `dependencies/pnpm/package.json` 的 version 字段）；
/// 未安装或清单缺失返回 None。
///
/// 供 [`ensure_pnpm`] 选版与 [`crate::service::plugin::verify`] 的修复选版共用（store 主版本匹配）。
pub(crate) fn bundled_pnpm_major(app_handle: &AppHandle) -> Option<u32> {
    bundled_pnpm_major_at(&config::get_pnpm_install_path(app_handle))
}

pub(crate) fn bundled_pnpm_major_at(pnpm_root: &Path) -> Option<u32> {
    let content = std::fs::read_to_string(pnpm_root.join("package.json")).ok()?;
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
pub(crate) async fn harness_prefer_bundled_pnpm(app_handle: &AppHandle) -> Result<bool, String> {
    harness_prefer_bundled_pnpm_from(
        &profile_dir(app_handle),
        &config::get_pnpm_install_path(app_handle),
        &config::get_pnpm_binary_path(app_handle),
        cli::find_user_pnpm(app_handle).as_deref(),
        &config::get_node_binary_path(app_handle),
        &cli::get_bin_dir(app_handle),
    )
    .await
}

pub(crate) async fn harness_prefer_bundled_pnpm_from(
    profile_dir: &Path,
    pnpm_root: &Path,
    pnpm_binary: &Path,
    user_pnpm: Option<&Path>,
    node: &Path,
    bin_dir: &Path,
) -> Result<bool, String> {
    if !pnpm_binary.exists() {
        return Ok(false);
    }
    let store_major = profile_store_major_at(profile_dir);
    if store_major.is_some_and(|store| bundled_pnpm_major_at(pnpm_root) != Some(store)) {
        return Ok(false);
    }
    let user_major = match user_pnpm {
        Some(pnpm) => {
            pnpm_major_version_at_bounded(pnpm, Some(node), Some(bin_dir), new_process_owner())
                .await?
        }
        None => None,
    };
    Ok(match store_major {
        Some(store) => user_major != Some(store),
        None => !matches!(user_major, Some(major) if major >= MIN_TRUSTED_PNPM_MAJOR),
    })
}

#[cfg(test)]
mod tests {
    use super::super::super::process::TEST_PROCESS_LOCK;
    use super::*;

    #[tokio::test]
    async fn startup_pnpm_paths_reread_metadata_and_skip_unneeded_probes() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let modules = profile.join("node_modules").join(".modules.yaml");
        let pnpm_root = root.path().join("pnpm");
        let manifest = pnpm_root.join("package.json");
        let binary = pnpm_root.join("bin").join("pnpm.cjs");
        let user = root.path().join("must-not-be-probed");
        let node = root.path().join("node");
        let bin_dir = root.path().join("desktop-bin");
        std::fs::create_dir_all(modules.parent().unwrap()).unwrap();
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        let yaml = "storeDir: /store/v10\n";
        std::fs::write(&modules, yaml).unwrap();
        std::fs::write(&manifest, r#"{"version":"11.2.0"}"#).unwrap();
        assert_eq!(read_modules_yaml_at(&profile).as_deref(), Some(yaml));
        assert_eq!(profile_store_major_at(&profile), Some(10));
        assert_eq!(
            profile_store_base_dir_at(&profile).as_deref(),
            Some("/store")
        );
        assert_eq!(bundled_pnpm_major_at(&pnpm_root), Some(11));

        let process_guard = acquire_process_lock().await.unwrap();
        for present in [false, true] {
            if present {
                std::fs::write(&binary, "").unwrap();
            }
            let prefer = tokio::time::timeout(
                std::time::Duration::from_millis(100),
                harness_prefer_bundled_pnpm_from(
                    &profile,
                    &pnpm_root,
                    &binary,
                    Some(&user),
                    &node,
                    &bin_dir,
                ),
            )
            .await
            .expect("missing or incompatible bundled pnpm must not acquire the probe lock")
            .unwrap();
            assert!(!prefer);
        }
        drop(process_guard);

        for store in [11, 10] {
            let json = format!(r#"{{"storeDir":"/store/v{store}"}}"#);
            std::fs::write(&modules, &json).unwrap();
            assert_eq!(profile_store_major_at(&profile), Some(store));
            assert_eq!(
                profile_store_base_dir_at(&profile).as_deref(),
                Some("/store")
            );
            assert_eq!(
                harness_prefer_bundled_pnpm_from(
                    &profile, &pnpm_root, &binary, None, &node, &bin_dir,
                )
                .await
                .unwrap(),
                store == 11
            );
            assert_eq!(std::fs::read_to_string(&modules).unwrap(), json);
        }
        std::fs::write(&manifest, r#"{"version":"10.9.0"}"#).unwrap();
        assert_eq!(bundled_pnpm_major_at(&pnpm_root), Some(10));
        assert!(harness_prefer_bundled_pnpm_from(
            &profile, &pnpm_root, &binary, None, &node, &bin_dir,
        )
        .await
        .unwrap());
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

        let mut child = pnpm_probe_command(&pnpm, None, None)
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

    #[tokio::test]
    async fn exited_probe_releases_its_pid_and_process_guard() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        #[cfg(windows)]
        let mut child = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd.exe")
                .creation_flags(0x08000000)
                .args(["/D", "/C", "exit 0"])
                .spawn()
                .unwrap()
        };
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(child.wait().unwrap().success());
        let owner = super::super::super::process::new_process_owner();
        let pid_guard = PidGuard::set(owner, pid);
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let process_guard = lock.clone().lock_owned().await;
        assert!(lock.try_lock().is_err());
        cleanup_probe(
            ProbeCleanupPending {
                child: Arc::new(Mutex::new(child)),
                owner,
                _process_guard: process_guard,
                _pid_guard: pid_guard,
            },
            None,
            "PNPM_PROBE_WAIT_TASK_FAILED: test cleanup".to_string(),
        )
        .await
        .unwrap();
        assert_eq!(super::super::super::process::active_plugin_pid(owner), None);
        assert!(lock.try_lock().is_ok());
    }

    #[tokio::test]
    async fn live_probe_retains_its_pid_and_process_guard_until_exit() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new("cmd.exe");
            command
                .creation_flags(0x08000000)
                .args(["/D", "/C", "set /p token="]);
            command
        };
        #[cfg(not(windows))]
        let mut command = {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "read -r token"]);
            command
        };
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        let owner = super::super::super::process::new_process_owner();
        let pid_guard = PidGuard::set(owner, pid);
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let process_guard = lock.clone().lock_owned().await;
        let mut input = child.stdin.take().unwrap();
        let pending = ProbeCleanupPending {
            child: Arc::new(Mutex::new(child)),
            owner,
            _process_guard: process_guard,
            _pid_guard: pid_guard,
        };
        let release = async {
            wait_for_probe_cleanup(&pending).await;
            pending.release();
        };
        tokio::pin!(release);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut release)
                .await
                .is_err()
        );
        assert_eq!(
            super::super::super::process::active_plugin_pid(owner),
            Some(pid)
        );
        assert!(lock.try_lock().is_err());
        use std::io::Write;
        input.write_all(b"done\n").unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), &mut release)
            .await
            .unwrap();
        assert_eq!(super::super::super::process::active_plugin_pid(owner), None);
        assert!(lock.try_lock().is_ok());
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
    #[tokio::test]
    async fn pnpm_major_version_at_probes_the_exact_selected_path() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
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

        for (path, major) in [(&selected, 11), (&other, 10)] {
            assert_eq!(
                pnpm_major_version_at_bounded(path, None, None, new_process_owner())
                    .await
                    .unwrap(),
                Some(major)
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    /// 回归 Windows GUI 的陈旧 PATH：pnpm shim 必须解析到桌面端选定的 Node，
    /// 即使 shim 同目录存在冲突的 node，且路径包含空格和 shell 元字符。
    #[cfg(windows)]
    #[tokio::test]
    async fn pnpm_major_version_probe_injects_selected_node_for_cmd_shim() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
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
            pnpm_major_version_at_bounded(&selected, Some(&node), None, new_process_owner())
                .await
                .unwrap(),
            Some(11)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn pnpm_version_probe_bounds_slow_shims_and_releases_the_process_lock() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let root = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let pnpm = {
            let pnpm = root.path().join("slow pnpm.cmd");
            std::fs::write(
                &pnpm,
                "@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 20\"\r\necho 11.2.0\r\n",
            )
            .unwrap();
            pnpm
        };
        #[cfg(unix)]
        let pnpm = {
            use std::os::unix::fs::PermissionsExt;
            let pnpm = root.path().join("slow-pnpm");
            std::fs::write(&pnpm, "#!/bin/sh\nsleep 20\nprintf '11.2.0\\n'\n").unwrap();
            std::fs::set_permissions(&pnpm, std::fs::Permissions::from_mode(0o700)).unwrap();
            pnpm
        };
        let started = std::time::Instant::now();
        assert_eq!(
            pnpm_major_version_at_bounded(&pnpm, None, None, new_process_owner())
                .await
                .unwrap(),
            None
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(18));
        let process_guard =
            tokio::time::timeout(std::time::Duration::from_secs(1), acquire_process_lock())
                .await
                .expect("finished probe must release the process lock")
                .unwrap();
        drop(process_guard);
    }

    #[tokio::test]
    async fn cancelled_probe_keeps_its_pid_and_lock_until_the_child_exits() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let root = tempfile::tempdir().unwrap();
        let release = root.path().join("release");
        #[cfg(windows)]
        let pnpm = {
            let pnpm = root.path().join("held pnpm.cmd");
            let path = release.to_string_lossy().replace('\'', "''");
            std::fs::write(
                &pnpm,
                format!("@echo off\r\npowershell.exe -NoProfile -NonInteractive -Command \"while (-not (Test-Path -LiteralPath '{path}')) {{ Start-Sleep -Milliseconds 25 }}\"\r\necho 11.2.0\r\n"),
            )
            .unwrap();
            pnpm
        };
        #[cfg(unix)]
        let pnpm = {
            use std::os::unix::fs::PermissionsExt;
            let pnpm = root.path().join("held-pnpm");
            let path = release.to_string_lossy().replace('\'', "'\\''");
            std::fs::write(
                &pnpm,
                format!("#!/bin/sh\nwhile [ ! -f '{path}' ]; do sleep 0.025; done\nprintf '11.2.0\\n'\n"),
            )
            .unwrap();
            std::fs::set_permissions(&pnpm, std::fs::Permissions::from_mode(0o700)).unwrap();
            pnpm
        };
        let owner = new_process_owner();
        let caller =
            tokio::spawn(
                async move { pnpm_major_version_at_bounded(&pnpm, None, None, owner).await },
            );
        let pid = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Some(pid) = super::super::super::process::active_plugin_pid(owner) {
                    break pid;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        let retained_pid = super::super::super::process::active_plugin_pid(owner);
        let held_lock =
            tokio::time::timeout(std::time::Duration::from_millis(50), acquire_process_lock())
                .await;
        std::fs::write(release, "done").unwrap();
        let released =
            tokio::time::timeout(std::time::Duration::from_secs(5), acquire_process_lock())
                .await
                .unwrap()
                .unwrap();
        assert_eq!(retained_pid, Some(pid));
        assert!(
            held_lock.is_err(),
            "cancelled caller must not release a live probe lock"
        );
        assert_eq!(super::super::super::process::active_plugin_pid(owner), None);
        drop(released);
    }

    #[tokio::test]
    async fn cleanup_timeout_fails_closed_until_the_waiter_finishes() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        #[cfg(windows)]
        let mut child = {
            use std::os::windows::process::CommandExt;
            std::process::Command::new("cmd.exe")
                .creation_flags(0x08000000)
                .args(["/D", "/C", "exit 0"])
                .spawn()
                .unwrap()
        };
        #[cfg(unix)]
        let mut child = std::process::Command::new("sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        let owner = new_process_owner();
        let process_guard = acquire_process_lock().await.unwrap();
        let pending = ProbeCleanupPending {
            child: Arc::new(Mutex::new(child)),
            owner,
            _process_guard: process_guard,
            _pid_guard: PidGuard::set(owner, pid),
        };
        let (release, held) = tokio::sync::oneshot::channel::<()>();
        let waiter = tauri::async_runtime::spawn(async move {
            held.await.unwrap();
            Err(std::io::Error::other("probe output pipe closed"))
        });
        let started = std::time::Instant::now();
        let result = cleanup_probe(
            pending,
            Some(waiter),
            "PNPM_PROBE_WAIT_TASK_FAILED: held waiter".to_string(),
        )
        .await;
        let retained_pid = super::super::super::process::active_plugin_pid(owner);
        let blocked =
            tokio::time::timeout(std::time::Duration::from_millis(50), acquire_process_lock())
                .await;
        release.send(()).unwrap();
        let released = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while super::super::super::process::active_plugin_pid(owner).is_some() {
                tokio::task::yield_now().await;
            }
            acquire_process_lock().await
        })
        .await
        .unwrap()
        .unwrap();
        assert!(result
            .unwrap_err()
            .starts_with("PNPM_PROBE_CLEANUP_TIMEOUT:"));
        assert!(started.elapsed() < std::time::Duration::from_secs(7));
        assert_eq!(retained_pid, Some(pid));
        assert!(blocked
            .unwrap()
            .unwrap_err()
            .starts_with("PNPM_PROBE_WAIT_TASK_FAILED:"));
        assert_eq!(super::super::super::process::active_plugin_pid(owner), None);
        drop(released);
    }

    #[tokio::test]
    async fn failed_tree_termination_retains_guards_even_after_root_exit() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = std::process::Command::new("cmd.exe");
            command
                .creation_flags(0x08000000)
                .args(["/D", "/C", "set /p token="]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            use std::os::unix::process::CommandExt;
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "read -r token"]).process_group(0);
            command
        };
        let child = Arc::new(Mutex::new(
            command
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap(),
        ));
        let pid = child.lock().unwrap().id();
        let owner = new_process_owner();
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let pending = ProbeCleanupPending {
            child: child.clone(),
            owner,
            _process_guard: lock.clone().lock_owned().await,
            _pid_guard: PidGuard::set(owner, pid),
        };
        let waiting_child = child.clone();
        let waiter =
            tauri::async_runtime::spawn_blocking(move || wait_for_probe_output(&waiting_child));
        let mut monitor = monitor_probe_cleanup(
            pending,
            Some(waiter),
            "PNPM_PROBE_TIMEOUT: injected tree termination failure".to_string(),
            |_| false,
        );
        let exited = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            while child.lock().unwrap().try_wait().unwrap().is_none() {
                tokio::time::sleep(PNPM_PROBE_REAP_RETRY_INTERVAL).await;
            }
        })
        .await;
        let failure = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if let Err(reason) = acquire_process_lock().await {
                    if reason.starts_with("PNPM_PROBE_TREE_CLEANUP_FAILED:") {
                        break reason;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        let retained_pid = super::super::super::process::active_plugin_pid(owner);
        let lock_held = lock.try_lock().is_err();
        let retained = tokio::time::timeout(std::time::Duration::from_millis(50), &mut monitor)
            .await
            .is_err();
        if retained {
            monitor.abort();
            let _ = monitor.await;
        }
        super::super::super::process::clear_process_cleanup_failed(owner);
        if exited.is_err() {
            let mut child = child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(
            exited.is_ok(),
            "root fallback must kill the real probe child"
        );
        assert!(
            failure.is_ok(),
            "root exit must not clear unconfirmed tree cleanup"
        );
        assert!(retained, "tree failure must retain the cleanup monitor");
        assert!(lock_held, "tree failure must retain the process guard");
        assert_eq!(retained_pid, Some(pid));
        assert_eq!(super::super::super::process::active_plugin_pid(owner), None);
        assert!(lock.try_lock().is_ok());
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

    /// 回归：pnpm 11 把 `.modules.yaml` 写成 JSON 流结构（`"storeDir": "..."`）。
    /// 旧实现按行前缀匹配裸 `storeDir:`，对真实文件恒定失败，导致 store 主版本
    /// 感知、元数据重置与 store 下传全部静默失效。
    #[test]
    fn store_dir_parsed_from_json_modules_yaml() {
        let content = r#"{
  "hoistPattern": [
    "*"
  ],
  "layoutVersion": 5,
  "storeDir": "/Users/ruan/Library/pnpm/store/v11",
  "virtualStoreDir": "node_modules/.pnpm"
}"#;
        assert_eq!(
            parse_store_dir_from_modules_yaml(content).as_deref(),
            Some("/Users/ruan/Library/pnpm/store/v11")
        );
        assert_eq!(parse_store_major_from_modules_yaml(content), Some(11));

        // JSON 双引号里的 `\\` 由解析器还原为单个反斜杠（Windows 档案同样命中）。
        let windows = r#"{"storeDir": "C:\\Users\\test\\AppData\\Local\\pnpm\\store\\v10"}"#;
        assert_eq!(
            parse_store_dir_from_modules_yaml(windows).as_deref(),
            Some(r"C:\Users\test\AppData\Local\pnpm\store\v10")
        );
        assert_eq!(parse_store_major_from_modules_yaml(windows), Some(10));

        // 合法 JSON 但没有 storeDir（或值不是字符串）→ 仍视为未知
        assert_eq!(parse_store_dir_from_modules_yaml("{}"), None);
        assert_eq!(
            parse_store_dir_from_modules_yaml(r#"{"storeDir": 5}"#),
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
        assert_eq!(
            strip_store_version("D:\\.pnpm-store\\v3"),
            "D:\\.pnpm-store"
        );
    }

    #[test]
    fn store_base_dir_keeps_paths_without_version_segment() {
        // 末尾不是 v<数字>：原样返回，避免把用户自定的 store 目录名吃掉
        assert_eq!(
            strip_store_version("C:\\Users\\x\\pnpm\\store"),
            "C:\\Users\\x\\pnpm\\store"
        );
        assert_eq!(
            strip_store_version("/mnt/pnpm-store-v10"),
            "/mnt/pnpm-store-v10"
        );
        assert_eq!(strip_store_version("/mnt/v-store"), "/mnt/v-store");
        assert_eq!(strip_store_version("v10"), "v10");
        assert_eq!(strip_store_version(""), "");
    }

    /// 探测 PATH 必须与 `build_plugin_envs`（安装子进程）同序：桌面端 shim 目录在
    /// 首位，然后才是选定 Node 与用户 pnpm 所在目录。顺序不一致时探测与安装可能
    /// 解析到不同的 pnpm，`ensure_pnpm` 据探测结果选出的主版本与实际安装的不相符。
    #[test]
    fn probe_path_puts_desktop_shim_dir_first() {
        let path = pnpm_probe_path(
            Path::new("/user/bin/pnpm"),
            Some(Path::new("/opt/node/bin/node")),
            Some(Path::new("/desktop/bin")),
        )
        .unwrap();
        let entries: Vec<String> = std::env::split_paths(&path)
            .map(|entry| entry.to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries[0], "/desktop/bin");
        assert_eq!(entries[1], "/opt/node/bin");
        assert_eq!(entries[2], "/user/bin");
    }

    /// 不注入桌面 shim 目录（按精确路径探测）时保持原有顺序，不凭空插入空目录。
    #[test]
    fn probe_path_without_bin_dir_keeps_node_first() {
        let path = pnpm_probe_path(
            Path::new("/user/bin/pnpm"),
            Some(Path::new("/opt/node/bin/node")),
            None,
        )
        .unwrap();
        let entries: Vec<String> = std::env::split_paths(&path)
            .map(|entry| entry.to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries[0], "/opt/node/bin");
        assert_eq!(entries[1], "/user/bin");
    }
}
