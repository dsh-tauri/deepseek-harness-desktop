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

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter as _};

mod env;
mod fs_ops;
mod migrate;
mod state;

/// 迁移进度事件（前端进度条订阅；与 `install-progress` 同款「后端推、前端渲染」）。
pub const PROGRESS_EVENT: &str = "data-dir://progress";

/// 非 Windows 平台不支持迁移：`DSH_HOME` 是用户级环境变量，只有 Windows 的
/// `HKCU\Environment` 有对应的读写点，且恢复脚本本身就是 Windows 专用。
pub(crate) fn platform_unsupported() -> String {
    format!("DATA_DIR_PLATFORM_UNSUPPORTED: {}", std::env::consts::OS)
}

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
        supported: cfg!(windows) && !cfg!(debug_assertions),
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
    let root = crate::config::get_dsh_data_path(app_handle);
    let read_dir =
        std::fs::read_dir(&root).map_err(|e| format!("DATA_DIR_READ: {}: {e}", root.display()))?;
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

/// 是否为「Harness 已经退出」的稳定状态：`.harness.pid` 里的进程不再存活。
///
/// 只认标记文件，不做端口猜测：端口可能被别的程序占用，也可能因为端口漂移而
/// 记着上一个端口；标记文件里的 PID 才是「本应用启动的 Harness」的唯一凭据。
/// 读不到标记（从未启动过、或上次已正常清理）同样视为已退出。
pub(super) fn harness_stopped(app_handle: &AppHandle) -> bool {
    let marker = crate::config::get_dsh_data_path(app_handle).join(".harness.pid");
    let Ok(text) = std::fs::read_to_string(&marker) else {
        return true;
    };
    let Some(pid) = text
        .lines()
        .next()
        .and_then(|line| line.trim().parse::<u32>().ok())
    else {
        return true;
    };
    !process_alive(pid)
}

/// 进程是否存活（只查该 PID，不刷新整张进程表）。
fn process_alive(pid: u32) -> bool {
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
}
