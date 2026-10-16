//! Windows 专用：以隐藏控制台的方式启动子进程。
//!
//! 打包版应用是 GUI 进程（没有控制台）。如果直接以 `CREATE_NO_WINDOW` 启动
//! node.exe，node 自身没有控制台，dsh 在 JS 里通过 `child_process` 派生的
//! 每个子进程（cmd / node / git 等）都会各自创建一个新的可见控制台窗口，
//! 表现为使用过程中频繁闪烁黑色 cmd 窗口。
//!
//! 这里改用 `CREATE_NEW_CONSOLE` + `STARTF_USESHOWWINDOW`/`SW_HIDE` 给 node
//! 分配一个隐藏的控制台：node 及其所有后代进程共享这个隐藏控制台，不再弹窗。
//! 模块声明处已按 `#[cfg(windows)]` 门控，仅在 Windows 构建中编译。

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, IntoRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::process::{ExitStatus, Output};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{
    CloseHandle, SetHandleInformation, ERROR_BROKEN_PIPE, GENERIC_READ, GENERIC_WRITE, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, ResumeThread, TerminateProcess, WaitForSingleObject,
    CREATE_NEW_CONSOLE, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION,
    STARTF_USESHOWWINDOW, STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

#[derive(Debug)]
pub(crate) struct ProcessCleanupFailed(pub(crate) String);

impl std::fmt::Display for ProcessCleanupFailed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ProcessCleanupFailed {}

pub(crate) struct ProcessJob {
    handle: OwnedHandle,
}

impl ProcessJob {
    pub(crate) fn new() -> io::Result<Self> {
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self { handle })
    }

    pub(crate) fn terminate(&self) -> io::Result<()> {
        if unsafe { TerminateJobObject(self.handle.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// 以隐藏控制台方式启动 `program`，返回其 stdout / stderr 管道读取端。
///
/// `envs` 中的键值会覆盖当前进程环境变量后传给子进程。
#[cfg_attr(not(test), allow(dead_code))]
pub fn spawn_with_hidden_console(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
) -> io::Result<(File, File)> {
    let (stdout, stderr, handle) =
        spawn_with_hidden_console_tracked(program, args, current_dir, envs)?;
    unsafe {
        CloseHandle(handle);
    }
    Ok((stdout, stderr))
}

/// 启动由桌面端持有的 Harness 进程，同时返回 PID 与进程句柄。
///
/// PID 用于只结束本应用创建的进程树；句柄由调用方等待并关闭，避免进程退出后
/// PID 被系统复用时误伤其他程序。
pub fn spawn_with_hidden_console_owned(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
) -> io::Result<(File, File, u32, HANDLE)> {
    spawn_with_hidden_console_inner(program, args, current_dir, envs, None, &[])
}

pub(crate) fn spawn_with_hidden_console_in_job(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
    job: &ProcessJob,
) -> io::Result<(File, File, u32, HANDLE)> {
    spawn_with_hidden_console_inner(program, args, current_dir, envs, Some(job), &[])
}

pub(crate) fn probe_in_job(
    program: &Path,
    args: &[OsString],
    job: &ProcessJob,
    registration_gate: &Mutex<bool>,
    remove_node_options: bool,
) -> io::Result<Output> {
    let (mut stdout, mut stderr, _, handle) = {
        let shutdown = registration_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *shutdown {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "probe rejected during shutdown",
            ));
        }
        spawn_with_hidden_console_inner(
            program,
            args,
            None,
            &HashMap::new(),
            Some(job),
            if remove_node_options {
                &["NODE_OPTIONS"]
            } else {
                &[]
            },
        )?
    };
    let process = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut output = [Vec::new(), Vec::new()];
    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            drain_probe_pipe(&mut stdout, &mut output[0])?;
            drain_probe_pipe(&mut stderr, &mut output[1])?;
            match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    if unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) } == 0 {
                        return Err(io::Error::last_os_error());
                    }
                    break Ok(ExitStatus::from_raw(code));
                }
                WAIT_TIMEOUT => {}
                _ => return Err(io::Error::last_os_error()),
            }
            if *registration_gate
                .lock()
                .unwrap_or_else(|error| error.into_inner())
            {
                return Err(io::Error::new(
                    io::ErrorKind::Interrupted,
                    "probe cancelled during shutdown",
                ));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "probe exceeded 8s"));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    let terminate = job.terminate();
    let cleanup = (|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            if unsafe {
                QueryInformationJobObject(
                    job.handle.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut core::ffi::c_void,
                    std::mem::size_of_val(&accounting) as u32,
                    std::ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            if accounting.ActiveProcesses == 0 {
                match unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } {
                    WAIT_OBJECT_0 => {
                        while drain_probe_pipe(&mut stdout, &mut output[0])?
                            | drain_probe_pipe(&mut stderr, &mut output[1])?
                        {
                            if Instant::now() >= deadline {
                                return Err(io::Error::new(
                                    io::ErrorKind::TimedOut,
                                    "probe pipes did not drain within 5s",
                                ));
                            }
                        }
                        return Ok(());
                    }
                    WAIT_TIMEOUT => {}
                    _ => return Err(io::Error::last_os_error()),
                }
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "probe job did not exit within 5s",
                ));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    })();
    if terminate.is_err() || cleanup.is_err() {
        let fallback = terminate_and_wait(process.as_raw_handle());
        return Err(io::Error::other(ProcessCleanupFailed(format!(
            "probe result: {result:?}; job terminate: {terminate:?}; job cleanup: {cleanup:?}; process cleanup: {fallback:?}"
        ))));
    }
    let [stdout, stderr] = output;
    Ok(Output {
        status: result?,
        stdout,
        stderr,
    })
}

fn drain_probe_pipe(pipe: &mut File, output: &mut Vec<u8>) -> io::Result<bool> {
    let mut available = 0;
    if unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        return if error.raw_os_error() == Some(ERROR_BROKEN_PIPE as i32) {
            Ok(false)
        } else {
            Err(error)
        };
    }
    let mut buffer = [0; 8192];
    let count = available.min(buffer.len() as u32) as usize;
    if count == 0 {
        return Ok(false);
    }
    let count = pipe.read(&mut buffer[..count])?;
    output.extend_from_slice(&buffer[..count.min((64 * 1024usize).saturating_sub(output.len()))]);
    Ok(count != 0)
}

/// 同 [`spawn_with_hidden_console`]，但额外返回进程句柄，供调用方等待进程
/// 结束并读取退出码（预装插件安装等需要判断成败的场景）。
pub fn spawn_with_hidden_console_tracked(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
) -> io::Result<(File, File, HANDLE)> {
    let (stdout, stderr, _, handle) =
        spawn_with_hidden_console_inner(program, args, current_dir, envs, None, &[])?;
    Ok((stdout, stderr, handle))
}

fn spawn_with_hidden_console_inner(
    program: &Path,
    args: &[OsString],
    current_dir: Option<&Path>,
    envs: &HashMap<String, String>,
    job: Option<&ProcessJob>,
    remove_env: &[&str],
) -> io::Result<(File, File, u32, HANDLE)> {
    unsafe {
        let pipe_attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: 1,
        };
        let (stdout_read, stdout_write) = create_output_pipe(&pipe_attrs)?;
        let (stderr_read, stderr_write) = create_output_pipe(&pipe_attrs)?;

        let nul: Vec<u16> = "NUL\0".encode_utf16().collect();
        let stdin_handle = CreateFileW(
            nul.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &pipe_attrs,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if stdin_handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let stdin_handle = OwnedHandle::from_raw_handle(stdin_handle);
        let mut command_line = build_command_line(program, args);
        let env_block = build_env_block(envs, remove_env);
        let mut application_name = program.as_os_str().encode_wide().collect::<Vec<u16>>();
        application_name.push(0);
        let current_dir_wide = current_dir.map(|dir| {
            dir.as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<u16>>()
        });
        let startup_info = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            dwFlags: STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES,
            wShowWindow: SW_HIDE as u16,
            hStdInput: stdin_handle.as_raw_handle(),
            hStdOutput: stdout_write.as_raw_handle(),
            hStdError: stderr_write.as_raw_handle(),
            ..Default::default()
        };
        let mut process_info = PROCESS_INFORMATION::default();
        if CreateProcessW(
            application_name.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            CREATE_NEW_CONSOLE
                | CREATE_UNICODE_ENVIRONMENT
                | if job.is_some() { CREATE_SUSPENDED } else { 0 },
            env_block.as_ptr() as *const core::ffi::c_void,
            current_dir_wide
                .as_ref()
                .map(|wide| wide.as_ptr())
                .unwrap_or(std::ptr::null()),
            &startup_info,
            &mut process_info,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let process = OwnedHandle::from_raw_handle(process_info.hProcess);
        let thread = OwnedHandle::from_raw_handle(process_info.hThread);
        drop((stdout_write, stderr_write, stdin_handle));
        if let Some(job) = job {
            assign_and_resume(job, process.as_raw_handle(), thread.as_raw_handle())?;
        }
        Ok((
            File::from(stdout_read),
            File::from(stderr_read),
            process_info.dwProcessId,
            process.into_raw_handle(),
        ))
    }
}

fn create_output_pipe(attrs: &SECURITY_ATTRIBUTES) -> io::Result<(OwnedHandle, OwnedHandle)> {
    let mut read = std::ptr::null_mut();
    let mut write = std::ptr::null_mut();
    if unsafe { CreatePipe(&mut read, &mut write, attrs, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let read = unsafe { OwnedHandle::from_raw_handle(read) };
    let write = unsafe { OwnedHandle::from_raw_handle(write) };
    if unsafe { SetHandleInformation(read.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((read, write))
}

fn assign_and_resume(job: &ProcessJob, process: HANDLE, thread: HANDLE) -> io::Result<()> {
    let operation = if unsafe { AssignProcessToJobObject(job.handle.as_raw_handle(), process) } == 0
    {
        "AssignProcessToJobObject"
    } else if unsafe { ResumeThread(thread) } == u32::MAX {
        "ResumeThread"
    } else {
        return Ok(());
    };
    let error = io::Error::last_os_error();
    terminate_and_wait(process).map_err(|cleanup| {
        io::Error::other(ProcessCleanupFailed(format!(
            "{operation}: {error}; cleanup: {cleanup}"
        )))
    })?;
    Err(error)
}

fn terminate_and_wait(process: HANDLE) -> io::Result<()> {
    let terminated = unsafe { TerminateProcess(process, 1) };
    let terminate_error = (terminated == 0).then(io::Error::last_os_error);
    match unsafe { WaitForSingleObject(process, 5000) } {
        WAIT_OBJECT_0 => terminate_error.map_or(Ok(()), Err),
        wait => {
            let wait_error = if wait == WAIT_TIMEOUT {
                io::Error::new(io::ErrorKind::TimedOut, "process did not exit within 5s")
            } else {
                io::Error::last_os_error()
            };
            Err(match terminate_error {
                Some(error) => io::Error::new(
                    wait_error.kind(),
                    format!("TerminateProcess: {error}; wait: {wait_error}"),
                ),
                None => wait_error,
            })
        }
    }
}

/// 构建完整的 Unicode 环境块（每个条目以 `\0` 结尾，整个块以额外 `\0` 结尾）
fn build_env_block(extra: &HashMap<String, String>, remove: &[&str]) -> Vec<u16> {
    let mut vars: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    for (key, value) in extra {
        let key_os = OsString::from(key);
        // Windows 环境变量大小写不敏感：用户/系统环境里的键通常是 `Path` 而非
        // `PATH`，若按大小写敏感匹配会追加重复键，子进程（CreateProcessW 环境块）
        // 取到旧值。必须大小写不敏感匹配再替换。
        if let Some(entry) = vars
            .iter_mut()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(&key_os))
        {
            entry.1 = OsString::from(value);
        } else {
            vars.push((key_os, OsString::from(value)));
        }
    }

    vars.retain(|(key, _)| {
        !remove
            .iter()
            .any(|name| key.eq_ignore_ascii_case(std::ffi::OsStr::new(name)))
    });
    let mut block = Vec::new();
    for (key, value) in vars {
        block.extend(key.encode_wide());
        block.push(b'=' as u16);
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// 构建 CreateProcessW 命令行（遵循 MSVC 的引号转义规则）
fn build_command_line(program: &Path, args: &[OsString]) -> Vec<u16> {
    let mut command = quote_arg(&program.as_os_str().to_string_lossy());
    for arg in args {
        command.push(' ');
        command.push_str(&quote_arg(&arg.to_string_lossy()));
    }
    let mut wide = command.encode_utf16().collect::<Vec<u16>>();
    wide.push(0);
    wide
}

/// 按 MSVC 规则为命令行参数加引号并转义反斜杠/双引号
fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '"')) {
        return arg.to_string();
    }

    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                for _ in 0..backslashes * 2 {
                    out.push('\\');
                }
                backslashes = 0;
                out.push('\\');
                out.push('"');
            }
            _ => {
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push(c);
            }
        }
    }
    for _ in 0..backslashes * 2 {
        out.push('\\');
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_key_match_is_case_insensitive() {
        // Windows 用户环境里的键通常是 `Path`：用 `PATH` 覆盖必须替换而不是追加
        let mut vars: Vec<(OsString, OsString)> = vec![
            (OsString::from("Path"), OsString::from("OLD")),
            (OsString::from("DSH_HOME"), OsString::from("x")),
        ];
        let key = OsString::from("PATH");
        let found = vars
            .iter_mut()
            .find(|(existing, _)| existing.eq_ignore_ascii_case(&key));
        assert!(found.is_some());
        if let Some(entry) = found {
            entry.1 = OsString::from("NEW");
        }
        // 替换后仍是单个 Path 条目且取新值
        let path_entries: Vec<String> = vars
            .iter()
            .filter(|(k, _)| k.to_string_lossy().eq_ignore_ascii_case("path"))
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .collect();
        assert_eq!(path_entries.len(), 1);
        assert_eq!(path_entries[0], "NEW");
    }

    #[test]
    fn spawn_captures_stdout_with_env_and_workdir() {
        let mut envs = HashMap::new();
        envs.insert("DSH_WIN_SPAWN_TEST".to_string(), "hello world".to_string());

        let workdir =
            std::env::temp_dir().join(format!("dsh_win_spawn_test_{}", std::process::id()));
        std::fs::create_dir_all(&workdir).unwrap();

        let args = vec![
            OsString::from("/d"),
            OsString::from("/c"),
            OsString::from("echo %DSH_WIN_SPAWN_TEST% && cd"),
        ];
        let (stdout, _stderr) = spawn_with_hidden_console(
            Path::new("C:\\Windows\\System32\\cmd.exe"),
            &args,
            Some(&workdir),
            &envs,
        )
        .unwrap();

        let mut output_bytes = Vec::new();
        use std::io::Read;
        let mut reader = stdout;
        reader.read_to_end(&mut output_bytes).unwrap();
        let output = String::from_utf8_lossy(&output_bytes);

        std::fs::remove_dir_all(&workdir).ok();

        assert!(output.contains("hello world"), "stdout: {output:?}");
        assert!(
            output.contains(&workdir.to_string_lossy().into_owned()),
            "stdout: {output:?}"
        );
    }

    #[test]
    fn spawned_process_gets_hidden_console() {
        let script = "$code='using System;using System.Runtime.InteropServices;public class C{[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);}';Add-Type -TypeDefinition $code;$h=[C]::GetConsoleWindow();if($h -eq [IntPtr]::Zero){'NO_CONSOLE'}else{'HAS_CONSOLE_VISIBLE='+[C]::IsWindowVisible($h)}";

        let args = vec![
            OsString::from("-NoProfile"),
            OsString::from("-NonInteractive"),
            OsString::from("-Command"),
            OsString::from(script),
        ];
        let (stdout, _stderr) = spawn_with_hidden_console(
            Path::new("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            &args,
            None,
            &HashMap::new(),
        )
        .unwrap();

        let mut output = String::new();
        use std::io::Read;
        let mut reader = stdout;
        reader.read_to_string(&mut output).unwrap();

        assert!(
            output.contains("HAS_CONSOLE_VISIBLE=False"),
            "expected a hidden console, got: {output:?}"
        );
    }

    #[test]
    fn grandchildren_inherit_hidden_console() {
        let node = find_node_on_path().expect("node.exe not found for the test");
        let ps1 =
            std::env::temp_dir().join(format!("dsh_console_check_{}.ps1", std::process::id()));
        std::fs::write(
            &ps1,
            "$code='using System;using System.Runtime.InteropServices;public class C{[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();[DllImport(\"user32.dll\")]public static extern bool IsWindowVisible(IntPtr h);}';Add-Type -TypeDefinition $code;$h=[C]::GetConsoleWindow();if($h -eq [IntPtr]::Zero){'NO_CONSOLE'}else{'HAS_CONSOLE_VISIBLE='+[C]::IsWindowVisible($h)}",
        )
        .unwrap();

        // node 作为“dsh 代理”：用 child_process 派生一个 powershell 孙进程，
        // 旧实现（node 无控制台）下孙进程会新建可见控制台窗口。
        let node_js = format!(
            "const{{spawnSync}}=require('child_process');const r=spawnSync('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',['-NoProfile','-NonInteractive','-File','{}'],{{encoding:'utf8'}});process.stdout.write((r.stdout??'')+(r.stderr??''));",
            ps1.to_string_lossy().replace('\\', "/")
        );

        let args = vec![OsString::from("-e"), OsString::from(node_js)];
        let (stdout, stderr) =
            spawn_with_hidden_console(&node, &args, None, &HashMap::new()).unwrap();

        let mut output = String::new();
        let mut error = String::new();
        use std::io::Read;
        let mut reader = stdout;
        reader.read_to_string(&mut output).unwrap();
        let mut reader = stderr;
        reader.read_to_string(&mut error).unwrap();
        std::fs::remove_file(&ps1).ok();

        assert!(
            output.contains("HAS_CONSOLE_VISIBLE=False"),
            "expected grandchildren to inherit a hidden console, got: {output:?} stderr: {error:?}"
        );
    }

    /// issue #647：内置插件的 `link:` spec 含空格时不再预加引号（0.1.6-alpha.2 起
    /// dsh CLI 以 argv 数组启动 pnpm），因此这条带空格的参数必须原样往返到 node 的
    /// argv——命令行构造（[`build_command_line`] / [`quote_arg`]）是「不加引号」方案
    /// 成立的前提。
    #[test]
    fn spaced_argument_round_trips_to_child_argv() {
        let node = find_node_on_path().expect("node.exe not found for the test");
        let spec = "link:D:/Deepseek Harness Desktop/resources/node_modules/dsh-tauri";
        let args = vec![
            OsString::from("-e"),
            OsString::from("process.stdout.write(JSON.stringify(process.argv.slice(1)))"),
            OsString::from(spec),
        ];
        let (stdout, _stderr) =
            spawn_with_hidden_console(&node, &args, None, &HashMap::new()).unwrap();

        let mut output = String::new();
        use std::io::Read;
        let mut reader = stdout;
        reader.read_to_string(&mut output).unwrap();

        assert_eq!(output, format!("[\"{spec}\"]"));
    }

    #[test]
    fn dropping_job_terminates_node_and_its_descendant() {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        };

        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ProcessJob>();
        let node = find_node_on_path().expect("node.exe required for job tests");
        let root = tempfile::tempdir().unwrap();
        let envs = isolated_node_env(root.path());
        let ready = root.path().join("descendant.pid");
        let job = ProcessJob::new().unwrap();
        let args = [
            OsString::from("-e"),
            OsString::from("const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000)'],{stdio:'ignore',windowsHide:true});child.once('spawn',()=>require('fs').writeFileSync(process.argv[1],String(child.pid)));child.once('error',error=>{throw error});setTimeout(()=>process.exit(0),60000)"),
            ready.clone().into_os_string(),
        ];
        let (_stdout, _stderr, _, handle) =
            spawn_with_hidden_console_in_job(&node, &args, Some(root.path()), &envs, &job).unwrap();
        let process = unsafe { OwnedHandle::from_raw_handle(handle) };
        let mut descendant = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let pid = loop {
                if let Ok(pid) = std::fs::read_to_string(&ready)
                    .and_then(|text| text.parse::<u32>().map_err(io::Error::other))
                {
                    break pid;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "Node descendant did not start"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            };
            let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE | PROCESS_TERMINATE, 0, pid) };
            assert!(
                !handle.is_null(),
                "retain Node descendant: {}",
                io::Error::last_os_error()
            );
            descendant = Some(unsafe { OwnedHandle::from_raw_handle(handle) });
            let handles = [
                process.as_raw_handle(),
                descendant.as_ref().unwrap().as_raw_handle(),
            ];
            for handle in handles {
                assert_eq!(unsafe { WaitForSingleObject(handle, 0) }, WAIT_TIMEOUT);
            }
            drop(job);
            for handle in handles {
                assert_eq!(
                    unsafe { WaitForSingleObject(handle, 5000) },
                    WAIT_OBJECT_0,
                    "dropping the job must terminate both Node generations"
                );
            }
        }));
        for handle in [Some(&process), descendant.as_ref()].into_iter().flatten() {
            if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } != WAIT_OBJECT_0 {
                terminate_and_wait(handle.as_raw_handle()).expect("clean up owned Node fixture");
            }
        }
        if let Err(error) = result {
            std::panic::resume_unwind(error);
        }
    }

    #[test]
    fn job_assignment_failure_terminates_and_reaps_suspended_node() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::Foundation::{DuplicateHandle, ERROR_ACCESS_DENIED};
        use windows_sys::Win32::System::SystemServices::JOB_OBJECT_QUERY;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, CREATE_NO_WINDOW};

        let node = find_node_on_path().expect("node.exe required for job tests");
        let root = tempfile::tempdir().unwrap();
        let envs = isolated_node_env(root.path());
        let job = ProcessJob::new().unwrap();
        let mut restricted = std::ptr::null_mut();
        assert_ne!(
            unsafe {
                DuplicateHandle(
                    GetCurrentProcess(),
                    job.handle.as_raw_handle(),
                    GetCurrentProcess(),
                    &mut restricted,
                    JOB_OBJECT_QUERY,
                    0,
                    0,
                )
            },
            0,
            "duplicate query-only job handle: {}",
            io::Error::last_os_error()
        );
        let restricted = ProcessJob {
            handle: unsafe { OwnedHandle::from_raw_handle(restricted) },
        };
        let mut child = std::process::Command::new(node)
            .args(["-e", "require('fs').writeFileSync('ran','unexpected');setTimeout(()=>process.exit(0),60000)"])
            .envs(envs)
            .current_dir(root.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let result = assign_and_resume(&restricted, child.as_raw_handle(), std::ptr::null_mut());
        let exited = unsafe { WaitForSingleObject(child.as_raw_handle(), 0) };
        if exited != WAIT_OBJECT_0 {
            child.kill().expect("clean up suspended Node fixture");
            assert_eq!(
                unsafe { WaitForSingleObject(child.as_raw_handle(), 5000) },
                WAIT_OBJECT_0
            );
        }
        assert_eq!(
            result.unwrap_err().raw_os_error(),
            Some(ERROR_ACCESS_DENIED as i32)
        );
        assert_eq!(
            exited, WAIT_OBJECT_0,
            "assignment failure must reap before returning"
        );
        assert_eq!(child.try_wait().unwrap().unwrap().code(), Some(1));
        assert!(
            !root.path().join("ran").exists(),
            "suspended Node must not run on assignment failure"
        );
    }

    #[test]
    fn job_probe_bounds_output_reaps_descendants_and_times_out() {
        let node = find_node_on_path().expect("node.exe required for probe tests");
        let root = tempfile::tempdir().unwrap();
        let envs = isolated_node_env(root.path());
        let job = ProcessJob::new().unwrap();
        let gate = Mutex::new(false);
        let vars = HashMap::from([("nOdE_OpTiOnS".into(), "--invalid-probe-option".into())]);
        let env = String::from_utf16_lossy(&build_env_block(&vars, &["NODE_OPTIONS"]));
        assert!(!env.to_ascii_lowercase().contains("node_options="));
        let env = String::from_utf16_lossy(&build_env_block(&vars, &[]));
        assert!(env.contains("--invalid-probe-option"));
        for timeout in [false, true] {
            let ready = root.path().join(if timeout {
                "timeout.pid"
            } else {
                "success.pid"
            });
            let script = format!(
                "Object.assign(process.env,{});const fs=require('fs');const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),60000)'],{{stdio:'inherit',windowsHide:true,env:{{...process.env,NODE_NO_WARNINGS:'1'}}}});child.once('error',error=>{{throw error}});child.once('spawn',()=>{{fs.writeFileSync({},String(child.pid));fs.writeSync(1,Buffer.alloc(131072,111));fs.writeSync(2,Buffer.alloc(131072,101));{}}});",
                serde_json::to_string(&envs).unwrap(),
                serde_json::to_string(&ready).unwrap(),
                if timeout { "setTimeout(()=>process.exit(0),60000)" } else { "process.exit(0)" },
            );
            let started = Instant::now();
            let result = probe_in_job(
                &node,
                &["--no-warnings".into(), "-e".into(), script.into()],
                &job,
                &gate,
                true,
            );
            let elapsed = started.elapsed();
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            assert_ne!(
                unsafe {
                    QueryInformationJobObject(
                        job.handle.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        &mut accounting as *mut _ as *mut core::ffi::c_void,
                        std::mem::size_of_val(&accounting) as u32,
                        std::ptr::null_mut(),
                    )
                },
                0,
                "query probe fixture job"
            );
            assert_eq!(
                accounting.ActiveProcesses, 0,
                "probe descendants must be reaped before returning"
            );
            assert!(
                std::fs::read_to_string(ready)
                    .unwrap()
                    .parse::<u32>()
                    .unwrap()
                    > 0
            );
            if timeout {
                assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
                assert!(elapsed >= Duration::from_secs(8));
            } else {
                let output = result.unwrap();
                assert!(output.status.success());
                assert_eq!(output.stdout, vec![b'o'; 64 * 1024]);
                assert_eq!(output.stderr, vec![b'e'; 64 * 1024]);
            }
            assert!(
                elapsed < Duration::from_secs(15),
                "probe must have a finite deadline: {elapsed:?}"
            );
        }
        let (_stdout, _stderr, _, handle) = spawn_with_hidden_console_in_job(
            &node,
            &["-e".into(), "process.exit(23)".into()],
            Some(root.path()),
            &envs,
            &job,
        )
        .expect("backend spawn must reuse the job after completed probes");
        let process = unsafe { OwnedHandle::from_raw_handle(handle) };
        let wait = unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) };
        if wait != WAIT_OBJECT_0 {
            terminate_and_wait(process.as_raw_handle()).expect("clean up backend fixture");
        }
        assert_eq!(wait, WAIT_OBJECT_0);
        let mut code = 0;
        assert_ne!(
            unsafe { GetExitCodeProcess(process.as_raw_handle(), &mut code) },
            0
        );
        assert_eq!(code, 23);
        *gate.lock().unwrap() = true;
        let error = probe_in_job(
            &node,
            &["-e".into(), "process.exit(0)".into()],
            &job,
            &gate,
            true,
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
    }

    fn isolated_node_env(root: &Path) -> HashMap<String, String> {
        let roaming = root.join("AppData/Roaming");
        let local = root.join("AppData/Local");
        std::fs::create_dir_all(&roaming).unwrap();
        std::fs::create_dir_all(&local).unwrap();
        HashMap::from([
            ("HOME".into(), root.to_string_lossy().into_owned()),
            ("USERPROFILE".into(), root.to_string_lossy().into_owned()),
            ("APPDATA".into(), roaming.to_string_lossy().into_owned()),
            ("LOCALAPPDATA".into(), local.to_string_lossy().into_owned()),
            ("DSH_E2E_HOME".into(), root.to_string_lossy().into_owned()),
            ("NODE_OPTIONS".into(), String::new()),
            ("NODE_PATH".into(), String::new()),
        ])
    }

    fn find_node_on_path() -> Option<std::path::PathBuf> {
        let path = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("node.exe");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }
}
