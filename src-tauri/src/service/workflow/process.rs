//! Harness 进程生命周期：本应用持有的根进程登记（PID + Windows 句柄成对存储）、
//! 启动守卫、进程树终止与退出状态回落，以及按 dsh 安装路径清扫历史残留的
//! 孤儿服务实例（各平台都按入口路径清扫：Windows 需穿过垫片的 `cmd.exe /C node`
//! 转发层判断持有者，Unix 的匹配与父进程状态无关，转发层自身也会被命中）。

use crate::config;
use std::fs;
#[cfg(windows)]
use std::path::Path;
use std::process::Command;
#[cfg(windows)]
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

use super::status;
use super::sweep::harness_pid_path;

/// 当前持有的 Harness 根进程意外退出时通知前端的专用事件。
pub(super) const HARNESS_PROCESS_EXITED_EVENT: &str = "harness-process-exited";

/// Harness 根进程退出事件载荷。退出码在 Unix 被信号终止或系统查询失败时为空。
#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct HarnessProcessExitedPayload {
    pub(super) pid: u32,
    pub(super) exit_code: Option<i64>,
}

/// 启动守卫：并发调用 `launch` 时只允许一个真正拉起 dsh 进程
pub(crate) static LAUNCH_GUARD: AtomicBool = AtomicBool::new(false);

/// 当前进程内由桌面端创建的 Harness 根进程（PID + Windows 句柄）。
///
/// PID 与句柄装在同一把锁的可选值里：`take()` 一次性成对取出，保证
/// 「PID 清空」与「句柄关闭」之间不存在跨原子竞态（WARN-6）。历史上 PID/句柄
/// 分两个 `Atomic*` 存储，`stop` 读 PID 与监视线程清句柄之间有微窗口可能导致
/// 漏杀或重复 close。
#[derive(Clone, Copy)]
pub(super) struct OwnedProcess {
    pub(super) pid: u32,
    /// Windows 进程句柄（原始 HANDLE 转 usize 存储，避免 `*mut c_void` 非 Send）。
    /// 只在 Windows 存在；Unix 无句柄概念。
    #[cfg(windows)]
    pub(super) handle: usize,
}

fn owned_process_lock() -> &'static Mutex<Option<OwnedProcess>> {
    static OWNED_PROCESS: OnceLock<Mutex<Option<OwnedProcess>>> = OnceLock::new();
    OWNED_PROCESS.get_or_init(|| Mutex::new(None))
}

/// 记录新持有的 Harness 根进程（Unix，启动成功后调用）。
#[cfg(not(windows))]
pub(super) fn set_owned_process(pid: u32) {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(OwnedProcess { pid });
}

/// 若调用方 owns 该进程（Windows 额外存句柄），记录之。
#[cfg(windows)]
pub(super) fn set_owned_process_with_handle(pid: u32, handle: usize) {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *guard = Some(OwnedProcess { pid, handle });
}

/// 原子取出持有的进程（PID+句柄一起）。取走者负责关闭 Windows 句柄；
/// 无条件取出（停止/退出路径）。
fn take_owned_process() -> Option<OwnedProcess> {
    owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
}

/// 仅当当前持有进程的 PID 与 `pid` 匹配时才取出（成对 PID+句柄）。
///
/// 保留 base 代码 `compare_exchange(pid, 0)` 的防护语义：退出监视线程只能清掉
/// 属于自己那一条登记，绝不误取/误清「刚启动的新进程」的登记——否则会把它
/// 当作已退出而错误回落 Status，并把新进程的句柄误关（WARN-6 合并引入的回退）。
fn take_owned_process_if(pid: u32) -> Option<OwnedProcess> {
    let mut guard = owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    take_owned_process_if_matching(&mut guard, pid)
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

pub(crate) struct LaunchGuard;

impl Drop for LaunchGuard {
    fn drop(&mut self) {
        LAUNCH_GUARD.store(false, Ordering::SeqCst);
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
    owned_process_lock()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
}

pub fn owned_process_pid() -> Option<u32> {
    owned_process_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|process| process.pid)
}

/// 处理「持有的 dsh 进程退出」这一事实（由退出监视线程与健康检查 tick 共用）：
///
/// - 仅当退出的 PID 仍是当前登记的那个进程时才清空持有（`take_owned_process_if`
///   按 pid 匹配），PID/句柄作为整体成对取出——杜绝「读 PID」与「清句柄」
///   之间的跨原子竞态（WARN-6），也杜绝旧监视线程误清新启动进程的登记；
/// - 匹配成功后无条件回落到 Stopped——进程可能在 Starting 或 Running 阶段
///   退出，任何情况下都不能继续广播一个已经失效的运行状态（WARN-5）。
///
/// 返回被取出的进程记录（含 Windows 句柄），取到者负责 `CloseHandle`——保证
/// 「取走进程」与「关闭句柄」同属一个调用者，杜绝重复 close。幂等：多次调用
/// （tick 与监视线程并发）只会生效一次，后续调用返回 None。
pub(super) fn on_owned_process_exit(
    app_handle: &AppHandle,
    pid: u32,
    exit_code: impl FnOnce(&OwnedProcess) -> Option<i64>,
) -> Option<OwnedProcess> {
    let owned = take_owned_process_if(pid)?;
    // 必须在成功取走当前 PID 后才读取 Windows 句柄：正常停止会先取走并关闭
    // 句柄，旧监视线程不得再查询该句柄，更不得发送“意外退出”事件。
    let exit_code = exit_code(&owned);

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

    status::set_status(status::Status::Stopped);
    status::emit_status(app_handle);
    let payload = HarnessProcessExitedPayload {
        pid: owned.pid,
        exit_code,
    };
    if let Err(error) = app_handle.emit(HARNESS_PROCESS_EXITED_EVENT, payload) {
        log::warn!("Failed to emit Harness process exit event: {error}");
    }
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
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::WaitForSingleObject;
        const WAIT_TIMEOUT_CODE: u32 = 0x0000_0102;
        let handle = owned.handle as windows_sys::Win32::Foundation::HANDLE;
        if handle.is_null() {
            return Ok(true);
        }
        // 真实句柄已结束说明 PID 可能已复用，此时绝不调用 taskkill。
        if unsafe { WaitForSingleObject(handle, 0) } != WAIT_TIMEOUT_CODE {
            unsafe { CloseHandle(handle) };
            return Ok(true);
        }
        kill_pid_tree(owned.pid);
        if unsafe { WaitForSingleObject(handle, 5_000) } != WAIT_OBJECT_0 {
            let mut guard = owned_process_lock()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if guard.is_none() {
                *guard = Some(owned);
            } else {
                unsafe { CloseHandle(handle) };
            }
            log::error!("Harness process {} is still running after stop", owned.pid);
            return Err(());
        }
        unsafe { CloseHandle(handle) };
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
    let boundary = format!(
        r#"(?i)^\s*(?:"[^"]*\\node(?:\.exe)?"|[^\s"]*node(?:\.exe)?)(?:\s+-[^\s"]*)*\s+"?{}(?:"|\s|$)"#,
        regex::escape(&path)
    );
    regex::Regex::new(&boundary).is_ok_and(|pattern| pattern.is_match(&normalized))
        && is_harness_command_line(
            &normalized.replace('"', "").to_lowercase(),
            &path.to_lowercase(),
        )
        && command_line_has_argument(&normalized, "--no-open")
}

#[cfg(windows)]
fn terminate_stale_harness_processes_at(dsh_bin: &Path) {
    use std::os::windows::process::CommandExt;

    let Some(dsh_bin) = dsh_bin.to_str() else {
        return;
    };
    // 候选进程连同其上方仍活着的祖先一起上报：垫片转发链是否孤儿，只有整条链能判断。
    // 祖先链被层数上限截断时单独标记，调用方据此放弃清扫（上方仍可能有持有者）。
    let script = r#"$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $all = Get-CimInstance Win32_Process
  $byPid = @{}
  foreach ($process in $all) { $byPid[$process.ProcessId] = $process }
  foreach ($child in $all) {
    if (-not $child.CommandLine -or -not $child.CommandLine.Contains('--no-open')) { continue }
    $ancestors = @()
    $parent = $byPid[$child.ParentProcessId]
    for ($depth = 0; $depth -lt 8; $depth++) {
      if (-not $parent) { break }
      $ancestorCreated = 0
      if ($parent.CreationDate) { $ancestorCreated = $parent.CreationDate.ToFileTimeUtc() }
      $ancestors += [pscustomobject]@{ pid = $parent.ProcessId; name = $parent.Name; created = $ancestorCreated; commandLine = $parent.CommandLine }
      $parent = $byPid[$parent.ParentProcessId]
    }
    $childCreated = 0
    if ($child.CreationDate) { $childCreated = $child.CreationDate.ToFileTimeUtc() }
    [pscustomobject]@{ pid = $child.ProcessId; created = $childCreated; commandLine = $child.CommandLine; ancestors = $ancestors; ancestorsTruncated = ($null -ne $parent) } | ConvertTo-Json -Compress -Depth 4
  }
} catch { Write-Error $_; exit 1 }"#;
    let output = match Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .output()
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            log::warn!(
                "Failed to enumerate orphan Harness processes: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        Err(error) => {
            log::warn!("Failed to enumerate orphan Harness processes: {error}");
            return;
        }
    };
    let owned_pid = owned_process_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .map(|process| process.pid);
    let mut found = 0;
    for (pid, created) in orphan_harness_pids(&output.stdout, dsh_bin, owned_pid) {
        if matches_process_creation(pid, created, || {
            log::warn!("Terminating orphan Harness service process {pid} (from dsh install dir)");
            kill_pid_tree(pid);
        }) {
            found += 1;
        }
    }
    if found > 0 {
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
}

#[cfg(windows)]
fn matches_process_creation(pid: u32, created: u64, terminate: impl FnOnce()) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE,
    };

    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return false;
    }
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = creation;
    let mut kernel = creation;
    let mut user = creation;
    let matches = unsafe {
        GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) != 0
            && WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
            && (u64::from(creation.dwHighDateTime) << 32 | u64::from(creation.dwLowDateTime)) / 10
                == created / 10
    };
    if matches {
        terminate();
    }
    if !matches {
        log::warn!("Skipping orphan Harness process {pid}: creation time or process state changed (expected {created}, observed {})", u64::from(creation.dwHighDateTime) << 32 | u64::from(creation.dwLowDateTime));
    }
    unsafe { CloseHandle(handle) };
    matches
}

#[cfg(windows)]
#[derive(serde::Deserialize)]
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
#[derive(serde::Deserialize)]
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
fn is_relay_ancestor(ancestor: &WindowsProcessAncestor) -> bool {
    ancestor.name.eq_ignore_ascii_case("cmd.exe")
        && ancestor.command_line.as_deref().is_some_and(|command| {
            command_line_has_argument(command, "--no-open") && is_relay_command_line(command)
        })
}

/// 判断命令行是否为 `cmd.exe /C node ...` 形式的转发：第一个词是 cmd（可带路径与
/// `.exe`），紧跟 `/C`，再接 node（可带路径与 `.exe`）。
#[cfg(windows)]
fn is_relay_command_line(command: &str) -> bool {
    regex::Regex::new(r"(?i)^\s*\S*cmd(?:\.exe)?\s+/c\s+\S*node(?:\.exe)?(?:\s|$)")
        .is_ok_and(|pattern| pattern.is_match(&command.replace('"', "")))
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
        if entry.ancestors_truncated
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
            if !is_relay_ancestor(ancestor) {
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
pub fn terminate_stale_harness_processes(app_handle: &tauri::AppHandle) {
    #[cfg(windows)]
    terminate_stale_harness_processes_at(&config::get_dsh_binary_path(app_handle));
    #[cfg(not(windows))]
    {
        if cfg!(debug_assertions) {
            return;
        }
        // Unix 同样需要按路径清扫：打开中的文件允许重命名确实不阻塞更新切换，
        // 但崩溃/强杀残留的孤儿 dsh 实例会持续监听端口，下一次启动只能一路
        // 漂移端口（3080→3081→…）并被持久化，表现为「更新后端口递增」
        // （issue #91）。用 `ps -ww -axo pid=,command=` 枚举完整命令行（`-ww`
        // 防止 macOS 按终端宽度截断长路径），按参数边界匹配本应用 dsh 入口与
        // 服务参数，不会误杀用户其它 node/dsh 命令，因此可安全地全部结束。
        let dsh_bin = config::get_dsh_binary_path(app_handle);
        let Some(dsh_bin_str) = dsh_bin.to_str() else {
            return;
        };
        let Ok(output) = Command::new("ps")
            .args(["-ww", "-axo", "pid=,command="])
            .output()
        else {
            log::error!("Failed to enumerate stale Harness service processes");
            return;
        };
        let mut found = 0;
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            let Some((pid, cmdline)) = parse_ps_line(line) else {
                continue;
            };
            if !is_harness_command_line(cmdline, dsh_bin_str) {
                continue;
            }
            found += 1;
            log::warn!("Terminating stale Harness service process {pid} (from dsh install dir)");
            kill_pid_tree(pid);
        }
        if found > 0 {
            // 与 stop() 同理：信号发完后 PID 回收与端口释放还有短暂滞后，
            // 让出一点时间避免紧随其后的启动探测撞上尚未释放的端口。
            std::thread::sleep(std::time::Duration::from_millis(800));
        }
    }
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
    log::info!("Stopping Harness service...");
    // 重置启动守卫，确保后续 launch 可以重新拉起；仅结束持有的根进程树。
    // 进程终止涉及 WaitForSingleObject（至多 5s）与 taskkill/kill 等同步阻塞
    // 调用，移出 Tokio 执行线程避免卡住其他并发任务（WARN-7/P2-#20）。
    LAUNCH_GUARD.store(false, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(terminate_owned_process)
        .await
        .map_err(|e| format!("STOP_FAILED: {e}"))?
        .map_err(|()| "STOP_FAILED: Harness process did not stop".to_string())?;
    // 清理孤儿清扫标记：正常停止的实例不应被下次启动当作残留
    let _ = fs::remove_file(harness_pid_path(&app_handle));

    // 给系统一点时间释放端口 (重要！)
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;

    status::set_status(status::Status::Stopped);
    status::emit_status(&app_handle);
    Ok(())
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
pub fn stop_for_installer(app_handle: &tauri::AppHandle) {
    if !matches!(terminate_owned_process(), Ok(true)) {
        return;
    }
    // 正常停止路径同样清理清扫标记（崩溃路径才需要下次启动清扫）
    let _ = fs::remove_file(harness_pid_path(app_handle));
    log::info!("Harness stopped and port released for installer handoff");
    std::thread::sleep(std::time::Duration::from_millis(800));
}

/// 应用退出时同步回收 Harness 进程。
///
/// 退出路径上不更新状态，只结束当前应用持有的 Harness 进程树（与安装器交接共用
/// [`stop_for_installer`]，保证两条路径行为一致）。
pub fn stop_on_exit(app_handle: &tauri::AppHandle) {
    stop_for_installer(app_handle);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个测试用 `OwnedProcess`（跨平台处理 Windows 句柄字段）。
    #[cfg(windows)]
    fn test_owned(pid: u32) -> OwnedProcess {
        OwnedProcess { pid, handle: 0 }
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
        std::fs::write(&bin, format!("require('fs').writeFileSync({:?}, 'ready'); setTimeout(() => process.exit(0), 60000)", ready.to_string_lossy())).unwrap();
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
            terminate_stale_harness_processes_at(&bin);
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
        std::fs::write(&bin, format!("require('fs').writeFileSync({:?}, 'ready'); setTimeout(() => process.exit(0), 60000)", ready.to_string_lossy())).unwrap();
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
                terminate_stale_harness_processes_at(&bin);
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
        let service = format!("node.exe {bin} --profile web --port 3080 --no-open");
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

    /// 回归：转发层只认 `cmd.exe /C node` 这种一次性转交。用户自己开着 `cmd.exe /K`
    /// 交互 shell 跑同一个入口时，shell 的命令行里同样有 `--no-open`，但它是那个服务
    /// 的宿主；误判会让清扫连带关掉用户的窗口。
    #[cfg(windows)]
    #[test]
    fn relay_command_line_requires_the_one_shot_transfer() {
        let bin = r"C:\Users\Example User\AppData\Roaming\dsh-tauri\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js";
        let service = format!("node.exe {bin} --profile web --port 3080 --no-open");
        assert!(is_relay_command_line(&format!(
            r#""cmd.exe" /C node {service}"#
        )));
        assert!(is_relay_command_line(&format!(
            r#"C:\Windows\System32\cmd.exe /c node.exe {service}"#
        )));
        assert!(!is_relay_command_line(&format!(
            r#""cmd.exe" /K node {service}"#
        )));
        assert!(!is_relay_command_line(&format!(
            r#""cmd.exe" /C npm exec dsh {service}"#
        )));
        assert!(!is_relay_command_line(&format!(
            r#"powershell.exe -Command "cmd.exe /C node {service}""#
        )));
    }

    #[cfg(windows)]
    #[test]
    fn windows_harness_command_line_matches_only_the_active_core_service() {
        let bin = r"C:\Users\Example User\AppData\Roaming\dsh-tauri\dev\dependencies\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js";
        let command = format!(r#""C:\node.exe" "{bin}" --profile web --port 3081 --no-open"#);
        assert!(is_windows_harness_command_line(&command, bin));
        // 回归 issue #751：node 与入口之间夹着堆选项时仍须命中孤儿。
        assert!(is_windows_harness_command_line(
            &command.replace(r#""C:\node.exe" "#, r#""C:\node.exe" --max-old-space-size=8192 "#),
            bin
        ));
        assert!(is_windows_harness_command_line(
            &format!(r#"node.exe --max-old-space-size=8192 "{bin}" --profile web --port 3081 --no-open"#),
            bin
        ));
        // 入口前还夹着别的脚本参数时不得命中，避免误伤外来的 node 进程。
        assert!(!is_windows_harness_command_line(
            &format!(r#"node.exe unrelated.js --max-old-space-size=8192 "{bin}" --profile web --port 3081 --no-open"#),
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
                "require('fs').writeFileSync({:?}, 'ready'); require('fs').writeFileSync({:?}, String(process.pid)); setTimeout(() => process.exit(0), 60000)",
                ready.to_string_lossy(),
                service_pid_file.to_string_lossy()
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
                terminate_stale_harness_processes_at(&bin);
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
