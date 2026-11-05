//! 多 Profile 环境隔离。
//!
//! 管理 `$DSH_HOME/profiles` 下的档案：列表、创建（web 模板）、切换当前使用中的
//! 档案，以及删除（默认档案与使用中的档案不可删除）与重置（清空档案数据、
//! 保留会话）。

use crate::config;
use crate::service::profile;
use crate::service::profile::migrate::{MigrateReport, MigrationAnalysis, MigrationDataKind};
use crate::AppHandle;

/// 档案列表（$DSH_HOME/profiles 下的目录，含 active/default 标记）
#[tauri::command]
pub fn get_profiles(window: crate::Window, app_handle: AppHandle) -> Vec<profile::Profile> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope_sync(profile, || profile::list(&app_handle))
}

/// 新建档案（初始化 $DSH_HOME/profiles/<id>，web 模板）
#[tauri::command]
pub async fn create_profile(
    app_handle: AppHandle,
    name: String,
) -> Result<profile::Profile, String> {
    let mutation = profile::mutation::acquire().await?;
    let profile_id = profile::active_profile(&app_handle);
    mutation
        .spawn_blocking(profile_id, move || profile::create(&app_handle, &name))
        .await
        .map_err(|e| format!("PROFILE_CREATE_TASK: {e}"))?
}

/// 切换当前窗口的档案。只有主窗口的切换会持久化成下次启动档案；额外窗口的
/// 切换只在本次会话生效，否则退出前在额外窗口选过的档案会顶替主窗口档案。
#[tauri::command]
pub async fn set_active_profile(
    app_handle: AppHandle,
    window: crate::Window,
    id: String,
) -> Result<profile::Profile, String> {
    let _transition = crate::service::workflow::acquire_core_transition().await?;
    let old = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    let mut selected = if window.label() == crate::desktop::builder::MAIN_WINDOW_LABEL {
        profile::set_active(&app_handle, &id)?
    } else {
        profile::select(&app_handle, &id)?
    };
    selected.active = true;
    crate::service::workflow::instances::bind_window(window.label(), &id);
    if old != id && !crate::service::workflow::instances::is_attached(&old) {
        crate::service::workflow::instances::scope(old, crate::service::workflow::stop(app_handle))
            .await?;
    }
    Ok(selected)
}

/// 删除档案（默认档案与使用中的档案不可删除）
#[tauri::command]
pub async fn remove_profile(
    window: crate::Window,
    app_handle: AppHandle,
    id: String,
) -> Result<(), String> {
    crate::service::fs_guard::validate_id(&id)?;
    if id == profile::DEFAULT_PROFILE {
        return Err("PROFILE_DEFAULT_NOT_REMOVABLE: the default profile cannot be removed".into());
    }
    let mutation = profile::mutation::acquire().await?;
    let current = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    if id == current || crate::service::workflow::instances::is_attached(&id) {
        return Err("PROFILE_ACTIVE_NOT_REMOVABLE: the active profile cannot be removed".into());
    }
    crate::service::workflow::instances::scope(id.clone(), async {
        crate::service::workflow::stop(app_handle.clone()).await
    })
    .await?;
    mutation
        .spawn_blocking(current, move || profile::remove(&app_handle, &id))
        .await
        .map_err(|e| format!("PROFILE_REMOVE_TASK: {e}"))?
}

/// 重置档案（清空档案目录并按模板重新初始化；会话数据在档案目录之外，保留）
#[tauri::command]
pub async fn reset_profile(
    app_handle: AppHandle,
    window: crate::Window,
    id: String,
) -> Result<(), String> {
    crate::service::fs_guard::validate_id(&id)?;
    let mutation = profile::mutation::acquire().await?;
    if crate::service::workflow::instances::attached_elsewhere(&id, window.label()) {
        return Err("PROFILE_IN_USE: stop and detach profile before reset".into());
    }
    crate::service::workflow::instances::scope(id.clone(), async move {
        crate::service::workflow::stop(app_handle.clone()).await?;
        mutation
            .spawn_blocking(id.clone(), move || profile::reset(&app_handle, &id))
            .await
            .map_err(|e| format!("PROFILE_RESET_TASK: {e}"))?
    })
    .await
}

/// 克隆档案（全量复制源档案目录，自动递增命名或指定名称）。
///
/// 异步命令：把 CPU/IO 密集的目录树复制放到 `spawn_blocking` 线程池，
/// 避免阻塞 Tauri 异步运行时导致 UI 卡顿。内部 `copy_dir_tree` 已用 rayon
/// 并行处理同级条目。
#[tauri::command]
pub async fn clone_profile(
    app_handle: AppHandle,
    source_id: String,
    name: Option<String>,
) -> Result<profile::Profile, String> {
    let mutation = profile::mutation::acquire().await?;
    let profiles_root = config::get_dsh_data_path(&app_handle).join("profiles");
    mutation
        .spawn_blocking(source_id.clone(), move || {
            profile::clone_with_root(&profiles_root, &source_id, name.as_deref())
        })
        .await
        .map_err(|e| format!("PROFILE_CLONE_TASK: {e}"))?
}

/// 分析源档案的可迁移插件与档案级数据（只读，判定基准 = 当前核心版本）
#[tauri::command]
pub async fn analyze_profile_migration(
    window: crate::Window,
    app_handle: AppHandle,
    source_id: String,
) -> Result<MigrationAnalysis, String> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope(profile, async move {
        profile::migrate::analyze(&app_handle, &source_id).await
    })
    .await
}

/// 把源档案选中的数据并入当前档案（逐项独立，结果里逐项报告）
#[tauri::command]
pub async fn migrate_profile_data(
    window: crate::Window,
    app_handle: AppHandle,
    source_id: String,
    items: Vec<MigrationDataKind>,
) -> Result<MigrateReport, String> {
    let mutation = profile::mutation::acquire().await?;
    let handle = app_handle.clone();
    let profile_id =
        crate::service::workflow::instances::window_profile(&app_handle, window.label());
    mutation.spawn_blocking(profile_id, move || {
        profile::migrate::apply(&handle, &source_id, &items)
    })
    .await
    .map_err(|e| format!("PROFILE_MIGRATION_TASK: {e}"))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_switch_persists_the_startup_profile_only_from_the_main_window() {
        let source = include_str!("profile.rs");
        let switch = source
            .split("pub async fn set_active_profile(")
            .nth(1)
            .unwrap()
            .split("pub async fn remove_profile(")
            .next()
            .unwrap();
        let guard = switch
            .find("window.label() == crate::desktop::builder::MAIN_WINDOW_LABEL")
            .unwrap();
        let persist = switch
            .find("profile::set_active(&app_handle, &id)")
            .unwrap();
        let transient = switch.find("profile::select(&app_handle, &id)").unwrap();
        assert!(
            guard < persist && guard < transient,
            "切换档案必须先按窗口区分：只有主窗口持久化下次启动档案"
        );
    }

    #[test]
    fn stale_setting_writes_never_replace_the_startup_profile() {
        use crate::{config, service::profile, service::workflow::instances};
        use tauri::utils::config::AppDirectoriesOverride;

        if std::env::var_os("DSH_TEST_PROFILE_PERSISTENCE").is_none() {
            let scratch = tempfile::tempdir().unwrap();
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "bridge::profile::tests::stale_setting_writes_never_replace_the_startup_profile",
                    "--nocapture",
                ])
                .env("DSH_TEST_PROFILE_PERSISTENCE", scratch.path())
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

        let root = std::path::PathBuf::from(std::env::var_os("DSH_TEST_PROFILE_PERSISTENCE").unwrap());
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().app.app_directories_override =
            Some(AppDirectoriesOverride::Root(root.join("store")));
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(context)
            .unwrap();
        let app = app.handle();
        for id in ["custom", "second"] {
            std::fs::create_dir_all(profile::profile_dir_of(app, id)).unwrap();
        }
        assert!(profile::set_active(app, "custom").unwrap().active);
        assert_eq!(config::get_store_dat_setting(app).active_profile, "custom");
        instances::scope_sync("second".into(), || {
            assert_eq!(profile::active_profile(app), "second");
        });
        let mut stale = config::get_store_dat_setting(app);
        stale.active_profile = "second".into();
        config::set_store_dat_setting(app, stale);
        assert_eq!(config::get_store_dat_setting(app).active_profile, "custom");
        assert!(
            profile::set_active(app, "missing")
                .unwrap_err()
                .starts_with("PROFILE_NOT_FOUND:")
        );
        assert_eq!(profile::active_profile(app), "custom");
        assert!(profile::set_active(app, "desktop").unwrap().active);
        assert_eq!(config::get_store_dat_setting(app).active_profile, "desktop");
    }

    #[test]
    fn profile_binding_entrypoints_share_the_destructive_transition_lock() {
        for (source, entry, end) in [
            (
                include_str!("../desktop/window.rs"),
                "pub async fn create_app_window(",
                "pub fn quit_app(",
            ),
            (
                include_str!("remote.rs"),
                "pub async fn remote_open_window(",
                "#[cfg(test)]",
            ),
            (
                include_str!("profile.rs"),
                "pub async fn set_active_profile(",
                "pub async fn remove_profile(",
            ),
        ] {
            let body = source
                .split(entry)
                .nth(1)
                .unwrap()
                .split(end)
                .next()
                .unwrap();
            let lock = body.find("acquire_core_transition().await?").unwrap();
            let binding = body
                .find("instances::bind_window(")
                .or_else(|| body.find("build_extra_window("))
                .unwrap();
            assert!(
                lock < binding,
                "{entry} must serialize bindings with reset/restore/removal"
            );
        }
    }
}
