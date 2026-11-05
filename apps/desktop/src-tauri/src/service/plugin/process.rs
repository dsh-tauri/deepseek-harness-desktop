//! dsh 子进程执行：启动 `dsh plugin` 进程并等待退出，输出逐行转发为事件。
//!
//! Windows 打包版是 GUI 进程（无控制台），直接以 CREATE_NO_WINDOW 启动会让
//! dsh 派生的子进程各建可见控制台窗口（黑窗闪烁），因此复用
//! `service/workflow/win_spawn` 的隐藏控制台方案并额外跟踪进程句柄以等待退出；
//! Unix 上直接以管道捕获标准输出/错误。

use crate::Window;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

use crate::utils::decode_process_line;

#[cfg(windows)]
use crate::service::workflow;
#[cfg(not(windows))]
use std::process::{Command, Stdio};

/// 前端监听的控制台事件名（进程输出行）
pub(crate) const PREINSTALL_LOG_EVENT: &str = "preinstall-log";

/// 进程输出行事件载荷
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreinstallLogPayload {
    pub line: String,
}

/// 当前正在运行的 `dsh plugin` 子进程 PID（无进行中安装时为 None）。
///
/// `cancel`（跨平台）用它结束安装进程树；安装结束/失败后必须复位，
/// 防止把「下一个安装」或无关进程误杀。
///
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) struct ProcessOwner(u64);

#[derive(Clone)]
pub(crate) struct ActivePluginProcess {
    pub(crate) pid: u32,
    pub(crate) child: Option<Arc<Mutex<std::process::Child>>>,
}

static NEXT_PROCESS_OWNER: AtomicU64 = AtomicU64::new(1);
static ACTIVE_PLUGIN_PIDS: OnceLock<Mutex<HashMap<ProcessOwner, ActivePluginProcess>>> =
    OnceLock::new();
static PLUGIN_PROCESS_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
static PLUGIN_OPERATION_LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
#[cfg(test)]
pub(crate) static TEST_PROCESS_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PLUGIN_CLEANUP_FAILURE: OnceLock<
    tokio::sync::watch::Sender<Option<(ProcessOwner, String)>>,
> = OnceLock::new();

fn active_pid_lock() -> &'static Mutex<HashMap<ProcessOwner, ActivePluginProcess>> {
    ACTIVE_PLUGIN_PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_failure_sender() -> &'static tokio::sync::watch::Sender<Option<(ProcessOwner, String)>> {
    PLUGIN_CLEANUP_FAILURE.get_or_init(|| tokio::sync::watch::channel(None).0)
}

pub(crate) fn new_process_owner() -> ProcessOwner {
    ProcessOwner(NEXT_PROCESS_OWNER.fetch_add(1, Ordering::Relaxed))
}

pub(crate) fn active_plugin_pid(owner: ProcessOwner) -> Option<u32> {
    active_plugin_process(owner).map(|process| process.pid)
}

pub(crate) fn active_plugin_process(owner: ProcessOwner) -> Option<ActivePluginProcess> {
    active_pid_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&owner)
        .cloned()
}

pub(crate) fn active_plugin_processes() -> Vec<(ProcessOwner, ActivePluginProcess)> {
    active_pid_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(owner, process)| (*owner, process.clone()))
        .collect()
}

#[cfg(windows)]
pub(crate) fn plugin_process_has_exited(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE_ACCESS,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return std::io::Error::last_os_error().raw_os_error() == Some(87);
    }
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    wait == 0
}

#[cfg(not(windows))]
pub(crate) fn plugin_process_has_exited(pid: u32) -> bool {
    let mut status = 0;
    let waited = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
    if waited == pid as libc::pid_t {
        return true;
    }
    if waited == 0 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

/// dsh 侧 `dsh-atomic-write` 的跨进程写锁路径（`<profile>/package.json.lock`）。
pub(crate) fn plugin_writer_lock_path(profile_dir: &Path) -> std::path::PathBuf {
    profile_dir.join("package.json.lock")
}

/// 锁内容（持有者 PID）是否表明持有者已退出：必须是正 PID，且该进程已不在。
fn orphan_lock_should_clear(recorded: &str, has_exited: impl Fn(u32) -> bool) -> bool {
    recorded
        .trim()
        .parse::<u32>()
        .is_ok_and(|pid| pid != 0 && has_exited(pid))
}

/// 清掉由已退出进程留下的孤儿写锁，返回是否真的删除。
///
/// `dsh` 用 `wx` 独占创建做锁、等待方只轮询从不删除（库文档明确「孤儿恢复属于运维
/// 动作」）：安装子进程被强杀（取消 / 页面刷新 / 应用退出）后锁会永久留下，之后每次
/// 安装都要静默等到 deadline 才报 `atomic-write: timed out waiting for the writer
/// lock`。这里按 PID 存活做等价恢复——**持有者还活着就绝不碰**，所以并发安装不会互相
/// 踩；锁内容缺失或无法解析时同样不删（无法证明持有者已退出）。
pub(crate) fn clear_orphan_plugin_writer_lock(profile_dir: &Path) -> bool {
    let path = plugin_writer_lock_path(profile_dir);
    let Ok(recorded) = std::fs::read_to_string(&path) else {
        return false;
    };
    if !orphan_lock_should_clear(&recorded, plugin_process_has_exited) {
        return false;
    }
    if std::fs::remove_file(&path).is_err() {
        return false;
    }
    log::warn!(
        "removed orphan plugin writer lock ({}), holder {} already exited",
        path.display(),
        recorded.trim()
    );
    true
}

/// 跨进程写锁守卫：按 `dsh-atomic-write` 的 `<profile>/package.json.lock` 协议
/// 持有写锁，Drop 时释放。
pub(crate) struct PluginWriterLock {
    path: std::path::PathBuf,
}

impl Drop for PluginWriterLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// 获取 profile 清单的跨进程写锁，供桌面壳直接改写 `package.json` 时使用。
///
/// 官方插件管理器和 `dsh plugin` 子进程都走 `withFileLock` 的同一把锁；桌面壳
/// 的读-改-写也必须持锁，否则并发切包时会把官方刚写入的清单覆盖回旧快照。
pub(crate) fn acquire_plugin_writer_lock(profile_dir: &Path) -> Result<PluginWriterLock, String> {
    let path = plugin_writer_lock_path(profile_dir);
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut delay = Duration::from_millis(20);
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                let guard = PluginWriterLock { path };
                let written = file
                    .write_all(format!("{}\n", std::process::id()).as_bytes())
                    .and_then(|()| file.sync_all());
                drop(file);
                written.map_err(|e| format!("PLUGIN_WRITER_LOCK_WRITE_FAILED: {e}"))?;
                return Ok(guard);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                take_over_exited_plugin_writer_lock(&path);
            }
            Err(error) => return Err(format!("PLUGIN_WRITER_LOCK_FAILED: {error}")),
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "PLUGIN_WRITER_LOCK_TIMEOUT: timed out waiting for {}",
                path.display()
            ));
        }
        std::thread::sleep(delay);
        delay = (delay * 2).min(Duration::from_millis(200));
    }
}

/// 接管已退出进程留下的写锁：认领文件 + 二次核对，避免误删竞争方刚拿到的锁。
fn take_over_exited_plugin_writer_lock(path: &Path) -> bool {
    let Ok(record) = std::fs::read_to_string(path) else {
        return false;
    };
    if !orphan_lock_should_clear(&record, plugin_process_has_exited) {
        return false;
    }
    let Some(claim) = claim_takeover(path, &record) else {
        return false;
    };
    let still_stale = std::fs::read_to_string(path).ok().as_deref() == Some(record.as_str())
        && orphan_lock_should_clear(&record, plugin_process_has_exited);
    let removed = still_stale && std::fs::remove_file(path).is_ok();
    let _ = std::fs::remove_file(&claim);
    removed
}

/// 认领一次接管：认领文件记录持有者 PID，已退出持有者留下的认领可被回收。
fn claim_takeover(path: &Path, record: &str) -> Option<std::path::PathBuf> {
    use std::io::Write;

    let claim = path.with_file_name(format!(
        "package.json.lock.takeover-{:016x}",
        lock_record_hash(record)
    ));
    for attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&claim)
        {
            Ok(mut file) => {
                let _ = file
                    .write_all(format!("{}\n", std::process::id()).as_bytes())
                    .and_then(|()| file.sync_all());
                return Some(claim);
            }
            Err(error) if attempt == 0 && error.kind() == std::io::ErrorKind::AlreadyExists => {
                let Ok(owner) = std::fs::read_to_string(&claim) else {
                    return None;
                };
                if !orphan_lock_should_clear(&owner, plugin_process_has_exited) {
                    return None;
                }
                let _ = std::fs::remove_file(&claim);
            }
            Err(_) => return None,
        }
    }
    None
}

fn lock_record_hash(record: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    record.hash(&mut hasher);
    hasher.finish()
}

pub(crate) fn process_cleanup_failure(owner: ProcessOwner) -> Option<String> {
    cleanup_failure_sender()
        .borrow()
        .as_ref()
        .filter(|(active, _)| *active == owner)
        .map(|(_, reason)| reason.clone())
}

pub(crate) fn is_process_cleanup_failure(error: &str) -> bool {
    let mut error = error;
    loop {
        if [
            // 不能整段匹配 `PNPM_PROBE_`：锁被正常安装占住时的 `PNPM_PROBE_LOCK_TIMEOUT`
            // 只是竞争，不代表上一次清理未确认。
            "PNPM_PROBE_TREE_CLEANUP_FAILED:",
            "PNPM_PROBE_CLEANUP_",
            "PLUGIN_PROCESS_",
            "PREINSTALL_WAIT:",
            "INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT:",
            "INTERNAL_PLUGIN_ENSURE_DROPPED:",
        ]
        .iter()
        .any(|prefix| error.starts_with(prefix))
        {
            return true;
        }
        let Some(inner) = error.strip_prefix("INTERNAL_PLUGIN_INSTALL_FAILED: ") else {
            return false;
        };
        error = inner;
    }
}

pub(crate) fn is_internal_plugin_startup_failure(error: &str) -> bool {
    let mut error = error;
    loop {
        if is_process_cleanup_failure(error)
            || [
                "PLUGIN_POLICY_BLOCKED:",
                "INTERNAL_PLUGIN_INSTALL_TIMEOUT:",
                "INTERNAL_PLUGIN_INSTALL_CANCELLED:",
            ]
            .iter()
            .any(|prefix| error.starts_with(prefix))
        {
            return true;
        }
        let Some(inner) = error.strip_prefix("INTERNAL_PLUGIN_INSTALL_FAILED: ") else {
            return false;
        };
        error = inner;
    }
}

pub(crate) fn mark_process_cleanup_failed(owner: ProcessOwner, reason: String) {
    cleanup_failure_sender().send_if_modified(|failure| {
        if failure.as_ref().is_some_and(|(active, current)| {
            *active == owner && current.starts_with("PNPM_PROBE_TREE_CLEANUP_FAILED:")
        }) {
            return false;
        }
        *failure = Some((owner, reason));
        true
    });
}

pub(crate) fn clear_process_cleanup_failed(owner: ProcessOwner) {
    cleanup_failure_sender().send_if_modified(|failure| {
        if failure.as_ref().is_some_and(|(active, _)| *active == owner) {
            *failure = None;
            true
        } else {
            false
        }
    });
}

pub(crate) fn release_process_cleanup(
    owner: ProcessOwner,
    pid_guard: PidGuard,
    process_guard: tokio::sync::OwnedMutexGuard<()>,
) {
    clear_process_cleanup_failed(owner);
    drop(pid_guard);
    drop(process_guard);
}

pub(crate) async fn acquire_process_lock() -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
    let lock = PLUGIN_PROCESS_LOCK
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    let mut cleanup_failure = cleanup_failure_sender().subscribe();
    loop {
        if let Some((_, reason)) = cleanup_failure.borrow().as_ref() {
            return Err(reason.clone());
        }
        tokio::select! {
            guard = lock.clone().lock_owned() => {
                if let Some((_, reason)) = cleanup_failure.borrow().as_ref() {
                    drop(guard);
                    return Err(reason.clone());
                }
                return Ok(guard);
            }
            changed = cleanup_failure.changed() => {
                if changed.is_err() {
                    return Err(
                        "PLUGIN_PROCESS_COORDINATOR_DROPPED: cleanup coordinator ended unexpectedly"
                            .to_string(),
                    );
                }
            }
        }
    }
}

pub(crate) async fn acquire_operation_lock() -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
    let operation = PLUGIN_OPERATION_LOCK
        .get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
        .lock_owned()
        .await;
    // 取消调用方后，阻塞线程仍可能持有正在写档案的子进程。
    drop(acquire_process_lock().await?);
    Ok(operation)
}

/// 记录/清除当前安装进程 PID（guard-drop 模式，作用域结束自动复位）。
pub(crate) struct PidGuard {
    owner: ProcessOwner,
    pid: u32,
}

impl PidGuard {
    pub(crate) fn set(owner: ProcessOwner, pid: u32) -> Self {
        active_pid_lock()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(owner, ActivePluginProcess { pid, child: None });
        Self { owner, pid }
    }

    pub(crate) fn set_child(owner: ProcessOwner, child: &Arc<Mutex<std::process::Child>>) -> Self {
        let pid = child.lock().unwrap_or_else(|error| error.into_inner()).id();
        active_pid_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                owner,
                ActivePluginProcess {
                    pid,
                    child: Some(child.clone()),
                },
            );
        Self { owner, pid }
    }
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        let mut active = active_pid_lock().lock().unwrap_or_else(|e| e.into_inner());
        if active
            .get(&self.owner)
            .is_some_and(|process| process.pid == self.pid)
        {
            active.remove(&self.owner);
        }
    }
}

/// Windows 进程句柄包装：原始句柄是 `*mut c_void`（非 Send），
/// 但 `WaitForSingleObject`/`GetExitCodeProcess` 均为线程安全的系统调用，
/// 包一层以安全地移入 `spawn_blocking` 等待进程退出。
#[cfg(windows)]
struct WaitableHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for WaitableHandle {}

/// 启动 `dsh plugin` 进程并等待结束，返回 `(退出码, 捕获的完整输出)`。
///
/// 输出仍然逐行实时转发为 `preinstall-log` 事件（供前端进度反馈），同时把
/// 全部行追加进共享缓冲区并返回——安装失败时 pnpm 会在错误里印出
/// `allowBuilds:` 允许键（git depPath / 被忽略的构建包名），调用方需要这段
/// 文本去解析并重试。
pub(crate) async fn run_plugin_process(
    node: &Path,
    args: &[OsString],
    cwd: &Path,
    envs: &HashMap<String, String>,
    window: &Window,
    owner: ProcessOwner,
) -> Result<(i32, String), String> {
    let profile = crate::service::profile::active_profile(window.app_handle());
    let mut carrier_args = Vec::new();
    let args = if args.get(1).is_some_and(|arg| arg == "plugin")
        && args.get(2).is_some_and(|arg| arg == "--profile")
        && args
            .get(3)
            .is_some_and(|arg| arg == crate::service::profile::DESKTOP_PROFILE)
    {
        carrier_args.extend(crate::service::profile::carrier_node_args(false));
        carrier_args.extend_from_slice(args);
        carrier_args.as_slice()
    } else {
        args
    };
    let process_guard = acquire_process_lock().await?;
    let captured = Arc::new(Mutex::new(String::new()));

    #[cfg(windows)]
    {
        let (stdout, stderr, pid, handle) =
            workflow::win_spawn::spawn_with_hidden_console_owned(node, args, Some(cwd), envs)
                .map_err(|e| format!("PREINSTALL_SPAWN: {e}"))?;
        let pid_guard = PidGuard::set(owner, pid);
        log::info!("dsh plugin install started, pid {pid}");

        spawn_line_emitter(stdout, window.clone(), captured.clone());
        spawn_line_emitter(stderr, window.clone(), captured.clone());

        let handle = WaitableHandle(handle);
        let exit_code = tauri::async_runtime::spawn_blocking(move || {
            crate::service::workflow::instances::scope_sync(profile, || {
                let _process_guard = process_guard;
                let _pid_guard = pid_guard;
                use windows_sys::Win32::Foundation::CloseHandle;
                use windows_sys::Win32::System::Threading::{
                    GetExitCodeProcess, WaitForSingleObject, INFINITE,
                };
                let handle = handle;
                unsafe {
                    let wait = WaitForSingleObject(handle.0, INFINITE);
                    let mut code: u32 = 0;
                    if GetExitCodeProcess(handle.0, &mut code) == 0 {
                        code = wait;
                    }
                    CloseHandle(handle.0);
                    code as i32
                }
            })
        })
        .await
        .map_err(|e| format!("PREINSTALL_WAIT: {e}"))?;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok((exit_code, drain_captured(captured)))
    }

    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new(node)
            .args(args)
            .envs(envs)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 独立进程组：取消时可用 `kill(-pid, ...)` 一次结束整棵安装进程树
            .process_group(0)
            .spawn()
            .map_err(|e| format!("PREINSTALL_SPAWN: {e}"))?;

        let pid = child.id();
        let pid_guard = PidGuard::set(owner, pid);
        // 绑定守卫实例：本 cfg 块作用域结束时自动把共享 PID 槽复位为 None，
        // 避免把「这一次安装」的 PID 泄漏给之后的取消/下一次安装（误杀无关进程）。
        // 若 spawn_blocking 因错误提前 `?` 返回，守卫同样会 Drop 复位。
        log::info!("dsh plugin install started, pid {pid}");

        if let Some(stdout) = child.stdout.take() {
            spawn_line_emitter(stdout, window.clone(), captured.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            spawn_line_emitter(stderr, window.clone(), captured.clone());
        }

        let exit_code = tauri::async_runtime::spawn_blocking(move || {
            crate::service::workflow::instances::scope_sync(profile, || {
                let _process_guard = process_guard;
                let _pid_guard = pid_guard;
                child.wait().map(|s| s.code().unwrap_or(1)).unwrap_or(1)
            })
        })
        .await
        .map_err(|e| format!("PREINSTALL_WAIT: {e}"))?;

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok((exit_code, drain_captured(captured)))
    }
}

/// 取出（并清空）共享缓冲区中的全部捕获输出。
pub(super) fn drain_captured(captured: Arc<Mutex<String>>) -> String {
    captured
        .lock()
        .map(|mut buf| std::mem::take(&mut *buf))
        .unwrap_or_default()
}

/// 在独立线程中逐行读取进程输出：实时通过 `preinstall-log` 事件转发，
/// 同时追加进共享缓冲区。
/// 使用静态泛型约束 `R: Read + Send + 'static` 避免动态派发（Box<dyn Read>）堆分配。
fn spawn_line_emitter<R: Read + Send + 'static>(
    reader: R,
    window: Window,
    captured: Arc<Mutex<String>>,
) {
    std::thread::spawn(move || {
        let mut buf = BufReader::new(reader);
        let mut acc_buf = Vec::new();
        loop {
            acc_buf.clear();
            match buf.read_until(b'\n', &mut acc_buf) {
                Ok(0) => break,
                Ok(_) => {
                    // 非法 UTF-8 不能中断本线程：管道读端一关，子进程写 stderr
                    // 就收到 EPIPE，安装进程可能因此以非 0 退出码失败而被误判为
                    // 安装失败。解码先走 ANSI 代码页（`decode_process_line`），
                    // zh-CN Windows 下 python MCP 插件的 GBK 日志才不会变乱码。
                    // 行尾剥离与上游 utils.rs 的 #197 修复一致：只剥 \r\n/\n，
                    // 保留行内尾随空白以对齐 BufRead::lines() 语义。
                    let line = decode_process_line(&acc_buf);
                    let trimmed = line
                        .strip_suffix("\r\n")
                        .or_else(|| line.strip_suffix('\n'))
                        .unwrap_or(&line)
                        .to_string();
                    let _ = window.emit(
                        PREINSTALL_LOG_EVENT,
                        PreinstallLogPayload {
                            line: trimmed.clone(),
                        },
                    );
                    if let Ok(mut acc) = captured.lock() {
                        acc.push_str(&trimmed);
                        acc.push('\n');
                    }
                }
                Err(e) => {
                    log::error!("Failed to read plugin process output: {}", e);
                    break;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn operation_preparation_waits_for_a_cancelled_process_to_exit() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let scratch = tempfile::tempdir().unwrap();
        let manifest = scratch.path().join("package.json");
        std::fs::write(&manifest, "original").unwrap();
        let process = acquire_process_lock().await.unwrap();
        let mut preparation = Box::pin(async {
            let _operation = acquire_operation_lock().await.unwrap();
            std::fs::write(&manifest, "prepared").unwrap();
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut preparation)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(&manifest).unwrap(), "original");
        drop(process);
        tokio::time::timeout(Duration::from_secs(5), preparation)
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&manifest).unwrap(), "prepared");
    }

    #[tokio::test]
    async fn profile_reset_waits_for_plugin_postverification_after_process_exit() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let scratch = tempfile::tempdir().unwrap();
        let profile = scratch.path().join("profile");
        std::fs::create_dir(&profile).unwrap();
        let marker = profile.join("plugin-state");
        std::fs::write(&marker, "installed").unwrap();
        let operation = acquire_operation_lock().await.unwrap();
        let process = acquire_process_lock().await.unwrap();
        drop(process);
        let mut reset = Box::pin(async {
            let mutation = crate::service::profile::mutation::acquire().await.unwrap();
            let root = scratch.path().to_path_buf();
            mutation
                .spawn_blocking("profile".into(), move || {
                    crate::service::profile::reset_with_root(&root, "profile")
                })
                .await
                .unwrap()
                .unwrap();
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut reset)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "installed");
        std::fs::write(&marker, "verified").unwrap();
        drop(operation);
        tokio::time::timeout(Duration::from_secs(5), reset)
            .await
            .unwrap();
        assert!(!marker.exists());
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(profile.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "dsh-profile-profile");
    }

    #[tokio::test]
    async fn cancelled_profile_mutation_keeps_locks_until_blocking_work_finishes() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path().to_path_buf();
        let marker = root.join("profile/plugin-state");
        std::fs::create_dir(root.join("profile")).unwrap();
        std::fs::write(&marker, "installed").unwrap();
        let mutation = crate::service::profile::mutation::acquire().await.unwrap();
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (finished, completed) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            mutation
                .spawn_blocking("profile".into(), move || {
                    started.send(()).unwrap();
                    wait.recv_timeout(Duration::from_secs(10)).unwrap();
                    crate::service::profile::reset_with_root(&root, "profile").unwrap();
                    finished.send(()).unwrap();
                })
                .await
                .unwrap();
        });
        tokio::time::timeout(Duration::from_secs(5), entered)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(30), acquire_operation_lock())
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(30), acquire_process_lock())
                .await
                .is_err()
        );
        assert!(
            tokio::time::timeout(
                Duration::from_millis(30),
                crate::service::workflow::acquire_core_transition(),
            )
            .await
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "installed");
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), completed)
            .await
            .unwrap()
            .unwrap();
        let operation = tokio::time::timeout(Duration::from_secs(5), acquire_operation_lock())
            .await
            .unwrap()
            .unwrap();
        drop(operation);
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn unconfirmed_process_cleanup_refuses_profile_mutation_without_writing() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let scratch = tempfile::tempdir().unwrap();
        let marker = scratch.path().join("profile/plugin-state");
        std::fs::create_dir(scratch.path().join("profile")).unwrap();
        std::fs::write(&marker, "installed").unwrap();
        let owner = new_process_owner();
        let reason = "PLUGIN_PROCESS_CLEANUP_FAILED: test process is still active";
        mark_process_cleanup_failed(owner, reason.into());
        let result = crate::service::profile::mutation::acquire().await;
        clear_process_cleanup_failed(owner);
        match result {
            Err(error) => assert_eq!(error, reason),
            Ok(_) => panic!("profile mutation must refuse unconfirmed process cleanup"),
        }
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "installed");
    }

    #[tokio::test]
    async fn blocking_plugin_task_retains_captured_profile() {
        use crate::service::workflow::instances;
        instances::scope("plugin-window-profile".into(), async {
            let profile = instances::current_profile().unwrap();
            let captured = tauri::async_runtime::spawn_blocking(move || {
                instances::scope_sync(profile, instances::current_profile)
            })
            .await
            .unwrap();
            assert_eq!(captured.as_deref(), Some("plugin-window-profile"));
        })
        .await;
        assert_eq!(instances::current_profile(), None);
    }

    #[test]
    fn drain_captured_preserves_exact_output_and_clears_shared_buffer() {
        let captured = Arc::new(Mutex::new(
            "stdout  \r\n\tstderr\0中文\npartial\r".to_string(),
        ));

        assert_eq!(
            drain_captured(captured.clone()),
            "stdout  \r\n\tstderr\0中文\npartial\r"
        );
        assert_eq!(*captured.lock().unwrap(), "");
        assert_eq!(drain_captured(captured.clone()), "");

        captured.lock().unwrap().push_str("late stderr");
        assert_eq!(drain_captured(captured.clone()), "late stderr");
        assert_eq!(*captured.lock().unwrap(), "");
    }

    #[test]
    fn drain_captured_returns_empty_without_recovering_poisoned_buffer() {
        let captured = Arc::new(Mutex::new("retained output".to_string()));
        let writer = captured.clone();
        assert!(std::thread::spawn(move || {
            let _guard = writer.lock().unwrap();
            panic!("poison isolated capture buffer");
        })
        .join()
        .is_err());

        assert_eq!(drain_captured(captured.clone()), "");
        assert!(captured.is_poisoned());
        assert_eq!(
            *captured.lock().unwrap_err().into_inner(),
            "retained output"
        );
    }

    #[tokio::test]
    async fn stale_guard_cannot_clear_a_new_process_for_the_same_owner() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let owner = new_process_owner();
        let stale = PidGuard::set(owner, 100);
        let current = PidGuard::set(owner, 200);

        drop(stale);
        assert_eq!(active_plugin_pid(owner), Some(200));

        drop(current);
        assert_eq!(active_plugin_pid(owner), None);
    }

    #[tokio::test]
    async fn cleanup_failure_clears_before_lock_handoff_and_preserves_other_owner() {
        let _test_guard = TEST_PROCESS_LOCK.lock().await;
        let guard = acquire_process_lock().await.unwrap();
        let owner = new_process_owner();
        let pid_guard = PidGuard::set(owner, 100);
        let reason = "PLUGIN_PROCESS_CLEANUP_FAILED: test process is still active".to_string();
        mark_process_cleanup_failed(owner, reason.clone());

        let waiter = tokio::spawn(acquire_process_lock());
        tokio::task::yield_now().await;
        assert!(
            waiter.is_finished(),
            "active cleanup failure should wake a queued waiter"
        );
        assert_eq!(waiter.await.unwrap().unwrap_err(), reason);

        clear_process_cleanup_failed(owner);
        let handoff = tokio::spawn(acquire_process_lock());
        tokio::task::yield_now().await;
        assert!(
            !handoff.is_finished(),
            "waiter should queue after failure clears while guard remains held"
        );
        drop(pid_guard);
        drop(guard);
        assert!(handoff.await.unwrap().is_ok());
        assert_eq!(active_plugin_pid(owner), None);

        let guard = acquire_process_lock().await.unwrap();
        let other_owner = new_process_owner();
        let stale_pid_guard = PidGuard::set(owner, 101);
        let other_reason =
            "PLUGIN_PROCESS_CLEANUP_FAILED: another owner is still active".to_string();
        mark_process_cleanup_failed(other_owner, other_reason.clone());
        release_process_cleanup(owner, stale_pid_guard, guard);

        assert_eq!(
            acquire_process_lock().await.unwrap_err(),
            other_reason,
            "clearing a stale owner must not remove another owner's failure"
        );
        clear_process_cleanup_failed(other_owner);

        let tree_reason = "PNPM_PROBE_TREE_CLEANUP_FAILED: tree exit is unconfirmed".to_string();
        mark_process_cleanup_failed(owner, tree_reason.clone());
        mark_process_cleanup_failed(owner, "PNPM_PROBE_TIMEOUT: cleanup started".to_string());
        let retained = cleanup_failure_sender().borrow().clone();
        assert_eq!(process_cleanup_failure(owner), Some(tree_reason.clone()));
        clear_process_cleanup_failed(owner);
        assert_eq!(retained, Some((owner, tree_reason)));
    }

    #[test]
    fn cleanup_classifier_keeps_ordinary_install_failures_best_effort() {
        for blocked in [
            "PNPM_PROBE_TREE_CLEANUP_FAILED: tree exit is unconfirmed",
            "PNPM_PROBE_CLEANUP_TIMEOUT: pnpm version probe cleanup did not finish within 5 seconds",
            "PLUGIN_PROCESS_CLEANUP_FAILED: test process is still active",
            "PLUGIN_PROCESS_COORDINATOR_DROPPED: cleanup coordinator ended unexpectedly",
            "PREINSTALL_WAIT: wait task failed",
            "INTERNAL_PLUGIN_PROCESS_REAP_TIMEOUT: owner remained active",
            "INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_PROCESS_CLEANUP_FAILED: active child",
            "INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_INSTALL_FAILED: PREINSTALL_WAIT: no confirmation",
        ] {
            assert!(
                is_process_cleanup_failure(blocked),
                "{blocked} must terminate startup instead of warning"
            );
        }
        for best_effort in [
            "PNPM_PROBE_LOCK_TIMEOUT: timed out waiting for the process lock",
            "PNPM_PROBE_TIMEOUT: pnpm version probe timed out but the process was recycled",
            "PNPM_PROBE_TASK_FAILED: task panicked",
            "PNPM_INSTALL_FAILED: exit code 1: ERR_PNPM_UNEXPECTED_STORE",
            "INTERNAL_PLUGIN_INSTALL_FAILED: pnpm add failed",
            "DEPRECATED_PLUGIN_UNINSTALL_FAILED: dshmarket: missing",
            "PRESET_PLUGIN_STILL_MISSING: 修复后仍缺失以下插件产物",
        ] {
            assert!(
                !is_process_cleanup_failure(best_effort),
                "{best_effort} must stay best-effort"
            );
        }
    }

    #[test]
    fn internal_plugin_policy_blocks_remain_fatal_when_wrapped() {
        for blocked in [
            "PLUGIN_POLICY_BLOCKED: []",
            "INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_POLICY_BLOCKED: []",
            "INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_INSTALL_FAILED: PLUGIN_POLICY_BLOCKED: []",
            "INTERNAL_PLUGIN_INSTALL_TIMEOUT: plugin install exceeded 600 seconds",
            "INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_INSTALL_TIMEOUT: plugin install exceeded 600 seconds",
            "INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled",
            "INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_INSTALL_FAILED: INTERNAL_PLUGIN_INSTALL_CANCELLED: plugin install was cancelled",
        ] {
            assert!(is_internal_plugin_startup_failure(blocked));
        }
        assert!(!is_internal_plugin_startup_failure(
            "INTERNAL_PLUGIN_INSTALL_FAILED: pnpm add failed"
        ));
        assert!(!is_internal_plugin_startup_failure(
            "INTERNAL_PLUGIN_SOURCE_MISSING: optional bundle source missing"
        ));
    }

    #[test]
    fn orphan_lock_clears_only_for_exited_positive_pid() {
        let alive = |_: u32| false;
        let exited = |_: u32| true;
        assert!(orphan_lock_should_clear("1234\n", exited));
        assert!(!orphan_lock_should_clear("1234\n", alive));
        assert!(!orphan_lock_should_clear("", exited));
        assert!(!orphan_lock_should_clear("   \n", exited));
        assert!(!orphan_lock_should_clear("not-a-pid", exited));
        assert!(!orphan_lock_should_clear("-1", exited));
        assert!(!orphan_lock_should_clear("0", exited));
    }

    #[test]
    fn orphan_lock_file_is_removed_for_dead_holder_and_kept_for_live_one() {
        let dir = std::env::temp_dir().join(format!(
            "dsh-orphan-lock-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = plugin_writer_lock_path(&dir);

        let live = std::process::id();
        std::fs::write(&path, format!("{live}\n")).unwrap();
        assert!(
            !clear_orphan_plugin_writer_lock(&dir),
            "live holder must never be touched"
        );
        assert!(path.exists());

        std::fs::write(&path, "garbage").unwrap();
        assert!(!clear_orphan_plugin_writer_lock(&dir));
        assert!(path.exists());

        std::fs::write(&path, format!("{}\n", u32::MAX - 1)).unwrap();
        assert!(
            clear_orphan_plugin_writer_lock(&dir),
            "unknown/absent pid counts as exited"
        );
        assert!(!path.exists());

        assert!(!clear_orphan_plugin_writer_lock(&dir), "no lock, no-op");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn writer_lock_test_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-writer-lock-{}-{:?}-{tag}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writer_lock_records_holder_and_releases_on_drop() {
        let dir = writer_lock_test_dir("release");
        let path = plugin_writer_lock_path(&dir);

        let guard = acquire_plugin_writer_lock(&dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap().trim(),
            std::process::id().to_string()
        );

        drop(guard);
        assert!(!path.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writer_lock_takes_over_dead_holder() {
        let dir = writer_lock_test_dir("takeover");
        let path = plugin_writer_lock_path(&dir);
        std::fs::write(&path, "4000000\n").unwrap();

        let guard = acquire_plugin_writer_lock(&dir).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap().trim(),
            std::process::id().to_string()
        );

        drop(guard);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writer_lock_reclaims_claim_left_by_exited_process() {
        let dir = writer_lock_test_dir("stale-claim");
        let path = plugin_writer_lock_path(&dir);
        let record = "4000000\n".to_string();
        std::fs::write(&path, &record).unwrap();
        let claim = path.with_file_name(format!(
            "package.json.lock.takeover-{:016x}",
            lock_record_hash(&record)
        ));
        std::fs::write(&claim, "3999999\n").unwrap();

        let guard = acquire_plugin_writer_lock(&dir).unwrap();
        assert!(!claim.exists());

        drop(guard);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
