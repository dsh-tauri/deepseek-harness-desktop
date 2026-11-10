//! Harness Core 多版本与本地核心切换。
//!
//! 管理本地 CLI 核心与预打包的各个发布版本，支持切换活动核心、下载历史版本
//! 到槽位、卸载已下载的历史版本，以及通过用户包管理器 CLI 更新本地核心。

use crate::service::core;
use crate::AppHandle;

/// 核心列表：本地 CLI 核心 + 预打包各版本（含 active 标记、cli path 与
/// preview 预览版标记）。版本行数据源为 GitHub releases（含 Pre-release label），
/// 拉取失败时降级为 git tags / 磁盘扫描（离线/限流仍可用）。
#[tauri::command]
pub async fn get_cores(app_handle: AppHandle) -> Vec<core::HarnessCore> {
    core::list(&app_handle).await
}

/// 切换活动核心（id: `local` | `app` | `app-<tag>`；持久化 + 预打包版本目录
/// 互换；自动重启由前端负责）
#[tauri::command]
pub async fn set_active_core(
    window: crate::Window,
    app_handle: AppHandle,
    id: String,
) -> Result<core::HarnessCore, String> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope(profile, core::set_active(&app_handle, &id)).await
}

/// 下载指定 tag 的预打包核心到历史槽位（不激活；切换由 `set_active_core` 完成）
#[tauri::command]
pub async fn download_core(
    window: crate::Window,
    app_handle: AppHandle,
    tag: String,
) -> Result<core::HarnessCore, String> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope(profile, core::download_version(&app_handle, &tag))
        .await
}

/// 卸载已下载的历史版本（激活中的版本不可卸载）
#[tauri::command]
pub async fn remove_core(app_handle: AppHandle, id: String) -> Result<(), String> {
    core::remove_version(&app_handle, &id).await
}

/// 核心引擎当前是否以 asar 归档分发（设置 → 核心 → 高级选项）
#[tauri::command]
pub async fn get_core_asar(app_handle: AppHandle) -> bool {
    crate::config::get_store_dat_setting(&app_handle).core_asar
}

/// 切换核心的分发格式：写入设置后复用安装流程重新下载对应格式的核心
/// （停服 → 校验 → 下载解压 → 写映射 → 记录 tag），失败回滚设置。
#[tauri::command]
pub async fn set_core_asar(
    window: crate::Window,
    app_handle: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope(profile, async move {
        if crate::config::get_store_dat_setting(&app_handle).core_asar == enabled {
            return Ok(());
        }
        if crate::config::dependencies::bundled_core_dir(&app_handle).is_some() {
            return Err(
                "CORE_ASAR_SWITCH_UNSUPPORTED: the bundled core ships with the app and cannot change format"
                    .to_string(),
            );
        }
        crate::config::update_store_dat_setting(&app_handle, |setting| setting.core_asar = enabled);
        let rollback = || {
            crate::config::update_store_dat_setting(&app_handle, |setting| {
                setting.core_asar = !enabled;
            });
        };
        if let Err(error) = crate::service::workflow::install(&app_handle, None).await {
            rollback();
            return Err(format!("CORE_ASAR_SWITCH_FAILED: {error}"));
        }
        if crate::service::download::Dsh.format_mismatch(&app_handle) {
            rollback();
            return Err(
                "CORE_ASAR_SWITCH_FAILED: the built core still uses the previous format".to_string(),
            );
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn update_local_core(
    window: crate::Window,
    app_handle: AppHandle,
) -> Result<String, String> {
    let profile = crate::service::workflow::instances::window_profile(&app_handle, window.label());
    crate::service::workflow::instances::scope(profile, async move {
        core::update_local_core(app_handle).await
    })
    .await
}
