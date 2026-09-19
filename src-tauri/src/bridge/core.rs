//! Harness Core 多版本与本地核心切换。
//!
//! 管理本地 CLI 核心与预打包的各个发布版本，支持切换活动核心、下载历史版本
//! 到槽位、卸载已下载的历史版本，以及通过用户包管理器 CLI 更新本地核心。

use crate::config;
use crate::service::core;
use tauri::AppHandle;

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
    app_handle: AppHandle,
    id: String,
) -> Result<core::HarnessCore, String> {
    core::set_active(&app_handle, &id).await
}

/// 下载指定 tag 的预打包核心到历史槽位（不激活；切换由 `set_active_core` 完成）
#[tauri::command]
pub async fn download_core(
    app_handle: AppHandle,
    tag: String,
) -> Result<core::HarnessCore, String> {
    if config::auto_download_disabled() {
        return Err("AUTO_DOWNLOAD_DISABLED: 自动下载已被禁用，无法下载核心".to_string());
    }
    core::download_version(&app_handle, &tag).await
}

/// 卸载已下载的历史版本（激活中的版本不可卸载）
#[tauri::command]
pub async fn remove_core(app_handle: AppHandle, id: String) -> Result<(), String> {
    core::remove_version(&app_handle, &id).await
}

/// 通过用户包管理器 CLI 更新本地核心（npm `install -g @latest` /
/// pnpm `add -g @latest`），返回更新后的版本号。
#[tauri::command]
pub async fn update_local_core(app_handle: AppHandle) -> Result<String, String> {
    core::update_local_core(app_handle).await
}
