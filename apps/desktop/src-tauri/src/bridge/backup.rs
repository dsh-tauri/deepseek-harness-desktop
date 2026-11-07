//! 备份 / 还原 Tauri 命令。

use crate::{AppHandle, Window};
use crate::service::{backup, workflow::instances};

fn target_profile<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
    current_profile: String,
    profile_id: Option<String>,
) -> Result<String, String> {
    let profile = profile_id.unwrap_or(current_profile);
    crate::service::profile::select(app_handle, &profile)?;
    Ok(profile)
}

#[tauri::command]
pub async fn export_recovery_backup(
    app_handle: AppHandle,
    window: Window,
    include_credentials: bool,
) -> Result<backup::BackupInfo, String> {
    let profile = instances::window_profile(&app_handle, window.label());
    instances::scope(profile.clone(), async move {
        let mutation = crate::service::profile::mutation::acquire().await?;
        crate::service::workflow::stop(app_handle.clone()).await?;
        let source = crate::config::get_dsh_data_path(&app_handle);
        let app_data = crate::config::get_base_dir(&app_handle);
        mutation
            .spawn_blocking(profile, move || {
                backup::recovery::export(&source, &app_data, include_credentials)
            })
            .await
            .map_err(|e| format!("RECOVERY_TASK: {e}"))?
    })
    .await
}

#[tauri::command]
pub async fn backup_profile(
    app_handle: AppHandle,
    window: Window,
    profile_id: Option<String>,
    include_credentials: bool,
) -> Result<backup::BackupInfo, String> {
    let current_profile = instances::window_profile(&app_handle, window.label());
    let mutation = crate::service::profile::mutation::acquire().await?;
    let profile = target_profile(&app_handle, current_profile, profile_id)?;
    let result = mutation
        .spawn_blocking(profile, move || {
            backup::create_backup(
                &app_handle,
                backup::BackupOptions {
                    include_credentials,
                },
            )
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
    window: Window,
    profile_id: Option<String>,
    timestamp: String,
    as_new: bool,
) -> Result<(), String> {
    let current_profile = instances::window_profile(&app_handle, window.label());
    let mutation = crate::service::profile::mutation::acquire().await?;
    let profile = target_profile(&app_handle, current_profile, profile_id)?;
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
        mutation
            .spawn_blocking(profile, move || {
                backup::restore_backup(&app_handle, &timestamp, mode)
            })
            .await
            .map_err(|e| format!("RESTORE_TASK: {e}"))?
    })
    .await
}

#[tauri::command]
pub fn list_backups(
    app_handle: AppHandle,
    window: Window,
    profile_id: Option<String>,
) -> Result<Vec<backup::BackupInfo>, String> {
    let profile = target_profile(
        &app_handle,
        instances::window_profile(&app_handle, window.label()),
        profile_id,
    )?;
    instances::scope_sync(profile, || backup::list_backups(&app_handle))
}

#[tauri::command]
pub async fn delete_backup<R: tauri::Runtime>(
    app_handle: AppHandle<R>,
    window: Window<R>,
    profile_id: Option<String>,
    timestamp: String,
) -> Result<(), String> {
    let current_profile = instances::window_profile(&app_handle, window.label());
    let mutation = crate::service::profile::mutation::acquire().await?;
    let profile = target_profile(&app_handle, current_profile, profile_id)?;
    mutation
        .spawn_blocking(profile, move || {
            backup::delete_backup(&app_handle, &timestamp)
        })
        .await
        .map_err(|e| format!("BACKUP_DELETE_TASK: {e}"))?
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn backup_delete_waits_for_profile_mutation_and_keeps_invocation_target() {
        use crate::service::{profile, workflow::instances};
        use std::time::Duration;
        use tauri::utils::config::AppDirectoriesOverride;

        const CHILD: &str = "DSH_TEST_BACKUP_DELETE_COORDINATION";
        if std::env::var_os(CHILD).is_none() {
            let scratch = tempfile::tempdir().unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "bridge::backup::tests::backup_delete_waits_for_profile_mutation_and_keeps_invocation_target",
                    "--nocapture",
                ])
                .env(CHILD, scratch.path())
                .env("HOME", scratch.path())
                .env("USERPROFILE", scratch.path())
                .env("APPDATA", scratch.path().join("AppData/Roaming"))
                .env("LOCALAPPDATA", scratch.path().join("AppData/Local"))
                .env("XDG_DATA_HOME", scratch.path().join(".local/share"))
                .env("DSH_HOME", scratch.path().join(".dsh"))
                .env("DSH_E2E_HOME", scratch.path())
                .env("TAURI_WEBDRIVER_PORT", "4445");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let root = std::path::PathBuf::from(std::env::var_os(CHILD).unwrap());
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(root.join("store")));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(context)
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "backup-delete-test",
            tauri::WebviewUrl::default(),
        )
        .build()
        .unwrap()
        .as_ref()
        .window()
        .clone();
        let app = app.handle();
        for id in ["profile-a", "profile-b"] {
            std::fs::create_dir_all(profile::profile_dir_of(app, id)).unwrap();
        }
        for selected in [None, Some("profile-a".to_string())] {
            profile::set_active(app, "profile-a").unwrap();
            instances::bind_window(
                window.label(),
                if selected.is_some() {
                    "profile-b"
                } else {
                    "profile-a"
                },
            );
            let backup_dir = crate::service::backup::get_backup_dir(app);
            let timestamp = "20261105010101";
            let first = backup_dir.join(format!("profile-a-{timestamp}.tar.zst"));
            let second = backup_dir.join(format!("profile-b-{timestamp}.tar.zst"));
            std::fs::write(&first, b"archive-a").unwrap();
            std::fs::write(&second, b"archive-b").unwrap();
            let entry = |id: &str, path: &std::path::Path| {
                serde_json::json!({
                    "timestamp": timestamp,
                    "profile": id,
                    "path": path,
                    "size": 9,
                    "includeCredentials": false,
                })
            };
            let manifest = serde_json::json!({
                "backups": [entry("profile-a", &first), entry("profile-b", &second)],
            });
            let manifest_path = backup_dir.join(".manifest.json");
            let original = serde_json::to_vec(&manifest).unwrap();
            std::fs::write(&manifest_path, &original).unwrap();
            let mutation = profile::mutation::acquire().await.unwrap();
            let mut deletion = Box::pin(super::delete_backup(
                app.clone(),
                window.clone(),
                selected,
                timestamp.into(),
            ));
            assert!(
                tokio::time::timeout(Duration::from_millis(30), &mut deletion)
                    .await
                    .is_err()
            );
            assert_eq!(std::fs::read(&first).unwrap(), b"archive-a");
            assert_eq!(std::fs::read(&manifest_path).unwrap(), original);
            profile::set_active(app, "profile-b").unwrap();
            instances::bind_window(window.label(), "profile-b");
            drop(mutation);
            tokio::time::timeout(Duration::from_secs(5), deletion)
                .await
                .unwrap()
                .unwrap();
            assert!(!first.exists());
            assert_eq!(std::fs::read(&second).unwrap(), b"archive-b");
            let after: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
            assert_eq!(
                after["backups"],
                serde_json::json!([entry("profile-b", &second)])
            );
            assert_eq!(profile::active_profile(app), "profile-b");
        }
    }

    #[test]
    fn backup_target_is_validated_without_switching_the_active_profile() {
        use crate::service::profile;
        use tauri::utils::config::AppDirectoriesOverride;
        const CHILD: &str = "DSH_TEST_BACKUP_TARGET";
        if std::env::var_os(CHILD).is_none() {
            let scratch = tempfile::tempdir().unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", "bridge::backup::tests::backup_target_is_validated_without_switching_the_active_profile", "--nocapture"])
                .env(CHILD, scratch.path())
                .env("HOME", scratch.path())
                .env("USERPROFILE", scratch.path())
                .env("APPDATA", scratch.path().join("AppData/Roaming"))
                .env("LOCALAPPDATA", scratch.path().join("AppData/Local"))
                .env("XDG_DATA_HOME", scratch.path().join(".local/share"))
                .env("DSH_HOME", scratch.path().join(".dsh"))
                .env("DSH_E2E_HOME", scratch.path())
                .env("TAURI_WEBDRIVER_PORT", "4445");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let root = std::path::PathBuf::from(std::env::var_os(CHILD).unwrap());
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(root.join("store")));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(context)
            .unwrap();
        let app = app.handle();
        for id in ["profile-a", "profile-b"] {
            std::fs::create_dir_all(profile::profile_dir_of(app, id)).unwrap();
        }
        profile::set_active(app, "profile-a").unwrap();
        assert_eq!(
            super::target_profile(app, "profile-a".into(), Some("profile-b".into())).unwrap(),
            "profile-b"
        );
        assert_eq!(
            super::target_profile(app, "profile-a".into(), None).unwrap(),
            "profile-a"
        );
        assert!(
            super::target_profile(app, "profile-a".into(), Some("missing".into()))
                .unwrap_err()
                .starts_with("PROFILE_NOT_FOUND:")
        );
        assert!(
            super::target_profile(app, "profile-a".into(), Some("../escape".into()))
                .unwrap_err()
                .starts_with("INVALID_ID:")
        );
        assert_eq!(profile::active_profile(app), "profile-a");
    }
}
