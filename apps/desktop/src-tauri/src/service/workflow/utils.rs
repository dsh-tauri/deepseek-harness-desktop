use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, mpsc};
use std::thread;
use std::time::Duration;

use crate::utils::decode_process_line;

const DSH_MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
pub(super) const DSH_MAX_BACKUPS: usize = 3;
static DSH_LOG_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
fn dsh_log_lock() -> &'static Mutex<()> {
    DSH_LOG_LOCK.get_or_init(|| Mutex::new(()))
}

pub async fn is_dsh_running(port: u16) -> bool {
    super::auth::launch_url(port).is_ok()
}

/// 有界等待端口回落为空闲；端口本来就空闲时立即返回。
///
/// 结束进程后端口释放有滞后，但实测是毫秒级，固定睡眠只会把这段滞后放大成白等。
pub fn wait_for_port_release(port: u16, budget: Duration) -> bool {
    let deadline = std::time::Instant::now() + budget;
    loop {
        if !is_port_in_use(port) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// 检查指定端口是否被占用。
///
/// 以实际绑定结果判断，能够识别“已绑定但尚未 listen”的占用状态。Windows 上
/// 具体地址与通配地址的绑定互不冲突（`0.0.0.0:3080` 与 `127.0.0.1:3080` 可
/// 同时绑定成功），只探一个地址会在另一种绑定下误判为空闲：harness 绑
/// `0.0.0.0`（局域网访问开关，issue #1021）时桌面端永远判定“未监听”，启动
/// 必然超时失败。两个地址都绑得上才算空闲。
pub fn is_port_in_use(port: u16) -> bool {
    [Ipv4Addr::LOCALHOST, Ipv4Addr::UNSPECIFIED]
        .iter()
        .any(|ip| TcpListener::bind(SocketAddr::new(IpAddr::V4(*ip), port)).is_err())
}

#[cfg(test)]
thread_local! {
    static OUTPUT_READER_FAILURE: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(super) fn with_output_reader_failure<T>(reader: usize, task: impl FnOnce() -> T) -> T {
    struct Reset(usize);
    impl Drop for Reset {
        fn drop(&mut self) {
            OUTPUT_READER_FAILURE.set(self.0);
        }
    }
    let _reset = Reset(OUTPUT_READER_FAILURE.replace(reader));
    task()
}

#[cfg(test)]
fn check_output_reader_spawn() -> io::Result<()> {
    if OUTPUT_READER_FAILURE.with(|failure| {
        let remaining = failure.get();
        failure.set(remaining.saturating_sub(1));
        remaining == 1
    }) {
        return Err(io::Error::other("injected output reader spawn failure"));
    }
    Ok(())
}

pub fn spawn_output_readers<R1, R2>(
    stdout: Option<R1>,
    stderr: Option<R2>,
    log_path: PathBuf,
) -> io::Result<mpsc::Receiver<bool>>
where
    R1: Read + Send + 'static,
    R2: Read + Send + 'static,
{
    if let Some(stdout) = stdout {
        let log_path = log_path.clone();
        let instance = super::instances::instance();
        let generation = instance
            .launch_url
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        let port = *instance
            .port
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        #[cfg(test)]
        check_output_reader_spawn()?;
        thread::Builder::new().spawn(move || {
            drain_subprocess_output(BufReader::new(stdout), log_path, log::Level::Info, |line| {
                if let Some((port, url)) = port
                    .and_then(|port| super::auth::launch_url_in(line, port).map(|url| (port, url)))
                {
                    let mut output = generation.lock().unwrap_or_else(|error| error.into_inner());
                    if output.is_none() {
                        *output = Some((port, url));
                    }
                }
            });
        })?;
    }

    let (signature, receiver) = mpsc::channel();
    if let Some(stderr) = stderr {
        #[cfg(test)]
        check_output_reader_spawn()?;
        thread::Builder::new().spawn(move || {
            let mut reported = false;
            drain_subprocess_output(BufReader::new(stderr), log_path, log::Level::Warn, |line| {
                if !reported && line.contains("duplicate loader entry") {
                    reported = true;
                    let _ = signature.send(true);
                }
            });
            let _ = signature.send(false);
        })?;
    }
    Ok(receiver)
}

/// 逐行读取子进程输出并写入日志。
///
/// 任何一行是非法 UTF-8 时**必须**继续读下去，不能中断：管道读端一旦被关闭，
/// dsh 主进程下一次写 stderr 就会收到 EPIPE，Node 以退出码 1 静默崩溃（插件
/// 子进程——python MCP 服务器等——在中文本地化 Windows 下按 ANSI 代码页输出
/// GBK 日志是常态），桌面端表现为 Harness 反复崩溃、WebView 永久卡在
/// "Loading plugins"。解码交给 [`decode_process_line`]：先严格 UTF-8，失败按
/// ANSI 代码页解，仍失败才以 U+FFFD 呈现。真正需要停手的只有 EOF 与管道自身的
/// I/O 错误。
fn drain_subprocess_output<R: Read + Send + 'static>(
    mut reader: BufReader<R>,
    log_path: PathBuf,
    level: log::Level,
    mut on_line: impl FnMut(&str),
) {
    loop {
        let mut bytes = Vec::new();
        match reader.read_until(b'\n', &mut bytes) {
            Ok(0) => break, // EOF
            Ok(_) => {
                // 去除行尾 \n / \r\n（与旧 lines() 行为一致）
                let bytes = bytes.strip_suffix(b"\n").unwrap_or(&bytes);
                let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
                let line = decode_process_line(bytes);
                on_line(&line);
                match level {
                    log::Level::Warn => log::warn!(target: "dsh", "{}", line),
                    _ => log::info!(target: "dsh", "{}", line),
                }
                append_log(&log_path, &line);
            }
            Err(e) => {
                log::error!("Failed to read dsh {}: {}", log_level_name(level), e);
                break;
            }
        }
    }
}

/// `log::Level` 的小写名称（内部日志用词与旧实现一致）。
fn log_level_name(level: log::Level) -> &'static str {
    match level {
        log::Level::Warn => "stderr",
        _ => "stdout",
    }
}

pub(super) fn append_log(log_path: &PathBuf, line: &str) {
    // 与 `logger` 的 `desktop.log` / `desktop.frontdesk.log` 保持一致：5MiB × 3 轮转
    let _guard = dsh_log_lock().lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(meta) = std::fs::metadata(log_path) {
        if meta
            .len()
            .saturating_add(line.len() as u64)
            .saturating_add(1)
            > DSH_MAX_LOG_BYTES
        {
            let _ = std::fs::remove_file(indexed_log_path(log_path, DSH_MAX_BACKUPS));
            for i in (1..DSH_MAX_BACKUPS).rev() {
                let from = indexed_log_path(log_path, i);
                let to = indexed_log_path(log_path, i + 1);
                if from.exists() {
                    let _ = std::fs::remove_file(&to);
                    let _ = std::fs::rename(&from, &to);
                }
            }
            if log_path.exists() {
                let _ = std::fs::rename(log_path, indexed_log_path(log_path, 1));
            }
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    {
        let _ = writeln!(file, "{}", line);
        let _ = file.flush();
    }
}

/// 轮转日志文件名：`dsh-web.log`（index 0）、`dsh-web.log.1`、`dsh-web.log.2`……
pub(super) fn indexed_log_path(log_path: &Path, index: usize) -> PathBuf {
    if index == 0 {
        return log_path.to_path_buf();
    }
    let mut name = log_path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}", index));
    log_path.with_file_name(name)
}

/// 每次启动服务前轮转日志，只保留最近 `keep` 次启动产生的日志文件。
///
/// 把当前 `dsh-web.log` 依次后退为 `.1`、`.2`……，超过保留上限的最老文件
/// 直接删除，再以空文件重新记录本次启动日志。这样磁盘上始终只保留最近
/// `keep` 次 dsh 启动的日志，避免单文件随多次启动无限增长。
pub fn rotate_service_log(log_path: &PathBuf, keep: usize) {
    if keep == 0 {
        let _ = std::fs::remove_file(log_path);
        return;
    }
    // 1) 删除超过保留上限的最老文件（它会被顶上来的文件覆盖且无处安放）
    let _ = std::fs::remove_file(indexed_log_path(log_path, keep - 1));
    // 2) 从次老到次新依次后移，为本次启动腾出位置
    for i in (1..keep).rev() {
        let from = indexed_log_path(log_path, i);
        let to = indexed_log_path(log_path, i + 1);
        if from.exists() {
            let _ = std::fs::remove_file(&to);
            let _ = std::fs::rename(&from, &to);
        }
    }
    // 3) 当前日志后移为 `.1`，重新开始本次记录
    if log_path.exists() {
        let _ = std::fs::rename(log_path, indexed_log_path(log_path, 1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(path: &PathBuf, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    /// 回归：非法 UTF-8 行（中文 Windows 下 python 插件输出 GBK 的典型形态）
    /// 绝不能让读取器中断——旧实现 break 会关闭管道读端，dsh 下次写 stderr
    /// 收到 EPIPE 以退出码 1 崩溃，表现为 Harness 崩溃循环 + WebView 卡在
    /// "Loading plugins"。
    #[test]
    fn drain_keeps_reading_after_invalid_utf8_lines() {
        let dir = std::env::temp_dir().join(format!("dsh_drain_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("out.log");

        // "因为测试" 的 GBK 编码（与系统 ANSI 代码页 936 输出一致）
        let mut data = b"first line\n".to_vec();
        data.extend_from_slice(b"\xd2\xf2\xce\xaa\xb2\xe2\xca\xd4\n");
        data.extend_from_slice(b"second line\n");

        drain_subprocess_output(
            std::io::BufReader::new(std::io::Cursor::new(data)),
            log.clone(),
            log::Level::Warn,
            |_| {},
        );

        let content = fs::read_to_string(&log).unwrap();
        assert!(
            content.contains("first line"),
            "first line must be logged, got: {content:?}"
        );
        assert!(
            content.contains("second line"),
            "reader must NOT stop at invalid UTF-8 (old code broke and closed the pipe); got: {content:?}"
        );
        // 非法 UTF-8 不再直接 lossy：Windows 先按 ANSI 代码页解码（zh-CN 的 936 还原
        // 中文，en-US 的 1252 也是可读字符），只有连 ANSI 都解不出时才回落 U+FFFD。
        // 逐字断言会绑死 runner 的代码页，故这里只断言「没走 lossy 快路」。
        #[cfg(windows)]
        assert!(
            !content.contains('\u{FFFD}'),
            "Windows 上非法 UTF-8 必须走 ANSI 代码页解码，got: {content:?}"
        );
        #[cfg(not(windows))]
        assert!(content.contains('\u{FFFD}'));
        let _ = fs::remove_dir_all(&dir);
    }

    /// `log::Level` 与日志名称的映射。
    #[test]
    fn log_level_name_maps_streams() {
        assert_eq!(log_level_name(log::Level::Warn), "stderr");
        assert_eq!(log_level_name(log::Level::Info), "stdout");
        assert_eq!(log_level_name(log::Level::Debug), "stdout");
    }

    /// 行尾处理与旧 `lines()` 行为一致：\n 与 \r\n 均被剥离。
    #[test]
    fn drain_strips_line_endings() {
        let dir = std::env::temp_dir().join(format!("dsh_drain_crlf_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = dir.join("out.log");

        drain_subprocess_output(
            std::io::BufReader::new(std::io::Cursor::new(b"a\r\nb\n".to_vec())),
            log.clone(),
            log::Level::Info,
            |_| {},
        );

        let content = fs::read_to_string(&log).unwrap();
        assert_eq!(content, "a\nb\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn output_readers_report_only_this_attempts_stderr_signature() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("dsh-web.log");
        let mut data = b"duplicate loader entry\n".to_vec();
        data.extend_from_slice(&vec![b'x'; 256 * 1024]);
        data.extend_from_slice(b"\nlast stderr line\n");
        let duplicate = spawn_output_readers(
            Some(std::io::Cursor::new(b"stdout ready\n".to_vec())),
            Some(std::io::Cursor::new(data)),
            log.clone(),
        )
        .unwrap();
        let timeout = Duration::from_secs(5);
        assert!(duplicate.recv_timeout(timeout).unwrap());
        assert!(!duplicate.recv_timeout(timeout).unwrap());
        let content = fs::read_to_string(&log).unwrap();
        assert!(content.contains("last stderr line\n"));

        let clean = spawn_output_readers(
            Some(std::io::Cursor::new(b"duplicate loader entry\n".to_vec())),
            Some(std::io::Cursor::new(b"unrelated error\n".to_vec())),
            log,
        )
        .unwrap();
        assert!(!clean.recv_timeout(timeout).unwrap());
    }

    #[test]
    fn append_keeps_the_new_line_in_current_log_when_size_limit_is_reached() {
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("dsh-web.log");
        let previous = vec![b'x'; 5 * 1024 * 1024];
        fs::write(&log, &previous).unwrap();
        let marker = "ERROR HARNESS_FATAL_REPORT: C:/logs/harness-fatal-42.json";

        append_log(&log, marker);

        assert_eq!(fs::read_to_string(&log).unwrap(), format!("{marker}\n"));
        assert_eq!(
            fs::read(root.path().join("dsh-web.log.1")).unwrap(),
            previous
        );
        append_log(&log, "next output");
        assert_eq!(
            fs::read_to_string(&log).unwrap(),
            format!("{marker}\nnext output\n")
        );
    }

    /// 模拟连续 5 次启动，验证磁盘上始终只保留最近 `keep` 份日志，
    /// 且每次启动都会新建当前日志文件。
    #[test]
    fn rotate_keeps_only_last_three_starts() {
        let dir = std::env::temp_dir().join(format!("dsh_rotate_test_{}", std::process::id()));
        let log = dir.join("dsh-web.log");
        let _ = fs::remove_dir_all(&dir);

        for i in 0..5 {
            // 每次启动前，当前日志写入上一批内容后轮转（与 sponsor 流程一致）
            write(&log, &format!("start {i} content\n"));
            rotate_service_log(&log, 3);
            // 轮转后当前文件应为空（尚未写入本次内容）
            assert_eq!(fs::read_to_string(&log).unwrap_or_default(), "");
            // 只允许保留 .0/.1/.2 三份
            assert!(!dir.join("dsh-web.log.3").exists());
            assert!(!dir.join("dsh-web.log.4").exists());
        }

        // 最后一次循环后：当前为空、.1 = start 4、.2 = start 3
        assert_eq!(fs::read_to_string(&log).unwrap_or_default(), "");
        assert!(
            fs::read_to_string(dir.join("dsh-web.log.1"))
                .unwrap()
                .contains("start 4")
        );
        assert!(
            fs::read_to_string(dir.join("dsh-web.log.2"))
                .unwrap()
                .contains("start 3")
        );
        assert!(!dir.join("dsh-web.log.3").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 被占用时等到预算耗尽才返回 false；端口回落为空闲后立即返回 true，
    /// 这正是「结束进程后不再固定睡 800ms」的依据。
    #[test]
    fn wait_for_port_release_bounds_the_wait_and_returns_as_soon_as_the_port_frees() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let started = std::time::Instant::now();
        assert!(!wait_for_port_release(port, Duration::from_millis(200)));
        assert!(
            started.elapsed() >= Duration::from_millis(200),
            "an occupied port must be waited on until the budget runs out"
        );
        drop(listener);
        let started = std::time::Instant::now();
        assert!(wait_for_port_release(port, Duration::from_millis(200)));
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "a released port must not be waited on"
        );
    }

    /// 回归（issue #1021）：Windows 上具体地址与通配地址的绑定互不冲突
    /// （`127.0.0.1:3080` 与 `0.0.0.0:3080` 可同时绑上），只探回环会把绑在
    /// `0.0.0.0` 的 harness 判成「端口空闲」，桌面端据此永远报未监听、
    /// 启动必然超时。两种绑定都必须被识别为占用，端口释放后则读作空闲。
    #[test]
    fn is_port_in_use_detects_wildcard_and_loopback_listeners() {
        for bind_addr in ["127.0.0.1:0", "0.0.0.0:0"] {
            let listener = TcpListener::bind(bind_addr).unwrap();
            let port = listener.local_addr().unwrap().port();
            assert!(
                is_port_in_use(port),
                "a listener on {bind_addr} must read as occupying port {port}"
            );
        }

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!is_port_in_use(port), "a released port must read as free");
    }

    /// keep=0 时把当前日志也删掉。
    #[test]
    fn rotate_with_keep_zero_removes_all() {
        let dir = std::env::temp_dir().join(format!("dsh_rotate_zero_{}", std::process::id()));
        let log = dir.join("dsh-web.log");
        let _ = fs::remove_dir_all(&dir);
        write(&log, "x");
        write(&dir.join("dsh-web.log.1"), "x");
        rotate_service_log(&log, 0);
        assert!(!log.exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
