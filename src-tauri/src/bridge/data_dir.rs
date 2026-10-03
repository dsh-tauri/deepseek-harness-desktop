//! 数据目录（`DSH_HOME`）迁移 / 回滚的 Tauri 命令（issue #871）。
//!
//! 薄封装：把 IPC 参数转成 `service::data_dir` 的调用，遵循 `bridge/backup.rs`
//! 的分层模式。迁移属于长任务（实测约 900 MiB / 25800 个文件），因此：
//! - 命令先取核心切换锁、停 Harness、持插件操作锁，再进 `spawn_blocking`；
//! - 进度通过 `data-dir://progress` 事件推送，前端订阅渲染。

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::service::data_dir;

/// 当前数据目录状态（同步命令：只读注册表与目录名，不做遍历）。
#[tauri::command]
pub fn get_data_dir_status(app_handle: AppHandle) -> data_dir::DataDirStatus {
    data_dir::status(&app_handle)
}

/// 弹出系统选目录对话框，返回用户选中的目录（取消返回 `None`）。
///
/// 选目录走 `rfd`（Windows-only 依赖）：仓库未引入 `tauri-plugin-dialog`，
/// `AsyncFileDialog` 自身起线程与 COM apartment，可直接在异步命令中 `.await`。
#[tauri::command]
pub async fn pick_data_dir(app_handle: AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let start = crate::config::get_dsh_data_path(&app_handle);
        let picked = rfd::AsyncFileDialog::new()
            .set_title("选择数据存放目录")
            .set_directory(start.parent().unwrap_or(&start))
            .pick_folder()
            .await;
        return Ok(picked.map(|handle| handle.path().to_string_lossy().into_owned()));
    }
    #[cfg(not(windows))]
    {
        let _ = app_handle;
        Err(data_dir::platform_unsupported())
    }
}

/// 数据目录下的顶层条目及占用空间（遍历目录树，脱离异步运行时）。
#[tauri::command]
pub async fn list_data_dir_entries(
    app_handle: AppHandle,
) -> Result<Vec<data_dir::DataDirEntry>, String> {
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || data_dir::entries(&app))
        .await
        .map_err(|e| format!("DATA_DIR_TASK: {e}"))?
}

/// 迁移预检：目标合法性、体积、磁盘空间（遍历目录树，脱离异步运行时）。
#[tauri::command]
pub async fn preview_data_dir_migration(
    app_handle: AppHandle,
    parent: String,
    leaf: String,
) -> Result<data_dir::MigrationPlan, String> {
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || data_dir::preview(&app, Path::new(&parent), &leaf))
        .await
        .map_err(|e| format!("DATA_DIR_TASK: {e}"))?
}

/// 把数据目录迁到 `<parent>\<leaf>`。
///
/// 顺序与 `export_recovery_backup` 一致：先停 Harness 再动文件，锁守卫活到
/// 任务结束，期间任何安装 / 备份 / 核心切换请求都会排队等待。
#[tauri::command]
pub async fn migrate_data_dir(
    app_handle: AppHandle,
    parent: String,
    leaf: String,
) -> Result<data_dir::MigrationOutcome, String> {
    let transition = crate::service::workflow::acquire_core_transition().await?;
    let operation = crate::service::plugin::acquire_operation_lock().await;
    crate::service::workflow::stop(app_handle.clone()).await?;
    let app = app_handle.clone();
    let result = data_dir::migrate(app, PathBuf::from(parent), leaf).await;
    drop(transition);
    drop(operation);
    result
}

/// 回滚到旧目录备份（`backup` 为空时按「会话数优先、时间戳其次」自动挑选）。
#[tauri::command]
pub async fn rollback_data_dir(
    app_handle: AppHandle,
    backup: Option<String>,
) -> Result<data_dir::MigrationOutcome, String> {
    let transition = crate::service::workflow::acquire_core_transition().await?;
    let operation = crate::service::plugin::acquire_operation_lock().await;
    crate::service::workflow::stop(app_handle.clone()).await?;
    let app = app_handle.clone();
    let result = data_dir::rollback(app, backup.map(PathBuf::from)).await;
    drop(transition);
    drop(operation);
    result
}
