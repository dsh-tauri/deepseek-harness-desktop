//! Harness 进程生命周期：本应用持有的根进程登记（PID + Windows 句柄成对存储）、
//! 启动守卫、进程树终止与退出状态回落，以及按 dsh 安装路径清扫历史残留的
//! 孤儿服务实例（各平台都按入口路径清扫：Windows 需穿过垫片的 `cmd.exe /C node`
//! 转发层判断持有者，Unix 的匹配与父进程状态无关，转发层自身也会被命中）。

use crate::config;
use std::fs;
#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, OwnedHandle};
use std::path::Path;
use std::process::Command;
#[cfg(windows)]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::AppHandle;

use super::status;
use super::sweep::harness_pid_path;
use super::utils::wait_for_port_release;

/// 当前持有的 Harness 根进程意外退出时通知前端的专用事件。
pub(super) const HARNESS_PROCESS_EXITED_EVENT: &str = "harness-process-exited";

/// Harness 根进程退出事件载荷。退出码在 Unix 被信号终止或系统查询失败时为空。
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessProcessExitedPayload {
    pub(super) pid: u32,
    pub(super) exit_code: Option<i64>,
}

/// 结束进程后等待端口回落的上限（正常情况毫秒级返回，只有真占用才等到上限）。
const PORT_RELEASE_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

/// 启动守卫：并发调用 `launch` 时只允许一个真正拉起 dsh 进程
pub(crate) fn launch_guard() -> Arc<AtomicBool> {
    Arc::clone(&super::instances::instance().launching)
}

/// 当前进程内由桌面端创建的 Harness 根进程（PID + Windows 句柄）。
///
/// PID 与句柄装在同一把锁的可选值里：`take()` 一次性成对取出，保证
/// 「PID 清空」与「句柄关闭」之间不存在跨原子竞态（WARN-6）。历史上 PID/句柄
/// 分两个 `Atomic*` 存储，`stop` 读 PID 与监视线程清句柄之间有微窗口可能导致
/// 漏杀或重复 close。
#[derive(Clone)]
pub(super) struct OwnedProcess {
    pub(super) pid: u32,
    #[cfg(windows)]
    pub(super) handle: Arc<OwnedHandle>,
}

/// 本次启动是否已按 dsh 入口路径清扫过历史残留。
///
/// 启动期的两处清扫（setup 的 sweep_orphan_harness 与 launch 前的那次）读的是同一份
/// 进程快照：两次之间没有任何进程由本应用拉起，结论不会变化，而 Windows 上一次全量
/// 枚举约 0.3–0.6s，重复执行纯属浪费启动时间。
static STARTUP_SWEEP_DONE: AtomicBool = AtomicBool::new(false);

/// 取用一次清扫机会：本次启动已清扫过时返回 false，调用方跳过重复清扫。
///
/// 先取后清，并发调用里只有一个真正执行。
pub(super) fn take_startup_sweep() -> bool {
    !STARTUP_SWEEP_DONE.swap(true, Ordering::SeqCst)
}

pub(super) fn retry_startup_sweep() {
    STARTUP_SWEEP_DONE.store(false, Ordering::SeqCst);
}

pub(super) fn register_owned_process<T>(
    previous_pid: Option<u32>,
    spawn: impl FnOnce() -> Result<(OwnedProcess, T), String>,
) -> Result<Option<T>, String> {
    register_owned_process_at(
        &super::instances::instance(),
        super::instances::registration_gate(),
        previous_pid,
        spawn,
    )
}

fn register_owned_process_at<T>(
    instance: &super::instances::Instance,
    shutdown: &std::sync::Mutex<bool>,
    previous_pid: Option<u32>,
    spawn: impl FnOnce() -> Result<(OwnedProcess, T), String>,
) -> Result<Option<T>, String> {
    let shutdown = shutdown.lock().unwrap_or_else(|error| error.into_inner());
    let mut guard = instance.process.lock().unwrap_or_else(|e| e.into_inner());
    if *shutdown
        || !instance.launching.load(Ordering::SeqCst)
        || guard.as_ref().map(|process| process.pid) != previous_pid
    {
        return Ok(None);
    }
    let (owned, value) = spawn()?;
    *guard = Some(owned);
    Ok(Some(value))
}

fn take_owned_process() -> Option<OwnedProcess> {
    let instance = super::instances::instance();
    let mut guard = instance.process.lock().unwrap_or_else(|e| e.into_inner());
    instance.launching.store(false, Ordering::SeqCst);
    guard.take()
}

/// 纯函数部分：便于单测，不触碰全局状态。
fn take_owned_process_if_matching(
    owned: &mut Option<OwnedProcess>,
    pid: u32,
) -> Option<OwnedProcess> {
    if owned.as_ref().map(|p| p.pid) == Some(pid) {
        owned.take()
    } else {
        None
    }
}

pub(crate) struct LaunchGuard(pub(super) Arc<AtomicBool>);

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 核心目录操作互斥锁：统一串行化「切换目录」与「启动并登记进程」两个临界区。
///
/// 不能只用一个布尔守卫：两个并发切换可能互相覆盖/清除状态，且 launch 在检查
/// 守卫与登记进程之间仍存在窗口。使用同一把 Tokio mutex 后，切换从停服到目录
/// 互换完成、launch 从最终状态检查到进程登记均保持互斥，避免 Harness 进程在
/// `dependencies/dsh` 目录交换期间加载 DLL 并产生 Windows os error 32。
fn core_transition_lock() -> &'static Arc<tokio::sync::Mutex<()>> {
    static LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    LOCK.get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
}

/// 获取核心目录操作互斥锁，最长等待 15 秒。
///
/// 调用方必须从获取锁开始，持续持有到目录切换完成或 Harness 进程登记完成；
/// RAII guard 会在所有成功/失败路径自动释放。超时必须失败返回，避免切换或启动
/// 卡死后永久阻塞后续所有核心操作。
pub async fn acquire_core_transition() -> Result<tokio::sync::OwnedMutexGuard<()>, String> {
    const CORE_TRANSITION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
    tokio::time::timeout(
        CORE_TRANSITION_TIMEOUT,
        Arc::clone(core_transition_lock()).lock_owned(),
    )
    .await
    .map_err(|error| {
        format!(
            "CORE_TRANSITION_TIMEOUT: timed out after {} seconds waiting for core transition lock: {error}",
            CORE_TRANSITION_TIMEOUT.as_secs()
        )
    })
}

/// 是否持有 Harness 进程。与其它访问器一致：锁被毒化（panic 残留）时取回
/// 毒化守卫继续读取，而不是把「已登记进程」误报为「无」。
pub fn has_owned_process() -> bool {
    crate::service::workflow::instances::instance()
        .process
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}

pub fn owned_process_pid() -> Option<u32> {
    crate::service::workflow::instances::instance()
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|process| process.pid)
}

/// 处理「持有的 dsh 进程退出」这一事实（由退出监视线程与健康检查 tick 共用）：
///
/// - 仅当退出的 PID 仍是当前登记的那个进程时才清空持有（按 pid 匹配），
///   PID/句柄作为整体成对取出——杜绝「读 PID」与「清句柄」
///   之间的跨原子竞态（WARN-6），也杜绝旧监视线程误清新启动进程的登记；
/// - 匹配成功后无条件回落到 Stopped——进程可能在 Starting 或 Running 阶段
///   退出，任何情况下都不能继续广播一个已经失效的运行状态（WARN-5）。
///
/// 幂等：多次调用只会生效一次，后续调用返回 None。
#[cfg(test)]
pub(super) fn on_owned_process_exit<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    pid: u32,
    exit_code: impl FnOnce(&OwnedProcess) -> Option<i64>,
) -> Option<OwnedProcess> {
    on_owned_process_exit_at(pid, exit_code, |payload| {
        status::emit_status(app_handle);
        super::instances::emit(app_handle, HARNESS_PROCESS_EXITED_EVENT, payload);
    })
}

pub(super) fn on_owned_process_exit_at(
    pid: u32,
    exit_code: impl FnOnce(&OwnedProcess) -> Option<i64>,
    notify: impl FnOnce(HarnessProcessExitedPayload),
) -> Option<OwnedProcess> {
    let (owned, exit_code) = {
        let instance = super::instances::instance();
        let mut guard = instance
            .process
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let owned = take_owned_process_if_matching(&mut guard, pid)?;
        // issue #1075：报告路径落盘前不让健康探测观察到 ownership 丢失。
        let exit_code = exit_code(&owned);
        *instance
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = status::Status::Stopped;
        (owned, exit_code)
    };

    if let Some(code) = exit_code {
        log::warn!(
            "Owned Harness process {} exited with code {code}; resetting status to Stopped",
            owned.pid
        );
        // SIGABRT：V8 堆耗尽（`JavaScript heap out of memory`）是桌面端最常见的成因
        // （issue #699），补一条可检索的日志，便于在没有前端时定位。
        if code == 134 {
            log::warn!(
                "HARNESS_HEAP_OOM: Harness aborted (code 134 / SIGABRT); an exhausted V8 heap \
                 limit is the common cause — raise the service memory limit in Settings"
            );
        }
    } else {
        log::warn!(
            "Owned Harness process {} exited (exit code unavailable); resetting status to Stopped",
            owned.pid
        );
    }

    notify(HarnessProcessExitedPayload {
        pid: owned.pid,
        exit_code,
    });
    Some(owned)
}

/// 只结束本应用当前进程创建并仍持有的 Harness 进程树。
///
/// 返回是否真的结束了一个进程：调用方据此决定要不要等端口释放。没有持有进程时
/// 是纯 no-op，不该白等——退出与安装器路径都在用户可见的关键路径上。
fn terminate_owned_process() -> Result<bool, ()> {
    // 一次性取出 PID+句柄（成对），杜绝「PID 已清空/句柄未清」的漏杀窗口
    let Some(owned) = take_owned_process() else {
        return Ok(false);
    };

    #[cfg(windows)]
    {
        let handle = owned.handle.as_raw_handle();
        if let Err(error) = terminate_windows_process(owned.pid, handle, kill_pid_tree) {
            log::error!("{error}");
            log::error!("Harness process {} is still running after stop", owned.pid);
            let instance = super::instances::instance();
            let mut guard = instance
                .process
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if guard.is_none() {
                *guard = Some(owned);
            }
            return Err(());
        }
    }

    #[cfg(unix)]
    {
        kill_pid_tree(owned.pid);
    }

    Ok(true)
}

/// 结束进程树（Windows `taskkill /PID <pid> /T /F`；Unix 负 PID 进程组，与
/// 启动时 `process_group(0)` 对应）。调用方需先确认 PID 确实指向目标进程。
pub(super) fn kill_pid_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        match cmd.output() {
            Ok(output) if output.status.success() => {}
            Ok(output) => log::error!(
                "Failed to stop Harness process tree {pid}: taskkill exited with {}",
                output.status
            ),
            Err(e) => log::error!("Failed to stop Harness process tree {pid}: {e}"),
        }
    }

    #[cfg(unix)]
    {
        // Harness 根进程启动在独立进程组中，负 PID 只作用于该进程树；手动通过
        // CLI 拉起的外围 dsh 进程未必有独立进程组（组信号报错），此时回退直接
        // 杀 PID——PID 的归属已由调用方确认（路径匹配或 .harness.pid 双重确认），
        // 绝不会误杀未知进程。
        let group = format!("-{pid}");
        let group_term_ok = Command::new("kill")
            .args(["-TERM", "--", &group])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !group_term_ok {
            let _ = Command::new("kill")
                .args(["-TERM", "--", &pid.to_string()])
                .output();
        }
        std::thread::sleep(std::time::Duration::from_millis(300));
        let group_kill_ok = Command::new("kill")
            .args(["-KILL", "--", &group])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);
        if !group_kill_ok {
            let _ = Command::new("kill")
                .args(["-KILL", "--", &pid.to_string()])
                .output();
        }
    }
}

/// 解析 `ps -axo pid=,command=` 的一行：返回 `(PID, 命令行)`。
///
/// 输出形如 `   12345 node /path/to/bin.js --profile web ...`（PID 前可能有
/// 前导空格、行尾有换行）。PID 缺失或不可解析的行返回 None（跳过该行）。
#[cfg_attr(windows, allow(dead_code))] // 仅 Unix 清场分支与测试使用
fn parse_ps_line(line: &str) -> Option<(u32, &str)> {
    let trimmed = line.trim_start();
    let split = trimmed.find(|c: char| c.is_whitespace())?;
    let pid = trimmed[..split].trim().parse::<u32>().ok()?;
    Some((pid, trimmed[split..].trim_start()))
}

/// 判断命令行中是否包含一个完整参数。
///
/// `ps` 会把 argv 用空格拼成命令行，但不会给本身含空格的参数补引号，因此不能
/// 用 `split_whitespace` 还原参数。改为在原始命令行中匹配完整字符串，并校验
/// 前后为空白或行边界；这样 macOS 的 `Library/Application Support` 路径也能
/// 正确识别，同时不会把路径前缀相似的其他参数误判为目标。
#[cfg_attr(windows, allow(dead_code))] // 仅 Unix 清场分支与测试使用
fn command_line_has_argument(cmdline: &str, argument: &str) -> bool {
    if argument.is_empty() {
        return false;
    }

    cmdline.match_indices(argument).any(|(start, matched)| {
        let before_is_boundary = cmdline[..start]
            .chars()
            .next_back()
            .is_none_or(char::is_whitespace);
        let end = start + matched.len();
        let after_is_boundary = cmdline[end..]
            .chars()
            .next()
            .is_none_or(char::is_whitespace);
        before_is_boundary && after_is_boundary
    })
}

/// 判断一个参数是否紧跟在另一个完整参数之后。
#[cfg_attr(windows, allow(dead_code))] // 仅 Unix 清场分支与测试使用
fn command_line_has_argument_after(cmdline: &str, preceding: &str, argument: &str) -> bool {
    if preceding.is_empty() || argument.is_empty() {
        return false;
    }

    cmdline.match_indices(preceding).any(|(start, matched)| {
        let end = start + matched.len();
        let rest = cmdline[end..].trim_start_matches(char::is_whitespace);
        rest.strip_prefix(argument)
            .is_some_and(|tail| tail.chars().next().is_none_or(char::is_whitespace))
    })
}

#[cfg(windows)]
fn is_windows_harness_command_line(cmdline: &str, dsh_bin: &str) -> bool {
    let normalized = cmdline.replace('/', "\\");
    let path = dsh_bin.replace('/', "\\");
    // node 选项（`--max-old-space-size` 等）合法地夹在 node 与入口之间（issue #751）。
    let entry = if path.chars().any(char::is_whitespace) {
        format!(r#""{}""#, regex::escape(&path))
    } else {
        format!(r#"(?:"{}"|{})"#, regex::escape(&path), regex::escape(&path))
    };
    let boundary = format!(
        r#"(?i)^\s*(?:"(?:[^"\r\n]*\\)?node(?:\.exe)?"|(?:[^\s"]*\\)?node(?:\.exe)?)(?:\s+(?:"-[^"\r\n]*"|-[^\s"]*(?:"[^"\r\n]*")?))*\s+{entry}\s+--profile\s+(?:"[^"\r\n]+"|[^\s"]+)(?:\s+--patch\s+(?:"[^"\r\n]+"|[^\s"]+))?\s+--port\s+\d+\s+--no-open\s*$"#
    );
    regex::Regex::new(&boundary).is_ok_and(|pattern| pattern.is_match(&normalized))
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
struct WindowsCommandLine {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

#[cfg(windows)]
fn decode_windows_command_line(buffer: &[usize], returned: usize) -> Option<String> {
    let header = std::mem::size_of::<WindowsCommandLine>();
    if returned < header || returned > std::mem::size_of_val(buffer) {
        return None;
    }
    let command = unsafe { std::ptr::read(buffer.as_ptr().cast::<WindowsCommandLine>()) };
    let base = buffer.as_ptr() as usize;
    let start = command.buffer as usize;
    if command.length % 2 != 0
        || command.maximum_length % 2 != 0
        || command.length > command.maximum_length
        || start % std::mem::align_of::<u16>() != 0
        || start < base.checked_add(header)?
        || start.checked_add(usize::from(command.maximum_length))? > base.checked_add(returned)?
    {
        return None;
    }
    let units = unsafe {
        std::slice::from_raw_parts(
            buffer.as_ptr().cast::<u16>().add((start - base) / 2),
            usize::from(command.length) / 2,
        )
    };
    if units.contains(&0) {
        return None;
    }
    String::from_utf16(units).ok()
}

#[cfg(windows)]
fn windows_process_snapshot(target_pid: Option<u32>) -> Result<Vec<u8>, String> {
    use std::collections::HashMap;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{
        ERROR_NO_MORE_FILES, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};
    use windows_sys::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    type QueryProcess =
        unsafe extern "system" fn(HANDLE, u32, *mut std::ffi::c_void, u32, *mut u32) -> i32;
    let module_name: Vec<_> = "ntdll.dll".encode_utf16().chain(Some(0)).collect();
    let module = unsafe { GetModuleHandleW(module_name.as_ptr()) };
    if module.is_null() {
        return Err("HARNESS_SWEEP_FAILED: process query unavailable".to_string());
    }
    let query: QueryProcess = unsafe {
        std::mem::transmute(
            GetProcAddress(module, b"NtQueryInformationProcess\0".as_ptr())
                .ok_or("HARNESS_SWEEP_FAILED: process query unavailable")?,
        )
    };
    let mut sampled: FILETIME = unsafe { std::mem::zeroed() };
    // Toolhelp 不记录创建时间：快照开始后才创建的 PID 可能已复用旧父链。
    unsafe { GetSystemTimePreciseAsFileTime(&mut sampled) };
    let sampled = u64::from(sampled.dwHighDateTime) << 32 | u64::from(sampled.dwLowDateTime);
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(format!(
            "HARNESS_SWEEP_FAILED: process enumeration failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot) };
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut processes = HashMap::new();
    let mut present = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
    loop {
        if present == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(format!(
                    "HARNESS_SWEEP_FAILED: process enumeration failed: {error}"
                ));
            }
            break;
        }
        let length = entry
            .szExeFile
            .iter()
            .position(|&unit| unit == 0)
            .unwrap_or(entry.szExeFile.len());
        processes.insert(
            entry.th32ProcessID,
            (
                entry.th32ParentProcessID,
                WindowsProcessAncestor {
                    pid: entry.th32ProcessID,
                    created: 0,
                    name: String::from_utf16(&entry.szExeFile[..length]).unwrap_or_default(),
                    command_line: None,
                },
            ),
        );
        present = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
    }
    for (_, process) in processes.values_mut() {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process.pid) };
        if handle.is_null() {
            continue;
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut creation: FILETIME = unsafe { std::mem::zeroed() };
        let mut exit = creation;
        let mut kernel = creation;
        let mut user = creation;
        if unsafe {
            GetProcessTimes(
                handle.as_raw_handle(),
                &mut creation,
                &mut exit,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            continue;
        }
        let created = u64::from(creation.dwHighDateTime) << 32 | u64::from(creation.dwLowDateTime);
        if created == 0 || created > sampled {
            continue;
        }
        process.created = created;
        let mut needed = 0;
        let status = unsafe {
            query(
                handle.as_raw_handle(),
                60,
                std::ptr::null_mut(),
                0,
                &mut needed,
            )
        };
        if ![0xc0000004u32 as i32, 0xc0000023u32 as i32].contains(&status)
            || (needed as usize) < std::mem::size_of::<WindowsCommandLine>()
            || (needed as usize) > std::mem::size_of::<WindowsCommandLine>() + usize::from(u16::MAX)
        {
            continue;
        }
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        let mut returned = 0;
        if unsafe {
            query(
                handle.as_raw_handle(),
                60,
                buffer.as_mut_ptr().cast(),
                needed,
                &mut returned,
            )
        } < 0
            || returned > needed
        {
            continue;
        }
        process.command_line = decode_windows_command_line(&buffer, returned as usize);
    }
    let mut output = Vec::new();
    for (&pid, (parent, process)) in &processes {
        if target_pid.is_some_and(|target| target != pid) {
            continue;
        }
        let Some(command_line) = &process.command_line else {
            continue;
        };
        if target_pid.is_none() && !command_line.contains("--no-open") {
            continue;
        }
        let mut next = *parent;
        let mut ancestors = Vec::new();
        for _ in 0..8 {
            let Some((parent, ancestor)) = processes.get(&next) else {
                break;
            };
            ancestors.push(ancestor.clone());
            next = *parent;
        }
        let entry = WindowsProcessEntry {
            pid,
            created: process.created,
            command_line: command_line.clone(),
            ancestors,
            ancestors_truncated: processes.contains_key(&next),
        };
        serde_json::to_writer(&mut output, &entry).map_err(|error| {
            format!("HARNESS_SWEEP_FAILED: process snapshot serialization failed: {error}")
        })?;
        output.push(b'\n');
    }
    Ok(output)
}

#[cfg(windows)]
pub(super) fn terminate_stale_harness_processes_at(dsh_bin: &Path) -> Result<(), String> {
    let output = windows_process_snapshot(None)?;
    let dsh_bin = dsh_bin
        .to_str()
        .ok_or("HARNESS_SWEEP_FAILED: invalid entry path")?;
    let instance = super::instances::instance();
    let owned_pid = instance
        .process
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|process| process.pid);
    // 结束进程后不再固定补睡：端口释放实测是毫秒级（taskkill 返回后约 1ms），
    // 而紧随其后的启动会以 `wait_for_port_release` 等到端口真正回落，固定睡眠
    // 只是把这段滞后放大成白等。
    let targets = orphan_harness_pids(&output, dsh_bin, owned_pid);
    for &(pid, created) in &targets {
        terminate_confirmed_process(pid, created)?;
    }
    for line in String::from_utf8_lossy(&output).lines() {
        if orphan_harness_pids(line.as_bytes(), dsh_bin, owned_pid).is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<WindowsProcessEntry>(line) {
            if !targets.iter().any(|&(pid, _)| pid == entry.pid) {
                terminate_confirmed_process(entry.pid, entry.created)?;
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn terminate_confirmed_process(pid: u32, created: u64) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(87) {
            return Ok(false);
        }
        return Err(format!(
            "HARNESS_CLEANUP_FAILED: cannot open confirmed orphan {pid}: {error}"
        ));
    }
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let queried =
        unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
    let state = unsafe { WaitForSingleObject(handle, 0) };
    if queried == 0
        || (state != WAIT_TIMEOUT && state != windows_sys::Win32::Foundation::WAIT_OBJECT_0)
    {
        unsafe { CloseHandle(handle) };
        return Err(format!(
            "HARNESS_CLEANUP_FAILED: cannot verify process {pid}"
        ));
    }
    let matches = state == WAIT_TIMEOUT
        && created != 0
        && (u64::from(creation.dwHighDateTime) << 32 | u64::from(creation.dwLowDateTime)) / 10
            == created / 10;
    let result = if matches {
        log::warn!("Terminating confirmed orphan Harness process {pid}");
        terminate_windows_process(pid, handle, kill_pid_tree).map(|()| true)
    } else {
        log::warn!("Skipping orphan Harness process {pid}: creation time or process state changed (expected {created}, observed {})", u64::from(creation.dwHighDateTime) << 32 | u64::from(creation.dwLowDateTime));
        Ok(false)
    };
    unsafe { CloseHandle(handle) };
    result
}

#[cfg(windows)]
pub(super) fn terminate_windows_process(
    pid: u32,
    handle: windows_sys::Win32::Foundation::HANDLE,
    kill_tree: impl FnOnce(u32),
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_OBJECT_0 => return Ok(()),
        WAIT_TIMEOUT => {}
        _ => {
            return Err(format!(
                "HARNESS_CLEANUP_FAILED: cannot query process {pid}"
            ))
        }
    }
    kill_tree(pid);
    if unsafe { WaitForSingleObject(handle, 1000) } == WAIT_OBJECT_0 {
        return Ok(());
    }
    // issue #1074：taskkill 失败后只升级已确认的句柄，不重新按裸 PID 打开进程。
    log::warn!("Harness process {pid} survived taskkill; terminating the retained handle");
    if unsafe { TerminateProcess(handle, 1) } == 0
        && unsafe { WaitForSingleObject(handle, 0) } != WAIT_OBJECT_0
    {
        return Err(format!(
            "HARNESS_CLEANUP_FAILED: cannot terminate process {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { WaitForSingleObject(handle, 5000) } != WAIT_OBJECT_0 {
        return Err(format!(
            "HARNESS_CLEANUP_FAILED: process {pid} did not exit"
        ));
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn reclaim_orphan_port(dsh_bin: &Path, port: u16) -> Result<bool, String> {
    use super::sweep::port_owner_pid;
    use super::utils::is_port_in_use;
    if !is_port_in_use(port) {
        return Ok(true);
    }
    let Some(pid) = port_owner_pid(port) else {
        log::warn!("PORT_OWNER: port={port} pid=unknown ownership=unknown");
        return Ok(false);
    };
    if super::instances::profiles()
        .into_iter()
        .any(|profile| super::instances::scope_sync(profile, owned_process_pid) == Some(pid))
    {
        return Ok(false);
    }
    let output = match windows_process_snapshot(Some(pid)) {
        Ok(output) => output,
        Err(error) => {
            log::warn!("PORT_OWNER: port={port} pid={pid} ownership=unknown: {error}");
            return Ok(false);
        }
    };
    let entry = dsh_bin
        .to_str()
        .ok_or("HARNESS_SWEEP_FAILED: invalid entry path")?;
    let targets = orphan_harness_pids(&output, entry, owned_process_pid());
    log::warn!(
        "PORT_OWNER: port={port} pid={pid} ownership={} process={}",
        if targets.is_empty() {
            "protected-or-unknown"
        } else {
            "confirmed-orphan"
        },
        String::from_utf8_lossy(&output).trim()
    );
    if targets.is_empty() {
        return Ok(!is_port_in_use(port));
    }
    let listener = String::from_utf8_lossy(&output)
        .lines()
        .find_map(|line| serde_json::from_str::<WindowsProcessEntry>(line).ok())
        .ok_or("HARNESS_CLEANUP_FAILED: confirmed listener snapshot missing")?;
    let terminated = terminate_confirmed_process(listener.pid, listener.created)?;
    if wait_for_port_release(port, PORT_RELEASE_WAIT) {
        return Ok(true);
    }
    if !terminated || port_owner_pid(port) != Some(pid) {
        log::warn!(
            "PORT_OWNER: port={port} ownership changed after orphan check; preserving new listener"
        );
        return Ok(false);
    }
    Err(format!(
        "HARNESS_CLEANUP_FAILED: confirmed orphan listener {pid} did not release port {port}"
    ))
}

#[cfg(windows)]
#[derive(serde::Deserialize, serde::Serialize)]
struct WindowsProcessEntry {
    pid: u32,
    created: u64,
    #[serde(rename = "commandLine")]
    command_line: String,
    #[serde(default)]
    ancestors: Vec<WindowsProcessAncestor>,
    #[serde(default, rename = "ancestorsTruncated")]
    ancestors_truncated: bool,
}

#[cfg(windows)]
#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct WindowsProcessAncestor {
    pid: u32,
    created: u64,
    name: String,
    #[serde(rename = "commandLine")]
    command_line: Option<String>,
}

/// 转发层：`cmd.exe /C node <入口>` 只是把命令转交给真身，它自己活着只代表还在等
/// 子进程结束，不代表服务仍被某个桌面实例持有。nvmd 等 Node 版本管理器的垫片就是
/// 这么转交的：垫片退出后真身的父进程是活着的 `cmd.exe`，旧谓词「父进程已退出」
/// 漏杀 → 端口一直被占，下次启动 EADDRINUSE 起不来。
///
/// 只认 `/C node` 这种一次性转交：用户自己开着 `cmd.exe /K` 交互 shell 跑同一个
/// 入口时，shell 的命令行里同样有 `--no-open`，但它是那个服务的宿主而不是转发层，
/// 误判会让清扫顺手关掉用户的窗口。
#[cfg(windows)]
fn is_relay_ancestor(ancestor: &WindowsProcessAncestor, dsh_bin: &str) -> bool {
    ancestor.name.eq_ignore_ascii_case("cmd.exe")
        && ancestor.command_line.as_deref().is_some_and(|command| {
            if command.contains(['&', '|', '<', '>', '^', '%', '\n', '\r']) {
                return false;
            }
            let prefix = regex::Regex::new(r#"(?i)^\s*(?:"(?:[^"\r\n]*\\)?cmd(?:\.exe)?"|(?:[^\s"]*\\)?cmd(?:\.exe)?)\s+/c\s+"#).unwrap();
            prefix.find(command).is_some_and(|matched| {
                is_windows_harness_command_line(&command[matched.end()..], dsh_bin)
            })
        })
}

/// 选出需要清扫的孤儿服务链，每条链返回转发层最顶层的进程：`taskkill /T` 会连同
/// 下方的转发层与服务本体一起结束。判定只看「向上穿过所有转发层后还有没有活着的
/// 宿主」：入口路径不匹配、已由本应用持有（`owned_pid`）、上方存在活着的非转发层
/// 进程（另一个桌面实例的垫片、用户自己的 shell）、祖先创建时间晚于后代（PID
/// 已被复用，父子关系失效），或祖先链被层数上限截断（上方仍可能有持有者）都不清扫。
#[cfg(windows)]
fn orphan_harness_pids(output: &[u8], dsh_bin: &str, owned_pid: Option<u32>) -> Vec<(u32, u64)> {
    let mut targets: Vec<(u32, u64)> = Vec::new();
    for entry in String::from_utf8_lossy(output)
        .lines()
        .filter_map(|line| serde_json::from_str::<WindowsProcessEntry>(line).ok())
    {
        if entry.created == 0
            || entry.ancestors_truncated
            || Some(entry.pid) == owned_pid
            || !is_windows_harness_command_line(&entry.command_line, dsh_bin)
        {
            continue;
        }
        let mut root = (entry.pid, entry.created);
        let mut descendant = entry.created;
        let mut owned = false;
        for ancestor in &entry.ancestors {
            if ancestor.created > descendant {
                break;
            }
            if ancestor.created == 0
                || Some(ancestor.pid) == owned_pid
                || !is_relay_ancestor(ancestor, dsh_bin)
            {
                owned = true;
                break;
            }
            root = (ancestor.pid, ancestor.created);
            descendant = ancestor.created;
        }
        if owned || Some(root.0) == owned_pid {
            continue;
        }
        if !targets.contains(&root) {
            targets.push(root);
        }
    }
    targets
}

/// 判断命令行是否为「从本应用 dsh 安装目录启动的 Harness 服务」。
///
/// 除入口路径外同时核对桌面端服务启动参数，避免清扫时误伤用户并行执行的
/// `dsh plugin` 等短命令。
#[cfg_attr(windows, allow(dead_code))] // 仅 Unix 清场分支与测试使用
fn is_harness_command_line(cmdline: &str, dsh_bin: &str) -> bool {
    command_line_has_argument(cmdline, dsh_bin)
        && !command_line_has_argument_after(cmdline, dsh_bin, "plugin")
        && command_line_has_argument(cmdline, "--profile")
        && command_line_has_argument(cmdline, "--port")
}

/// 结束所有从本应用 dsh 安装目录启动的 Harness 服务进程（含历史崩溃残留的孤儿实例）。
///
/// 只停本应用当前持有的进程不够：`.harness.pid` 标记只记录最近一次会话的 PID，
/// 应用多次崩溃/强杀（任务管理器结束等）会遗留多个孤儿 dsh 进程、端口一路漂移
/// （3080→3081→…），`sweep_orphan_harness` 每次只能回收最近一个，更早的孤儿
/// 会持续占用 `dependencies/dsh` 目录的文件句柄（node 以该目录为 cwd 且模块
/// DLL 加载在内存），更新切换目录时触发 os error 32（INSTALL_BACKUP_FAILED）。
///
/// Windows 只结束入口路径精确匹配且已失去持有者的 node 服务：父进程已退出，或
/// 父进程只是垫片的 `cmd.exe /C node` 转发层且上方没有活着的垫片。仍由另一个
/// 桌面实例持有的服务（真身直接挂在实例下，或转发层上方还压着活着的垫片）不做清扫。
/// Unix 保持原有 release 路径匹配行为：枚举 `ps` 按入口路径与启动参数匹配命令行，
/// 与父进程是否存活无关——垫片/shell 包装层的命令行同样带着入口路径与服务参数，
/// 因此转发层与其下方的真身会被分别命中，不存在 Windows 的转发层漏杀问题
/// （debug 构建跳过该分支，只按 `.harness.pid` 标记回收）。
pub fn terminate_stale_harness_processes(app_handle: &tauri::AppHandle) -> Result<(), String> {
    if super::instances::profiles()
        .into_iter()
        .any(|profile| super::instances::scope_sync(profile, has_owned_process))
    {
        return Ok(());
    }
    #[cfg(windows)]
    {
        terminate_stale_harness_processes_at(&config::get_dsh_binary_path(app_handle))?;
    }
    #[cfg(not(windows))]
    {
        if cfg!(debug_assertions) {
            return Ok(());
        }
        // Unix 同样需要按路径清扫：打开中的文件允许重命名确实不阻塞更新切换，
        // 但崩溃/强杀残留的孤儿 dsh 实例会持续监听端口，下一次启动只能一路
        // 漂移端口（3080→3081→…）并被持久化，表现为「更新后端口递增」
        // （issue #91）。用 `ps -ww -axo pid=,command=` 枚举完整命令行（`-ww`
        // 防止 macOS 按终端宽度截断长路径），按参数边界匹配本应用 dsh 入口与
        // 服务参数，不会误杀用户其它 node/dsh 命令，因此可安全地全部结束。
        let dsh_bin = config::get_dsh_binary_path(app_handle);
        let Some(dsh_bin_str) = dsh_bin.to_str() else {
            return Err("HARNESS_SWEEP_FAILED: invalid entry path".to_string());
        };
        let Ok(output) = Command::new("ps")
            .args(["-ww", "-axo", "pid=,command="])
            .output()
        else {
            return Err("HARNESS_SWEEP_FAILED: cannot enumerate service processes".to_string());
        };
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Some((pid, cmdline)) = parse_ps_line(line) else {
                continue;
            };
            if !is_harness_command_line(cmdline, dsh_bin_str) {
                continue;
            }
            log::warn!("Terminating stale Harness service process {pid} (from dsh install dir)");
            kill_pid_tree(pid);
        }
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn warn_if_inotify_watch_limit_low() {
    let Some(limit) = crate::config::linux_inotify_max_user_watches() else {
        return;
    };
    if limit < crate::config::MIN_INOTIFY_MAX_USER_WATCHES {
        log::warn!(
            "Linux inotify.max_user_watches is {} (below recommended {}); dsh web may crash with ENOSPC (issue #116). To fix, run `sudo sysctl fs.inotify.max_user_watches={}` and write the same value to /etc/sysctl.conf to persist.",
            limit,
            crate::config::MIN_INOTIFY_MAX_USER_WATCHES,
            crate::config::MIN_INOTIFY_MAX_USER_WATCHES,
        );
    }
}

/// 停止 Harness 服务
pub async fn stop(app_handle: tauri::AppHandle) -> Result<(), String> {
    let profile = super::instances::current_profile()
        .unwrap_or_else(|| crate::service::profile::active_profile(&app_handle));
    super::instances::scope(profile.clone(), async move {
        log::info!("Stopping Harness service...");
        // 重置启动守卫，确保后续 launch 可以重新拉起；仅结束持有的根进程树。
        // 进程终止涉及 WaitForSingleObject（至多 5s）与 taskkill/kill 等同步阻塞
        // 调用，移出 Tokio 执行线程避免卡住其他并发任务（WARN-7/P2-#20）。
        launch_guard().store(false, Ordering::SeqCst);
        tauri::async_runtime::spawn_blocking(move || {
            super::instances::scope_sync(profile, terminate_owned_process)
        })
        .await
        .map_err(|e| format!("STOP_FAILED: {e}"))?
        .map_err(|()| "STOP_FAILED: Harness process did not stop".to_string())?;
        // 清理孤儿清扫标记：正常停止的实例不应被下次启动当作残留
        let _ = fs::remove_file(harness_pid_path(&app_handle));

        let port = super::instances::port(&app_handle);
        #[cfg(windows)]
        let entry = crate::service::core::active_dsh_binary(&app_handle);
        let profile = super::instances::current_profile().unwrap();
        tauri::async_runtime::spawn_blocking(move || {
            super::instances::scope_sync(profile, || -> Result<(), String> {
                if !wait_for_port_release(port, PORT_RELEASE_WAIT) {
                    #[cfg(windows)]
                    {
                        reclaim_orphan_port(&entry, port)?;
                    }
                }
                Ok(())
            })
        })
        .await
        .map_err(|error| format!("STOP_FAILED: {error}"))??;

        status::set_status(status::Status::Stopped);
        status::emit_status(&app_handle);
        Ok(())
    })
    .await
}

/// 交付安装包前的同步停服：结束持有的 Harness 进程树 → 等端口释放 → 清清扫标记。
///
/// 安装器（Windows 的 `CheckIfAppIsRunning` → taskkill、macOS 安装脚本的
/// `CheckIfAppIsRunning`）会强杀桌面端进程，让应用走不到正常退出路径；桌面端一旦
/// 先消失，它持有的 Harness 子进程就变成孤儿继续占着配置端口，更新后新实例启动
/// 撞上 EADDRINUSE（表现为「更新后进不去」）。因此**打开安装包之前**必须先停服，
/// 这是平台无关的要求，不能只在某一条调用路径上做。
///
/// 同步、可在退出路径调用（无 async 运行时依赖）：进程从 SIGKILL 返回那一刻已死，
/// 但内核回收监听套接字仍有短暂滞后，故结束过进程后补一次有界等待，让紧随其后的
/// 安装器/新实例看到端口已释放。没持有进程时不等待，避免在用户可见路径上白耗。
fn stop_instance_for_installer(app_handle: &tauri::AppHandle) -> Result<(), String> {
    stop_instance_at(
        &harness_pid_path(app_handle),
        super::instances::port(app_handle),
        #[cfg(windows)]
        &crate::service::core::active_dsh_binary(app_handle),
    )
}

pub(super) fn stop_instance_at(
    pid_path: &Path,
    port: u16,
    #[cfg(windows)] entry: &Path,
) -> Result<(), String> {
    let terminated = terminate_owned_process()
        .map_err(|()| "STOP_FAILED: Harness process did not stop".to_string())?;
    #[cfg(not(windows))]
    if !terminated {
        return Ok(());
    }
    #[cfg(windows)]
    let _ = terminated;
    let _ = fs::remove_file(pid_path);
    if !wait_for_port_release(port, PORT_RELEASE_WAIT) {
        #[cfg(windows)]
        {
            reclaim_orphan_port(entry, port)?;
        }
    }
    log::info!("Harness stopped for installer handoff");
    Ok(())
}

/// 应用退出时同步回收 Harness 进程。
///
/// 退出路径上不更新状态，只结束当前应用持有的 Harness 进程树（与安装器交接共用
/// [`stop_for_installer`]，保证两条路径行为一致）。
pub fn stop_for_installer(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let mut profiles = super::instances::profiles();
    if profiles.is_empty() {
        profiles.push(crate::service::profile::active_profile(app_handle));
    }
    let mut result = Ok(());
    for profile in profiles {
        if let Err(error) =
            super::instances::scope_sync(profile, || stop_instance_for_installer(app_handle))
        {
            result = Err(error);
        }
    }
    result
}

pub fn stop_on_exit(app_handle: &tauri::AppHandle) {
    super::instances::begin_shutdown();
    if let Err(error) = stop_for_installer(app_handle) {
        log::error!("Harness exit cleanup failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stop_keeps_all_instance_effects_in_resolved_profile_scope() {
        let source = include_str!("process.rs");
        let stop = source
            .split("pub async fn stop(")
            .nth(1)
            .unwrap()
            .split("/// 交付安装包前")
            .next()
            .unwrap();
        let scope = stop
            .find("super::instances::scope(profile.clone(), async move {")
            .unwrap();
        for effect in [
            "launch_guard().store",
            "spawn_blocking",
            "harness_pid_path",
            "super::instances::port",
            "status::set_status",
            "status::emit_status",
        ] {
            assert!(
                stop.find(effect).unwrap() > scope,
                "{effect} must run inside resolved profile scope"
            );
        }
        assert!(stop
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>()
            .ends_with("}).await}"));
    }

    #[test]
    fn stop_instance_without_app_cancels_an_unowned_launch() {
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("harness.pid");
        fs::write(&marker, "stale marker").unwrap();
        super::super::instances::scope_sync("stop-without-app-test".into(), || {
            launch_guard().store(true, Ordering::SeqCst);
            assert!(!has_owned_process());
            assert_eq!(
                stop_instance_at(
                    &marker,
                    0,
                    #[cfg(windows)]
                    &root.path().join("entry.js"),
                ),
                Ok(())
            );
            assert!(!launch_guard().load(Ordering::SeqCst));
            assert!(!has_owned_process());
        });
        assert_eq!(marker.exists(), !cfg!(windows));
    }

    #[test]
    fn exit_closes_registration_before_stop_but_installer_keeps_restarts_available() {
        let source = include_str!("process.rs");
        let exit = source
            .split("pub fn stop_on_exit(")
            .nth(1)
            .unwrap()
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        assert!(
            exit.find("super::instances::begin_shutdown();").unwrap()
                < exit.find("stop_for_installer(app_handle)").unwrap()
        );
        let installer = source
            .split("fn stop_instance_for_installer(")
            .nth(1)
            .unwrap()
            .split("pub fn stop_on_exit(")
            .next()
            .unwrap();
        assert!(installer.contains("stop_instance_at("));
        assert!(!installer.contains("begin_shutdown"));
    }

    #[test]
    fn orphan_port_reclaim_preserves_every_registered_profile_process() {
        let source = include_str!("process.rs");
        let reclaim = source
            .split("pub(super) fn reclaim_orphan_port(")
            .nth(1)
            .unwrap()
            .split("#[cfg(windows)]\n#[derive")
            .next()
            .unwrap();
        assert!(
            reclaim.find("super::instances::profiles()").unwrap()
                < reclaim.find("windows_process_snapshot(Some(pid))").unwrap()
        );
        assert!(reclaim
            .contains("super::instances::scope_sync(profile, owned_process_pid) == Some(pid)"));
    }

    /// 构造一个测试用 `OwnedProcess`（跨平台处理 Windows 句柄字段）。
    #[cfg(windows)]
    fn test_owned(pid: u32) -> OwnedProcess {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::Threading::CreateEventW;

        let handle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        assert!(!handle.is_null(), "{}", std::io::Error::last_os_error());
        OwnedProcess {
            pid,
            handle: Arc::new(unsafe { OwnedHandle::from_raw_handle(handle) }),
        }
    }
    #[cfg(not(windows))]
    fn test_owned(pid: u32) -> OwnedProcess {
        OwnedProcess { pid }
    }

    /// 退出监视线程只能清掉「与自己 PID 匹配」的登记，不许误清刚启动的新进程，
    /// 也不许重复取出（幂等）。回归 WARN-6 合并引入的回退。
    #[test]
    fn owned_process_take_if_only_matches_pid() {
        // 匹配的 PID 才可取出，且取走后槽清空
        let mut slot = Some(test_owned(42));
        let taken = take_owned_process_if_matching(&mut slot, 42);
        assert_eq!(taken.map(|p| p.pid), Some(42));
        assert!(slot.is_none());

        // PID 不匹配（旧进程 41 退出）时禁止取出/清空新进程（新进程 42）
        let mut slot = Some(test_owned(42));
        let taken = take_owned_process_if_matching(&mut slot, 41);
        assert!(taken.is_none());
        assert_eq!(slot.as_ref().map(|p| p.pid), Some(42));

        // 幂等：已清空后再次取出返回 None
        let mut slot: Option<OwnedProcess> = None;
        assert!(take_owned_process_if_matching(&mut slot, 42).is_none());
    }

    #[test]
    fn exit_diagnostics_finish_before_ownership_loss_is_observable() {
        use std::sync::mpsc;
        use std::time::Duration;

        let profile = "exit-diagnostics-test";
        let app = tauri::test::mock_app();
        let root = tempfile::tempdir().unwrap();
        let marker = root.path().join("fatal-report.log");
        let instance = super::super::instances::instance_of(profile);
        *instance.process.lock().unwrap() = Some(test_owned(42));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let timeout = Duration::from_secs(5);

        std::thread::scope(|scope| {
            let callback_marker = marker.clone();
            let handle = app.handle().clone();
            let exit = scope.spawn(move || {
                super::super::instances::scope_sync(profile.into(), || {
                    on_owned_process_exit(&handle, 42, |_| {
                        entered_tx.send(()).unwrap();
                        resume_rx.recv_timeout(timeout).unwrap();
                        fs::write(callback_marker, "ERROR HARNESS_FATAL_REPORT: fatal.json\n")
                            .unwrap();
                        Some(1)
                    })
                })
            });
            entered_rx.recv_timeout(timeout).unwrap();
            let callback_holds_ownership = matches!(
                instance.process.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
            let observer = scope.spawn(|| {
                super::super::instances::scope_sync(profile.into(), || {
                    (has_owned_process(), marker.is_file())
                })
            });
            resume_tx.send(()).unwrap();
            assert_eq!(exit.join().unwrap().map(|owned| owned.pid), Some(42));
            assert!(callback_holds_ownership);
            assert_eq!(observer.join().unwrap(), (false, true));
        });
    }

    #[test]
    fn registration_rejects_cancelled_launch_and_replaces_only_expected_pid() {
        super::super::instances::scope_sync("registration-test".into(), || {
            let launching = launch_guard();
            launching.store(true, Ordering::SeqCst);
            assert!(take_owned_process().is_none());
            assert!(!launching.load(Ordering::SeqCst));
            assert!(
                register_owned_process::<()>(None, || panic!("cancelled spawn"))
                    .unwrap()
                    .is_none()
            );
            assert_eq!(owned_process_pid(), None);

            launching.store(true, Ordering::SeqCst);
            assert_eq!(
                register_owned_process(None, || Ok((test_owned(41), 41))).unwrap(),
                Some(41)
            );
            assert_eq!(
                register_owned_process(Some(41), || Ok((test_owned(42), 42))).unwrap(),
                Some(42)
            );
            assert!(
                register_owned_process::<()>(Some(41), || panic!("stale retry spawn"))
                    .unwrap()
                    .is_none()
            );
            assert_eq!(owned_process_pid(), Some(42));
            assert_eq!(
                register_owned_process::<()>(Some(42), || Err("spawn failed".into())).unwrap_err(),
                "spawn failed"
            );
            assert_eq!(owned_process_pid(), Some(42));
            assert_eq!(take_owned_process().map(|owned| owned.pid), Some(42));
            assert!(
                register_owned_process::<()>(Some(42), || panic!("cancelled retry spawn"))
                    .unwrap()
                    .is_none()
            );
            assert_eq!(owned_process_pid(), None);
        });
    }

    #[test]
    fn shutdown_gate_rejects_every_profile_after_inflight_registration() {
        use std::sync::{mpsc, Mutex, TryLockError};
        use std::time::Duration;

        let shutdown = Mutex::new(false);
        let first = super::super::instances::Instance::default();
        let second = super::super::instances::Instance::default();
        first.launching.store(true, Ordering::SeqCst);
        second.launching.store(true, Ordering::SeqCst);
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let timeout = Duration::from_secs(5);
        std::thread::scope(|scope| {
            let first = &first;
            let shutdown = &shutdown;
            let registration = scope.spawn(move || {
                register_owned_process_at(first, shutdown, None, || {
                    entered_tx.send(()).unwrap();
                    resume_rx.recv_timeout(timeout).unwrap();
                    Ok((test_owned(41), 41))
                })
            });
            entered_rx.recv_timeout(timeout).unwrap();
            let holds_gate = matches!(shutdown.try_lock(), Err(TryLockError::WouldBlock));
            let holds_slot = matches!(first.process.try_lock(), Err(TryLockError::WouldBlock));
            let shutdown_thread = scope.spawn(move || {
                super::super::instances::begin_shutdown_at(shutdown);
            });
            resume_tx.send(()).unwrap();
            assert_eq!(registration.join().unwrap().unwrap(), Some(41));
            shutdown_thread.join().unwrap();
            assert!(holds_gate && holds_slot);
        });
        assert!(
            register_owned_process_at::<()>(&first, &shutdown, Some(41), || {
                panic!("shutdown must reject an existing profile retry")
            })
            .unwrap()
            .is_none()
        );
        assert!(
            register_owned_process_at::<()>(&second, &shutdown, None, || {
                panic!("shutdown must reject another profile's first launch")
            })
            .unwrap()
            .is_none()
        );
        assert_eq!(
            first
                .process
                .lock()
                .unwrap()
                .as_ref()
                .map(|owned| owned.pid),
            Some(41)
        );
        assert!(second.process.lock().unwrap().is_none());
    }

    #[test]
    fn launch_guard_clears_its_own_profile_outside_original_scope() {
        let guard = super::super::instances::scope_sync("guard-owner-test".into(), || {
            let launching = launch_guard();
            launching.store(true, Ordering::SeqCst);
            LaunchGuard(launching)
        });
        super::super::instances::scope_sync("guard-drop-test".into(), || {
            let launching = launch_guard();
            launching.store(true, Ordering::SeqCst);
            drop(guard);
            assert!(launching.load(Ordering::SeqCst));
            assert!(!super::super::instances::instance_of("guard-owner-test")
                .launching
                .load(Ordering::SeqCst));
            launching.store(false, Ordering::SeqCst);
        });
    }

    #[test]
    fn exit_holds_ownership_until_status_commit_and_preserves_new_registration() {
        use std::sync::mpsc;
        use std::time::Duration;

        let profile = "exit-status-commit-test";
        let instance = super::super::instances::instance_of(profile);
        instance.launching.store(true, Ordering::SeqCst);
        *instance.process.lock().unwrap() = Some(test_owned(41));
        let mut status_guard = instance.status.lock().unwrap();
        *status_guard = status::Status::Running;
        let (exiting_tx, exiting_rx) = mpsc::channel();
        let (observed_tx, observed_rx) = mpsc::channel();
        let (notified_tx, notified_rx) = mpsc::channel();
        let timeout = std::time::Duration::from_secs(5);

        std::thread::scope(|scope| {
            let exit = scope.spawn(move || {
                super::super::instances::scope_sync(profile.into(), || {
                    on_owned_process_exit_at(
                        41,
                        |_| {
                            exiting_tx.send(()).unwrap();
                            Some(1)
                        },
                        |payload| {
                            assert_eq!(owned_process_pid(), None);
                            assert_eq!(status::get_status(), status::Status::Stopped);
                            notified_tx.send(payload).unwrap();
                        },
                    )
                })
            });
            exiting_rx.recv_timeout(timeout).unwrap();
            let observer_instance = instance.clone();
            let observer = scope.spawn(move || {
                let guard = observer_instance.process.lock().unwrap();
                observed_tx.send(guard.is_none()).unwrap();
            });
            let blocked_until_commit = observed_rx
                .recv_timeout(Duration::from_millis(100))
                .is_err();
            drop(status_guard);
            assert_eq!(exit.join().unwrap().map(|owned| owned.pid), Some(41));
            assert!(observed_rx.recv_timeout(timeout).unwrap());
            observer.join().unwrap();
            assert!(
                blocked_until_commit,
                "ownership must stay locked until Stopped is committed"
            );
            assert_eq!(
                notified_rx.recv_timeout(timeout).unwrap(),
                HarnessProcessExitedPayload {
                    pid: 41,
                    exit_code: Some(1)
                }
            );
        });

        super::super::instances::scope_sync(profile.into(), || {
            assert_eq!(status::get_status(), status::Status::Stopped);
            assert!(register_owned_process(None, || Ok((test_owned(42), ())))
                .unwrap()
                .is_some());
            status::set_status(status::Status::Running);
            assert!(on_owned_process_exit_at(
                41,
                |_| panic!("stale exit must not report"),
                |_| panic!("stale exit must not notify"),
            )
            .is_none());
            assert_eq!(owned_process_pid(), Some(42));
            assert_eq!(status::get_status(), status::Status::Running);
            take_owned_process();
        });
    }

    /// 退出载荷保留退出码（含 0），无法取得时显式序列化为 null。
    #[test]
    fn harness_process_exit_payload_serializes_exit_code() {
        let with_code = serde_json::to_value(HarnessProcessExitedPayload {
            pid: 42,
            exit_code: Some(0),
        })
        .expect("serialize process exit payload");
        assert_eq!(with_code, serde_json::json!({ "pid": 42, "exitCode": 0 }));

        let without_code = serde_json::to_value(HarnessProcessExitedPayload {
            pid: 43,
            exit_code: None,
        })
        .expect("serialize process exit payload");
        assert_eq!(
            without_code,
            serde_json::json!({ "pid": 43, "exitCode": null })
        );
    }

    /// 核心转换锁可被多个异步操作按顺序获取，避免两个切换重叠。
    #[tokio::test]
    async fn core_transition_lock_serializes_operations() {
        let first = acquire_core_transition()
            .await
            .expect("first transition lock should be acquired");
        let second = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            acquire_core_transition(),
        )
        .await;
        assert!(second.is_err());
        drop(first);
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            acquire_core_transition()
        )
        .await
        .expect("transition lock should be available after release")
        .is_ok());
    }

    /// 两个切换请求不能重叠：第一个释放转换锁后，第二个才可进入。
    #[tokio::test]
    async fn overlapping_switches_are_serialized() {
        let first = acquire_core_transition()
            .await
            .expect("first transition lock should be acquired");
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel(1);
        let waiter = tokio::spawn(async move {
            let _second = acquire_core_transition().await;
            entered_tx
                .send(())
                .await
                .expect("notify second switch entry");
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), entered_rx.recv())
                .await
                .is_err()
        );
        drop(first);
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .expect("second switch should enter after first releases")
            .expect("second switch task should complete");
    }

    /// 启动请求不能在切换持锁期间进入：切换完成后启动才可进入并完成登记阶段。
    #[tokio::test]
    async fn launch_and_switch_overlap_is_serialized() {
        let switch_guard = acquire_core_transition()
            .await
            .expect("switch transition lock should be acquired");
        let (entered_tx, mut entered_rx) = tokio::sync::mpsc::channel(1);
        let launcher = tokio::spawn(async move {
            let _launch_guard = acquire_core_transition().await;
            // 模拟启动完成进程登记后才释放转换锁。
            entered_tx
                .send(())
                .await
                .expect("notify launch registration");
        });

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), entered_rx.recv())
                .await
                .is_err()
        );
        drop(switch_guard);
        tokio::time::timeout(std::time::Duration::from_millis(100), launcher)
            .await
            .expect("launch should enter after switch releases")
            .expect("launch task should complete");
    }

    /// `ps -axo pid=,command=` 行解析：首列 PID，其余为命令行。
    #[test]
    fn parse_ps_line_extracts_pid_and_cmdline() {
        // `.lines()` 迭代已去掉行尾换行
        let (pid, cmdline) =
            parse_ps_line("   12345 node /path/to/bin.js --profile web").expect("parse ps line");
        assert_eq!(pid, 12345);
        assert_eq!(cmdline, "node /path/to/bin.js --profile web");
        // 多列空白（PID 与命令之间多个空格）+ 行首空白
        let (pid, cmdline) = parse_ps_line("  67890    sh  -c  sleep 1").expect("parse ps line");
        assert_eq!(pid, 67890);
        assert_eq!(cmdline, "sh  -c  sleep 1");
    }

    #[test]
    fn parse_ps_line_skips_invalid_rows() {
        // 无空白分隔（纯 PID）→ 无法取命令行，跳过
        assert!(parse_ps_line("12345").is_none());
        // PID 不可解析（可能是表头残留）→ 跳过
        assert!(parse_ps_line("PID COMMAND").is_none());
        // 空行 → 跳过
        assert!(parse_ps_line("").is_none());
    }

    /// 命令行匹配：argv 整词精确等于 dsh 入口路径才算本应用服务实例。
    #[test]
    fn harness_cmdline_matches_service_arguments() {
        let bin = "/home/u/.dsh/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
        assert!(is_harness_command_line(
            &format!("node {bin} --profile web --port 3083"),
            bin
        ));
    }

    /// Unix 侧清扫只按入口路径与启动参数匹配命令行，与父进程是否存活无关：垫片/
    /// shell 包装层的命令行里同样带着入口路径与服务参数，转发层与其下方的真身会
    /// 被分别命中，因此 Windows 上「转发层活着导致真身漏杀」不会在 Unix 出现。
    #[test]
    fn harness_cmdline_matches_relay_wrapper_arguments() {
        let bin = "/home/u/.dsh/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
        // 版本管理器垫片（asdf 等）：包装层自身的命令行同样带入口路径与服务参数
        assert!(is_harness_command_line(
            &format!("/home/u/.asdf/shims/node {bin} --profile web --port 3080 --no-open"),
            bin
        ));
        // 真身独立命中：包装层与真身各自被枚举到，任一层被回收都会释放端口
        assert!(is_harness_command_line(
            &format!("/home/u/.asdf/installs/nodejs/22.22.0/bin/node {bin} --profile web --port 3080 --no-open"),
            bin
        ));
    }

    #[cfg(windows)]
    #[test]
    fn live_peer_service_is_not_reaped_from_temporary_core_directory() {
        use std::os::windows::process::CommandExt;

        let root = std::env::temp_dir().join(format!(
            "dsh-sweep-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let core = root.join("dependencies").join("dsh");
        let bin = core
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        let ready = root.join("ready");
        std::fs::write(&bin, format!("require('net').createServer().listen(0, '127.0.0.1', function() {{ require('fs').writeFileSync({:?}, String(this.address().port)) }}); setTimeout(() => process.exit(0), 60000)", ready.to_string_lossy())).unwrap();
        let mut child = Command::new("node.exe")
            .arg(&bin)
            .args(["--profile", "web", "--port", "3081", "--no-open"])
            .current_dir(&core)
            .creation_flags(0x08000000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn temporary service");
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let started = std::time::Instant::now();
            while !ready.exists() && started.elapsed() < std::time::Duration::from_secs(5) {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            assert!(ready.exists(), "temporary service must become ready");
            assert!(
                std::fs::rename(&core, root.join("renamed")).is_err(),
                "a live service working directory must block Windows rename"
            );
            let port = std::fs::read_to_string(&ready)
                .unwrap()
                .parse::<u16>()
                .unwrap();
            assert!(!reclaim_orphan_port(&bin, port).expect("live peer port must be preserved"));
            terminate_stale_harness_processes_at(&bin).expect("temporary core sweep");
            assert!(
                child.try_wait().unwrap().is_none(),
                "live peer desktop child must not be killed"
            );
            assert!(
                std::fs::rename(&core, root.join("renamed")).is_err(),
                "live peer must still pin its core directory"
            );
        }));
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&root);
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }

    #[cfg(windows)]
    #[test]
    fn orphan_service_releases_temporary_core_directory_for_rename() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        let root = std::env::temp_dir().join(format!(
            "dsh-孤儿-sweep-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let core = root.join("dependencies").join("dsh");
        let bin = core
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        let ready = root.join("ready");
        std::fs::write(&bin, format!("require('net').createServer().listen(0, '127.0.0.1', function() {{ require('fs').writeFileSync({:?}, String(this.address().port)) }}); setTimeout(() => process.exit(0), 60000)", ready.to_string_lossy())).unwrap();
        let pid_file = root.join("orphan.pid");
        let parent = "const {spawn}=require('child_process'); const c=spawn(process.execPath,[process.argv[1],'--profile','web','--port','3081','--no-open'],{cwd:process.argv[2],detached:true,stdio:'ignore'}); try { require('fs').writeFileSync(process.argv[3],String(c.pid)) } catch (error) { c.kill(); throw error } c.unref()";
        let result = std::panic::catch_unwind(|| {
            let output = Command::new("node.exe")
                .args(["-e", parent])
                .arg(&bin)
                .arg(&core)
                .arg(&pid_file)
                .creation_flags(0x08000000)
                .output()
                .expect("spawn temporary parent");
            assert!(
                output.status.success(),
                "temporary parent should spawn orphan"
            );
            let pid = std::fs::read_to_string(&pid_file)
                .expect("orphan pid file")
                .parse::<u32>()
                .expect("orphan pid");
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
            assert!(
                !handle.is_null(),
                "retain the temporary orphan process handle"
            );
            let check = std::panic::catch_unwind(|| {
                let started = std::time::Instant::now();
                while !ready.exists() && started.elapsed() < std::time::Duration::from_secs(5) {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                assert!(ready.exists(), "temporary orphan must become ready");
                assert!(
                    std::fs::rename(&core, root.join("renamed")).is_err(),
                    "orphan working directory must block Windows rename"
                );
                let port = std::fs::read_to_string(&ready)
                    .unwrap()
                    .parse::<u16>()
                    .unwrap();
                assert!(super::super::utils::is_port_in_use(port));
                assert!(reclaim_orphan_port(&bin, port).expect("reclaim temporary orphan listener"));
                assert!(!super::super::utils::is_port_in_use(port));
                assert_eq!(
                    unsafe { WaitForSingleObject(handle, 5000) },
                    WAIT_OBJECT_0,
                    "the matching orphan should be terminated"
                );
                std::fs::rename(&core, root.join("renamed"))
                    .expect("rename should succeed after orphan cleanup");
            });
            if unsafe { WaitForSingleObject(handle, 0) } != WAIT_OBJECT_0 {
                kill_pid_tree(pid);
            }
            unsafe { CloseHandle(handle) };
            if let Err(error) = check {
                std::panic::resume_unwind(error);
            }
        });
        if result.is_err() {
            if let Ok(pid) = std::fs::read_to_string(&pid_file).and_then(|text| {
                text.parse::<u32>()
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
            }) {
                let script = format!(
                    "(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}').CommandLine"
                );
                if let Ok(output) = Command::new("powershell")
                    .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                    .creation_flags(0x08000000)
                    .output()
                {
                    if is_windows_harness_command_line(
                        &String::from_utf8_lossy(&output.stdout),
                        &bin.to_string_lossy(),
                    ) {
                        kill_pid_tree(pid);
                    }
                }
            }
        }
        let _ = std::fs::remove_dir_all(&root);
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }

    #[cfg(windows)]
    #[test]
    fn failed_taskkill_escalates_only_the_retained_process_handle() {
        use std::os::windows::io::AsRawHandle;
        use std::os::windows::process::CommandExt;
        let mut child = Command::new("node.exe")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let result = terminate_windows_process(child.id(), child.as_raw_handle(), |_| {});
        let stopped = child.try_wait().unwrap().is_some();
        let _ = child.kill();
        let exit = child.wait().unwrap();
        result.expect("failed taskkill must fall back to retained handle");
        assert!(stopped, "fallback must confirm exit before returning");
        assert!(!exit.success());
        assert!(
            terminate_windows_process(0, std::ptr::null_mut(), |_| panic!(
                "invalid handle must not invoke taskkill"
            ))
            .unwrap_err()
            .starts_with("HARNESS_CLEANUP_FAILED:")
        );
    }

    #[cfg(windows)]
    #[test]
    fn denied_handle_termination_reports_failure_and_preserves_process() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        let mut child = Command::new("node.exe")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, child.id()) };
        assert!(!handle.is_null());
        let result = terminate_windows_process(child.id(), handle, |_| {});
        let alive = child.try_wait().unwrap().is_none();
        unsafe { CloseHandle(handle) };
        let _ = child.kill();
        let _ = child.wait();
        assert!(result
            .unwrap_err()
            .starts_with("HARNESS_CLEANUP_FAILED: cannot terminate process"));
        assert!(alive);
    }

    #[cfg(windows)]
    #[test]
    fn native_command_line_rejects_truncated_or_invalid_utf16() {
        let header = std::mem::size_of::<WindowsCommandLine>();
        let command: Vec<_> = r#"node.exe "path with spaces" "payload --no-open""#
            .encode_utf16()
            .collect();
        let bytes = header + (command.len() + 1) * 2;
        let mut buffer = vec![0usize; bytes.div_ceil(std::mem::size_of::<usize>())];
        let string = unsafe { buffer.as_mut_ptr().cast::<u8>().add(header).cast::<u16>() };
        let valid = WindowsCommandLine {
            length: (command.len() * 2) as u16,
            maximum_length: ((command.len() + 1) * 2) as u16,
            buffer: string,
        };
        unsafe {
            std::ptr::copy_nonoverlapping(command.as_ptr(), string, command.len());
            buffer
                .as_mut_ptr()
                .cast::<WindowsCommandLine>()
                .write(valid);
        }
        assert_eq!(
            decode_windows_command_line(&buffer, bytes).as_deref(),
            Some(r#"node.exe "path with spaces" "payload --no-open""#)
        );
        assert!(decode_windows_command_line(&buffer, header - 1).is_none());
        assert!(decode_windows_command_line(&buffer, bytes - 1).is_none());
        assert!(
            decode_windows_command_line(&buffer, std::mem::size_of_val(buffer.as_slice()) + 1)
                .is_none()
        );
        for invalid in [
            WindowsCommandLine {
                length: valid.length - 1,
                ..valid
            },
            WindowsCommandLine {
                maximum_length: valid.length - 2,
                ..valid
            },
            WindowsCommandLine {
                buffer: std::ptr::null(),
                ..valid
            },
            WindowsCommandLine {
                buffer: buffer.as_ptr().cast(),
                ..valid
            },
            WindowsCommandLine {
                buffer: usize::MAX as *const u16,
                ..valid
            },
        ] {
            unsafe {
                buffer
                    .as_mut_ptr()
                    .cast::<WindowsCommandLine>()
                    .write(invalid)
            };
            assert!(decode_windows_command_line(&buffer, bytes).is_none());
        }
        unsafe {
            buffer
                .as_mut_ptr()
                .cast::<WindowsCommandLine>()
                .write(valid);
            string.write(0xd800);
        }
        assert!(decode_windows_command_line(&buffer, bytes).is_none());
        unsafe { string.write(0) };
        assert!(decode_windows_command_line(&buffer, bytes).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn native_process_snapshot_preserves_raw_command_line_and_filetime() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::System::Threading::GetProcessTimes;

        let root = tempfile::Builder::new()
            .prefix("process-snapshot 空格-")
            .tempdir()
            .unwrap();
        let raw = format!(
            r#""{}" "payload --no-open" "escaped\"quote" --no-open"#,
            root.path().join("quoted path").join("entry.js").display()
        );
        let mut child = Command::new("node.exe")
            .args(["-e", "process.stdin.resume()", "--"])
            .raw_arg(&raw)
            .current_dir(root.path())
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn isolated snapshot probe");
        let checked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut creation: FILETIME = unsafe { std::mem::zeroed() };
            let mut exit = creation;
            let mut kernel = creation;
            let mut user = creation;
            assert_ne!(
                unsafe {
                    GetProcessTimes(
                        child.as_raw_handle(),
                        &mut creation,
                        &mut exit,
                        &mut kernel,
                        &mut user,
                    )
                },
                0
            );
            let expected =
                u64::from(creation.dwHighDateTime) << 32 | u64::from(creation.dwLowDateTime);
            let started = std::time::Instant::now();
            let output = windows_process_snapshot(Some(child.id())).unwrap();
            eprintln!("native target snapshot: {:?}", started.elapsed());
            let entries = String::from_utf8(output).unwrap();
            let entries: Vec<WindowsProcessEntry> = entries
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            assert_eq!(entries.len(), 1);
            let entry = &entries[0];
            assert_eq!(entry.pid, child.id());
            assert_eq!(
                entry.created, expected,
                "creation time must retain 100 ns precision"
            );
            assert!(
                entry.command_line.ends_with(&raw),
                "raw quoting must survive: {}",
                entry.command_line
            );
            assert_eq!(entry.ancestors[0].pid, std::process::id());
            assert_ne!(entry.ancestors[0].created, 0);
            assert!(!entry.ancestors_truncated || entry.ancestors.len() == 8);
            let started = std::time::Instant::now();
            let output = windows_process_snapshot(None).unwrap();
            eprintln!("native full snapshot: {:?}", started.elapsed());
            let entries = String::from_utf8(output).unwrap();
            let entry = entries
                .lines()
                .map(|line| serde_json::from_str::<WindowsProcessEntry>(line).unwrap())
                .find(|entry| entry.pid == child.id())
                .expect("full snapshot must retain the controlled probe");
            assert_eq!(entry.created, expected);
            assert!(entry.command_line.ends_with(&raw));

            let source = include_str!("process.rs");
            let snapshot = source
                .split("fn windows_process_snapshot(")
                .nth(1)
                .unwrap()
                .split("fn terminate_stale_harness_processes_at(")
                .next()
                .unwrap();
            assert!(
                !snapshot.contains("Command::new("),
                "process snapshots must not spawn an interpreter"
            );
        }));
        drop(child.stdin.take());
        let exited = child.wait().expect("wait for isolated snapshot probe");
        if let Err(error) = checked {
            std::panic::resume_unwind(error);
        }
        assert!(exited.success());
    }

    #[cfg(windows)]
    #[test]
    fn creation_mismatch_preserves_the_live_process() {
        use std::os::windows::process::CommandExt;
        let mut child = Command::new("node.exe")
            .args(["-e", "setTimeout(() => {}, 60000)"])
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let result = terminate_confirmed_process(child.id(), 1);
        let alive = child.try_wait().unwrap().is_none();
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(result.unwrap(), false);
        assert!(
            alive,
            "PID creation time mismatch must preserve the process"
        );
    }

    #[cfg(windows)]
    #[test]
    fn orphan_selection_excludes_owned_foreign_and_plugin_processes() {
        let bin = r"C:\sandbox\dev\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js";
        let lines = [
            serde_json::json!({ "pid": 101, "created": 1001, "commandLine": format!("node.exe {bin} --profile web --port 3081 --no-open"), "ancestors": [] }),
            serde_json::json!({ "pid": 102, "created": 1002, "commandLine": format!("node.exe {bin} --profile web --port 3082 --no-open"), "ancestors": [] }),
            serde_json::json!({ "pid": 103, "created": 1003, "commandLine": format!("node.exe {bin} plugin --profile web --port 3083"), "ancestors": [] }),
            serde_json::json!({ "pid": 104, "created": 1004, "commandLine": format!("node.exe {bin}.backup --profile web --port 3084"), "ancestors": [] }),
        ];
        let output = lines
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(
            orphan_harness_pids(output.as_bytes(), bin, Some(102)),
            vec![(101, 1001)]
        );
        assert_eq!(
            orphan_harness_pids(b"invalid json", bin, None),
            Vec::<(u32, u64)>::new()
        );
    }

    /// 回归：nvmd 等 Node 版本管理器的垫片以 `cmd.exe /C node <入口>` 转交真身。
    /// 垫片退出后真身的父进程是仍活着的 `cmd.exe`，旧谓词「父进程已退出」判定
    /// 它「有人管」而跳过清扫 → 真身继续占着 3080，下次启动直接 EADDRINUSE。
    /// 新谓词须穿过转发层清扫，同时不得误伤仍被活着的垫片持有的服务。
    #[cfg(windows)]
    #[test]
    fn orphan_selection_sweeps_through_relay_ancestors() {
        let bin = r"C:\Users\Example User\AppData\Roaming\dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js";
        let service = format!(r#"node.exe "{bin}" --profile web --port 3080 --no-open"#);
        let relay = format!(r#""cmd.exe" /C node "{bin}" --profile web --port 3080 --no-open"#);
        let shim = format!(r"C:\nvmd\bin\node.exe {bin} --profile web --port 3080 --no-open");
        let entry = |pid: u32, ancestors: Vec<serde_json::Value>| serde_json::json!({ "pid": pid, "created": 1000 + u64::from(pid), "commandLine": service, "ancestors": ancestors });
        let ancestor = |created: u64, pid: u32, name: &str, command_line: &str| serde_json::json!({ "pid": pid, "created": created, "name": name, "commandLine": command_line });
        let output = [
            // 垫片退出，只剩 `cmd.exe` 压着真身 → 须连转发层一起结束
            entry(201, vec![ancestor(1100, 301, "cmd.exe", &relay)]),
            // 转发层上方还压着活着的垫片 → 另一个桌面实例仍持有，不能碰
            entry(
                202,
                vec![
                    ancestor(1102, 302, "cmd.exe", &relay),
                    ancestor(1101, 402, "node.exe", &shim),
                ],
            ),
            // 真身直接挂在桌面实例下（没有垫片）→ 实例仍持有，不能碰
            entry(
                203,
                vec![ancestor(1103, 403, "deepseek-harness-desktop.exe", "")],
            ),
            // 命令行里出现 `--no-open` 但不是转发层（用户自己的 shell）→ 不能碰
            entry(
                204,
                vec![ancestor(
                    1104,
                    304,
                    "powershell.exe",
                    &format!("pwsh -Command \"{service}\""),
                )],
            ),
            // 祖先创建时间晚于后代：父子关系已失效（PID 复用），退回按子进程本身清扫
            entry(205, vec![ancestor(9999, 305, "cmd.exe", &relay)]),
            // 用户自己开着 `cmd.exe /K` 交互 shell 跑同一个入口 → 那是服务的宿主，不能碰
            entry(
                206,
                vec![ancestor(
                    1106,
                    306,
                    "cmd.exe",
                    &relay.replace("/C node", "/K node"),
                )],
            ),
            entry(208, vec![ancestor(1108, 308, "cmd.exe", &format!("{relay} & echo retained"))]),
            entry(209, vec![ancestor(1109, 309, "cmd.exe", &relay.replace(bin, r"C:\foreign\bin.js"))]),
            entry(210, vec![ancestor(0, 310, "cmd.exe", &relay)]),
            // 祖先链被层数上限截断：上方仍可能有持有者，不能清扫
            serde_json::json!({ "pid": 207, "created": 1207, "commandLine": service, "ancestors": [ancestor(1107, 307, "cmd.exe", &relay)], "ancestorsTruncated": true }),
        ]
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");
        assert_eq!(
            orphan_harness_pids(output.as_bytes(), bin, None),
            vec![(301, 1100), (205, 1205)]
        );
        assert_eq!(
            orphan_harness_pids(output.as_bytes(), bin, Some(301)),
            vec![(205, 1205)]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_harness_command_line_rejects_impostor_executable_and_embedded_flags() {
        let bin = r"C:\sandbox\dependencies\dsh\lib\bin.js";
        for command in [
            format!(r#"notnode.exe "{bin}" --profile web --port 3081 --no-open"#),
            format!(r#"node.exe "{bin}" --profile web --port 3081 "payload --no-open""#),
            format!(r#"node.exe "{bin}" --profile web --port 3081 --no-open extra.js"#),
        ] {
            assert!(!is_windows_harness_command_line(&command, bin), "{command}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_harness_command_line_matches_only_the_active_core_service() {
        let bin = r"C:\Users\Example User\AppData\Roaming\dsh-tauri\dev\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js";
        let command = format!(r#""C:\node.exe" "{bin}" --profile web --port 3081 --no-open"#);
        assert!(is_windows_harness_command_line(&command, bin));
        assert!(!is_windows_harness_command_line(
            &command.replace(&format!(r#""{bin}""#), bin),
            bin
        ));
        // 回归 issue #751：node 与入口之间夹着堆选项时仍须命中孤儿。
        assert!(is_windows_harness_command_line(
            &command.replace(
                r#""C:\node.exe" "#,
                r#""C:\node.exe" --max-old-space-size=8192 "#
            ),
            bin
        ));
        assert!(is_windows_harness_command_line(
            &format!(
                r#"node.exe --max-old-space-size=8192 "{bin}" --profile web --port 3081 --no-open"#
            ),
            bin
        ));
        for flags in [
            r#"--report-on-fatalerror "--report-directory=C:\用户 data\logs" --report-filename=fatal.json"#,
            r#"--report-on-fatalerror --report-directory="C:\用户 data\logs" --report-filename=fatal.json"#,
            r#"--max-old-space-size=8192 --report-on-fatalerror "--report-directory=C:\用户 data\logs" --report-filename=fatal.json"#,
        ] {
            assert!(is_windows_harness_command_line(
                &format!(r#"node.exe {flags} "{bin}" --profile web --port 3081 --no-open"#),
                bin
            ));
            assert!(!is_windows_harness_command_line(
                &format!(
                    r#"node.exe unrelated.js {flags} "{bin}" --profile web --port 3081 --no-open"#
                ),
                bin
            ));
        }
        // 入口前还夹着别的脚本参数时不得命中，避免误伤外来的 node 进程。
        assert!(!is_windows_harness_command_line(
            &format!(
                r#"node.exe unrelated.js --max-old-space-size=8192 "{bin}" --profile web --port 3081 --no-open"#
            ),
            bin
        ));
        assert!(!is_windows_harness_command_line(
            &command.replace(bin, &format!("{bin}.backup")),
            bin
        ));
        assert!(!is_windows_harness_command_line(
            &command.replace(bin, &format!("{bin}-foreign")),
            bin
        ));
        assert!(!is_windows_harness_command_line(
            &command.replace(" --profile", " plugin --profile"),
            bin
        ));
        assert!(!is_windows_harness_command_line(
            "node.exe other.js --profile web --port 3081",
            bin
        ));
        assert!(!is_windows_harness_command_line(
            &format!(r#"node.exe unrelated.js "{bin}" --profile web --port 3081"#),
            bin
        ));
    }

    #[test]
    fn harness_cmdline_matches_macos_app_data_path_with_spaces() {
        let bin = "/Users/simon/Library/Application Support/dsh-tauri/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
        let cmdline = format!("/opt/homebrew/bin/node {bin} --profile web --port 3084");
        assert!(is_harness_command_line(&cmdline, bin));
    }

    #[test]
    fn harness_cmdline_rejects_foreign_and_prefix_paths() {
        let bin = "/home/u/.dsh/dependencies/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";
        // 用户其它 node 程序
        assert!(!is_harness_command_line(
            "node /usr/bin/some-server.js",
            bin
        ));
        // 路径前缀相似但不同（整词匹配，不做子串匹配）
        assert!(!is_harness_command_line(
            "node /home/u/.dsh/dependencies/dsh-extra/tool.js",
            bin
        ));
        // 完整路径只是另一参数的前缀时不能命中
        assert!(!is_harness_command_line(
            &format!("node {bin}.backup --profile web --port 3083"),
            bin
        ));
        // 同一 dsh 入口执行插件命令时不是 Harness 服务，不能清扫
        assert!(!is_harness_command_line(
            &format!("node {bin} plugin list"),
            bin
        ));
        // 即使插件转发了服务参数，也不能被清扫
        assert!(!is_harness_command_line(
            &format!("node {bin} plugin --profile web add --port 3083"),
            bin
        ));
        // 名为 plugin 的 profile 仍是合法的 Harness 服务
        assert!(is_harness_command_line(
            &format!("node {bin} --profile plugin --port 3083"),
            bin
        ));
        // 路径作为另一个参数的后缀时不能命中
        assert!(!is_harness_command_line(
            &format!("node prefix{bin} --profile web --port 3083"),
            bin
        ));
        // 空命令行
        assert!(!is_harness_command_line("", bin));
    }

    /// 回归：nvmd 等 Node 版本管理器的垫片以 `cmd.exe /C node <entry>` 转交真身，
    /// 垫片先退出后真身仍占着端口。旧谓词要求「父进程已退出」才清扫，此时真身的父
    /// 进程 `cmd.exe` 还活着 → 漏杀，端口一直占着，下次启动 EADDRINUSE。
    /// 新谓词按入口路径清扫，并连带结束上方的转发层。
    #[cfg(windows)]
    #[test]
    fn orphan_service_is_swept_through_live_relay_ancestors() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
        };

        fn read_pid(path: &std::path::Path) -> u32 {
            std::fs::read_to_string(path)
                .expect("pid file")
                .trim()
                .parse::<u32>()
                .expect("pid")
        }

        let root = std::env::temp_dir().join(format!(
            "dsh-转发链-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let core = root.join("dependencies").join("dsh");
        let bin = core
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        let ready = root.join("ready");
        let service_pid_file = root.join("service.pid");
        std::fs::write(
            &bin,
            format!(
                "require('fs').writeFileSync({:?}, String(process.pid)); require('fs').writeFileSync({:?}, 'ready'); setTimeout(() => process.exit(0), 60000)",
                service_pid_file.to_string_lossy(),
                ready.to_string_lossy()
            ),
        )
        .unwrap();
        let relay_pid_file = root.join("relay.pid");
        let relay = "const {spawn}=require('child_process'); const c=spawn('cmd.exe',['/C','node',process.argv[1],'--profile','web','--port','3081','--no-open'],{cwd:process.argv[2],detached:true,stdio:'ignore'}); require('fs').writeFileSync(process.argv[3],String(c.pid)); c.unref()";
        let result = std::panic::catch_unwind(|| {
            let output = Command::new("node.exe")
                .args(["-e", relay])
                .arg(&bin)
                .arg(&core)
                .arg(&relay_pid_file)
                .creation_flags(0x08000000)
                .output()
                .expect("spawn temporary relay");
            assert!(
                output.status.success(),
                "temporary relay should spawn the service through cmd.exe"
            );
            let relay_pid = read_pid(&relay_pid_file);
            let started = std::time::Instant::now();
            while !ready.exists() && started.elapsed() < std::time::Duration::from_secs(5) {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            assert!(ready.exists(), "temporary service must become ready");
            let service = read_pid(&service_pid_file);
            let service_handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, service) };
            assert!(!service_handle.is_null(), "retain the service handle");
            let relay_handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, relay_pid) };
            assert!(!relay_handle.is_null(), "retain the relay handle");
            let check = std::panic::catch_unwind(|| {
                terminate_stale_harness_processes_at(&bin).expect("temporary core sweep");
                assert_eq!(
                    unsafe { WaitForSingleObject(service_handle, 5000) },
                    WAIT_OBJECT_0,
                    "the relayed orphan service should be terminated"
                );
                assert_eq!(
                    unsafe { WaitForSingleObject(relay_handle, 5000) },
                    WAIT_OBJECT_0,
                    "the live relay ancestors should be terminated with it"
                );
            });
            if unsafe { WaitForSingleObject(service_handle, 0) } != WAIT_OBJECT_0 {
                kill_pid_tree(service);
            }
            if unsafe { WaitForSingleObject(relay_handle, 0) } != WAIT_OBJECT_0 {
                kill_pid_tree(relay_pid);
            }
            unsafe { CloseHandle(service_handle) };
            unsafe { CloseHandle(relay_handle) };
            if let Err(error) = check {
                std::panic::resume_unwind(error);
            }
        });
        let _ = std::fs::remove_dir_all(&root);
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }

    /// 回归（issue #91）：Unix 上 `kill_pid_tree` 对「无独立进程组」的进程
    /// 必须回退到直接杀 PID——否则手动 CLI 拉起的外围 dsh 永远杀不掉，
    /// 残留进程持续占用端口导致端口一路递增。
    #[cfg(unix)]
    #[test]
    fn kill_pid_tree_falls_back_to_direct_pid_kill() {
        // 子进程不设独立进程组（模拟手动拉起的外围 dsh）；2 秒后自然退出，
        // 若 kill_pid_tree 未能杀死它，wait 会等到 2 秒后自然退出 → 超时断言失败
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 2")
            .spawn()
            .expect("spawn sleep child");
        let pid = child.id();
        // 给子进程一点时间进入 sleep，确保信号发到的是 sleep 而非刚 fork 的 sh
        std::thread::sleep(std::time::Duration::from_millis(200));
        let started = std::time::Instant::now();
        kill_pid_tree(pid);
        let status = child.wait().expect("wait for child");
        assert!(
            started.elapsed() < std::time::Duration::from_millis(1500),
            "child should have been killed by kill_pid_tree, not waited for natural exit"
        );
        // 被信号杀死：success() 为 false（SIGTERM 143 / SIGKILL 137）
        assert!(!status.success());
    }

    /// 正常路径：根进程在独立进程组中（与启动时 `process_group(0)` 对应），
    /// 负 PID 组信号应能结束整个进程树。
    #[cfg(unix)]
    #[test]
    fn kill_pid_tree_kills_process_group() {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("sh")
            .arg("-c")
            .arg("sleep 2")
            .process_group(0)
            .spawn()
            .expect("spawn group child");
        let pid = child.id();
        std::thread::sleep(std::time::Duration::from_millis(200));
        let started = std::time::Instant::now();
        kill_pid_tree(pid);
        let status = child.wait().expect("wait for group child");
        assert!(started.elapsed() < std::time::Duration::from_millis(1500));
        assert!(!status.success());
    }
}
