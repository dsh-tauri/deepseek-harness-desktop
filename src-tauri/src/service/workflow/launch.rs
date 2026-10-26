//! Harness 服务启动编排：`start` / `restart` / `launch`，含端口自愈
//! （避让递增 + 回落、等待释放）、补丁挂点与 Windows 隐藏控制台启动。

use crate::config;
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, OnceLock};
use tauri::Manager;

#[cfg(unix)]
use super::process::warn_if_inotify_watch_limit_low;
use super::process::{
    has_owned_process, launch_guard, on_owned_process_exit_at, register_owned_process, stop,
    take_startup_sweep, terminate_stale_harness_processes, LaunchGuard, OwnedProcess,
    HARNESS_PROCESS_EXITED_EVENT,
};
use super::status;
#[cfg(windows)]
use super::sweep::{dsh_bin_open_error, relaunch_marker_path, relaunch_via_shell_escape};
use super::utils::{append_log, rotate_service_log, spawn_output_readers, wait_for_port_release};
use super::win_inspector;

#[cfg(windows)]
type HarnessChild = std::sync::Arc<std::os::windows::io::OwnedHandle>;
#[cfg(unix)]
type HarnessChild = std::process::Child;

pub(super) struct LaunchPlan {
    pub(super) setting: config::Setting,
    pub(super) profile: String,
    pub(super) node: PathBuf,
    pub(super) dsh_binary: PathBuf,
    pub(super) core_dir: PathBuf,
    pub(super) profile_root: PathBuf,
    pub(super) dsh_home: PathBuf,
    pub(super) base: PathBuf,
    pub(super) bin_dir: PathBuf,
    pub(super) pnpm_root: PathBuf,
    pub(super) pnpm_binary: PathBuf,
    pub(super) pid_path: PathBuf,
    pub(super) resources: Option<PathBuf>,
    pub(super) git_dir: Option<PathBuf>,
    pub(super) user_pnpm: Option<PathBuf>,
}

/// 端口释放等待上限：刚结束/清扫过上个会话的残留 dsh 进程后，TCP 端口释放
/// 存在短暂滞后（taskkill 返回 ≠ 端口已可复用）。等待窗口内端口回落为空闲则
/// 复用配置端口；到期仍未释放才按“真占用”逐级递增。
const PORT_RELEASE_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

#[cfg(target_os = "linux")]
fn harness_library_path(
    appdir: Option<&std::ffi::OsStr>,
    library_path: Option<&std::ffi::OsStr>,
) -> Option<OsString> {
    use std::os::unix::ffi::OsStrExt;

    let library_path = library_path?;
    let Some(appdir) = appdir.filter(|path| !path.is_empty()) else {
        return Some(library_path.to_os_string());
    };
    Some(
        std::env::join_paths(
            library_path
                .as_bytes()
                .split(|byte| matches!(*byte, b':' | b';'))
                .map(|path| Path::new(std::ffi::OsStr::from_bytes(path)))
                .filter(|path| !path.starts_with(Path::new(appdir))),
        )
        .expect("split Linux library paths contain no path separator"),
    )
}

fn fatal_report_path(log_path: &Path) -> PathBuf {
    static NEXT_REPORT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_REPORT.fetch_add(1, Ordering::Relaxed);
    log_path.with_file_name(format!(
        "harness-fatal-{}-{timestamp}-{sequence}.json",
        std::process::id()
    ))
}

fn log_fatal_report(log_path: &PathBuf, report_path: &Path) {
    if report_path.is_file() {
        let line = format!("ERROR HARNESS_FATAL_REPORT: {}", report_path.display());
        append_log(log_path, &line);
        log::error!("{line}");
    }
}

fn build_harness_args(
    dsh_binary: &Path,
    profile: &str,
    patch: Option<&Path>,
    port: u16,
    heap_mb: Option<u32>,
    report_path: &Path,
) -> Vec<OsString> {
    let mut args = Vec::with_capacity(12);
    args.extend(super::heap::heap_option_arg(heap_mb));
    let mut directory = OsString::from("--report-directory=");
    directory.push(report_path.parent().unwrap_or(Path::new(".")));
    let mut filename = OsString::from("--report-filename=");
    filename.push(report_path.file_name().unwrap_or_default());
    args.extend([
        OsString::from("--report-on-fatalerror"),
        directory,
        filename,
    ]);
    args.extend([
        dsh_binary.as_os_str().to_os_string(),
        OsString::from("--profile"),
        OsString::from(profile),
    ]);
    if let Some(patch) = patch {
        args.push(OsString::from("--patch"));
        args.push(patch.as_os_str().to_os_string());
    }
    args.extend([
        OsString::from("--port"),
        OsString::from(port.to_string()),
        OsString::from("--no-open"),
    ]);
    args
}

/// 从起始端口向上查找第一个空闲端口，绝不结束未知的端口占用进程。
fn find_available_port(start: u16, dsh_binary: &Path) -> Result<u16, String> {
    find_available_port_by(start, |port| {
        prepare_port(dsh_binary, port).map(|free| !free)
    })
}

fn prepare_port(dsh_binary: &Path, port: u16) -> Result<bool, String> {
    if !super::utils::is_port_in_use(port) {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        super::process::reclaim_orphan_port(dsh_binary, port)
    }
    #[cfg(not(windows))]
    {
        let _ = dsh_binary;
        log::warn!(
            "PORT_OWNER: port={port} pid={:?} ownership=unknown",
            super::sweep::port_owner_pid(port)
        );
        Ok(false)
    }
}

/// 按调用方提供的占用判定查找第一个空闲端口。
///
/// 将扫描决策与真实套接字状态分离，使单测能确定性验证递增与溢出，不在函数
/// 返回后再次探测系统端口；后者存在不可消除的 TOCTOU，任何端口段都可能被
/// 其他进程在两次探测之间占用。
fn find_available_port_by(
    start: u16,
    mut is_in_use: impl FnMut(u16) -> Result<bool, String>,
) -> Result<u16, String> {
    let mut port = start;
    loop {
        if !is_in_use(port)? {
            return Ok(port);
        }
        log::warn!("Port {port} is occupied, trying the next port");
        port = port.checked_add(1).ok_or_else(|| {
            "PORT_EXHAUSTED: no available TCP port after the configured port".to_string()
        })?;
    }
}

/// 启动时端口自愈决策（纯函数，便于单测）。
///
/// 自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口只在回落目标
/// （用户手动端口或默认端口）空闲时才回落；回落目标被占则维持当前端口，
/// 留给 `find_available_port` 逐级递增。用户手动设置的端口经 `manual_port`
/// 记录，回落目标即用户值；从未手动设置时回落目标是默认端口（3080/3081）。
/// 返回值与 `configured` 相同表示无需自愈。
fn resolve_heal_port(configured: u16, heal_target: u16, heal_target_free: bool) -> u16 {
    if configured != heal_target && heal_target_free {
        heal_target
    } else {
        configured
    }
}

pub(super) fn attach_requested(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("true"))
}

async fn attachable_core(port: u16) -> bool {
    super::utils::is_port_in_use(port) && super::utils::is_dsh_running(port).await
}

/// 检测并启动 Harness 服务
pub async fn start(app_handle: tauri::AppHandle) -> Result<(), String> {
    super::early::wait_preparation().await?;
    let setting = config::get_store_dat_setting(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    // 活动核心的入口：本地核心存在时优先本地（需求 3），否则预打包
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    if !setting.installed {
        log::debug!("Harness not installed, skipping startup");
        return Ok(());
    }
    if !node_binary_path.exists() || !dsh_binary_path.exists() {
        // Windows RedirectionGuard(448)：安装器继承的强制执行上下文永不自行恢复，
        // 先尝试通过 explorer 逃逸重拉（见 relaunch_via_shell_escape 注释），
        // 成功则本进程退出；未命中（重拉未逃逸/非 448）才走常规缺失处理。
        #[cfg(windows)]
        if dsh_bin_open_error(&app_handle) == Some(448) {
            relaunch_via_shell_escape(&app_handle);
        }
        let mut setting = config::get_store_dat_setting(&app_handle);
        setting.installed = false;
        config::set_store_dat_setting(&app_handle, setting);
        // 状态变更需要 info 级落盘：这是「store 显示未安装」的源头之一
        // （核心文件短暂缺失被复位），自更新后自动重开走进安装分支多由此触发。
        log::info!("Runtime files missing (node/dsh), resetting installed flag");
        return Ok(());
    }

    if has_owned_process() {
        log::info!("Owned Harness process is already running");
        status::set_status(status::Status::Running);
        status::emit_status(&app_handle);
        return Ok(());
    }

    let port = super::instances::port(&app_handle);
    if attach_requested(std::env::var("DSH_DESKTOP_ATTACH").ok().as_deref())
        && attachable_core(port).await
    {
        log::info!("Attaching to the running Harness on port {port} (issue #1235)");
        super::instances::set_attached_core(true);
        status::set_status(status::Status::Running);
        status::emit_status(&app_handle);
        return Ok(());
    }

    super::process::decline_attach();

    // 清理 RedirectionGuard(448) 逃逸重拉标记：本进程正常走到启动说明处于干净上下文，
    // 移除标记保证下次自更新后仍能触发逃逸重拉。
    #[cfg(windows)]
    let _ = std::fs::remove_file(relaunch_marker_path(&app_handle));

    log::info!("Starting Harness service");
    status::set_status(status::Status::Starting);
    status::emit_status(&app_handle);
    launch(app_handle).await?;
    // 之后由 scheduler/task/tick_check_dsh_process/mod.rs 检测状态

    Ok(())
}

/// 重启 Harness 服务
pub async fn restart(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Restarting Harness service");

    // 1. 停止现有服务
    stop(app_handle.clone()).await?;

    // 2. 重新启动
    start(app_handle).await?;

    Ok(())
}

/// 把 active profile 的 `cordis.yml` 重置为官方空根。
///
/// dsh 的 Loader 在插件 dispose 时会把组合后的整棵 entry 树回写进
/// `cordis.yml`（dsh-app-boot：plugin self-disposing persists the current
/// tree）。上一轮被杀/崩溃的 dsh 若留下组合行，新 boot 会读到已含 bundle 行的
/// 文件，再叠加同一批 patch → `duplicate loader entry`。spawn 前与「早期退出
/// 重试」各调用一次，把竞态窗口关闭到最小；文件已是空根时静默跳过。
fn reset_active_profile_root(profile_root: &Path) {
    if !profile_root.is_dir() {
        return;
    }
    let root_config = profile_root.join("cordis.yml");
    const PROFILE_ROOT_EMPTY: &str = "# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n";
    if std::fs::read_to_string(&root_config).ok().as_deref() != Some(PROFILE_ROOT_EMPTY) {
        if let Err(e) = std::fs::write(&root_config, PROFILE_ROOT_EMPTY) {
            log::warn!("PROFILE_ROOT_RESET_FAILED: {}: {e}", root_config.display());
        } else {
            log::info!(
                "Reset stale profile root before spawn: {}",
                root_config.display()
            );
        }
    }
}

fn wait_harness(
    child: &mut HarnessChild,
    timeout: Option<std::time::Duration>,
) -> Result<Option<Option<i64>>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, WaitForSingleObject, INFINITE,
        };

        let handle = child.as_raw_handle();
        let millis = timeout.map_or(INFINITE, |value| value.as_millis() as u32);
        match unsafe { WaitForSingleObject(handle, millis) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                Ok(Some(
                    (unsafe { GetExitCodeProcess(handle, &mut code) } != 0)
                        .then_some(i64::from(code)),
                ))
            }
            _ => Err(format!(
                "PROCESS_WAIT_FAILED: {}",
                std::io::Error::last_os_error()
            )),
        }
    }
    #[cfg(unix)]
    {
        let Some(timeout) = timeout else {
            return child
                .wait()
                .map(|exit| Some(exit.code().map(i64::from)))
                .map_err(|error| format!("PROCESS_WAIT_FAILED: {error}"));
        };
        let deadline = std::time::Instant::now() + timeout;
        loop {
            match child.try_wait() {
                Ok(Some(exit)) => return Ok(Some(exit.code().map(i64::from))),
                Ok(None) if std::time::Instant::now() >= deadline => return Ok(None),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                Err(error) => return Err(format!("PROCESS_WAIT_FAILED: {error}")),
            }
        }
    }
}

fn supervise_harness(
    mut on_exit: impl FnMut(u32, Option<i64>, Option<&Path>),
    log_path: &PathBuf,
    started: &mut Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
    guards: (LaunchGuard, tokio::sync::OwnedMutexGuard<()>),
    mut spawn: impl FnMut(
        &Path,
    ) -> Result<
        (
            OwnedProcess,
            HarnessChild,
            std::io::Result<std::sync::mpsc::Receiver<bool>>,
        ),
        String,
    >,
    mut reset: impl FnMut(),
    mut persist: impl FnMut(u32),
) -> Result<(), String> {
    let mut guards = Some(guards);
    let mut previous_exit = None;
    for attempt in 1..=3 {
        let report_path = fatal_report_path(log_path);
        let registered = register_owned_process(previous_exit.map(|(pid, _)| pid), || {
            if previous_exit.is_some() {
                reset();
            }
            let (owned, child, signature) = spawn(&report_path)?;
            #[cfg(unix)]
            let mut child = child;
            let pid = owned.pid;
            let signature = match signature {
                Ok(signature) => {
                    persist(pid);
                    Ok(signature)
                }
                Err(error) => {
                    let error = format!("PROCESS_START_FAILED: spawn output reader: {error}");
                    #[cfg(windows)]
                    let cleanup = {
                        use std::os::windows::io::AsRawHandle;
                        super::process::terminate_windows_process(
                            pid,
                            child.as_raw_handle(),
                            super::process::kill_pid_tree,
                        )
                    };
                    #[cfg(unix)]
                    let cleanup = (|| {
                        if child.try_wait()?.is_none() {
                            // 线程耗尽时不依赖再创建外部 kill 进程；未 reap 的 PID 不会复用。
                            unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) };
                            if let Err(kill) = child.kill() {
                                if child.try_wait()?.is_none() {
                                    return Err(kill);
                                }
                            }
                        }
                        child.wait().map(|_| ())
                    })()
                    .map_err(|cleanup: std::io::Error| {
                        format!("HARNESS_CLEANUP_FAILED: process {pid}: {cleanup}")
                    });
                    match cleanup {
                        Ok(()) => return Err(error),
                        Err(cleanup) => Err(format!("{error}; {cleanup}")),
                    }
                }
            };
            Ok((owned, (pid, child, signature)))
        });
        let (pid, mut child, signature) = match registered {
            Ok(Some(process)) => process,
            Ok(None) => return Err("STARTUP_CANCELLED: Harness launch was stopped".into()),
            Err(error) => {
                if let Some((pid, code)) = previous_exit {
                    on_exit(pid, code, None);
                }
                return Err(error);
            }
        };
        let signature = signature?;
        log::info!("Harness process spawned and registered: pid={pid}, attempt={attempt}");
        if let Some(started) = started.take() {
            let _ = started.send(Ok(()));
        }
        let mut wait = |timeout| {
            let result = wait_harness(&mut child, timeout);
            if let Err(error) = &result {
                log::error!(
                    "{error}; terminating this Harness process before releasing its monitor"
                );
                #[cfg(windows)]
                {
                    use std::os::windows::io::AsRawHandle;
                    super::process::terminate_windows_process(
                        pid,
                        child.as_raw_handle(),
                        super::process::kill_pid_tree,
                    )?;
                }
                #[cfg(unix)]
                {
                    super::process::kill_pid_tree(pid);
                    child
                        .wait()
                        .map_err(|cleanup| format!("{error}; cleanup failed: {cleanup}"))?;
                }
                on_exit(pid, None, Some(&report_path));
            }
            result
        };
        let code = match wait(Some(std::time::Duration::from_millis(2500)))? {
            Some(code) => code,
            None => {
                let (launch, transition) = guards.take().unwrap();
                drop(launch);
                drop(transition);
                let code = wait(None)?.flatten();
                on_exit(pid, code, Some(&report_path));
                return Ok(());
            }
        };
        // 子孙进程可能继承 stderr 写端；只等本轮签名，不能等无界 EOF。
        let duplicate = matches!(
            signature.recv_timeout(std::time::Duration::from_millis(250)),
            Ok(true)
        );
        if code == Some(1) && duplicate && attempt < 3 {
            log_fatal_report(log_path, &report_path);
            log::warn!(
                "DUPLICATE_LOADER_ENTRY: dsh exited early with duplicate loader entry \
                 (pid={pid}, code=1); resetting profile root and relaunching (attempt {attempt}/3)"
            );
            previous_exit = Some((pid, code));
            continue;
        }
        on_exit(pid, code, Some(&report_path));
        return Ok(());
    }
    unreachable!()
}

/// 启动 Harness 服务进程
pub async fn launch(app_handle: tauri::AppHandle) -> Result<(), String> {
    super::early::wait_preparation().await?;
    // 启动分段计时（issue #766）：只写日志，不改控制流。每段一行 `STARTUP_PHASE`，
    // `ms` 是本段耗时、`total` 是本次 launch 的累计耗时。启动慢的归因过去只能靠
    // 时间戳猜测（同一进程内 auto_start 与前端 invoke 并发交错），埋点后可直接
    // 从 desktop.log 读出「哪一段慢、慢多少」。
    let startup_started = std::time::Instant::now();
    let mut phase_started = startup_started;
    // 段末打点：`ms` 为上一段耗时，`total` 为 launch 累计。closure 只服务本函数，
    // 因此就地定义而不抽成独立模块/工具。
    let mark_phase = |name: &str, phase_started: &mut std::time::Instant| {
        let now = std::time::Instant::now();
        log::info!(
            "STARTUP_PHASE: name={name} ms={} total={}",
            now.duration_since(*phase_started).as_millis(),
            now.duration_since(startup_started).as_millis()
        );
        *phase_started = now;
    };
    let mut setting = config::get_store_dat_setting(&app_handle);
    setting.port = super::instances::port(&app_handle);
    let node_binary_path = config::get_node_binary_path(&app_handle);
    let transition = super::process::acquire_core_transition();
    tokio::pin!(transition);
    let _transition_guard = loop {
        if launch_guard().load(Ordering::SeqCst) && has_owned_process() {
            return Ok(());
        }
        tokio::select! {
            guard = &mut transition => break guard?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(20)) => {}
        }
    };
    let dsh_binary_path = crate::service::core::active_dsh_binary(&app_handle);

    log::debug!("Checking Node.js path: {:?}", node_binary_path);
    if !node_binary_path.exists() {
        log::error!("Node.js not installed");
        return Err("NODE_NOT_FOUND: Node.js not installed".to_string());
    }
    log::debug!("Checking Harness path: {:?}", dsh_binary_path);
    if !dsh_binary_path.exists() {
        log::error!("Harness not installed");
        return Err("HARNESS_NOT_FOUND: Harness not installed".to_string());
    }
    mark_phase("resolve", &mut phase_started);

    // 从这里开始持有与核心切换共用的互斥锁：最终状态检查、启动守卫、残留清扫
    // 及新进程登记必须处于同一临界区，避免切换在检查后插入。

    // 避免重复启动（配合启动守卫，确保并发调用只拉起一个进程）
    if has_owned_process() {
        log::info!("Owned Harness process is already running, skipping launch");
        return Ok(());
    }
    if launch_guard()
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        log::info!("Harness launch already in progress, skipping");
        return Ok(());
    }
    let _launch_guard = LaunchGuard(launch_guard());
    // 只有持有启动守卫的这条路径清扫残留：并发启动的其它调用已在守卫处返回，
    // 不会误杀刚拉起的进程。崩溃/强杀残留的孤儿 Harness 实例（不在
    // .harness.pid 标记中）持续占用配置端口与 dependencies/dsh 的文件句柄，
    // 不清扫会导致端口一路漂移（3080→…→3085，issue #91）并让后续目录互换
    // 失败（os error 32）。按命令行路径精确匹配本应用 dsh 服务，不会误杀
    // 用户其它 node 程序。
    //
    // setup 阶段（workflow::sweep_orphan_harness）已在本次启动里清扫过一次，
    // 期间本应用没有拉起任何进程，重复枚举同一份快照没有新结论（Windows 上
    // 一次全量枚举约 0.3–0.6s），因此只在尚未清扫时才执行。
    {
        let handle = app_handle.clone();
        let profile = crate::service::profile::active_profile(&app_handle);
        tauri::async_runtime::spawn_blocking(move || {
            super::instances::scope_sync(profile, || {
                if take_startup_sweep() {
                    let result = terminate_stale_harness_processes(&handle);
                    if result.is_err() {
                        super::process::retry_startup_sweep();
                    }
                    result
                } else {
                    log::debug!(
                        "Skipping pre-launch stale Harness sweep: already swept during this launch"
                    );
                    Ok(())
                }
            })
        })
        .await
        .map_err(|error| format!("HARNESS_SWEEP_FAILED: {error}"))??;
    }

    // 端口自愈：自动避让递增（配置端口被占 → 逐级顶高）遗留的非默认端口，
    // 在回落目标（用户手动端口 manual_port，否则默认端口）空闲时回落，避免
    // 端口只增不减、一路从 3080 漂到 3084+（issue #91）。先于
    // wait_for_port_release 探测：既然放弃旧端口，就无需等它释放。
    let heal_target = setting.manual_port.unwrap_or(config::default_port());
    let entry = dsh_binary_path.clone();
    let profile = crate::service::profile::active_profile(&app_handle);
    let heal_target_free = tauri::async_runtime::spawn_blocking(move || {
        super::instances::scope_sync(profile, || {
            wait_for_port_release(heal_target, PORT_RELEASE_WAIT);
            prepare_port(&entry, heal_target)
        })
    })
    .await
    .map_err(|error| format!("HARNESS_CLEANUP_FAILED: {error}"))??;
    let healed_port = resolve_heal_port(setting.port, heal_target, heal_target_free);
    if healed_port != setting.port {
        log::info!(
            "Harness port healed from {} back to {} (no longer occupied)",
            setting.port,
            healed_port
        );
        setting.port = healed_port;
        super::instances::set_port(setting.port);
    }

    // 端口冲突时从当前值开始逐个递增，并持久化最终选择供所有调用方复用。
    // 注意：上个会话的残留 dsh 进程刚被我们结束/清扫（sweep_orphan、stop、
    // stop_on_exit），TCP 端口释放存在短暂滞后——此刻立刻探测会把“刚释放的
    // 端口”误判为仍占用，从而把配置端口永久顶高（dev 热更新下 3081→3082→…
    // 一路漂移，表现为“端口持续累加 + 首次启动超时、刷新后恢复”）。先留出
    // 窗口等配置端口回落为空闲，再决定是否真的逐级递增。
    // 有界轮询是阻塞等待，交给阻塞线程池，避免占用启动所在的 Tokio 执行线程。
    let port = setting.port;
    let entry = dsh_binary_path.clone();
    let profile = crate::service::profile::active_profile(&app_handle);
    let available_port = tauri::async_runtime::spawn_blocking(move || {
        super::instances::scope_sync(profile, || {
            if port != heal_target {
                wait_for_port_release(port, PORT_RELEASE_WAIT);
            }
            find_available_port(port, &entry)
        })
    })
    .await
    .map_err(|error| format!("HARNESS_CLEANUP_FAILED: {error}"))??;
    if available_port != setting.port {
        log::info!(
            "Harness port changed from {} to {} because the configured port is occupied",
            setting.port,
            available_port
        );
        setting.port = available_port;
        super::instances::set_port(setting.port);
    }
    super::instances::set_port(setting.port);
    mark_phase("stale_sweep_and_port", &mut phase_started);

    // 构造环境变量：隔离的 $DSH_HOME + 隐私默认（关闭遥测）
    //
    // 建目录 + 可写性预检（issue #466）：`~/.dsh` 属主不是当前用户时（典型：此前
    // 用 sudo 运行过 dsh，macOS 的 sudo 保留 $HOME），读得到、写不了——dsh 起来后
    // 必然崩在写 cordis.yml/settings.yaml 上，前端只能看到
    // 「Harness exited early: exit status: 1」，完全不可行动。这里提前阻断并给出
    // 可直接粘贴的 chown 指引。
    let dsh_home = config::get_dsh_data_path(&app_handle);
    crate::service::perm::ensure_dir_writable(&dsh_home, "DSH_HOME_MKDIR_FAILED")?;
    // 当前档案目录同样必须在 spawn 前可写：`$DSH_HOME` 可写不代表档案可写——属主
    // 错位可能只落在 `profiles` 或 `profiles/<id>` 上（安全模式要新建 `profiles/safe`，
    // 因此 `profiles` 不可写同样是致命状态）。
    //
    // 先跑一次档案迁移 + 首装引导（幂等）：desktop::setup 的引导若失败（磁盘/权限
    // 抖动）或本进程没进过 setup，这里兜底；改名必须早于可写性预检，否则预检拿到的
    // 还是改名前的档案目录。最佳努力：失败只告警，不阻断启动。
    crate::service::profile::migrate_desktop_profile_name(&app_handle);

    // 预检不创建目录，避免抢先建出半初始化档案（issue #452）。
    crate::service::perm::ensure_writable_path(
        &crate::service::plugin::profile_dir(&app_handle),
        &dsh_home,
        "PROFILE_NOT_WRITABLE",
    )?;

    // 核心 bundle 层自愈（issue #452）：当前档案的 `dsh.profile.bundles` 必须带
    // 桌面端内嵌 web UI 依赖的 `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`
    // （顺序即补丁层应用顺序）。档案目录被 CLI/外部初始化过（`dsh plugin add`
    // 对无清单目录只写 dsh-base）、首次初始化中途失败、用户手工编辑清单都会剥掉
    // web 层，此时宿主不提供 webServer/connection/webRuntime，内置插件与市场插件
    // 全部停在 pending，服务启动必然失败——日志只显示「N entries did not
    // activate / waiting for service: webServer」，看不出根因。缺失时按官方 web
    // 模板补齐（只补不删，用户插件条目原样保留），本轮启动即可恢复。必须在
    // 任何插件操作与 spawn 之前做。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = crate::service::profile::ensure_active_profile_core_bundles(&app_handle) {
        log::warn!("ensure active profile core bundles failed: {e}");
    }

    // 安全模式：安全档案的契约是「只加载 web 模板核心 bundles、不带任何用户插件」，
    // 但档案目录一旦存在就绝不重建（用户可能反复进出安全模式），而内置插件自愈与
    // 首次引导安装都作用于「当时的活动档案」，于是安全档案里会累积用户插件——它们
    // 往往正是启动失败的元凶，不清干净的话每次进入安全模式都带着同一批插件重启，
    // 隔离形同虚设。必须在 spawn dsh 之前做（服务未运行时改清单、删 node_modules
    // 目录才安全）。内置插件与核心包由被调方保留；非安全档案直接跳过。最佳努力：
    // 失败只告警，不阻断启动（清理不彻底只是隔离效果打折，启动阻塞则让应用彻底不可用）。
    if let Err(e) = crate::service::plugin::purge_user_plugins_in_safe_profile(&app_handle) {
        log::warn!("safe mode user plugin purge failed: {e}");
    }
    mark_phase("profile_prepare", &mut phase_started);

    // Linux 起步前探测 inotify 监视上限：harness 服务（dsh web）用 chokidar 递归
    // 监视 profile 目录，上限过低会在启动一瞬间抛 ENOSPC 直接退出（issue #116）。
    // 进程无法自我调高该参数，这里只做告警（启动日志 + 读取 run logs 中的环境信息），
    // 前端据服务日志的 ENOSPC 特征给出「调高 fs.inotify.max_user_watches」的针对性提示。
    #[cfg(unix)]
    warn_if_inotify_watch_limit_low();

    // Windows：剥离历史遗留的 `dsh-win-terminal-inspector` 注入行（幂等，官方核心
    // 自 0.1.0-rc.8 起内置 inspector）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = win_inspector::apply(&app_handle) {
        log::warn!("win32 legacy patch cleanup failed: {e}");
    }
    // renderer 的 SlotOutlet 一行导出补丁（dsh-tauri-ui 设置侧边栏依赖）：只补
    // 活动核心的 dsh-client-ui-renderer lib/client.js，已含导出即跳过（幂等；核心
    // 换版本后自动重打，上游官方导出后自动退休）。最佳努力：失败只告警，不阻断
    // 启动——未打补丁时插件侧降级，官方设置 dialog 照常工作，绝不白屏。
    if let Err(e) = crate::service::patch::renderer::apply(&app_handle) {
        log::warn!("renderer SlotOutlet patch failed: {e}");
    }
    // composer 可用性：官方 ConversationRoot 对「不属于任何工作区的空白会话」把
    // composer 换成「选择工作区」触发器（`inert` 只看 chipTitle，而 chipTitle 只来自
    // 工作区），于是 dsh-tauri-ui 的「未分组」新会话无法输入。补丁放宽该判定（会话已有
    // cwd 即不算 inert）并写入 `data-dsh-composer-cwd` 能力标记；标记缺失时插件侧按
    // 退级策略禁用「未分组」入口并告警。最佳努力且幂等：锚点缺失安全跳过。
    if let Err(e) = crate::service::patch::composer::apply(&app_handle) {
        log::warn!("composer workspace-less patch failed: {e}");
    }
    if let Err(e) = crate::service::patch::conversation_draft::apply(&app_handle) {
        log::warn!("conversation draft compatibility patch failed: {e}");
    }
    if let Err(e) = crate::service::patch::permission_settings::apply(&app_handle) {
        log::warn!("permission settings error patch failed: {e}");
    }
    if let Err(e) = crate::service::patch::scroll_follow::apply(&app_handle) {
        log::warn!("Scroll follow reduced-motion patch skipped: {e}");
    }
    if let Err(e) = crate::service::patch::chat_follow_anchor::apply(&app_handle) {
        log::warn!("Chat follow anchor patch skipped: {e}");
    }
    if let Err(e) = crate::service::patch::mobile_composer::apply(&app_handle) {
        log::warn!("mobile composer patch failed: {e}");
    }
    if let Err(e) = crate::service::patch::mobile_sidebar::apply(&app_handle) {
        log::warn!("mobile sidebar patch failed: {e}");
    }
    // Expose an id-based SessionStore.remove facade so plugins can perform a
    // real in-memory teardown instead of leaving deleted sessions ungrouped.
    if let Err(e) = crate::service::patch::session::apply(&app_handle) {
        log::warn!("SessionStore.remove patch failed: {e}");
    }
    // OpenCode Go 需要稳定的会话 ID 头，否则返回 400 MissingSessionID；上游 pi-ai
    // 适配器把 sessionId 只透传给 SDK、不落成请求头，这里补上原生会话头，并限定到
    // OpenCode 路由（provider id 前缀或生效 baseUrl 主机为 opencode.ai），其它 provider
    // 的请求头保持不变。最佳努力且幂等：目标已含标记或锚点缺失时 patch_dsh 安全跳过。
    if let Err(e) = crate::service::patch::llm_session::apply(&app_handle) {
        log::warn!("pi-ai session header patch failed: {e}");
    }
    // Codex 系端点把思维链写在正文里（`<thinking>…</thinking>`），pi-ai 的
    // openai-completions 适配器只认识结构化推理字段，思考便混进回答正文。补丁在
    // 消息开头的围栏处把这段文本改道到 thinking 事件，harness 侧按 reasoning 块落库。
    // 最佳努力且幂等：目标已含标记或锚点缺失时 patch_dsh 安全跳过。
    if let Err(e) = crate::service::patch::pi_ai_thinking::apply(&app_handle) {
        log::warn!("pi-ai thinking-as-text patch failed: {e}");
    }
    // WKWebView 点击 `<button>` 不转移焦点：模型座位的 portal 菜单在 mousedown 阶段收到
    // `relatedTarget` 为 null 的 blur 就直接 close()，菜单在 click 之前卸载，鼠标选择
    // 模型 / 推理等级变成空操作（键盘 Enter 正常、浏览器正常）。补丁放行该 blur，菜单外的
    // 点击仍由组件自身的文档级 mousedown 处理器关闭。最佳努力且幂等：锚点缺失时安全跳过。
    if let Err(e) = crate::service::patch::model_selection::apply(&app_handle) {
        log::warn!("model selection mouse click patch failed: {e}");
    }
    // worktree 会话以隔离 cwd 执行，但产品归属仍是源 Workspace；放宽上游显式
    // attach 的 cwd 相等约束，其他 cwd 有效性校验保持不变。最佳努力且幂等。
    if let Err(e) = crate::service::patch::workspace::apply(&app_handle) {
        log::warn!("workspace worktree membership patch failed: {e}");
    }
    if let Err(e) = crate::service::patch::workspace_view::apply(&app_handle) {
        log::warn!("workspace view state patch failed: {e}");
    }
    // 内置插件（dsh-tauri-*）只在壳的插件弹窗里可见：官方侧边栏 Plugins 页与插件市场
    // 都按各自的硬编码内置/inbox 名单判断 bundle 归属，上游没有可配置开关，因此对这两个
    // 前端做幂等补丁。最佳努力且幂等：锚点缺失（上游改写布局）时安全跳过。
    if let Err(e) = crate::service::patch::plugin_visibility::apply(&app_handle) {
        log::warn!("plugin visibility patch failed: {e}");
    }
    crate::service::patch::mcp_startup::apply(&app_handle)?;
    mark_phase("core_patches", &mut phase_started);
    // 预防性处理：pnpm 在无 TTY 环境（dsh-market 等子进程）下重装/更新插件时，
    // 清理/重建 node_modules 会触发交互确认并因无 TTY 直接中止
    // （ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY），表现为插件更新失败。
    // 启动时确保 profile 的 .npmrc 写入 confirmModulesPurge=false（幂等、保留
    // 已有配置）。最佳努力：失败只告警，不阻断启动。
    if let Err(e) = crate::service::plugin::ensure_profile_npmrc(&app_handle) {
        log::warn!("ensure profile .npmrc failed: {e}");
    }
    // 内置插件自愈：随包分发的内置插件（dsh-tauri 等）必须在服务进程加载插件
    // 前就绪——核对「已安装 + 安装路径指向当前捆绑目录」，未安装、路径不正确
    // 或用户卸载后重启，一律强制重装（见 service::plugin::internal）。普通
    // 失败只告警，不阻断启动（核心功能缺失是发布缺陷，由 build:plugins 报错）；
    // 但进程清理/协调器失败意味着前一次 pnpm 去向未确认，必须终止本次启动。
    if let Err(e) = crate::service::plugin::ensure_internal_plugins(&app_handle).await {
        if crate::service::plugin::is_process_cleanup_failure(&e) {
            log::error!("ensure internal plugins blocked by unconfirmed process cleanup: {e}");
            return Err(e);
        }
        log::warn!("ensure internal plugins failed: {e}");
    }
    mark_phase("ensure_internal_plugins", &mut phase_started);
    // 预装插件完整性自检：清单引用的预装插件若在 node_modules 缺失产物，服务
    // 启动时 loader 会对每个缺失插件抛 ERR_MODULE_NOT_FOUND 而整体失败（issue
    // #90，日志特征 `Cannot find package`）。用 `pnpm install` 以现有 manifest +
    // lockfile 为准重建依赖图修复；普通修复失败只告警并给缺失插件记录错误标记
    // （启动失败场景由前端 recovery 对话框兜底，见 service::plugin::recovery），
    // 只有进程清理/协调器失败会作为 Err 传上来并终止启动。
    if let Err(e) = crate::service::plugin::ensure_preset_plugins(&app_handle).await {
        log::error!("ensure preset plugins blocked by unconfirmed process cleanup: {e}");
        return Err(e);
    }
    mark_phase("ensure_preset_plugins", &mut phase_started);
    // 插件自愈（内置插件重装 / 预装插件完整性自检）可能刚把插件市场装进档案，而上一轮补丁
    // 执行时它还不存在、已被安全跳过；自愈完成后按需重打一次（逐名字判定，已登记则跳过）。
    if let Err(e) = crate::service::patch::plugin_visibility::apply(&app_handle) {
        log::warn!("plugin visibility patch after plugin self-healing failed: {e}");
    }
    // 预打包核心运行时自愈：把 app 内置插件与 profile 插件入口链接进活动核心的
    // node_modules（dsh 的 loader 以核心根为裸包解析根），并核验/修复 sharp/koffi
    // 原生可选依赖。只作用于 CoreSource::App，本地核心由用户自行管理。dsh 在缺失
    // 这些入口或原生依赖时无法启动，因此失败直接阻断本次 launch（前端展示可恢复
    // 错误），而不是带着必然失败的核心继续 spawn。
    if let Err(e) = crate::service::core::prepare_active_runtime(&app_handle).await {
        log::error!("prepare active core runtime failed: {e}");
        return Err(e);
    }
    mark_phase("prepare_active_runtime", &mut phase_started);
    // prepare 可能因核心原生模块的 ABI 与本地 node 不匹配而改用捆绑运行时
    // （issue #441），此时必须重新解析：下面的 DSH_NODE 注入与 PATH 前置都以
    // 这里的结果为准，否则子进程仍会用那个加载不了原生模块的本地 node。
    let node_binary_path = config::get_node_binary_path(&app_handle);
    if !node_binary_path.exists() {
        log::error!("Node.js runtime resolved for launch is missing");
        return Err(format!(
            "NODE_NOT_FOUND: Node.js runtime is missing: {}",
            node_binary_path.display()
        ));
    }
    let profile = crate::service::profile::active_profile(&app_handle);
    let plan = LaunchPlan {
        setting,
        profile_root: crate::service::profile::profile_dir_of(&app_handle, &profile),
        profile,
        node: node_binary_path,
        dsh_binary: dsh_binary_path,
        core_dir: crate::service::core::active_core_dir(&app_handle),
        dsh_home,
        base: config::get_base_dir(&app_handle),
        bin_dir: crate::service::cli::get_bin_dir(&app_handle),
        pnpm_root: config::get_pnpm_install_path(&app_handle),
        pnpm_binary: config::get_pnpm_binary_path(&app_handle),
        pid_path: super::sweep::harness_pid_path(&app_handle),
        resources: app_handle.path().resource_dir().ok(),
        git_dir: config::get_git_cmd_dir(&app_handle),
        user_pnpm: crate::service::cli::find_user_pnpm(&app_handle),
    };
    let notifications = Arc::new(OnceLock::new());
    let _ = notifications.set(app_handle);
    launch_prepared(
        plan,
        (_launch_guard, _transition_guard),
        notifications,
        #[cfg(windows)]
        None,
    )
    .await
}

pub(super) async fn launch_prepared(
    plan: LaunchPlan,
    guards: (LaunchGuard, tokio::sync::OwnedMutexGuard<()>),
    notifications: Arc<OnceLock<tauri::AppHandle>>,
    #[cfg(windows)] job: Option<Arc<super::win_spawn::ProcessJob>>,
) -> Result<(), String> {
    let prepared_started = std::time::Instant::now();
    let mut phase_started = prepared_started;
    let mark_phase = |name: &str, phase_started: &mut std::time::Instant| {
        let now = std::time::Instant::now();
        log::info!(
            "STARTUP_PHASE: name={name} ms={} prepared_total={}",
            now.duration_since(*phase_started).as_millis(),
            now.duration_since(prepared_started).as_millis()
        );
        *phase_started = now;
    };
    let LaunchPlan {
        setting,
        profile: active_profile,
        node: node_binary_path,
        dsh_binary: dsh_binary_path,
        core_dir,
        profile_root,
        dsh_home,
        base,
        bin_dir,
        pnpm_root,
        pnpm_binary,
        pid_path,
        resources,
        git_dir,
        user_pnpm,
    } = plan;
    let mut envs: HashMap<String, String> = HashMap::new();
    envs.insert(
        "DSH_HOME".to_string(),
        dsh_home.to_string_lossy().into_owned(),
    );
    envs.insert("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string());
    envs.insert("NO_COLOR".to_string(), "1".to_string());
    envs.insert("DSH_WEB_PORT".to_string(), setting.port.to_string());
    // 把服务实际使用的 node 路径显式交给子进程（pnpm/dsh shim 的 DSH_NODE
    // 优先）：市场（dsh-market）等子进程经 PATH 解析 node 可能与桌面端预检
    // 不一致（相对 PATH 条目 / junction / 子进程 PATH 布局差异），导致 pnpm
    // shim 报 "Node.js runtime not found"（issue #121，与 build_plugin_envs
    // 的注入保持一致）。先规范化为绝对路径：相对路径在子进程 CWD 下会解析
    // 到错误位置；已存在（上面校验过）的 node 可安全 canonicalize。用
    // dunce::canonicalize 而不是 std::fs::canonicalize：后者在 Windows 上会
    // 返回 `\\?\` verbatim 前缀，cmd.exe 无法直接启动这种路径，导致 pnpm/dsh
    // shim 报 "The system cannot find the path specified."。
    let node_abs =
        dunce::canonicalize(&node_binary_path).unwrap_or_else(|_| node_binary_path.clone());
    envs.insert(
        "DSH_NODE".to_string(),
        node_abs.to_string_lossy().into_owned(),
    );

    // 扩展 PATH，让 dsh 及其子进程能找到 node 与桌面端自动配置的 Git；Windows
    // 上再注入 Git Bash 的 bin 目录：persistent bash（--noprofile --norc）不执行
    // profile 脚本、PATH
    // 完全继承服务进程，若不含 Git 的 usr/bin，ls/sed/find 等 coreutils 全会
    // `command not found`（MSYS 运行时在部分环境下不会自动补 /usr/bin）。
    // 前置应用自身的 shim 目录，使市场（dsh-market）及其子进程通过名字解析的
    // `pnpm`/`dsh` 都命中桌面端 shim，从而受桌面端 pnpm 选版策略管辖
    // （轻量缓解，issue #69 系列）。
    if let Some(node_dir) = node_binary_path.parent() {
        if let Some(existing_path) = std::env::var_os("PATH") {
            let git_dirs = win_inspector::git_bash_bin_dirs();
            // 只打印注入的前缀目录，完整 PATH 太长会刷屏
            for dir in &git_dirs {
                log::debug!("harness service PATH prepend: {}", dir.to_string_lossy());
            }
            let mut paths = vec![bin_dir.clone()];
            paths.push(node_dir.to_path_buf());
            if let Some(git_dir) = git_dir {
                log::debug!(
                    "harness service Git PATH prepend: {}",
                    git_dir.to_string_lossy()
                );
                paths.push(git_dir);
            }
            paths.extend(git_dirs);
            paths.extend(std::env::split_paths(&existing_path));
            if let Ok(new_path) = std::env::join_paths(paths) {
                envs.insert("PATH".to_string(), new_path.to_string_lossy().into_owned());
            }
        }
    }

    // GUI 进程可能启动在 pnpm 安装之前，继承的 PATH 因而没有 npm 全局目录。
    // 直接注入探测到的绝对路径，避免 dsh-market 的 pnpm --version 落到自身 shim
    // 后又因 PATH 看不到真正的 pnpm（issue #139）。
    if let Some(user_pnpm) = user_pnpm.as_deref() {
        // Unix mise shim 依赖调用路径中的 argv[0]；只做字面绝对化，不能解析
        // `pnpm -> mise` 链接。Windows 仍由同一辅助函数处理连接点与 `\\?\`。
        if let Some(pnpm_value) = crate::service::cli::pnpm_env_value(user_pnpm, &bin_dir) {
            envs.insert("DSH_PNPM".to_string(), pnpm_value);
        }
    }

    // 让市场子进程的 pnpm 与桌面端同一套受控策略（store 主版本感知、避免落到系统
    // homebrew pnpm）。与插件安装路径的 ensure_pnpm 版本感知一致，但启动阶段绝不
    // 触发下载；捆绑版未安装或与 store 不匹配时不注入（交由用户 pnpm）。探测被正常
    // 安装占住或探针自身失败只告警，只有进程清理未确认才终止启动。
    match crate::service::plugin::harness_prefer_bundled_pnpm_from(
        &profile_root,
        &pnpm_root,
        &pnpm_binary,
        user_pnpm.as_deref(),
        &node_binary_path,
        &bin_dir,
    )
    .await
    {
        Ok(true) => {
            envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
        }
        Ok(false) => {}
        Err(e) if crate::service::plugin::is_process_cleanup_failure(&e) => {
            log::error!("prefer bundled pnpm blocked by unconfirmed process cleanup: {e}");
            return Err(e);
        }
        Err(e) => log::warn!("prefer bundled pnpm probe failed, keeping user pnpm: {e}"),
    }

    // 桌面端代理设置（issue #110）：核心（dsh-http-proxy）在启动时读
    // `http_proxy` / `https_proxy` / `no_proxy` 发布代理策略，再给**它自己** spawn
    // 的子进程补 `NODE_USE_ENV_PROXY`；桌面端 spawn 的这个服务进程不在那条链路上，
    // 必须显式下发，否则配置页的代理只作用于桌面端自身的下载与更新请求。
    // 最佳努力：空值返回空 map，不覆盖用户已有的同名环境变量。
    envs.extend(config::proxy::proxy_child_env(&setting.proxy_url));

    // 内嵌 WebView 是 `tauri.localhost` 下的跨源沙箱 iframe，`SameSite=Strict` 的
    // browser-session Cookie 不会被携带。载体标记交给 dsh-tauri 插件（载体鉴权适配）：
    // 只有该标记在场时它才覆写 connection 的鉴权闸门，因此同一 profile 下独立运行
    // 的 `dsh web` 不受影响（取代原先对核心 JS 打的 `--skip-auth` 磁盘补丁）。
    envs.insert("DSH_TAURI_EMBEDDED".to_string(), "1".to_string());

    // issue #1064：AppImage 的旧库不能泄漏给 Harness 启动的宿主目录选择器。
    #[cfg(target_os = "linux")]
    let library_path = harness_library_path(
        std::env::var_os("APPDIR").as_deref(),
        std::env::var_os("LD_LIBRARY_PATH").as_deref(),
    );

    // 日志文件（前端日志面板读取）。
    // 每次真实启动前轮转：只保留最近 3 次启动的日志，旧文件后退为
    // `dsh-web.log.1` / `dsh-web.log.2`，避免单文件随多次启动无限增长。
    let log_path = config::service_log_path_from(&base, Some(&active_profile));
    fs::create_dir_all(log_path.parent().unwrap_or(std::path::Path::new(".")))
        .map_err(|e| format!("LOG_DIR_MKDIR_FAILED: create log dir failed: {e}"))?;
    rotate_service_log(&log_path, 3);

    // 补丁层悬空 insert 预检：手写的 `insert` 条目在包被卸载（市场会拒绝卸载
    // 「仍被用户补丁引用」的插件，用户于是改走手工删依赖 / pnpm remove）或本地
    // `link:` 源被删后仍留在补丁层里，loader 会在 import 时抛 ERR_MODULE_NOT_FOUND，
    // 让整棵插件树加载失败——应用彻底起不来，用户只看到一坨 Node 堆栈。上游契约
    // 是「补丁文件存在却应用不了就大声失败」，这里不改变契约，只把同一结果提前成
    // 一条可操作的错误（哪个文件、哪一行、哪个包），错误页据此给出「移除悬空条目」
    // 的一键恢复。必须在所有插件自愈之后：那些步骤会改变安装状态。
    if let Err(e) = crate::service::plugin::preflight_patch_entries_at(
        &profile_root,
        &dsh_home,
        Some(&dsh_binary_path),
    ) {
        log::error!("patch layer entry preflight failed: {e}");
        return Err(e);
    }
    mark_phase("patch_entry_preflight", &mut phase_started);

    let inherited_heap_mb = super::heap::node_options_heap_limit_mb();
    let inherited_heap_flags = super::heap::node_options_has_heap_flags_env();
    let heap_mb = super::heap::resolve_heap_limit_mb(
        setting.harness_max_heap_mb,
        inherited_heap_flags,
        super::heap::physical_memory_mb(),
    );
    // 命令行 `--max-old-space-size` 压得住 NODE_OPTIONS 里的同名 flag，却压不住
    // `--max-old-space-size-percentage`（V8 实测：只写 percentage 时命令行上限被
    // 完全无视）。既然这次要显式下发用户设置，就把继承来的堆 flag 从子进程环境里
    // 摘掉——只删堆相关项，`--require` 等其余选项原样保留；否则「已设置 16384」
    // 仍可能是一句谎话。
    if super::heap::heap_option_arg(heap_mb).is_some() {
        if let Ok(node_options) = std::env::var("NODE_OPTIONS") {
            if super::heap::node_options_has_heap_flags(&node_options) {
                let stripped = super::heap::node_options_without_heap_flags(&node_options);
                log::info!(
                    "Dropped inherited heap flags from NODE_OPTIONS for the Harness process (kept={:?})",
                    stripped
                );
                envs.insert("NODE_OPTIONS".to_string(), stripped.unwrap_or_default());
            }
        }
    }
    // 提示里说的上限必须与进程真正拿到的上限一致，否则用户会看到「已设置 8192
    // 还提示 8192」这种自相矛盾的诊断（详见 heap.rs 的优先级说明）。
    match super::heap::effective_limit_mb(heap_mb, inherited_heap_mb) {
        Some(mb) => log::info!(
            "Starting Harness process with effective heap limit {mb} MB (configured={:?}, inherited_from_node_options={:?})",
            setting.harness_max_heap_mb,
            inherited_heap_mb
        ),
        None if inherited_heap_flags => log::info!(
            "Starting Harness process with the heap limit inherited from NODE_OPTIONS (configured={:?})",
            setting.harness_max_heap_mb
        ),
        None => log::info!(
            "Starting Harness process with the Node default heap limit (configured={:?}, inherited_from_node_options={:?})",
            setting.harness_max_heap_mb,
            inherited_heap_mb
        ),
    }

    // dsh 的 Loader 在插件 dispose 时会把组合后的整棵 entry 树回写进
    // `cordis.yml`（dsh-app-boot：plugin self-disposing persists the current
    // tree）。上一轮被杀/崩溃的 dsh 若在「新进程 prepareProfile 重置之后、
    // Include 读取之前」完成回写，新 boot 会读到已含 bundle 组合行的文件，
    // 再叠加同一批 patch → duplicate loader entry（本会话实测特征
    // `duplicate loader entry id: dsh-tauri-worktree`）。spawn 前最后一刻重置
    // profile 根关闭常见窗口；回写恰好落在探测窗口内的残余竞态由下方
    // Windows 分支的「早期退出重试」兜底。
    reset_active_profile_root(&profile_root);

    // 本地插件热重载：把已挂载的本地路径插件源码目录折算成桌面端独占的补丁层，
    // 随启动以 `--patch` 注入核心 HMR（本地插件没有版本号可升级，改源码即时生效）。
    // 该层只在本次进程有效，每次启动都要按当前安装状态重算；没有本地插件时不传
    // `--patch`（指向不存在的文件会让核心在读取补丁层时直接失败）。
    let hmr_patch = crate::service::plugin::local_plugin_hmr_sync_at(
        &base,
        &profile_root,
        resources.as_deref(),
        setting.local_plugin_hmr,
    );
    if let Some(path) = hmr_patch.as_deref() {
        log::info!("Injecting local plugin HMR layer: {}", path.display());
    }

    if let Some(parent) = pid_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let port = setting.port;
    mark_phase("pre_spawn_setup", &mut phase_started);
    super::startup::note_spawn();
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("harness-startup".into())
        .spawn(move || {
            super::instances::scope_sync(active_profile.clone(), || {
                let mut started = Some(started_tx);
                let result = supervise_harness(
                    |pid, code, report_path| {
                        on_owned_process_exit_at(
                            pid,
                            |_| {
                                if let Some(report_path) = report_path {
                                    log_fatal_report(&log_path, report_path);
                                }
                                code
                            },
                            |payload| {
                                if let Some(app) = notifications.get() {
                                    status::emit_status(app);
                                    super::instances::emit(
                                        app,
                                        HARNESS_PROCESS_EXITED_EVENT,
                                        payload,
                                    );
                                }
                            },
                        );
                    },
                    &log_path,
                    &mut started,
                    guards,
                    |report_path| {
                        let args = build_harness_args(
                            &dsh_binary_path,
                            &active_profile,
                            hmr_patch.as_deref(),
                            port,
                            heap_mb,
                            report_path,
                        );
                        #[cfg(windows)]
                        {
                            use std::os::windows::io::{FromRawHandle, OwnedHandle};
                            let spawned = if let Some(job) = job.as_deref() {
                                super::win_spawn::spawn_with_hidden_console_in_job(
                                    &node_binary_path,
                                    &args,
                                    Some(&core_dir),
                                    &envs,
                                    job,
                                )
                            } else {
                                super::win_spawn::spawn_with_hidden_console_owned(
                                    &node_binary_path,
                                    &args,
                                    Some(&core_dir),
                                    &envs,
                                )
                            };
                            let (stdout, stderr, pid, handle) = spawned
                                .map_err(|error| format!("PROCESS_START_FAILED: {error}"))?;
                            let handle = Arc::new(unsafe { OwnedHandle::from_raw_handle(handle) });
                            let signature =
                                spawn_output_readers(Some(stdout), Some(stderr), log_path.clone());
                            Ok((
                                OwnedProcess {
                                    pid,
                                    handle: handle.clone(),
                                },
                                handle,
                                signature,
                            ))
                        }
                        #[cfg(unix)]
                        {
                            use std::os::unix::process::CommandExt;
                            let mut command = Command::new(&node_binary_path);
                            command
                                .args(args)
                                .envs(&envs)
                                .current_dir(&core_dir)
                                .stdin(Stdio::null())
                                .stdout(Stdio::piped())
                                .stderr(Stdio::piped())
                                .process_group(0);
                            #[cfg(target_os = "linux")]
                            if let Some(path) = &library_path {
                                command.env("LD_LIBRARY_PATH", path);
                            }
                            let mut child = command
                                .spawn()
                                .map_err(|error| format!("PROCESS_START_FAILED: {error}"))?;
                            let pid = child.id();
                            let signature = spawn_output_readers(
                                child.stdout.take(),
                                child.stderr.take(),
                                log_path.clone(),
                            );
                            Ok((OwnedProcess { pid }, child, signature))
                        }
                    },
                    || reset_active_profile_root(&profile_root),
                    |pid| {
                        let _ = fs::write(&pid_path, format!("{pid}\n{port}\n"));
                    },
                );
                if let Err(error) = result {
                    log::error!("Harness startup supervisor failed: {error}");
                    if let Some(started) = started.take() {
                        let _ = started.send(Err(error));
                    }
                }
            });
        })
        .map_err(|error| format!("PROCESS_START_FAILED: spawn startup supervisor: {error}"))?;
    let result = started_rx
        .await
        .map_err(|error| format!("PROCESS_START_FAILED: startup supervisor ended: {error}"))?;
    mark_phase("spawn_and_register", &mut phase_started);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_requires_explicit_opt_in() {
        assert!(attach_requested(Some("1")));
        assert!(attach_requested(Some("true")));
        assert!(!attach_requested(Some("0")));
        assert!(!attach_requested(Some("")));
        assert!(!attach_requested(None));
    }

    #[test]
    fn startup_sweep_waits_for_attach_decision() {
        let process = include_str!("process.rs");
        let take = process
            .split("pub(super) fn take_startup_sweep(")
            .nth(1)
            .unwrap()
            .split("static ATTACH_DECLINED")
            .next()
            .unwrap();
        assert!(take.find("attach_pending()").unwrap() < take.find("STARTUP_SWEEP_DONE").unwrap());
        let launch = include_str!("launch.rs");
        let start = launch.split("pub async fn start(").nth(1).unwrap();
        assert!(
            start.find("attachable_core(port)").unwrap() < start.find("decline_attach()").unwrap()
        );
    }

    #[tokio::test]
    async fn attachable_core_requires_listening_dsh_http_200() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let free_port = free.local_addr().unwrap().port();
        drop(free);
        assert!(!attachable_core(free_port).await);

        for (status, expected) in [("200 OK", true), ("503 Service Unavailable", false)] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buffer = [0u8; 1024];
                let _ = socket.read(&mut buffer).await;
                let response =
                    format!("HTTP/1.1 {status}
content-length: 0
connection: close

");
                socket.write_all(response.as_bytes()).await.unwrap();
            });
            assert_eq!(attachable_core(port).await, expected, "{status}");
            server.await.unwrap();
        }
    }

    #[cfg(target_os = "linux")]
    mod appimage_library_path {
        use super::*;
        use std::ffi::OsStr;
        use std::os::unix::ffi::{OsStrExt, OsStringExt};

        #[test]
        fn removes_only_appimage_library_directories() {
            assert_eq!(
                harness_library_path(
                    Some(OsStr::new("/tmp/.mount_DSH")),
                    Some(OsStr::new("/opt/custom/lib:/tmp/.mount_DSH/usr/lib:/tmp/.mount_DSH:/tmp/.mount_DSH-other/lib:")),
                ),
                Some(OsString::from("/opt/custom/lib:/tmp/.mount_DSH-other/lib:")),
            );
        }

        #[test]
        fn filters_semicolon_and_mixed_library_path_separators() {
            for path in [
                "/opt/custom/lib;/tmp/.mount_DSH/usr/lib",
                "/tmp/.mount_DSH/usr/lib;/opt/custom/lib",
                "/tmp/.mount_DSH/usr/lib:/opt/custom/lib;/tmp/.mount_DSH/usr/lib64",
            ] {
                assert_eq!(
                    harness_library_path(
                        Some(OsStr::new("/tmp/.mount_DSH")),
                        Some(OsStr::new(path))
                    ),
                    Some(OsString::from("/opt/custom/lib")),
                    "{path}",
                );
            }
        }

        #[test]
        fn retains_empty_components_and_loader_tokens() {
            assert_eq!(
                harness_library_path(
                    Some(OsStr::new("/tmp/.mount_DSH")),
                    Some(OsStr::new(";/tmp/.mount_DSH/usr/lib;;$ORIGIN/$LIB:;")),
                ),
                Some(OsString::from("::$ORIGIN/$LIB::")),
            );
        }

        #[test]
        fn filters_non_utf8_appimage_paths_without_removing_siblings() {
            assert_eq!(
                harness_library_path(
                    Some(OsStr::from_bytes(b"/tmp/.mount_\xff")),
                    Some(OsStr::from_bytes(
                        b"/tmp/.mount_\xff/usr/lib;/opt/\xfe/lib:/tmp/.mount_\xff-other/lib"
                    )),
                ),
                Some(OsString::from_vec(
                    b"/opt/\xfe/lib:/tmp/.mount_\xff-other/lib".to_vec()
                )),
            );
        }

        #[test]
        fn preserves_library_path_without_an_appimage_directory() {
            let path = Some(OsStr::new("/opt/custom/lib"));
            assert_eq!(
                harness_library_path(None, path),
                Some(OsString::from("/opt/custom/lib"))
            );
            assert_eq!(
                harness_library_path(Some(OsStr::new("")), path),
                Some(OsString::from("/opt/custom/lib"))
            );
        }

        #[test]
        fn preserves_an_unset_library_path() {
            assert_eq!(
                harness_library_path(Some(OsStr::new("/tmp/.mount_DSH")), None),
                None
            );
        }

        #[test]
        fn clears_a_library_path_containing_only_appimage_directories() {
            for path in [
                "/tmp/.mount_DSH/usr/lib",
                "/tmp/.mount_DSH/usr/lib;/tmp/.mount_DSH/usr/lib64",
                "",
            ] {
                assert_eq!(
                    harness_library_path(
                        Some(OsStr::new("/tmp/.mount_DSH")),
                        Some(OsStr::new(path))
                    ),
                    Some(OsString::new()),
                    "{path}",
                );
            }
        }

        #[test]
        fn preserves_non_utf8_user_library_paths() {
            assert_eq!(
                harness_library_path(
                    Some(OsStr::new("/tmp/.mount_DSH")),
                    Some(OsStr::from_bytes(b"/opt/\xff/lib:/tmp/.mount_DSH/usr/lib"))
                ),
                Some(OsString::from_vec(b"/opt/\xff/lib".to_vec())),
            );
        }
    }

    #[test]
    fn occupied_port_advances_to_a_free_port() {
        let mut checked = Vec::new();
        let selected = find_available_port_by(3080, |port| {
            checked.push(port);
            Ok(port < 3082)
        })
        .expect("find next free port");

        assert_eq!(selected, 3082);
        assert_eq!(checked, vec![3080, 3081, 3082]);
    }

    #[test]
    fn occupied_port_reports_exhaustion_at_max_port() {
        let error = find_available_port_by(u16::MAX, |_| Ok(true)).expect_err("port exhaustion");
        assert!(error.starts_with("PORT_EXHAUSTED:"));
    }

    #[test]
    fn confirmed_orphan_cleanup_failure_does_not_advance_port() {
        let mut checked = Vec::new();
        let error = find_available_port_by(3080, |port| {
            checked.push(port);
            Err("HARNESS_CLEANUP_FAILED: retained listener".to_string())
        })
        .unwrap_err();
        assert_eq!(error, "HARNESS_CLEANUP_FAILED: retained listener");
        assert_eq!(checked, vec![3080]);
    }

    fn text_args(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    /// `--patch` 必须排在子命令参数之前：`dsh` 的选项收集器在遇到第一个非选项
    /// 参数（内层应用名）之后会把剩余参数整段透传，排在其后的 `--patch` 会被内层
    /// 应用判为未知选项并立刻退出（实测）。
    #[test]
    fn patch_layer_argument_precedes_the_port_flags() {
        let patch = Path::new("D:/app-data/cordis.hmr.patch.yml");
        let args = build_harness_args(
            Path::new("D:/core/lib/bin.js"),
            "tauri",
            Some(patch),
            3080,
            None,
            Path::new("D:/app-data/logs/fatal.json"),
        );
        assert_eq!(
            text_args(&args),
            vec![
                "--report-on-fatalerror".to_string(),
                "--report-directory=D:/app-data/logs".to_string(),
                "--report-filename=fatal.json".to_string(),
                "D:/core/lib/bin.js".to_string(),
                "--profile".to_string(),
                "tauri".to_string(),
                "--patch".to_string(),
                "D:/app-data/cordis.hmr.patch.yml".to_string(),
                "--port".to_string(),
                "3080".to_string(),
                "--no-open".to_string(),
            ]
        );
    }

    #[test]
    fn fatal_report_flags_precede_the_script_path() {
        let args = build_harness_args(
            Path::new("D:/core/lib/bin.js"),
            "tauri",
            None,
            3081,
            None,
            Path::new("D:/用户 data/logs/fatal.json"),
        );
        let text = text_args(&args);
        assert_eq!(text[0], "--report-on-fatalerror");
        assert_eq!(text[1], "--report-directory=D:/用户 data/logs");
        assert_eq!(text[2], "--report-filename=fatal.json");
        assert_eq!(text[3], "D:/core/lib/bin.js");
    }

    #[test]
    fn fatal_report_paths_are_distinct_for_each_spawn_attempt() {
        let log = Path::new("D:/用户 data/logs/dsh-web.log");
        let first = fatal_report_path(log);
        let second = fatal_report_path(log);
        assert_eq!(first.parent(), Some(Path::new("D:/用户 data/logs")));
        assert_eq!(first.extension(), Some(std::ffi::OsStr::new("json")));
        assert_ne!(first, second);
    }

    #[test]
    fn fatal_report_log_only_names_this_attempts_existing_file_without_reading_it() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("dsh-web.log");
        fs::write(&log, "existing error\n").unwrap();
        let stale = fatal_report_path(&log);
        fs::write(&stale, b"secret environment").unwrap();
        let report = fatal_report_path(&log);
        log_fatal_report(&log, &report);
        assert_eq!(fs::read_to_string(&log).unwrap(), "existing error\n");
        fs::create_dir(&report).unwrap();
        log_fatal_report(&log, &report);
        assert_eq!(fs::read_to_string(&log).unwrap(), "existing error\n");
        fs::remove_dir(&report).unwrap();
        fs::write(&report, b"\xffsecret environment").unwrap();
        log_fatal_report(&log, &report);
        assert_eq!(
            fs::read_to_string(&log).unwrap(),
            format!(
                "existing error\nERROR HARNESS_FATAL_REPORT: {}\n",
                report.display()
            )
        );
    }

    #[test]
    fn heap_option_stays_ahead_of_the_script_path() {
        let args = build_harness_args(
            Path::new("D:/core/lib/bin.js"),
            "tauri",
            None,
            3081,
            Some(4096),
            Path::new("D:/logs/fatal.json"),
        );
        let text = text_args(&args);
        assert_eq!(text[0], "--max-old-space-size=4096");
        assert_eq!(text[1], "--report-on-fatalerror");
        assert_eq!(text[4], "D:/core/lib/bin.js");
        assert!(!text.contains(&"--patch".to_string()));
    }

    struct SupervisedNode {
        root: tempfile::TempDir,
        instance: std::sync::Arc<super::super::instances::Instance>,
        started: Option<tokio::sync::oneshot::Receiver<Result<(), String>>>,
        finished: std::sync::mpsc::Receiver<Result<(), String>>,
        worker: Option<std::thread::JoinHandle<()>>,
        attempts: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        spawned: std::sync::Arc<std::sync::Mutex<Option<OwnedProcess>>>,
        resets: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        transition: std::sync::Arc<tokio::sync::Mutex<()>>,
    }

    impl SupervisedNode {
        fn new(script: &str) -> Self {
            Self::with_reader_failure(script, 0)
        }

        fn with_reader_failure(script: &str, reader: usize) -> Self {
            use std::sync::{atomic::AtomicUsize, Arc, Mutex};

            let node = config::get_local_node_path()
                .expect("supported Node.js required for supervisor tests");
            let root = tempfile::tempdir().unwrap();
            let path = root.path().to_path_buf();
            let script_path = path.join("fixture.cjs");
            fs::write(&script_path, script).unwrap();
            fs::create_dir_all(path.join("AppData/Local")).unwrap();
            fs::create_dir_all(path.join("AppData/Roaming")).unwrap();
            let envs: HashMap<String, String> = HashMap::from([
                ("HOME".into(), path.to_string_lossy().into_owned()),
                ("USERPROFILE".into(), path.to_string_lossy().into_owned()),
                (
                    "APPDATA".into(),
                    path.join("AppData/Roaming").to_string_lossy().into_owned(),
                ),
                (
                    "LOCALAPPDATA".into(),
                    path.join("AppData/Local").to_string_lossy().into_owned(),
                ),
                ("DSH_E2E_HOME".into(), path.to_string_lossy().into_owned()),
                ("NODE_OPTIONS".into(), String::new()),
                ("NODE_PATH".into(), String::new()),
            ]);
            let profile = format!("supervisor-{}", path.file_name().unwrap().to_string_lossy());
            let instance = super::super::instances::instance_of(&profile);
            instance.launching.store(true, Ordering::SeqCst);
            *instance.status.lock().unwrap() = status::Status::Starting;
            let attempts = Arc::new(AtomicUsize::new(0));
            let resets = Arc::new(AtomicUsize::new(0));
            let transition = Arc::new(tokio::sync::Mutex::new(()));
            let guards = (
                LaunchGuard(instance.launching.clone()),
                transition.clone().try_lock_owned().unwrap(),
            );
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (finished_tx, finished) = std::sync::mpsc::channel();
            let spawned = Arc::new(Mutex::new(None));
            let spawned_process = spawned.clone();
            let spawn_count = attempts.clone();
            let reset_count = resets.clone();
            let worker = std::thread::spawn(move || {
                let log = path.join("dsh-web.log");
                let mut started = Some(started_tx);
                let result = super::super::utils::with_output_reader_failure(reader, || {
                    super::super::instances::scope_sync(profile, || {
                        supervise_harness(
                            |pid, code, report_path| {
                                on_owned_process_exit_at(
                                    pid,
                                    |_| {
                                        if let Some(report_path) = report_path {
                                            log_fatal_report(&log, report_path);
                                        }
                                        code
                                    },
                                    |_| {},
                                );
                            },
                            &log,
                            &mut started,
                            guards,
                            |_| {
                                if spawn_count.fetch_add(1, Ordering::SeqCst) > 0
                                    && !fs::read_to_string(path.join("cordis.yml"))
                                        .unwrap()
                                        .ends_with("\n[]\n")
                                {
                                    return Err("FIXTURE_PROFILE_NOT_RESET: stale root".into());
                                }
                                if path.join("fail-next-spawn").exists() {
                                    return Err(
                                        "PROCESS_START_FAILED: fixture retry spawn failure".into(),
                                    );
                                }
                                fs::write(path.join("cordis.yml"), "- stale-loader-entry\n")
                                    .unwrap();
                                #[cfg(windows)]
                                {
                                    use std::os::windows::io::{FromRawHandle, OwnedHandle};
                                    let (stdout, stderr, pid, handle) =
                                        super::super::win_spawn::spawn_with_hidden_console_owned(
                                            &node,
                                            &[script_path.clone().into_os_string()],
                                            Some(&path),
                                            &envs,
                                        )
                                        .map_err(
                                            |error| format!("PROCESS_START_FAILED: {error}"),
                                        )?;
                                    let handle =
                                        Arc::new(unsafe { OwnedHandle::from_raw_handle(handle) });
                                    let owned = OwnedProcess {
                                        pid,
                                        handle: handle.clone(),
                                    };
                                    *spawned_process.lock().unwrap() = Some(owned.clone());
                                    let signature = spawn_output_readers(
                                        Some(stdout),
                                        Some(stderr),
                                        log.clone(),
                                    );
                                    Ok((owned, handle, signature))
                                }
                                #[cfg(unix)]
                                {
                                    use std::os::unix::process::CommandExt;
                                    let mut child = Command::new(&node)
                                        .arg(&script_path)
                                        .envs(&envs)
                                        .current_dir(&path)
                                        .stdin(Stdio::null())
                                        .stdout(Stdio::piped())
                                        .stderr(Stdio::piped())
                                        .process_group(0)
                                        .spawn()
                                        .map_err(|error| {
                                            format!("PROCESS_START_FAILED: {error}")
                                        })?;
                                    let pid = child.id();
                                    *spawned_process.lock().unwrap() = Some(OwnedProcess { pid });
                                    let signature = spawn_output_readers(
                                        child.stdout.take(),
                                        child.stderr.take(),
                                        log.clone(),
                                    );
                                    Ok((OwnedProcess { pid }, child, signature))
                                }
                            },
                            || {
                                reset_count.fetch_add(1, Ordering::SeqCst);
                                reset_active_profile_root(&path);
                            },
                            |pid| fs::write(path.join("harness.pid"), pid.to_string()).unwrap(),
                        )
                    })
                });
                if let Some(started) = started.take() {
                    let _ = started.send(result.clone());
                }
                finished_tx.send(result).unwrap();
            });
            Self {
                root,
                instance,
                started: Some(started_rx),
                finished,
                worker: Some(worker),
                attempts,
                spawned,
                resets,
                transition,
            }
        }

        fn acknowledge(&mut self) {
            tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap()
                .block_on(async {
                    tokio::time::timeout(
                        std::time::Duration::from_secs(2),
                        self.started.take().unwrap(),
                    )
                    .await
                })
                .expect("spawn acknowledgement must not wait for the startup probe")
                .expect("supervisor must send acknowledgement")
                .expect("fixture must spawn and register");
        }

        fn wait_until(&self, check: impl Fn() -> bool) {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(6);
            while !check() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "supervisor fixture condition timed out"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        fn cancel(&self) -> Result<(), String> {
            let owned = {
                let mut slot = self
                    .instance
                    .process
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                self.instance.launching.store(false, Ordering::SeqCst);
                slot.take()
            };
            if let Some(owned) = owned {
                #[cfg(windows)]
                {
                    use std::os::windows::io::AsRawHandle;
                    super::super::process::terminate_windows_process(
                        owned.pid,
                        owned.handle.as_raw_handle(),
                        super::super::process::kill_pid_tree,
                    )?;
                }
                #[cfg(unix)]
                super::super::process::kill_pid_tree(owned.pid);
            }
            Ok(())
        }

        fn finish(&mut self) -> Result<(), String> {
            let result = self
                .finished
                .recv_timeout(std::time::Duration::from_secs(10))
                .expect("supervisor must finish and reap its child");
            self.worker.take().unwrap().join().unwrap();
            result
        }
    }

    impl Drop for SupervisedNode {
        fn drop(&mut self) {
            let _ = self.cancel();
            if let Some(worker) = self.worker.take().filter(|worker| worker.is_finished()) {
                let _ = worker.join();
            }
        }
    }

    fn assert_reader_failure_is_reaped(reader: usize) {
        let mut fixture = SupervisedNode::with_reader_failure("setTimeout(()=>{},60000)", reader);
        let error = fixture.finish().unwrap_err();
        assert_eq!(
            error,
            "PROCESS_START_FAILED: spawn output reader: injected output reader spawn failure"
        );
        assert_eq!(
            fixture.started.take().unwrap().blocking_recv().unwrap(),
            Err(error)
        );
        assert_eq!(fixture.attempts.load(Ordering::SeqCst), 1);
        assert!(fixture.instance.process.lock().unwrap().is_none());
        assert!(!fixture.root.path().join("harness.pid").exists());
        assert!(!fixture.instance.launching.load(Ordering::SeqCst));
        assert!(fixture.transition.try_lock().is_ok());
        let spawned = fixture.spawned.lock().unwrap();
        let owned = spawned.as_ref().expect("fixture must create a real child");
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            assert_eq!(
                unsafe {
                    windows_sys::Win32::System::Threading::WaitForSingleObject(
                        owned.handle.as_raw_handle(),
                        0,
                    )
                },
                windows_sys::Win32::Foundation::WAIT_OBJECT_0,
                "failed reader setup must confirm the exact process exited"
            );
        }
        #[cfg(unix)]
        {
            let mut status = 0;
            assert_eq!(unsafe { libc::kill(owned.pid as libc::pid_t, 0) }, -1);
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            assert_eq!(
                unsafe { libc::waitpid(owned.pid as libc::pid_t, &mut status, libc::WNOHANG) },
                -1
            );
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ECHILD)
            );
        }
    }

    #[test]
    fn supervisor_reaps_child_when_first_output_reader_spawn_fails() {
        assert_reader_failure_is_reaped(1);
    }

    #[test]
    fn supervisor_reaps_child_when_second_output_reader_spawn_fails() {
        assert_reader_failure_is_reaped(2);
    }

    #[test]
    fn supervisor_acknowledges_before_probe_and_drains_both_full_pipes() {
        let mut fixture = SupervisedNode::new(
            "const fs=require('fs'); const chunk='x'.repeat(1024)+'\\n'; for(let i=0;i<512;i++){fs.writeSync(1,'OUT:'+chunk);fs.writeSync(2,'ERR:'+chunk)} fs.writeSync(1,'STDOUT_DONE\\n');fs.writeSync(2,'STDERR_DONE\\n');setTimeout(()=>{},10000)",
        );
        fixture.acknowledge();
        let pid = fixture
            .instance
            .process
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .pid;
        assert_eq!(
            fs::read_to_string(fixture.root.path().join("harness.pid")).unwrap(),
            pid.to_string()
        );
        assert!(fixture.instance.launching.load(Ordering::SeqCst));
        assert!(fixture.transition.try_lock().is_err());
        let log = fixture.root.path().join("dsh-web.log");
        fixture.wait_until(|| {
            fs::read_to_string(&log)
                .is_ok_and(|text| text.contains("STDOUT_DONE") && text.contains("STDERR_DONE"))
        });
        let output = fs::read_to_string(log).unwrap();
        assert_eq!(output.matches("OUT:").count(), 512);
        assert_eq!(output.matches("ERR:").count(), 512);
        fixture.wait_until(|| {
            !fixture.instance.launching.load(Ordering::SeqCst)
                && fixture.transition.try_lock().is_ok()
        });
        assert!(fixture.instance.process.lock().unwrap().is_some());
        fixture.cancel().unwrap();
        fixture.finish().unwrap();
        assert!(fixture.instance.process.lock().unwrap().is_none());
    }

    #[test]
    fn supervisor_retries_only_duplicate_code_one_at_most_twice() {
        for (script, attempts, resets) in [
            ("require('fs').writeSync(2,'duplicate loader entry id: fixture\\n');process.exit(1)", 3, 2),
            ("require('fs').writeSync(2,'Error: EADDRINUSE\\n');process.exit(1)", 1, 0),
            ("require('fs').writeSync(2,'duplicate loader entry id: fixture\\n');process.exit(0)", 1, 0),
        ] {
            let mut fixture = SupervisedNode::new(script);
            fixture.acknowledge();
            fixture.finish().unwrap();
            assert_eq!(fixture.attempts.load(Ordering::SeqCst), attempts, "{script}");
            assert_eq!(fixture.resets.load(Ordering::SeqCst), resets, "{script}");
            assert!(fixture.instance.process.lock().unwrap().is_none());
            assert!(!fixture.instance.launching.load(Ordering::SeqCst));
            assert_eq!(*fixture.instance.status.lock().unwrap(), status::Status::Stopped);
            assert!(fixture.transition.try_lock().is_ok());
        }
    }

    #[test]
    fn supervisor_releases_ownership_and_guards_when_retry_spawn_fails() {
        let mut fixture = SupervisedNode::new(
            "const fs=require('fs');fs.writeFileSync('fail-next-spawn','1');fs.writeSync(2,'duplicate loader entry id: fixture\\n');process.exit(1)",
        );
        fixture.acknowledge();
        assert_eq!(
            fixture.finish().unwrap_err(),
            "PROCESS_START_FAILED: fixture retry spawn failure"
        );
        assert_eq!(fixture.attempts.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.resets.load(Ordering::SeqCst), 1);
        assert!(fixture.instance.process.lock().unwrap().is_none());
        assert_eq!(
            *fixture.instance.status.lock().unwrap(),
            status::Status::Stopped
        );
        fixture.wait_until(|| {
            !fixture.instance.launching.load(Ordering::SeqCst)
                && fixture.transition.try_lock().is_ok()
        });
    }

    #[test]
    fn stopping_during_probe_cancels_retry_without_invalidating_monitor_handle() {
        let mut fixture = SupervisedNode::new(
            "require('fs').writeSync(2,'duplicate loader entry id: fixture\\n');setTimeout(()=>{},10000)",
        );
        fixture.acknowledge();
        let log = fixture.root.path().join("dsh-web.log");
        fixture.wait_until(|| {
            fs::read_to_string(&log).is_ok_and(|text| text.contains("duplicate loader entry"))
        });
        assert!(fixture.instance.launching.load(Ordering::SeqCst));
        fixture.cancel().unwrap();
        if let Err(error) = fixture.finish() {
            assert_eq!(error, "STARTUP_CANCELLED: Harness launch was stopped");
        }
        assert_eq!(fixture.attempts.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.resets.load(Ordering::SeqCst), 0);
        assert!(fixture.instance.process.lock().unwrap().is_none());
        assert!(!fixture.instance.launching.load(Ordering::SeqCst));
        assert!(fixture.transition.try_lock().is_ok());
    }

    /// 端口自愈（issue #91）：自动避让递增遗留的非默认端口，在回落目标空闲时
    /// 回落到目标（默认端口或用户手动端口），回落目标被占时维持当前端口。
    #[test]
    fn heal_port_returns_target_when_free() {
        // 自动递增遗留 3084，默认 3080 空闲 → 回落默认端口
        assert_eq!(resolve_heal_port(3084, 3080, true), 3080);
        // 用户手动 9090 空闲 → 回落用户值
        assert_eq!(resolve_heal_port(9091, 9090, true), 9090);
    }

    #[test]
    fn heal_port_keeps_current_when_target_busy_or_aligned() {
        // 回落目标被占 → 维持当前端口（留给 find_available_port 逐级递增）
        assert_eq!(resolve_heal_port(3084, 3080, false), 3084);
        // 当前端口即回落目标（已是最优）→ 不变
        assert_eq!(resolve_heal_port(3080, 3080, true), 3080);
        assert_eq!(resolve_heal_port(3080, 3080, false), 3080);
    }
}
