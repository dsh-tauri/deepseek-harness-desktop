//! 迁移用文件系统动作：树统计、递归复制、重复解析点重建。
//!
//! 全部以 `&Path` 为参数、不接触 `AppHandle`：仓库里没有 `tauri::test`，任何需要
//! `AppHandle` 的函数都无法单测，而迁移是「一次写错就丢数据」的逻辑，必须能在
//! 临时目录里被完整驱动（见本模块测试与 `mod.rs` 的用例）。

use rayon::prelude::*;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// 每复制多少个文件回报一次进度：约 900MB / 2.6 万文件的一次迁移，
/// 逐文件发事件会淹没 IPC。
const PROGRESS_EVERY_FILES: u64 = 256;

/// 目录树统计。`links` 单列：重复解析点不复制内容，因此不参与「文件数 + 字节数」
/// 校验，但必须让用户知道有多少条链接需要重建。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct TreeStats {
    pub files: u64,
    pub bytes: u64,
    pub links: u64,
}

impl TreeStats {
    /// 复制是否覆盖了源：文件数或字节数任一少于源即视为不完整。
    ///
    /// 只用「不少于」而不是「相等」：迁移期间用户可能有程序在往源目录写新文件，
    /// 目标比源多不算失败；目标比源少才是真丢数据。
    pub(super) fn covers(&self, source: &TreeStats) -> bool {
        self.files >= source.files && self.bytes >= source.bytes
    }
}

/// 是否为重复解析点（Windows 符号链接、目录联接、挂载点）。
///
/// 必须用 `symlink_metadata` + `FILE_ATTRIBUTE_REPARSE_POINT` 判定，不能只看
/// `FileType::is_symlink()`：目录联接在部分路径上并不报告为 symlink，跟随它递归
/// 会复制链接目标（pnpm store）的数据，递归删除时更会删掉链接目标里的真实数据
/// ——这正是 issue #848 的成因。
#[cfg(windows)]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    meta.file_type().is_symlink()
}

/// 运行时产物判定（文件名非 UTF-8 时不跳过，宁可多复制一个文件也不漏数据）。
fn is_skipped(name: &str) -> bool {
    crate::config::HARNESS_PID_MARKER_NAMES.contains(&name)
}

/// 递归统计目录树（跳过运行时产物，不跟随重复解析点）。
pub(super) fn scan_tree(root: &Path, stats: &mut TreeStats) -> Result<(), String> {
    let read_dir =
        fs::read_dir(root).map_err(|e| format!("DATA_DIR_SCAN_READ: {}: {e}", root.display()))?;
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("DATA_DIR_SCAN_ENTRY: {e}"))?;
        let name = entry.file_name();
        if name.to_str().map(is_skipped).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("DATA_DIR_SCAN_META: {}: {e}", path.display()))?;
        if is_reparse_point(&meta) {
            stats.links += 1;
        } else if meta.is_dir() {
            scan_tree(&path, stats)?;
        } else if meta.is_file() {
            stats.files += 1;
            stats.bytes += meta.len();
        }
    }
    Ok(())
}

/// 复制进度：并行分支共享的计数器 + 节流后的回调。
pub(super) struct CopyProgress<'a> {
    files: AtomicU64,
    bytes: AtomicU64,
    links: AtomicU64,
    on_tick: &'a (dyn Fn(u64, u64) + Send + Sync),
}

impl<'a> CopyProgress<'a> {
    pub(super) fn new(on_tick: &'a (dyn Fn(u64, u64) + Send + Sync)) -> Self {
        Self {
            files: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            links: AtomicU64::new(0),
            on_tick,
        }
    }

    /// 已复制的累计量（复制结束后即为目标树的实际内容量）。
    pub(super) fn stats(&self) -> TreeStats {
        TreeStats {
            files: self.files.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            links: self.links.load(Ordering::Relaxed),
        }
    }

    fn record_file(&self, bytes: u64) {
        let files = self.files.fetch_add(1, Ordering::Relaxed) + 1;
        let total = self.bytes.fetch_add(bytes, Ordering::Relaxed) + bytes;
        if files % PROGRESS_EVERY_FILES == 0 {
            (self.on_tick)(files, total);
        }
    }

    fn record_link(&self) {
        self.links.fetch_add(1, Ordering::Relaxed);
    }
}

/// 递归复制目录树到 `dst`（目标必须已存在或可创建，且不得是源的子孙）。
///
/// 顶层条目并行处理（同 `service::profile::copy_dir_tree`）：pnpm 档案下
/// `node_modules` 层级深、文件多，串行复制会让 900MB 的迁移明显变慢。
pub(super) fn copy_tree(src: &Path, dst: &Path, progress: &CopyProgress) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("DATA_DIR_COPY_MKDIR: {}: {e}", dst.display()))?;
    let read_dir =
        fs::read_dir(src).map_err(|e| format!("DATA_DIR_COPY_READ: {}: {e}", src.display()))?;
    let entries: Vec<fs::DirEntry> = read_dir
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("DATA_DIR_COPY_ENTRY: {e}"))?;
    entries.par_iter().try_for_each(|entry| -> Result<(), String> {
        let name = entry.file_name();
        if name.to_str().map(is_skipped).unwrap_or(false) {
            return Ok(());
        }
        let src_path = entry.path();
        let dst_path = dst.join(&name);
        let meta = fs::symlink_metadata(&src_path)
            .map_err(|e| format!("DATA_DIR_COPY_META: {}: {e}", src_path.display()))?;
        if is_reparse_point(&meta) {
            copy_link(&src_path, &dst_path);
            progress.record_link();
        } else if meta.is_dir() {
            copy_tree(&src_path, &dst_path, progress)?;
        } else if meta.is_file() {
            fs::copy(&src_path, &dst_path)
                .map_err(|e| format!("DATA_DIR_COPY_FILE: {}: {e}", src_path.display()))?;
            progress.record_file(meta.len());
        }
        Ok(())
    })
}

/// 重建一条重复解析点（best-effort）。
///
/// 不跟随链接：pnpm 的 `node_modules` 链接指向全局 store，跟随复制既会成倍放大
/// 数据量，也会让新旧目录共享同一份文件。重建失败（Windows 创建符号链接需要
/// 权限或开发者模式）只告警、不阻断迁移——链接可以由插件重装流程重建，
/// 而数据文件不能重来。
fn copy_link(src: &Path, dst: &Path) {
    let Ok(target) = fs::read_link(src) else {
        log::warn!("DATA_DIR_COPY_LINK_READ: {}", src.display());
        return;
    };
    #[cfg(unix)]
    let created = std::os::unix::fs::symlink(&target, dst);
    #[cfg(windows)]
    let created = std::os::windows::fs::symlink_dir(&target, dst)
        .or_else(|_| std::os::windows::fs::symlink_file(&target, dst));
    if let Err(error) = created {
        log::warn!("DATA_DIR_COPY_LINK_CREATE: {}: {error}", dst.display());
    }
}

/// 目录不存在或为空 → true。
///
/// 读不到目录时返回 false（当成非空）：回滚时据此决定「删掉空目录」还是「挪到
/// 一边」，宁可多留一份，也不冒删数据的风险。
pub(super) fn is_dir_empty(path: &Path) -> bool {
    if fs::symlink_metadata(path).is_err() {
        return true;
    }
    match fs::read_dir(path) {
        Ok(mut entries) => entries.next().is_none(),
        Err(_) => false,
    }
}

/// `<home>/sessions` 下递归匹配 `session-*` 的目录数（与恢复脚本同口径）。
///
/// 只枚举目录、不读文件，因此可以在状态查询里对每个候选备份调用。
pub(super) fn count_sessions(home: &Path) -> u64 {
    fn walk(dir: &Path, count: &mut u64) {
        let Ok(read_dir) = fs::read_dir(dir) else {
            return;
        };
        for entry in read_dir.flatten() {
            let Ok(meta) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if is_reparse_point(&meta) || !meta.is_dir() {
                continue;
            }
            if entry
                .file_name()
                .to_str()
                .map(|name| name.starts_with("session-"))
                .unwrap_or(false)
            {
                *count += 1;
            }
            walk(&entry.path(), count);
        }
    }
    let mut count = 0;
    walk(&home.join("sessions"), &mut count);
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-data-dir-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn scan_tree_counts_files_and_bytes_and_skips_runtime_marker() {
        let root = temp_dir("scan");
        write(&root.join("a.txt"), "12345");
        write(&root.join("nested/b.txt"), "123");
        write(&root.join(".harness.pid"), "99999999");
        write(&root.join(".harness-nightly.pid"), "99999999");

        let mut stats = TreeStats::default();
        scan_tree(&root, &mut stats).unwrap();

        assert_eq!(stats.files, 2);
        assert_eq!(stats.bytes, 8);
        assert_eq!(stats.links, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_tree_reproduces_content_and_reports_totals() {
        let root = temp_dir("copy");
        let src = root.join("src");
        let dst = root.join("dst");
        write(&src.join("a.txt"), "12345");
        write(&src.join("nested/b.txt"), "123");
        write(&src.join(".harness.pid"), "99999999");
        write(&src.join(".harness-nightly.pid"), "99999999");

        let tick = |_files: u64, _bytes: u64| {};
        let progress = CopyProgress::new(&tick);
        copy_tree(&src, &dst, &progress).unwrap();

        let stats = progress.stats();
        assert_eq!(stats.files, 2);
        assert_eq!(stats.bytes, 8);
        assert_eq!(fs::read_to_string(dst.join("nested/b.txt")).unwrap(), "123");
        // 运行时产物不随迁移走：目标目录里不该出现 PID 标记
        assert!(!dst.join(".harness.pid").exists());
        assert!(!dst.join(".harness-nightly.pid").exists());

        let mut verified = TreeStats::default();
        scan_tree(&dst, &mut verified).unwrap();
        assert!(verified.covers(&stats));
        let _ = fs::remove_dir_all(&root);
    }

    /// 目标目录已存在且有内容时也必须完成复制：调用方（迁移）负责先判定「目标必须
    /// 为空或不存在」，复制本身不做这个判断，避免两处规则不一致。
    #[test]
    fn copy_tree_into_existing_empty_directory_succeeds() {
        let root = temp_dir("copy-existing");
        let src = root.join("src");
        let dst = root.join("dst");
        write(&src.join("a.txt"), "1");
        fs::create_dir_all(&dst).unwrap();

        let tick = |_files: u64, _bytes: u64| {};
        let progress = CopyProgress::new(&tick);
        copy_tree(&src, &dst, &progress).unwrap();

        assert_eq!(fs::read_to_string(dst.join("a.txt")).unwrap(), "1");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn is_dir_empty_distinguishes_missing_empty_and_filled() {
        let root = temp_dir("empty");
        assert!(is_dir_empty(&root.join("missing")));
        assert!(is_dir_empty(&root));
        write(&root.join("a.txt"), "1");
        assert!(!is_dir_empty(&root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn count_sessions_matches_nested_session_directories() {
        let root = temp_dir("sessions");
        write(&root.join("sessions/--C-a--/session-1/x.jsonl"), "{}");
        write(&root.join("sessions/--C-a--/session-2/x.jsonl"), "{}");
        write(&root.join("sessions/--C-b--/not-a-session/x.jsonl"), "{}");
        write(&root.join("other/session-9/x.jsonl"), "{}");

        assert_eq!(count_sessions(&root), 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn covers_requires_target_not_smaller_than_source() {
        let source = TreeStats { files: 10, bytes: 100, links: 0 };
        assert!(TreeStats { files: 10, bytes: 100, links: 0 }.covers(&source));
        assert!(TreeStats { files: 11, bytes: 100, links: 0 }.covers(&source));
        assert!(!TreeStats { files: 10, bytes: 99, links: 0 }.covers(&source));
        assert!(!TreeStats { files: 9, bytes: 100, links: 0 }.covers(&source));
    }
}
