//! 依赖（核心运行时）安装根的查看 / 迁移命令（issue #1285）。
//!
//! 薄封装：把 IPC 参数转成 `service::deps_root` 的调用（同 `bridge/data_dir.rs`）。
//! 迁移属于长任务（实测约 1GB / 数千文件），因此：
//! - 命令先取核心切换锁、停 Harness、持插件操作锁，再进 `spawn_blocking`；
//! - 进度通过 `deps-root://progress` 事件推送，前端订阅渲染。

use std::path::{Path, PathBuf};

use crate::AppHandle;

use crate::service::deps_root;

/// 弹出系统选目录对话框，返回用户选中的目录（取消返回 `None`）。
///
/// 与 `pick_data_dir` 同款：仓库未引入 `tauri-plugin-dialog`，`AsyncFileDialog` 自带线程
/// （macOS 会派发到主线程），可以直接在异步命令里 `.await`。
#[tauri::command]
pub async fn pick_dependencies_root(app_handle: AppHandle) -> Result<Option<String>, String> {
    let start = crate::config::dependencies::deps_root(&app_handle);
    let picked = rfd::AsyncFileDialog::new()
        .set_title("选择核心目录")
        .set_directory(start.parent().unwrap_or(&start))
        .pick_folder()
        .await;
    Ok(picked.map(|handle| handle.path().to_string_lossy().into_owned()))
}

/// 当前依赖根状态（只读：会扫一遍文件数，脱离异步运行时）。
#[tauri::command]
pub async fn get_dependencies_root_status(
    app_handle: AppHandle,
) -> Result<deps_root::DependenciesRootStatus, String> {
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || deps_root::status(&app))
        .await
        .map_err(|error| format!("DEPS_ROOT_TASK: {error}"))
}

/// 迁移预检：目标合法性、体积、磁盘空间（遍历目标与源，脱离异步运行时）。
#[tauri::command]
pub async fn preview_dependencies_root_migration(
    app_handle: AppHandle,
    path: String,
) -> Result<deps_root::DependenciesRootPreview, String> {
    let app = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || deps_root::preview(&app, Path::new(&path)))
        .await
        .map_err(|error| format!("DEPS_ROOT_TASK: {error}"))?
}

/// 把依赖根迁到 `path`（绝对路径；目标必须为空或不存在）。
///
/// 顺序与 `migrate_data_dir` 一致：先停 Harness 再动文件，锁守卫活到任务结束，期间
/// 任何安装 / 备份 / 核心切换请求都会排队等待。
#[tauri::command]
pub async fn migrate_dependencies_root(
    window: crate::Window,
    app_handle: AppHandle,
    path: String,
) -> Result<deps_root::DependenciesMigrationOutcome, String> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope(profile, async move {
        let mutation = crate::service::profile::mutation::acquire().await?;
        crate::service::workflow::instances::require_exclusive_profile()?;
        crate::service::workflow::stop(app_handle.clone()).await?;
        deps_root::sweep_stale_harness(&app_handle).await;
        let app = app_handle.clone();
        let outcome = deps_root::migrate(app, PathBuf::from(path), mutation).await?;
        deps_root::refresh_shims(&app_handle);
        Ok(outcome)
    })
    .await
}
