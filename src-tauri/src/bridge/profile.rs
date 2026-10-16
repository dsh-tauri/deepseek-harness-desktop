//! 多 Profile 环境隔离。
//!
//! 管理 `$DSH_HOME/profiles` 下的档案：列表、创建（web 模板）、切换当前使用中的
//! 档案，以及删除（默认档案与使用中的档案不可删除）与重置（清空档案数据、
//! 保留会话）。

use crate::config;
use crate::service::profile;
use crate::service::profile::migrate::{MigrateReport, MigrationAnalysis, MigrationDataKind};
use tauri::AppHandle;

/// 档案列表（$DSH_HOME/profiles 下的目录，含 active/default 标记）
#[tauri::command]
pub fn get_profiles(window: tauri::WebviewWindow, app_handle: AppHandle) -> Vec<profile::Profile> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope_sync(profile, || profile::list(&app_handle))
}

/// 新建档案（初始化 $DSH_HOME/profiles/<id>，web 模板）
#[tauri::command]
pub fn create_profile(app_handle: AppHandle, name: String) -> Result<profile::Profile, String> {
    profile::create(&app_handle, &name)
}

/// 切换当前窗口的档案并持久化下次启动默认档案。
#[tauri::command]
pub async fn set_active_profile(
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<profile::Profile, String> {
    let _transition = crate::service::workflow::acquire_core_transition().await?;
    let old = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    let mut selected = profile::set_active(&app_handle, &id)?;
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
    window: tauri::WebviewWindow,
    app_handle: AppHandle,
    id: String,
) -> Result<(), String> {
    crate::service::fs_guard::validate_id(&id)?;
    if id == profile::DEFAULT_PROFILE {
        return Err("PROFILE_DEFAULT_NOT_REMOVABLE: the default profile cannot be removed".into());
    }
    let _transition = crate::service::workflow::acquire_core_transition().await?;
    let current = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    if id == current || crate::service::workflow::instances::is_attached(&id) {
        return Err("PROFILE_ACTIVE_NOT_REMOVABLE: the active profile cannot be removed".into());
    }
    crate::service::workflow::instances::scope(id.clone(), async {
        crate::service::workflow::stop(app_handle.clone()).await
    })
    .await?;
    crate::service::workflow::instances::scope_sync(current, || profile::remove(&app_handle, &id))
}

/// 重置档案（清空档案目录并按模板重新初始化；会话数据在档案目录之外，保留）
#[tauri::command]
pub async fn reset_profile(
    app_handle: AppHandle,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<(), String> {
    crate::service::fs_guard::validate_id(&id)?;
    let _transition = crate::service::workflow::acquire_core_transition().await?;
    if crate::service::workflow::instances::attached_elsewhere(&id, window.label()) {
        return Err("PROFILE_IN_USE: stop and detach profile before reset".into());
    }
    crate::service::workflow::instances::scope(id.clone(), async {
        crate::service::workflow::stop(app_handle.clone()).await?;
        profile::reset(&app_handle, &id)
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
    let profiles_root = config::get_dsh_data_path(&app_handle).join("profiles");
    tauri::async_runtime::spawn_blocking(move || {
        profile::clone_with_root(&profiles_root, &source_id, name.as_deref())
    })
    .await
    .map_err(|e| format!("PROFILE_CLONE_TASK: {e}"))?
}

/// 分析源档案的可迁移插件与档案级数据（只读，判定基准 = 当前核心版本）
#[tauri::command]
pub async fn analyze_profile_migration(
    window: tauri::WebviewWindow,
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
    window: tauri::WebviewWindow,
    app_handle: AppHandle,
    source_id: String,
    items: Vec<MigrationDataKind>,
) -> Result<MigrateReport, String> {
    let handle = app_handle.clone();
    let profile_id =
        crate::service::workflow::instances::window_profile(&app_handle, window.label());
    tauri::async_runtime::spawn_blocking(move || {
        crate::service::workflow::instances::scope_sync(profile_id, || {
            profile::migrate::apply(&handle, &source_id, &items)
        })
    })
    .await
    .map_err(|e| format!("PROFILE_MIGRATION_TASK: {e}"))?
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_removal_waits_for_stop_before_deleting_detached_data() {
        let source = include_str!("profile.rs");
        let removal = source
            .split("pub async fn remove_profile(")
            .nth(1)
            .unwrap()
            .split("pub async fn reset_profile(")
            .next()
            .unwrap();
        let lock = removal.find("acquire_core_transition().await?").unwrap();
        let attached = removal.find("instances::is_attached(&id)").unwrap();
        let scope = removal.find("instances::scope(id.clone(),").unwrap();
        let stop = removal
            .find("workflow::stop(app_handle.clone()).await")
            .unwrap();
        let confirmed = stop + removal[stop..].find(".await?;").unwrap();
        let delete = removal.find("profile::remove(&app_handle, &id)").unwrap();
        assert!(lock < attached && attached < scope && scope < stop);
        assert!(stop < confirmed && confirmed < delete);
    }

    #[test]
    fn profile_binding_entrypoints_share_the_destructive_transition_lock() {
        for (source, entry, end) in [
            (
                include_str!("../desktop/window.rs"),
                "pub async fn create_app_window(",
                "fn session_window_path(",
            ),
            (
                include_str!("remote.rs"),
                "pub async fn remote_open_window(",
                "#[cfg(test)]",
            ),
            (
                include_str!("lifecycle.rs"),
                "pub async fn enter_safe_mode(",
                "pub async fn quarantine_broken_patch_layers(",
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
