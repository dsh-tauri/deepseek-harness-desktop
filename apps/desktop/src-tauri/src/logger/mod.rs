//! 统一日志底座 — `log` 外观代理 `tracing` 栈
//!
//! 目标：
//! - 后端：`log::*`（业务，`dsh` target 表示 Harness 输出）→ `tracing` 经 `tracing_log::LogTracer` → `tracing-subscriber` + `tracing-appender`（non-blocking）+ `EnvFilter`
//! - 格式：`[YYYY-MM-DD HH:MM:SS.mmmZ] LEVEL target: message`（例 `INFO dsh:` / `INFO frontend:`）
//! - 轮转：`desktop.log` + `desktop.frontdesk.log` 各 5MiB，保留 `.1 ~ .3`
//! - 降噪：`reqwest`/`hyper` 默认 `warn`，可通过 `RUST_LOG=reqwest=debug` 覆盖

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tracing_appender::non_blocking::{NonBlocking, WorkerGuard};
use tracing_subscriber::filter::filter_fn;
use tracing_subscriber::fmt::time::OffsetTime;
use tracing_subscriber::layer::{Layer, SubscriberExt};
use tracing_subscriber::{fmt, util::SubscriberInitExt, EnvFilter};

use crate::config::{APP_DATA_DEV_DIR_NAME, APP_IDENTIFIER};

const LOG_FILE_NAME: &str = "desktop.log";
const FRONTDESK_LOG_FILE_NAME: &str = "desktop.frontdesk.log";
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
const MAX_BACKUPS: usize = 3;

static FILE_GUARD: OnceLock<WorkerGuard> = OnceLock::new();
static FRONTDESK_WRITER: OnceLock<Arc<Mutex<SizeRotatingWriter>>> = OnceLock::new();

pub(crate) fn identifier_dir() -> Option<PathBuf> {
    match crate::config::e2e_app_data_dir() {
        Ok(Some(directory)) => return Some(directory),
        Err(_) => return None,
        Ok(None) => {}
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").ok()?;
        return Some(PathBuf::from(appdata).join(APP_IDENTIFIER));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").ok()?;
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(APP_IDENTIFIER),
        );
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var("XDG_DATA_HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var("HOME")
                    .ok()
                    .map(|h| PathBuf::from(h).join(".local/share"))
            })?;
        return Some(base.join(APP_IDENTIFIER));
    }
    #[allow(unreachable_code)]
    None
}

/// debug 构建在 `identifier` 目录下多一层 `dev/`，与 `config::get_base_dir` 同口径。
fn apply_dev_segment(base: PathBuf) -> PathBuf {
    if cfg!(debug_assertions) {
        base.join(APP_DATA_DEV_DIR_NAME)
    } else {
        base
    }
}

/// 本进程写日志用的应用数据目录。
///
/// dev 与 release 共用同一个 `identifier`（`dsh-tauri`），不隔离就会让两个本可同时
/// 运行的进程打开同一个 `desktop.log`：日志互相交错，5 MiB 轮转的归档 rename 还会
/// 彼此抢（一方 rename 完，另一方仍按旧长度 append）。核心安装目录、运行时与 Store
/// 都已按 `dev/` 隔离，日志必须同口径。
fn app_data_dir() -> Option<PathBuf> {
    identifier_dir().map(apply_dev_segment)
}

fn log_file_path() -> Option<PathBuf> {
    Some(app_data_dir()?.join("logs").join(LOG_FILE_NAME))
}

fn frontdesk_log_file_path() -> Option<PathBuf> {
    Some(app_data_dir()?.join("logs").join(FRONTDESK_LOG_FILE_NAME))
}

fn backup_path(base: &Path, n: usize) -> PathBuf {
    if n == 0 {
        base.to_path_buf()
    } else {
        PathBuf::from(format!("{}.{}", base.display(), n))
    }
}

struct SizeRotatingWriter {
    path: PathBuf,
    file: Mutex<Option<File>>,
    max_bytes: u64,
    max_backups: usize,
}

impl SizeRotatingWriter {
    fn new(path: PathBuf, max_bytes: u64, max_backups: usize) -> Self {
        Self {
            path,
            file: Mutex::new(None),
            max_bytes,
            max_backups,
        }
    }
    fn ensure_file(&self) -> io::Result<()> {
        let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        *guard = Some(f);
        Ok(())
    }
    fn rotate_if_needed(&self) {
        let len = {
            let guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .as_ref()
                .and_then(|f| f.metadata().ok())
                .map(|m| m.len())
                .unwrap_or(0)
        };
        if len <= self.max_bytes {
            return;
        }
        {
            let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
            *guard = None;
        }
        let _ = std::fs::remove_file(backup_path(&self.path, self.max_backups));
        for i in (1..=self.max_backups).rev() {
            let src = backup_path(&self.path, i - 1);
            let dst = backup_path(&self.path, i);
            if src.exists() {
                let _ = std::fs::rename(&src, &dst);
            }
        }
    }

    /// 供 `log_frontend` 以 `&self` 追加写入（带轮转），避免 `&mut` 约束
    fn append_bytes(&self, buf: &[u8]) -> io::Result<()> {
        let _ = self.ensure_file();
        {
            let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(f) = guard.as_mut() {
                f.write_all(buf)?;
                let _ = f.flush();
            } else {
                return Ok(());
            }
        }
        self.rotate_if_needed();
        Ok(())
    }

    fn write_and_rotate(&self, buf: &[u8]) -> io::Result<usize> {
        let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = guard.as_mut() {
            let n = f.write(buf)?;
            let _ = f.flush();
            drop(guard);
            self.rotate_if_needed();
            Ok(n)
        } else {
            Ok(buf.len())
        }
    }
    fn flush_file(&self) -> io::Result<()> {
        let mut guard = self.file.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(f) = guard.as_mut() {
            f.flush()
        } else {
            Ok(())
        }
    }
}

impl Write for SizeRotatingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let _ = self.ensure_file();
        self.write_and_rotate(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.flush_file()
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SizeRotatingWriter {
    type Writer = SizeRotatingWriterGuard<'a>;
    fn make_writer(&'a self) -> Self::Writer {
        let _ = self.ensure_file();
        SizeRotatingWriterGuard { parent: self }
    }
}

struct SizeRotatingWriterGuard<'a> {
    parent: &'a SizeRotatingWriter,
}

impl<'a> Write for SizeRotatingWriterGuard<'a> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.parent.write_and_rotate(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.parent.flush_file()
    }
}

fn build_env_filter() -> EnvFilter {
    let raw = std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string());
    let mut filter_str = raw.clone();
    if !filter_str.contains("reqwest") {
        filter_str.push_str(",reqwest=warn");
    }
    if !filter_str.contains("hyper") {
        filter_str.push_str(",hyper=warn");
    }
    EnvFilter::try_new(filter_str).unwrap_or_else(|_| EnvFilter::new("info"))
}

pub fn init() {
    let _ = tracing_log::LogTracer::init();
    let filter = build_env_filter();
    let file_writer: Option<(NonBlocking, WorkerGuard)> = log_file_path().map(|path| {
        let rotating = SizeRotatingWriter::new(path, MAX_LOG_BYTES, MAX_BACKUPS);
        tracing_appender::non_blocking(rotating)
    });
    // 前端独立文件：desktop.frontdesk.log（与 dsh 的 `target: "dsh"` 标识对称，`target: "frontend"`）
    if let Some(path) = frontdesk_log_file_path() {
        let w = Arc::new(Mutex::new(SizeRotatingWriter::new(
            path,
            MAX_LOG_BYTES,
            MAX_BACKUPS,
        )));
        let _ = FRONTDESK_WRITER.set(w);
    }
    let timer = OffsetTime::new(
        time::UtcOffset::UTC,
        time::format_description::parse_borrowed::<2>(
            "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]Z",
        )
        .unwrap(),
    );
    let stdout_layer = fmt::layer()
        .with_writer(std::io::stdout)
        .with_timer(timer.clone())
        .with_target(true)
        .with_ansi(true)
        .with_level(true);
    if let Some((nb, guard)) = file_writer {
        let _ = FILE_GUARD.set(guard);
        // 文件层对前端 `target: "frontend"` 直接跳过：前端 `console.*` 只进
        // `desktop.frontdesk.log`（log_frontend 直写），不混入后端 `desktop.log`，
        // 避免前端日志及其多行堆栈把后端日志挤没（复制运行日志时更清晰）。
        let file_layer = fmt::layer()
            .with_writer(nb)
            .with_timer(timer)
            .with_target(true)
            .with_ansi(false)
            .with_level(true)
            .with_filter(filter_fn(|meta| meta.target() != "frontend"));
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(stdout_layer)
            .with(file_layer)
            .try_init();
    } else {
        let _ = tracing_subscriber::registry()
            .with(filter)
            .with(stdout_layer)
            .try_init();
    }
}

#[derive(Debug, Clone, Copy)]
pub enum FrontendLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl FrontendLevel {
    pub fn from_str(s: &str) -> Self {
        match s.to_ascii_lowercase().as_str() {
            "trace" => Self::Trace,
            "debug" => Self::Debug,
            "info" => Self::Info,
            "warn" => Self::Warn,
            "error" => Self::Error,
            _ => Self::Info,
        }
    }
}

pub fn log_frontend(level: FrontendLevel, target: &str, message: &str) {
    // 前端日志独立落盘到 `desktop.frontdesk.log`，与后端 `desktop.log`（含 `dsh` target）分离；
    // 文件层已跳过 `frontend` target（见 init），此处经 `log` 代理仅为 `pnpm tauri dev` 终端可见
    // 标识与 `dsh` 对称：`frontend` 作为 target 出现在 LEVEL 之后（`... INFO frontend: [tag] message`）
    // 当 JS 劫持以 `target: "frontend"` 透传时，避免 `frontend: [frontend]` 重复，退化为 `frontend: message`
    let is_generic_frontend = target == "frontend";
    let prefixed = if is_generic_frontend {
        message.to_string()
    } else {
        format!("[{}] {}", target, message)
    };
    // 1) 终端 stdout（tracing 层，带 ANSI、受 RUST_LOG 过滤）
    match level {
        FrontendLevel::Trace => log::trace!(target: "frontend", "{}", prefixed),
        FrontendLevel::Debug => log::debug!(target: "frontend", "{}", prefixed),
        FrontendLevel::Info => log::info!(target: "frontend", "{}", prefixed),
        FrontendLevel::Warn => log::warn!(target: "frontend", "{}", prefixed),
        FrontendLevel::Error => log::error!(target: "frontend", "{}", prefixed),
    }
    // 2) 独立文件 desktop.frontdesk.log（自格式化，避免再经 EnvFilter 过滤丢失）
    let level_str = match level {
        FrontendLevel::Trace => "TRACE",
        FrontendLevel::Debug => "DEBUG",
        FrontendLevel::Info => "INFO",
        FrontendLevel::Warn => "WARN",
        FrontendLevel::Error => "ERROR",
    };
    let formatted = {
        let now = time::OffsetDateTime::now_utc();
        let fmt = time::format_description::parse_borrowed::<2>(
            "[year]-[month]-[day] [hour]:[minute]:[second].[subsecond digits:3]Z",
        )
        .unwrap();
        let ts = now
            .format(&fmt)
            .unwrap_or_else(|_| "1970-01-01 00:00:00.000Z".to_string());
        if is_generic_frontend {
            format!("[{}] {:>5} frontend: {}\n", ts, level_str, message)
        } else {
            format!(
                "[{}] {:>5} frontend: [{}] {}\n",
                ts, level_str, target, message
            )
        }
    };
    let bytes = formatted.as_bytes();
    if let Some(w) = FRONTDESK_WRITER.get()
        && let Ok(g) = w.lock()
    {
        let _ = g.append_bytes(bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::fmt::MakeWriter;

    struct TempLogDir(PathBuf);

    impl TempLogDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "dsh-logger-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempLogDir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn rotating_writer_keeps_exact_limit_and_reopens_after_overflow() {
        for append in [false, true] {
            let dir = TempLogDir::new();
            let path = dir.0.join("desktop.log");
            std::fs::write(&path, b"ab").unwrap();
            let mut writer = SizeRotatingWriter::new(path.clone(), 4, 3);
            if append {
                writer.append_bytes(b"cd").unwrap();
            } else {
                writer.write_all(b"cd").unwrap();
            }
            assert_eq!(std::fs::read(&path).unwrap(), b"abcd");
            assert!(!backup_path(&path, 1).exists());
            if append {
                writer.append_bytes(b"e").unwrap();
            } else {
                assert_eq!(writer.write(b"e").unwrap(), 1);
            }
            assert!(!path.exists());
            assert_eq!(std::fs::read(backup_path(&path, 1)).unwrap(), b"abcde");
            if append {
                writer.append_bytes(b"new").unwrap();
            } else {
                writer.write_all(b"new").unwrap();
                writer.flush().unwrap();
            }
            assert_eq!(std::fs::read(&path).unwrap(), b"new");
            assert_eq!(std::fs::read(backup_path(&path, 1)).unwrap(), b"abcde");
        }
    }

    #[test]
    fn rotating_writer_retains_only_three_newest_backups() {
        let dir = TempLogDir::new();
        let path = dir.0.join("desktop.log");
        let writer = SizeRotatingWriter::new(path.clone(), 1, 3);
        for bytes in [b"aa", b"bb", b"cc", b"dd"] {
            writer.append_bytes(bytes).unwrap();
        }
        assert!(!path.exists());
        assert_eq!(std::fs::read(backup_path(&path, 1)).unwrap(), b"dd");
        assert_eq!(std::fs::read(backup_path(&path, 2)).unwrap(), b"cc");
        assert_eq!(std::fs::read(backup_path(&path, 3)).unwrap(), b"bb");
        assert!(!backup_path(&path, 4).exists());
    }

    #[test]
    fn rotating_writer_guard_reopens_only_when_new_guard_is_created() {
        let dir = TempLogDir::new();
        let path = dir.0.join("desktop.log");
        let writer = SizeRotatingWriter::new(path.clone(), 1, 3);
        let mut guard = writer.make_writer();
        assert_eq!(guard.write(b"ab").unwrap(), 2);
        assert_eq!(guard.write(b"ignored").unwrap(), 7);
        guard.flush().unwrap();
        assert!(!path.exists());
        assert_eq!(std::fs::read(backup_path(&path, 1)).unwrap(), b"ab");
        let mut next_guard = writer.make_writer();
        assert_eq!(next_guard.write(b"c").unwrap(), 1);
        next_guard.flush().unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"c");
    }

    #[test]
    fn rotating_writer_silently_drops_failed_opens_and_retries_next_write() {
        let dir = TempLogDir::new();
        let blocker = dir.0.join("blocked");
        std::fs::write(&blocker, b"file").unwrap();
        let path = blocker.join("desktop.log");
        let mut writer = SizeRotatingWriter::new(path.clone(), 4, 3);
        assert!(writer.ensure_file().is_err());
        writer.append_bytes(b"lost").unwrap();
        assert_eq!(writer.write(b"lost").unwrap(), 4);
        writer.flush().unwrap();
        {
            let mut guard = writer.make_writer();
            assert_eq!(guard.write(b"lost").unwrap(), 4);
            guard.flush().unwrap();
        }
        std::fs::remove_file(&blocker).unwrap();
        writer.write_all(b"ok").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"ok");
    }

    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn debug_logs_are_separated_from_release() {
        // dev 与 release 共用 identifier；不隔离会让两个进程写同一个 desktop.log。
        assert!(cfg!(debug_assertions), "cargo test 构建为 debug");
        let base = PathBuf::from("/tmp/dsh-tauri");
        assert_eq!(
            apply_dev_segment(base.clone()),
            base.join(APP_DATA_DEV_DIR_NAME)
        );
    }
    #[test]
    fn backup_path_naming() {
        let base = PathBuf::from("/tmp/desktop.log");
        assert_eq!(backup_path(&base, 0), PathBuf::from("/tmp/desktop.log"));
        assert_eq!(backup_path(&base, 1), PathBuf::from("/tmp/desktop.log.1"));
        assert_eq!(backup_path(&base, 3), PathBuf::from("/tmp/desktop.log.3"));
    }
    #[test]
    fn env_filter_defaults_no_panic() {
        let _ = build_env_filter();
    }
    #[test]
    fn frontend_level_parse() {
        assert!(matches!(
            FrontendLevel::from_str("warn"),
            FrontendLevel::Warn
        ));
        assert!(matches!(
            FrontendLevel::from_str("WARN"),
            FrontendLevel::Warn
        ));
        assert!(matches!(
            FrontendLevel::from_str("unknown"),
            FrontendLevel::Info
        ));
    }
}
