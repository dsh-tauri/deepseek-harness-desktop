//! 预装与已安装插件的增删改查、管理。

use crate::{AppHandle, Window};
use crate::config;
use crate::service::{plugin, workflow::instances};

use tauri_plugin_opener::OpenerExt;

fn mark_preinstall_done(app_handle: &AppHandle) {
    let mut setting = config::get_store_dat_setting(app_handle);
    setting.preinstall_done = true;
    if let Some(hash) = plugin::current_preset_hash(app_handle) {
        setting.preset_hash = Some(hash);
    }
    config::set_store_dat_setting(app_handle, setting);
}

#[tauri::command]
pub async fn get_preinstall_plugins(
    app_handle: AppHandle,
    window: Window,
) -> Result<Vec<plugin::PreinstallPlugin>, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async { Ok(plugin::list(&app_handle)) }).await
}

#[tauri::command]
pub async fn install_preinstall_plugins(
    app_handle: AppHandle,
    window: Window,
    install_ids: Vec<String>,
    uninstall_ids: Vec<String>,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        if !uninstall_ids.is_empty() {
            plugin::remove_many(&app_handle, &uninstall_ids).await?;
        }
        if !install_ids.is_empty() {
            plugin::install(&app_handle, &install_ids).await?;
        }
        mark_preinstall_done(&app_handle);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn cancel_plugin_processes(app_handle: AppHandle) {
    plugin::cancel(&app_handle).await;
}

#[tauri::command]
pub async fn install_plugin_specs(
    app_handle: AppHandle,
    window: Window,
    specs: Vec<String>,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        plugin::install_specs(&app_handle, &specs).await?;
        plugin::watch::force_emit(&app_handle);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn get_local_plugin_hmr(
    app_handle: AppHandle,
    window: Window,
) -> Result<plugin::LocalHmrStatus, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        Ok(plugin::local_plugin_hmr_status(&app_handle))
    })
    .await
}

#[tauri::command]
pub async fn set_local_plugin_hmr(
    app_handle: AppHandle,
    window: Window,
    enabled: bool,
) -> Result<plugin::LocalHmrStatus, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        config::update_store_dat_setting(&app_handle, |setting| {
            setting.local_plugin_hmr = enabled;
        });
        let patch = plugin::local_plugin_hmr_sync(&app_handle);
        log::info!(
            "[hmr] local plugin hot reload set to {enabled}, layer: {:?}",
            patch.as_ref().map(|path| path.display().to_string())
        );
        Ok(plugin::local_plugin_hmr_status(&app_handle))
    })
    .await
}

#[tauri::command]
pub async fn inspect_plugin_specs(
    app_handle: AppHandle,
    window: Window,
    specs: Vec<String>,
    dsh: Option<String>,
) -> Result<Vec<plugin::compat::PluginInspect>, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, plugin::inspect_specs(&app_handle, &specs, dsh)).await
}

#[tauri::command]
pub async fn allow_plugin_versions(
    app_handle: AppHandle,
    window: Window,
    versions: Vec<plugin::IncompatibleVersion>,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(
        profile,
        plugin::allow_version_exemptions(&app_handle, &versions),
    )
    .await
}

#[tauri::command]
pub async fn allow_plugin_policy_versions(
    app_handle: AppHandle,
    window: Window,
    versions: Vec<plugin::PolicyBlockedVersion>,
    expected_profile: Option<String>,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        plugin::allow_policy_versions(&app_handle, &versions, expected_profile.as_deref())
            .await
    })
    .await
}

#[tauri::command]
pub async fn skip_preinstall_plugins(
    app_handle: AppHandle,
    window: Window,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        mark_preinstall_done(&app_handle);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn ensure_internal_plugins(
    app_handle: AppHandle,
    window: Window,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, plugin::ensure_internal_plugins(&app_handle)).await
}

#[tauri::command]
pub async fn cancel_internal_plugins(
    app_handle: AppHandle,
    window: Window,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, plugin::cancel_internal_plugins()).await
}

#[tauri::command]
pub fn get_preinstall_pending(
    app_handle: AppHandle,
    window: Window,
) -> Result<bool, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope_sync(profile, || Ok(plugin::preinstall_pending(&app_handle)))
}

#[tauri::command]
pub async fn open_preinstall_repo(app_handle: AppHandle, id: String) -> Result<(), String> {
    let url = plugin::repo_url_of(&app_handle, &id)
        .ok_or_else(|| format!("PREINSTALL_INVALID_ID: {id}"))?;
    app_handle
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_dsh_plugins(app_handle: AppHandle, window: Window) -> Vec<plugin::DshPlugin> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope_sync(profile, || {
        let mut plugins = plugin::watch::list(&app_handle);
        plugin::update::apply_cache(&app_handle, &mut plugins);
        plugins
    })
}

#[tauri::command]
pub async fn refresh_plugin_updates(
    app_handle: AppHandle,
    window: Window,
) -> Result<Vec<plugin::DshPlugin>, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, plugin::update::refresh(&app_handle)).await
}

#[tauri::command]
pub async fn update_dsh_plugins(
    app_handle: AppHandle,
    window: Window,
    ids: Vec<String>,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        plugin::update_many(&app_handle, &ids).await?;
        plugin::watch::force_emit(&app_handle);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn remove_dsh_plugins(
    app_handle: AppHandle,
    window: Window,
    ids: Vec<String>,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        plugin::remove_many(&app_handle, &ids).await?;
        plugin::watch::force_emit(&app_handle);
        Ok(())
    })
    .await
}

#[tauri::command]
pub fn report_plugin_error(
    app_handle: AppHandle,
    window: Window,
    id: String,
    error: String,
    action: Option<String>,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope_sync(profile, || {
        plugin::errors::record(
            &app_handle,
            &id,
            action.as_deref().unwrap_or("runtime"),
            &error,
        )?;
        plugin::watch::force_emit(&app_handle);
        let info = plugin::PluginRecoveryInfo {
            plugins: vec![id],
            reason: "runtime".to_string(),
            detail: String::new(),
            raw_error: error,
        };
        instances::emit(
            &app_handle,
            plugin::recovery::RECOVERY_REQUIRED_EVENT,
            &info,
        );
        Ok(())
    })
}

#[tauri::command]
pub fn detect_plugin_recovery(
    app_handle: AppHandle,
    window: Window,
    logs: Vec<String>,
) -> plugin::PluginRecoveryInfo {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope_sync(profile, || plugin::detect_recovery(&app_handle, &logs))
}

#[tauri::command]
pub async fn recover_plugin(
    app_handle: AppHandle,
    window: Window,
    id: String,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    let mutation = crate::service::profile::mutation::acquire().await?;
    mutation.spawn_blocking(profile, move || {
        plugin::uninstall_recovery(&app_handle, &id)?;
        plugin::watch::force_emit(&app_handle);
        Ok(())
    })
    .await
    .map_err(|e| format!("PLUGIN_RECOVERY_TASK: {e}"))?
}

#[tauri::command]
pub async fn disable_dsh_plugin(
    app_handle: AppHandle,
    window: Window,
    id: String,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    run_plugin_toggle(profile, move || plugin::disable(&app_handle, &id)).await
}

#[tauri::command]
pub async fn enable_dsh_plugin(
    app_handle: AppHandle,
    window: Window,
    id: String,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    run_plugin_toggle(profile, move || plugin::enable(&app_handle, &id)).await
}

async fn run_plugin_toggle(
    profile: String,
    action: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || instances::scope_sync(profile, action))
        .await
        .map_err(|error| format!("PLUGIN_TOGGLE_TASK: {error}"))?
}

#[tauri::command]
pub async fn snapshot_plugin(
    app_handle: AppHandle,
    window: Window,
    id: String,
) -> Result<plugin::snapshot::SnapshotInfo, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    let operation = plugin::acquire_operation_lock().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        instances::scope_sync(profile, || plugin::snapshot::create(&app_handle, &id))
    })
    .await
    .map_err(|e| format!("SNAPSHOT_CREATE_TASK: {e}"))?
}

#[tauri::command]
pub async fn snapshot_plugins(
    app_handle: AppHandle,
    window: Window,
    ids: Vec<String>,
) -> Result<Vec<plugin::snapshot::SnapshotResult>, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    let operation = plugin::acquire_operation_lock().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        instances::scope_sync(profile, || plugin::snapshot::create_many(&app_handle, &ids))
    })
    .await
    .map_err(|e| format!("SNAPSHOT_CREATE_TASK: {e}"))
}

#[tauri::command]
pub fn get_plugin_backup(
    app_handle: AppHandle,
    window: Window,
    id: String,
) -> plugin::snapshot::PluginBackupInfo {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope_sync(profile, || plugin::snapshot::get(&app_handle, &id))
}

#[tauri::command]
pub async fn restore_plugin(
    app_handle: AppHandle,
    window: Window,
    id: String,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile, async {
        plugin::snapshot::restore(&app_handle, &id).await?;
        plugin::watch::force_emit(&app_handle);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn pick_local_plugin_dir(app_handle: AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        use tauri::Manager;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let app = app_handle.clone();
        app_handle
            .run_on_main_thread(move || {
                let mut dialog = rfd::FileDialog::new().set_title("选择本地插件目录");
                if let Some(window) =
                    app.get_window(crate::desktop::builder::MAIN_WINDOW_LABEL)
                {
                    dialog = dialog.set_parent(&window);
                }
                let picked = dialog
                    .pick_folder()
                    .map(|dir| plugin::local_spec_from_path(&dir));
                let _ = sender.send(picked);
            })
            .map_err(|error| format!("PLUGIN_PICK_FOLDER_FAILED: {error}"))?;
        receiver
            .await
            .map_err(|error| format!("PLUGIN_PICK_FOLDER_FAILED: {error}"))
    }
    #[cfg(not(windows))]
    {
        let _ = app_handle;
        let picked = rfd::AsyncFileDialog::new()
            .set_title("选择本地插件目录")
            .pick_folder()
            .await;
        Ok(picked.map(|handle| plugin::local_spec_from_path(handle.path())))
    }
}

#[tauri::command]
pub async fn delete_plugin_backup(
    app_handle: AppHandle,
    window: Window,
    id: String,
) -> Result<(), String> {
    let profile = instances::window_profile(&app_handle, window.label());
    let operation = plugin::acquire_operation_lock().await?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        instances::scope_sync(profile, || plugin::snapshot::delete(&app_handle, &id))
    })
    .await
    .map_err(|e| format!("SNAPSHOT_DELETE_TASK: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test(flavor = "current_thread")]
    async fn plugin_toggle_waits_off_dispatch_thread_with_captured_profile() {
        let _test_guard = plugin::TEST_PROCESS_LOCK.lock().await;
        let scratch = tempfile::tempdir().unwrap();
        let first = scratch.path().join("profile-a");
        let second = scratch.path().join("profile-b");
        for profile in [&first, &second] {
            std::fs::create_dir(profile).unwrap();
            std::fs::write(
                profile.join("package.json"),
                r#"{"dependencies":{"dsh-better-sidebar":"1.0.0"}}"#,
            )
            .unwrap();
        }
        let operation = plugin::acquire_operation_lock().await.unwrap();
        let dispatch_thread = std::thread::current().id();
        let root = scratch.path().to_path_buf();
        let (entered, started) = tokio::sync::oneshot::channel();
        let mut toggle = Box::pin(run_plugin_toggle("profile-a".into(), move || {
            assert_ne!(std::thread::current().id(), dispatch_thread);
            entered.send(()).unwrap();
            let _operation = tauri::async_runtime::block_on(plugin::acquire_operation_lock())?;
            let profile = instances::current_profile().unwrap();
            plugin::disable::disable_plugin_at(&root.join(profile), "dsh-better-sidebar")
        }));
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut toggle)
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_secs(5), started)
            .await
            .unwrap()
            .unwrap();
        assert!(!first.join("cordis.patch.yml").exists());
        assert!(!second.join("cordis.patch.yml").exists());
        instances::scope("profile-b".into(), async {
            drop(operation);
            tokio::time::timeout(Duration::from_secs(5), toggle)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(instances::current_profile().as_deref(), Some("profile-b"));
        })
        .await;
        assert!(plugin::disable::has_patch_disable(
            &first,
            "dsh-better-sidebar"
        ));
        assert!(!second.join("cordis.patch.yml").exists());
    }
}
