//! 桌面端应用自身的检查与更新。
//!
//! 检查桌面端是否有新版本、下载安装包（含进度事件推送）、打开已下载的安装包，
//! 以及关于对话框信息。

use crate::service::update;
use tauri::AppHandle;

/// 检查桌面端自身是否有新版本（含安装包是否已下载）
#[tauri::command]
pub async fn check_desktop_update(
    app_handle: AppHandle,
) -> Result<Option<update::DesktopUpdateInfo>, String> {
    update::check(&app_handle).await
}

/// 下载桌面端新版本安装包；已下载则直接返回。进度通过 `desktop-update-progress` 事件推送
#[tauri::command]
pub async fn download_desktop_update(
    app_handle: AppHandle,
) -> Result<update::DesktopUpdateInfo, String> {
    update::download(&app_handle).await
}

/// 打开已下载的桌面端安装包（exe/msi/dmg...，交给系统默认处理器）
#[tauri::command]
pub async fn open_desktop_installer(app_handle: AppHandle, path: String) -> Result<(), String> {
    update::open_installer(&app_handle, path).await
}

/// 关于对话框信息（版本 / 发布时间 / 版权 / 仓库）
#[tauri::command]
pub async fn get_desktop_about(app_handle: AppHandle) -> Result<update::DesktopAboutInfo, String> {
    Ok(update::about(&app_handle).await)
}
