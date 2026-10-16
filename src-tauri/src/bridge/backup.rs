//! 备份 / 还原 Tauri 命令。

use tauri::{AppHandle, WebviewWindow};

use crate::service::{backup, workflow::instances};

#[tauri::command]
pub async fn export_recovery_backup(
    app_handle: AppHandle,
    window: WebviewWindow,
    include_credentials: bool,
) -> Result<backup::BackupInfo, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile.clone(), async move {
        let transition = crate::service::workflow::acquire_core_transition().await?;
        let operation = crate::service::plugin::acquire_operation_lock().await;
        crate::service::workflow::stop(app_handle.clone()).await?;
        let source = crate::config::get_dsh_data_path(&app_handle);
        let app_data = crate::config::get_base_dir(&app_handle);
        tauri::async_runtime::spawn_blocking(move || {
            instances::scope_sync(profile, || {
                let _transition = transition;
                let _operation = operation;
                backup::recovery::export(&source, &app_data, include_credentials)
            })
        })
        .await
        .map_err(|e| format!("RECOVERY_TASK: {e}"))?
    })
    .await
}

#[tauri::command]
pub async fn backup_profile(
    app_handle: AppHandle,
    window: WebviewWindow,
    include_credentials: bool,
) -> Result<backup::BackupInfo, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    let result = tauri::async_runtime::spawn_blocking(move || {
        instances::scope_sync(profile, || {
            backup::create_backup(
                &app_handle,
                backup::BackupOptions {
                    include_credentials,
                },
            )
        })
    })
    .await
    .map_err(|e| format!("BACKUP_TASK: {e}"))?;
    match &result {
        Ok(info) => log::info!(
            "[backup] 创建成功: {} ({} bytes)",
            info.timestamp,
            info.size
        ),
        Err(e) => log::error!("[backup] 创建失败: {e}"),
    }
    result
}

#[tauri::command]
pub async fn restore_profile(
    app_handle: AppHandle,
    window: WebviewWindow,
    timestamp: String,
    as_new: bool,
) -> Result<(), String> {
    let transition = crate::service::workflow::acquire_core_transition().await?;
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile.clone(), async move {
        let mode = if as_new {
            backup::RestoreMode::AsNew
        } else {
            if instances::attached_elsewhere(&profile, window.label()) {
                return Err("PROFILE_IN_USE: detach other windows before restoring profile".into());
            }
            crate::service::workflow::stop(app_handle.clone()).await?;
            backup::RestoreMode::Overwrite
        };
        tauri::async_runtime::spawn_blocking(move || {
            instances::scope_sync(profile, || {
                let _transition = transition;
                backup::restore_backup(&app_handle, &timestamp, mode)
            })
        })
        .await
        .map_err(|e| format!("RESTORE_TASK: {e}"))?
    })
    .await
}

#[tauri::command]
pub fn list_backups(app_handle: AppHandle, window: WebviewWindow) -> Vec<backup::BackupInfo> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope_sync(profile, || backup::list_backups(&app_handle))
}

#[tauri::command]
pub async fn delete_backup(
    app_handle: AppHandle,
    window: WebviewWindow,
    timestamp: String,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    tauri::async_runtime::spawn_blocking(move || {
        instances::scope_sync(profile, || backup::delete_backup(&app_handle, &timestamp))
    })
    .await
    .map_err(|e| format!("BACKUP_DELETE_TASK: {e}"))?
}
