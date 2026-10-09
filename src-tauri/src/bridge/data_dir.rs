//! 数据目录（`DSH_HOME`）迁移 / 回滚的 Tauri 命令（issue #871）。
//!
//! 薄封装：把 IPC 参数转成 `service::data_dir` 的调用，遵循 `bridge/backup.rs`
//! 的分层模式。迁移属于长任务（实测约 900 MiB / 25800 个文件），因此：
//! - 命令先取核心切换锁、停 Harness、持插件操作锁，再进 `spawn_blocking`；
//! - 进度通过 `data-dir://progress` 事件推送，前端订阅渲染。

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::service::data_dir;

// stop 会删掉本通道标记；不可读的先拒绝，已记录的 PID 留到停服后复核。
fn reject_unreadable_markers(recorded: [data_dir::HarnessMarker; 2]) -> Result<(), String> {
    use data_dir::HarnessMarker;
    recorded
        .into_iter()
        .zip(crate::config::HARNESS_PID_MARKER_NAMES)
        .try_for_each(|(marker, name)| match marker {
            HarnessMarker::Invalid => Err(format!(
                "DATA_DIR_HARNESS_MARKER_INVALID: {name} 读不出来，无法确认 Harness 是否已退出，请先退出所有实例再重试"
            )),
            HarnessMarker::Missing | HarnessMarker::Pid(_) => Ok(()),
        })
}

// DSH_HOME 仍然共享；只报告另一个通道的存活进程，不能替用户结束它。
fn confirm_harness_stopped(recorded: [data_dir::HarnessMarker; 2]) -> Result<(), String> {
    reject_unreadable_markers(recorded)?;
    for marker in recorded {
        if let data_dir::HarnessMarker::Pid(pid) = marker {
            if data_dir::process_alive(pid) {
                return Err(format!(
                    "DATA_DIR_HARNESS_RUNNING: {pid} 仍在使用数据目录，请先退出那个实例再重试"
                ));
            }
        }
    }
    Ok(())
}

/// 当前数据目录状态（同步命令：只读注册表与目录名，不做遍历）。
#[tauri::command]
pub fn get_data_dir_status(app_handle: AppHandle) -> data_dir::DataDirStatus {
    data_dir::status(&app_handle)
}

/// 弹出系统选目录对话框，返回用户选中的目录（取消返回 `None`）。
///
/// 选目录走 `rfd`：仓库未引入 `tauri-plugin-dialog`，`AsyncFileDialog` 自己起线程
/// （macOS 后端会把对话框派发到主线程），因此可以直接在异步命令里 `.await`。
/// Linux 上用 xdg-desktop-portal 后端；没有 portal 的会话（纯 X11、无 DBus）会
/// 失败，前端据此提示用户手填路径。
#[tauri::command]
pub async fn pick_data_dir(app_handle: AppHandle) -> Result<Option<String>, String> {
    let start = crate::config::get_dsh_data_path(&app_handle);
    let picked = rfd::AsyncFileDialog::new()
        .set_title("选择数据存放目录")
        .set_directory(start.parent().unwrap_or(&start))
        .pick_folder()
        .await;
    Ok(picked.map(|handle| handle.path().to_string_lossy().into_owned()))
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
    // 标记要在 `stop()` 之前读：停成功时它会顺手删掉标记，删掉之后就再也查不出
    // 「崩溃残留、不在 owned 注册表里的 Harness」是否还在写这个目录。
    let recorded = data_dir::harness_markers(&crate::config::get_dsh_data_path(&app_handle));
    reject_unreadable_markers(recorded)?;
    crate::service::workflow::stop(app_handle.clone()).await?;
    confirm_harness_stopped(recorded)?;
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
    let recorded = data_dir::harness_markers(&crate::config::get_dsh_data_path(&app_handle));
    reject_unreadable_markers(recorded)?;
    crate::service::workflow::stop(app_handle.clone()).await?;
    confirm_harness_stopped(recorded)?;
    let app = app_handle.clone();
    let result = data_dir::rollback(app, backup.map(PathBuf::from)).await;
    drop(transition);
    drop(operation);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use data_dir::HarnessMarker::{Invalid, Missing, Pid};

    #[test]
    fn recorded_markers_prevent_live_channel_migration_after_marker_removal() {
        assert!(confirm_harness_stopped([Missing; 2]).is_ok());
        assert!(confirm_harness_stopped([Pid(u32::MAX); 2]).is_ok());
        for (index, name) in [".harness.pid", ".harness-nightly.pid"]
            .into_iter()
            .enumerate()
        {
            let mut recorded = [Missing; 2];
            recorded[index] = Pid(std::process::id());
            assert!(reject_unreadable_markers(recorded).is_ok());
            assert!(confirm_harness_stopped(recorded)
                .unwrap_err()
                .starts_with("DATA_DIR_HARNESS_RUNNING:"));
            recorded[index] = Invalid;
            let error = reject_unreadable_markers(recorded).unwrap_err();
            assert!(error.starts_with("DATA_DIR_HARNESS_MARKER_INVALID:"));
            assert!(error.contains(name));
            assert!(confirm_harness_stopped(recorded).is_err());
        }
    }
}
