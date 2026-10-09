//! Harness 数据目录（`DSH_HOME`）的查看、迁移与回滚（issue #871）。
//!
//! 官方 dsh 用用户级环境变量 `DSH_HOME` 决定数据目录，桌面端只是跟随它；因此
//! 迁移 = 复制数据 + 改写用户级 `DSH_HOME` + 旧目录改名保底，全程不使用目录联接
//! （issue #848：联接被递归删除会删掉目标里的真实数据）。
//!
//! 硬约束（每一条都对应一次真实事故或恢复脚本踩过的坑）：
//! - 迁移前必须确认 Harness 完全退出：改目录时仍有进程在写，复制出来的是一份
//!   撕裂的数据；
//! - 复制后按「文件数 + 总字节数」校验，目标少于源即中止且不动源目录；
//! - 旧目录只改名（`<原目录>.moved-<时间戳>`），永不删除；
//! - 回滚按「会话数优先、时间戳其次」挑备份，并在目标非空时先把它挪到
//!   `<目标>.current-<时间戳>`。
//!
//! 模块划分（参考 `service/backup/`）：
//! - [`env`]：环境变量、默认目录、时间戳、磁盘空间
//! - [`fs_ops`]：树统计、递归复制、备份发现所需的纯文件系统动作
//! - [`state`]：上次迁移记录与 `.moved-*` 命名规则
//! - [`migrate`]：迁移/回滚的编排（校验、复制、改名、改写环境变量）

use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter as _};

mod env;
mod fs_ops;
mod migrate;
mod state;
#[cfg(unix)]
mod unix_env;

/// 应用启动时把持久化的 `DSH_HOME` 注入本进程（Unix 的实现见 [`unix_env`]；
/// Windows 走注册表，进程启动时已经拿到值，这里是空操作）。
///
/// 必须在任何 `config::get_dsh_data_path` 调用之前执行：macOS / Linux 上由
/// launchd 或显示管理器启动的 GUI 应用拿不到登录 shell 的环境变量，迁移过的
/// 数据目录只能靠这一步回到进程里，否则会「迁移成功但重启后又读旧目录」。
pub fn restore_process_env() {
    #[cfg(unix)]
    unix_env::restore_process_env();
}

/// 迁移进度事件（前端进度条订阅；与 `install-progress` 同款「后端推、前端渲染」）。
pub const PROGRESS_EVENT: &str = "data-dir://progress";

/// 数据目录状态（`supported` 为 false 时前端只展示说明、不展示任何动作）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirStatus {
    pub supported: bool,
    /// 当前生效的数据目录
    pub data_dir: String,
    /// 未设置 `DSH_HOME` 时使用的默认目录（回滚目标可能是它）
    pub default_dir: String,
    /// 用户级 `DSH_HOME`（未设置时为空字符串）
    pub env_override: String,
    /// 最近一次迁移是否仍可回滚（旧目录还在）
    pub rollback_available: bool,
    /// 已发现的旧目录备份，按「会话数优先、时间戳其次」排序
    pub backups: Vec<MigrationBackup>,
    /// debug 构建忽略 `DSH_HOME`，面板据此解释「为什么这里改不了」
    pub debug_build: bool,
}

/// 一个可回滚的旧目录备份。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBackup {
    pub path: String,
    pub stamp: String,
    /// 其中的会话数（备份价值的主要指标，`sessions` 为 0 时面板要给出警告）
    pub sessions: u64,
}

/// 数据目录下的一个顶层条目，附占用空间（面板用来展示「要搬走的是什么」）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataDirEntry {
    pub name: String,
    pub path: String,
    pub files: u64,
    pub bytes: u64,
}

/// 迁移预检结果（磁盘空间、目标来源、需要重建的链接数）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub source: String,
    pub target: String,
    pub total_files: u64,
    pub total_bytes: u64,
    pub links: u64,
    pub target_free_bytes: u64,
    pub enough_space: bool,
    /// 目标所在目录已存在（父目录已建好，创建可能失败）
    pub parent_exists: bool,
    /// 目标取自用户在上次迁移中记录过的位置（提示「回到旧位置」）
    pub remembered: bool,
}

/// 迁移/回滚结果。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOutcome {
    pub source: String,
    pub target: String,
    /// 旧位置：迁移时是改名后的备份目录，回滚时是「被挪到一边的当前目录」
    pub moved_to: String,
    pub files: u64,
    pub bytes: u64,
    pub links: u64,
    pub sessions: u64,
}

/// 进度回调：迁移在阻塞线程里跑，回调必须能跨线程共享（`CopyProgress` 会在
/// rayon 工作线程上触发它）。
pub(super) type ProgressSink<'a> = &'a (dyn Fn(ProgressPayload) + Send + Sync);

/// 进度事件载荷（camelCase 与前端字段一致）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    /// `migrate` / `rollback`
    pub operation: &'static str,
    /// `scan` / `copy` / `verify` / `finalize` / `done`
    pub phase: &'static str,
    pub copied_files: u64,
    pub copied_bytes: u64,
    pub total_files: u64,
    pub total_bytes: u64,
}

/// 当前数据目录状态。
///
/// 永不返回错误：面板要在任何情况下都能显示「数据目录在哪、能不能改」，
/// 单个探测失败（读不到注册表、目录不存在）只让对应字段退化为默认值。
pub fn status(app_handle: &AppHandle) -> DataDirStatus {
    let data_dir = crate::config::get_dsh_data_path(app_handle);
    let default_dir = env::default_home();
    let env_override = env::read_user_home().ok().flatten().unwrap_or_default();
    let backups: Vec<MigrationBackup> =
        migrate::find_backups(app_handle, &data_dir).into_iter().collect();
    let rollback_available = !backups.is_empty();
    DataDirStatus {
        supported: !cfg!(debug_assertions),
        data_dir: data_dir.to_string_lossy().into_owned(),
        default_dir: default_dir.to_string_lossy().into_owned(),
        env_override,
        rollback_available,
        backups,
        debug_build: cfg!(debug_assertions),
    }
}

/// 当前数据目录下的顶层条目，按占用字节数降序。
///
/// 与恢复脚本一致：迁移是整目录搬家，用户只需要知道「这一堆档案一共多大」，
/// 不需要逐个勾选，因此这里只用于展示与体积汇总。
pub fn entries(app_handle: &AppHandle) -> Result<Vec<DataDirEntry>, String> {
    entries_in(&crate::config::get_dsh_data_path(app_handle))
}

/// [`entries`] 的纯目录版本（不依赖 `AppHandle`，因此可单测）。
///
/// 目录不存在时返回空列表而不是错误：迁移刚把旧目录改名搬走、Harness 还没来得及
/// 重建它，或者安装器把 `DSH_HOME` 指向一个尚未创建的目录时，面板该显示空态
/// （`data_dir.entries_empty_desc` 就是为这一刻写的），而不是一片红色报错。
fn entries_in(root: &Path) -> Result<Vec<DataDirEntry>, String> {
    let read_dir = match std::fs::read_dir(root) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("DATA_DIR_READ: {}: {error}", root.display())),
    };
    let mut candidates: Vec<DataDirEntry> = Vec::new();
    for entry in read_dir {
        let Ok(entry) = entry else { continue };
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let mut stats = fs_ops::TreeStats::default();
        fs_ops::scan_tree(&entry.path(), &mut stats)?;
        candidates.push(DataDirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            files: stats.files,
            bytes: stats.bytes,
        });
    }
    candidates.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
    Ok(candidates)
}

/// 迁移预检：目标合法性、磁盘空间、来源（是否用户上次用过的位置）。
///
/// 预检与真正迁移共用 `migrate::plan`，避免「预检说没问题、执行时才拒绝」的错位。
pub fn preview(
    app_handle: &AppHandle,
    parent: &Path,
    leaf: &str,
) -> Result<MigrationPlan, String> {
    let source = crate::config::get_dsh_data_path(app_handle);
    let target = join_leaf(parent, leaf)?;
    migrate::plan(app_handle, &source, &target)
}

/// 把数据目录迁到 `<parent>\<leaf>`。
///
/// 调用方（`bridge::data_dir`）必须已经取得核心切换锁、停止 Harness 并持有
/// 插件操作锁：迁移会改写 `DSH_HOME`，此刻任何仍在运行的 Harness 都会把数据
/// 写回旧目录，导致两边各有一半。
pub async fn migrate(
    app_handle: AppHandle,
    parent: PathBuf,
    leaf: String,
) -> Result<MigrationOutcome, String> {
    let source = crate::config::get_dsh_data_path(&app_handle);
    let target = join_leaf(&parent, &leaf)?;
    migrate::plan(&app_handle, &source, &target)?;
    let handle = app_handle.clone();
    let emit = move |payload: ProgressPayload| {
        let _ = handle.emit(PROGRESS_EVENT, payload);
    };
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || migrate::run(&app, &source, &target, &emit))
        .await
        .map_err(|e| format!("DATA_DIR_TASK: {e}"))?
}

/// 回滚到最近的（或指定的）旧目录备份。
///
/// `backup` 为 `None` 时按「会话数优先、时间戳其次」自动挑选；选择规则与恢复
/// 脚本一致，两边挑中的必须是同一个目录。
pub async fn rollback(
    app_handle: AppHandle,
    backup: Option<PathBuf>,
) -> Result<MigrationOutcome, String> {
    let current = crate::config::get_dsh_data_path(&app_handle);
    let handle = app_handle.clone();
    let emit = move |payload: ProgressPayload| {
        let _ = handle.emit(PROGRESS_EVENT, payload);
    };
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        migrate::rollback(&app, &current, backup.as_deref(), &emit)
    })
    .await
    .map_err(|e| format!("DATA_DIR_TASK: {e}"))?
}

/// Harness 标记的读取结果（两行：PID、端口）。
///
/// 「文件不在」与「文件在但读不出来 / 解析不出来」必须分开：前者是正常的
/// 「从未启动过、或上次已正常清理」，后者说明有人正动这个文件（占用、权限、写到
/// 一半）。区别在于 `workflow::process::stop()` 无论哪种情况都会把标记删掉，于是
/// 「标记没了」会被误读成「Harness 已退出」——只有把 Invalid 单独标出来，调用方
/// 才有机会在删标记之前拒绝这次迁移。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HarnessMarker {
    /// 文件不在：从未启动过、或上次已正常清理。
    Missing,
    /// 文件在，但读不出来或第一行不是 PID。
    Invalid,
    /// 标记里记录的 PID。
    Pid(u32),
}

pub(crate) fn harness_markers(root: &Path) -> [HarnessMarker; 2] {
    crate::config::HARNESS_PID_MARKER_NAMES.map(|name| harness_marker_at(&root.join(name)))
}

/// 无 `AppHandle` 版本：路径由调用方给出，便于用临时目录直接测三种分类。
fn harness_marker_at(marker: &Path) -> HarnessMarker {
    let text = match std::fs::read_to_string(marker) {
        Ok(text) => text,
        Err(error) if error.kind() == ErrorKind::NotFound => return HarnessMarker::Missing,
        Err(error) => {
            log::warn!("DATA_DIR_HARNESS_MARKER: {error}");
            return HarnessMarker::Invalid;
        }
    };
    let Some(pid) = text
        .lines()
        .next()
        .and_then(|line| line.trim().parse::<u32>().ok())
    else {
        log::warn!("DATA_DIR_HARNESS_MARKER: 无法解析 {}", marker.display());
        return HarnessMarker::Invalid;
    };
    HarnessMarker::Pid(pid)
}

// 两个通道共享 DSH_HOME；任一仍在运行或标记不可读都不能迁移。
pub(super) fn harness_stopped(root: &Path) -> bool {
    harness_markers(root)
        .into_iter()
        .all(|marker| match marker {
            HarnessMarker::Missing => true,
            HarnessMarker::Invalid => false,
            HarnessMarker::Pid(pid) => !process_alive(pid),
        })
}

/// 进程是否存活（只查该 PID，不刷新整张进程表）。
pub(crate) fn process_alive(pid: u32) -> bool {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

    let mut system = System::new();
    let target = [Pid::from_u32(pid)];
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&target),
        true,
        ProcessRefreshKind::nothing(),
    );
    system.process(Pid::from_u32(pid)).is_some()
}

/// 把用户选的「名称」拼到「上级目录」上。
///
/// 拒绝含路径分隔符的名字：`Path::join` 遇到绝对路径会整段替换，放任一个
/// `D:\evil` 之类的名字进来就能把数据目录建到用户没选的地方。
fn join_leaf(parent: &Path, leaf: &str) -> Result<PathBuf, String> {
    let trimmed = leaf.trim();
    if trimmed.is_empty() {
        return Err(format!("DATA_DIR_NAME_INVALID: {leaf}"));
    }
    let allowed = trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'));
    if !allowed {
        return Err(format!("DATA_DIR_NAME_INVALID: {leaf}"));
    }
    if parent.as_os_str().is_empty() {
        return Err(format!("DATA_DIR_PARENT_MISSING: {leaf}"));
    }
    Ok(parent.join(trimmed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_leaf_accepts_plain_names_only() {
        let parent = Path::new("D:\\");
        assert_eq!(join_leaf(parent, "DSHHome").unwrap(), parent.join("DSHHome"));
        assert_eq!(
            join_leaf(parent, " DSH Home ").unwrap(),
            parent.join("DSH Home")
        );
        // 绝对路径会被 Path::join 整段替换，必须拒绝
        assert!(join_leaf(parent, "D:\\evil").is_err());
        assert!(join_leaf(parent, "a/b").is_err());
        assert!(join_leaf(parent, "a\\b").is_err());
        assert!(join_leaf(parent, "   ").is_err());
        assert!(join_leaf(Path::new(""), "DSHHome").is_err());
    }

    #[test]
    fn process_alive_reports_the_current_process() {
        assert!(process_alive(std::process::id()));
    }

    /// 「文件不在」与「文件在但读不出来 / 解析不出来」必须分开：`stop()` 两种
    /// 情况都会删标记，只有 Invalid 能让调用方在删之前拒绝迁移。
    #[test]
    fn harness_marker_tells_missing_from_unreadable() {
        let root = temp_dir("marker");
        let marker = root.join(".harness.pid");
        assert_eq!(harness_marker_at(&marker), HarnessMarker::Missing);

        // 两行（PID、端口）：只取第一行
        std::fs::write(&marker, "4242\n3080\n").unwrap();
        assert_eq!(harness_marker_at(&marker), HarnessMarker::Pid(4242));

        std::fs::write(&marker, "not-a-pid\n3080\n").unwrap();
        assert_eq!(harness_marker_at(&marker), HarnessMarker::Invalid);
        std::fs::write(&marker, "").unwrap();
        assert_eq!(harness_marker_at(&marker), HarnessMarker::Invalid);

        // 同名目录：`read_to_string` 报的不是 NotFound，属于「有人占着这个名字」
        std::fs::remove_file(&marker).unwrap();
        std::fs::create_dir(&marker).unwrap();
        assert_eq!(harness_marker_at(&marker), HarnessMarker::Invalid);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migration_requires_both_channels_to_be_stopped() {
        let root = temp_dir("channels");
        assert_eq!(harness_markers(&root), [HarnessMarker::Missing; 2]);
        assert!(harness_stopped(&root));
        for (index, name) in [".harness.pid", ".harness-nightly.pid"]
            .into_iter()
            .enumerate()
        {
            let path = root.join(name);
            std::fs::write(&path, format!("{}\n3080\n", std::process::id())).unwrap();
            let mut expected = [HarnessMarker::Missing; 2];
            expected[index] = HarnessMarker::Pid(std::process::id());
            assert_eq!(harness_markers(&root), expected);
            assert!(!harness_stopped(&root));
            std::fs::write(&path, "broken\n").unwrap();
            assert!(!harness_stopped(&root));
            std::fs::write(&path, format!("{}\n3080\n", u32::MAX)).unwrap();
            assert!(harness_stopped(&root));
            std::fs::remove_file(path).unwrap();
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    /// 迁移刚把旧目录改名搬走、Harness 还没重建它时，目录会短暂不存在。
    #[test]
    fn entries_treat_a_missing_directory_as_empty() {
        let root = temp_dir("entries-missing");
        let _ = std::fs::remove_dir_all(&root);
        assert!(entries_in(&root).unwrap().is_empty());
        // 真正的读取错误仍要报出来，别把权限问题也当成空目录
        let file = root.with_extension("txt");
        std::fs::write(&file, "not a directory").unwrap();
        assert!(entries_in(&file).unwrap_err().starts_with("DATA_DIR_READ: "));
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn entries_lists_directories_largest_first() {
        let root = temp_dir("entries-order");
        write(&root.join("small").join("one.bin"), "abc");
        write(&root.join("big").join("one.bin"), "abcdef");
        write(&root.join("big").join("two.bin"), "abcdef");
        // 顶层文件不算「子项占用」，不参与统计
        write(&root.join("loose.txt"), "x");

        let listed = entries_in(&root).unwrap();
        let names: Vec<&str> = listed.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["big", "small"]);
        assert_eq!((listed[0].files, listed[0].bytes), (2, 12));
        assert_eq!((listed[1].files, listed[1].bytes), (1, 3));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 临时目录自建：dev-dependencies 里没有 `tempfile`（与 `fs_ops` 同款写法）。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-data-dir-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, text).unwrap();
    }
}
