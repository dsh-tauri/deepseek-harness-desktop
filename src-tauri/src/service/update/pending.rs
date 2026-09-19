//! 「安装包已下载、等待安装」标记与退出时自动更新。
//!
//! 需求链路：桌面端检测到新版本后**静默下载**（不弹右下角 toast）；用户可能不
//! 立刻安装，于是在**关闭应用**时自动打开已下载的安装器，避免用户错过升级。
//!
//! 标记存在 store 的独立键（`STORE_PENDING_INSTALLER_KEY`）而非 `Setting` 字段：
//! `Setting` 会被前端整对象写回（`bridge::config` / `bridge::lifecycle`），运行期
//! 标记不能被前端 payload 覆盖。下载成功即置位，用户真正打开安装包（对话框
//! 「打开安装包」或退出时自动打开）后清除。

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::config::{store_dat_file_name, STORE_PENDING_INSTALLER_KEY};
use crate::service::workflow;

/// 「待安装」标记：安装包路径 + 它对应的版本号。
///
/// 记版本号是为了退出时的**版本护栏**（见 [`launch_pending_installer`]）：
/// 用户可能用别的方式（手动下载/包管理器）升级到了更新的版本，此时绝不能拿
/// 手里的旧安装包在退出时把它降级安装掉。
#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingInstaller {
    path: String,
    version: String,
}

/// 读取「待安装」标记；无标记、内容非法或路径为空时返回 `None`。
fn get(app_handle: &AppHandle) -> Option<PendingInstaller> {
    let store = app_handle.store(store_dat_file_name()).ok()?;
    let value = store.get(STORE_PENDING_INSTALLER_KEY)?;
    let pending: PendingInstaller = serde_json::from_value(value).ok()?;
    if pending.path.is_empty() {
        return None;
    }
    Some(pending)
}

/// 记录 / 清除「待安装」标记（`None` = 已安装，或无需退出时自动打开）。
///
/// 失败只告警不阻断：标记只是「退出时自动更新」的辅助，丢掉它的降级态是用户
/// 需要在对话框里手动点一次「打开安装包」，不该让下载/打开流程随之失败。
pub(super) fn set(app_handle: &AppHandle, pending: Option<(&Path, &str)>) {
    let Ok(store) = app_handle.store(store_dat_file_name()) else {
        log::warn!("Failed to load store for pending installer marker");
        return;
    };
    match pending {
        Some((path, version)) => {
            let value = serde_json::json!({
                "path": path.to_string_lossy(),
                "version": version,
            });
            store.set(STORE_PENDING_INSTALLER_KEY, value);
        }
        None => {
            store.delete(STORE_PENDING_INSTALLER_KEY);
        }
    }
    if let Err(error) = store.save() {
        log::warn!("Failed to save pending installer marker: {error}");
    }
}

/// 应用退出时自动打开已下载的待安装包。
///
/// 只在「已下载但用户没在应用内打开过」时触发（标记由 `install` 模块维护）。
/// 同步、不触网：退出路径不能引入等待或网络请求，把安装包交给系统默认处理器
/// 启动即可（Windows 会触发 UAC，macOS/Linux 交给各自的系统安装流程）。
pub fn launch_pending_installer(app_handle: &AppHandle) {
    let Some(pending) = get(app_handle) else {
        return;
    };
    // 先清标记：无论本次能否成功打开，都不在后续退出时反复尝试——用户已经明确
    // 退出应用，反复拉起安装器只会变成打扰；降级态是用户自己在对话框里手动安装。
    set(app_handle, None);

    // 版本护栏：待安装包必须严格新于当前运行版本。用户若已用别的方式升到更新的
    // 版本（手动下载/包管理器），此刻拉起旧安装包会变成降级安装。
    let current = super::version::current_version();
    if !super::version::is_newer(&pending.version, &current) {
        log::info!(
            "Pending installer {} is not newer than running {current}, skipping auto update",
            pending.version
        );
        return;
    }

    log::info!(
        "Launching pending desktop installer on exit: {} ({})",
        pending.path,
        pending.version
    );
    // 打开安装包前先停 Harness：安装器会强杀桌面端进程，桌面端先消失就没人回收
    // Harness 子进程，它会变成孤儿继续占用配置端口，更新后新实例撞 EADDRINUSE。
    // 退出路径虽已调过 stop_on_exit，但那份保障依赖调用方顺序与 `setting.installed`
    // 门槛；自动更新是「用安装器替换本应用」的场景，停服必须由交付点自己保证（幂等，
    // 重复调用只是 no-op）。
    workflow::stop_for_installer(app_handle);
    if let Err(error) = super::install::open_installer_now(app_handle, &pending.path) {
        log::warn!("UPDATE_OPEN: failed to launch pending installer on exit: {error}");
    }
}
