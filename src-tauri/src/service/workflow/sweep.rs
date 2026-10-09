//! 孤儿 Harness 清扫：崩溃/强杀残留实例的识别与回收（issue #34 关联现象），
//! 以及 Windows RedirectionGuard(448) 逃逸重拉。

use crate::config;
use std::fs;
use std::process::Command;

use super::process::{
    has_owned_process, kill_pid_tree, take_startup_sweep, terminate_stale_harness_processes,
};
use super::utils::is_port_in_use;

/// 孤儿清扫用的 PID/端口标记文件路径（两行：PID、端口）。
///
/// 应用被强杀（崩溃、任务管理器结束等）时无法执行退出清理，其 Harness 子进程
/// 会继续占用端口；下一次启动只能一路漂移端口（3080→3081→…）并触发服务端
/// "already running"，表现为应用"坏掉"。启动前据此文件识别并清理这类残留。
pub(super) fn harness_pid_path<R: tauri::Runtime>(
    app_handle: &tauri::AppHandle<R>,
) -> std::path::PathBuf {
    let channel = usize::from(app_handle.config().identifier == "dsh-tauri-nightly");
    config::get_dsh_data_path(app_handle).join(config::HARNESS_PID_MARKER_NAMES[channel])
}

#[cfg(test)]
mod tests {
    use super::harness_pid_path;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    #[test]
    fn harness_pid_marker_is_isolated_by_channel() {
        for (identifier, marker) in [
            ("dsh-tauri", ".harness.pid"),
            ("dsh-tauri-nightly", ".harness-nightly.pid"),
        ] {
            let mut context = mock_context(noop_assets());
            context.config_mut().identifier = identifier.into();
            let app = mock_builder().build(context).unwrap();
            let path = harness_pid_path(app.handle());
            assert_eq!(path.file_name().unwrap(), marker);
        }
    }
}

/// 记录本次启动的 Harness PID 与端口，供下次启动清扫孤儿用。
pub(super) fn persist_harness_pid(app_handle: &tauri::AppHandle, pid: u32, port: u16) {
    let path = harness_pid_path(app_handle);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let _ = fs::write(&path, format!("{pid}\n{port}\n"));
}

/// 启动前清扫上次崩溃残留的孤儿 Harness。Unix 标记回收经端口与 PID 双重确认：
/// - 标记进程已死 → 仅清理陈旧标记；
/// - 端口占用者正是标记中的 PID → 本应用残留，结束其进程树并清标记；
/// - 其余情况（标记不可解析、端口被其他程序占用、无法探测占用者）一律不动，
///   绝不凭端口猜进程、绝不杀未知进程。
pub fn sweep_orphan_harness(app_handle: &tauri::AppHandle) {
    if has_owned_process() {
        return;
    }
    // 先按命令行路径清扫所有从本应用 dsh 安装目录启动的孤儿 Harness 实例：
    // 标记文件只记录最近一次会话的 PID，应用多次崩溃/强杀会遗留更早的孤儿。
    // Windows 按入口路径与转发链状态回收，不按共享标记结束另一个仍在运行的 dev 实例。
    // 启动期只做一次：本次启动已清扫过就跳过（重复枚举同一份进程快照没有新结论）。
    if take_startup_sweep() {
        terminate_stale_harness_processes(app_handle);
    } else {
        log::debug!("Skipping orphan Harness sweep: already swept during this launch");
    }
    if cfg!(windows) {
        return;
    }
    let pid_file = harness_pid_path(app_handle);
    let Ok(text) = fs::read_to_string(&pid_file) else {
        return;
    };
    let mut lines = text.lines();
    let (Some(pid), Some(port)) = (
        lines.next().and_then(|l| l.trim().parse::<u32>().ok()),
        lines.next().and_then(|l| l.trim().parse::<u16>().ok()),
    ) else {
        // 标记内容不可解析：陈旧垃圾，清掉即可
        let _ = fs::remove_file(&pid_file);
        return;
    };
    if !is_port_in_use(port) {
        // 端口已释放：残留实例早已自行退出，仅清理标记
        let _ = fs::remove_file(&pid_file);
        return;
    }
    if port_owner_pid(port) != Some(pid) {
        // 端口占用者不是我们落盘的进程（或探测不到）：可能是其他程序，不动
        return;
    }
    log::warn!("Sweeping orphaned Harness process {pid} (port {port}) left by a previous session");
    kill_pid_tree(pid);
    let _ = fs::remove_file(&pid_file);
}

/// 占用指定端口的进程 PID（LISTENING 状态）。
/// - Windows：`netstat -ano` 解析；
/// - Unix：`lsof -ti tcp:<port>`，不可用时返回 None。
///   返回 None 视为"无法确认"，调用方不会因此杀任何进程。
fn port_owner_pid(port: u16) -> Option<u32> {
    #[cfg(windows)]
    {
        // 打包版是 GUI 进程（无控制台）：netstat 是控制台子系统程序，直接运行会
        // 新建一个可见的黑色 cmd 窗口（启动时的孤儿清扫会走到这里）。必须
        // CREATE_NO_WINDOW，否则每次启动闪一个黑窗。
        use std::os::windows::process::CommandExt;
        let output = Command::new("netstat")
            .arg("-ano")
            .creation_flags(0x08000000)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout);
        // `fields[1]` 来自 split_whitespace，已无尾随空格：needle 只带端口后缀
        let needle = format!(":{port}");
        for line in text.lines() {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 5 || fields[0] != "TCP" {
                continue;
            }
            // 本地地址列（如 127.0.0.1:3080 / [::1]:3080）以 :<port> 结尾
            if !fields[1].ends_with(&needle) {
                continue;
            }
            if fields[3] == "LISTENING" {
                return fields[4].parse().ok();
            }
        }
        None
    }
    #[cfg(not(windows))]
    {
        // lsof 在 macOS 默认可用、Linux 常缺失；缺失时跳过清扫（返回 None）
        let output = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()
            .and_then(|l| l.trim().parse().ok())
    }
}

/// Windows RedirectionGuard（错误码 448 = ERROR_UNTRUSTED_MOUNT_POINT）逃逸重拉的标记路径。
#[cfg(windows)]
pub(super) fn relaunch_marker_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    config::get_base_dir(app_handle).join(".dsh-relaunch-448")
}

/// 探测 dsh 入口在当前进程上下文下的打开错误码（None=可打开）。
///
/// 448 只在「进程继承 RedirectionGuard 强制执行」时出现；干净上下文（父进程为
/// explorer 等普通进程）下 Level-1 符号链接可正常穿越。
#[cfg(windows)]
pub(super) fn dsh_bin_open_error(app_handle: &tauri::AppHandle) -> Option<i32> {
    std::fs::File::open(config::get_dsh_binary_path(app_handle))
        .err()
        .and_then(|e| e.raw_os_error())
}

/// 通过 explorer 转交启动请求，脱离 RedirectionGuard 强制执行上下文后退出本进程。
///
/// Windows 11 25H2 的 RedirectionGuard 对「非提权进程创建的符号链接/联接点」盖信任章，
/// 而安装器（msiexec/RestartManager 自动重开）会在自身进程启用强制执行并随进程树继承，
/// 导致新实例跨越 pnpm 符号链接链打开 bin.js 时持续报 448——实测与等待时长无关、
/// 永不自行恢复（issue #35）。应用无法在运行时关闭继承的策略，只能脱离被污染的进程树：
/// 把启动请求转交给 explorer（单实例壳进程，干净上下文），由 explorer 创建新实例，
/// 其父进程即 explorer，不再继承强制执行（实测：explorer.exe <exe> 的子进程父进程为
/// explorer.exe，而非转交发起者）。标记文件用于防死循环：若上次重拉未逃逸
/// （explorer 未运行等），本次回退到常规缺失处理（复位 installed 走安装流程）。
#[cfg(windows)]
pub(super) fn relaunch_via_shell_escape(app_handle: &tauri::AppHandle) {
    let marker = relaunch_marker_path(app_handle);
    if marker.exists() {
        let _ = std::fs::remove_file(&marker);
        log::warn!("RedirectionGuard(448) relaunch did not escape, falling back to normal missing handling");
        return;
    }
    let _ = std::fs::write(&marker, b"1");
    let Ok(exe) = std::env::current_exe() else {
        log::warn!("RedirectionGuard(448) detected but current_exe unavailable, falling back");
        return;
    };
    match std::process::Command::new("explorer.exe").arg(&exe).spawn() {
        Ok(_) => {
            log::warn!(
                "RedirectionGuard(448) detected, relaunching via explorer to escape enforced context: {}",
                exe.display()
            );
            // 短暂让出后退出，避免与新实例产生单实例冲突
            std::thread::sleep(std::time::Duration::from_millis(300));
            std::process::exit(0);
        }
        Err(e) => {
            log::warn!(
                "RedirectionGuard(448) detected but explorer spawn failed ({e}), falling back"
            );
        }
    }
}
