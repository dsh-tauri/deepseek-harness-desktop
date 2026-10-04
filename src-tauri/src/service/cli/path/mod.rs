//! 用户 PATH 注册与路径计算：bin 目录定位、Windows 注册表读写与
//! `WM_SETTINGCHANGE` 广播、Unix shell rc 幂等块更新（备份 + 失败回滚），以及
//! 用户 pnpm 探测。
//!
//! 模块划分：
//! - [`pnpm`]：用户 pnpm 探测（PATH + mise/Windows 标准目录，排除本应用 shim）
//! - [`registry`]：Windows 注册表辅助（仅 Windows）
//! - [`rc`]：Unix shell rc 幂等块注入/移除（仅 Unix）

#[cfg(not(windows))]
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[cfg(windows)]
use super::shim::SHIM_CMD_NAME;
#[cfg(unix)]
use super::shim::SHIM_SH_NAME;
#[cfg(windows)]
use crate::config::CLI_ROOT_DEV_DIR_NAME;

#[cfg(not(windows))]
use rc::{inject_shell_rc, strip_shell_rc, RC_FILES, RC_MARK_START};
#[cfg(windows)]
use registry::{path_contains_token, read_user_path, remove_path_token, write_user_path};

mod pnpm;
mod rc;
#[cfg(windows)]
mod registry;

#[cfg(windows)]
pub(crate) use pnpm::find_user_pnpm_executable;
#[cfg(windows)]
pub(crate) use registry::{
    delete_user_env, notify_environment_change, read_user_env, write_user_env,
};
// 数据目录（issue #871）在 Unix 上复用 rc 的「标记块 + 备份写回」原语，
// 免得再抄一份 rc 文件读写实现。rc 模块本身是私有的，跨模块用要在这里再导出。
#[cfg(unix)]
pub(crate) use rc::{strip_rc_block, upsert_rc_block, write_rc_with_backup};
pub use pnpm::{find_user_pnpm, pnpm_env_value};

/// Windows 下 shim 根目录名（`%LOCALAPPDATA%\<此目录>\bin`）
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 bin 目录计算使用
const CLI_ROOT_DIR_NAME: &str = "deepseek-harness";

/// Unix 下 shim 所在目录（XDG 约定）
#[cfg(unix)]
const UNIX_BIN_DIR: &str = ".local/bin";

// ---------------------------------------------------------------------------
// 路径计算
// ---------------------------------------------------------------------------

/// bin 目录：
/// - Windows：`%LOCALAPPDATA%\deepseek-harness\bin`（用户级、不随应用数据目录变动）
/// - Unix：`~/.local/bin`（XDG 约定，通常已在 PATH 中）
pub fn get_bin_dir(app_handle: &AppHandle) -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                app_handle
                    .path()
                    .local_data_dir()
                    .ok()
                    .and_then(|d| d.parent().map(|p| p.to_path_buf()))
            })
            .unwrap_or_else(std::env::temp_dir)
            .join(if cfg!(debug_assertions) {
                CLI_ROOT_DEV_DIR_NAME
            } else {
                CLI_ROOT_DIR_NAME
            })
            .join("bin")
    }
    #[cfg(not(windows))]
    {
        let home = app_handle
            .path()
            .home_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        if cfg!(debug_assertions) {
            home.join(".local/bin/dev")
        } else {
            home.join(UNIX_BIN_DIR)
        }
    }
}

/// 主 shim 文件路径（状态展示用）
pub fn get_shim_path(app_handle: &AppHandle) -> PathBuf {
    let bin_dir = get_bin_dir(app_handle);
    #[cfg(windows)]
    {
        bin_dir.join(SHIM_CMD_NAME)
    }
    #[cfg(not(windows))]
    {
        bin_dir.join(SHIM_SH_NAME)
    }
}

/// 当前用户 PATH 中是否已包含 bin 目录（Windows 以注册表为准，
/// 因为进程内 PATH 在广播 WM_SETTINGCHANGE 后不会自动更新）
pub fn path_registered(app_handle: &AppHandle) -> bool {
    #[cfg(windows)]
    {
        let bin_dir = get_bin_dir(app_handle);
        let Some(bin_str) = bin_dir.to_str() else {
            return false;
        };
        read_user_path()
            .map(|value| path_contains_token(&value, bin_str))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let bin_dir = get_bin_dir(app_handle);
        // 1. 当前进程 PATH 已包含（新终端直接可用）
        if std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .any(|p| p == bin_dir)
        {
            return true;
        }
        // 2. rc 文件中已注入标记块（重启 shell 后可用）
        let home = app_handle
            .path()
            .home_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        RC_FILES.iter().any(|name| {
            fs::read_to_string(home.join(name))
                .map(|content| content.contains(RC_MARK_START))
                .unwrap_or(false)
        })
    }
}

// ---------------------------------------------------------------------------
// PATH 注册 / 注销（Windows：注册表 + WM_SETTINGCHANGE；Unix：shell rc）
// ---------------------------------------------------------------------------

/// 注册 bin 目录到用户 PATH（幂等）
pub fn register_path(app_handle: &AppHandle) -> Result<(), String> {
    if path_registered(app_handle) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let bin_dir = get_bin_dir(app_handle);
        let bin_str = bin_dir
            .to_str()
            .ok_or_else(|| "PATH_BIN_DIR_NOT_UTF8: bin dir is not valid UTF-8".to_string())?;
        // 注册表读取失败（None）时中止，绝不把失败当成空 PATH 写回（那会清空
        // 用户 PATH 其它条目）；`Path` 值缺失（ERROR_FILE_NOT_FOUND）返回的
        // Some("") 才按空串处理。
        let current = read_user_path()
            .ok_or_else(|| "PATH_REG_READ_FAILED: failed to read user PATH".to_string())?;
        let new_value = if current.trim().is_empty() {
            bin_str.to_string()
        } else {
            format!("{};{}", current.trim_end_matches(';'), bin_str)
        };
        write_user_path(&new_value)?;
        notify_environment_change();
        log::info!("Registered dsh bin dir in user PATH: {bin_str}");
    }
    #[cfg(not(windows))]
    {
        inject_shell_rc(app_handle)?;
    }
    Ok(())
}

/// 从用户 PATH 中移除 bin 目录（幂等）
pub fn unregister_path(app_handle: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let bin_dir = get_bin_dir(app_handle);
        let Some(bin_str) = bin_dir.to_str() else {
            return Ok(());
        };
        if let Some(current) = read_user_path() {
            if !path_contains_token(&current, bin_str) {
                return Ok(());
            }
            let new_value = remove_path_token(&current, bin_str);
            write_user_path(&new_value)?;
            notify_environment_change();
            log::info!("Removed dsh bin dir from user PATH");
        }
    }
    #[cfg(not(windows))]
    {
        strip_shell_rc(app_handle)?;
    }
    Ok(())
}

#[cfg(test)]
mod test_util {
    use std::path::Path;

    pub(super) fn make_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(path).unwrap().permissions();
            permissions.set_mode(0o700);
            std::fs::set_permissions(path, permissions).unwrap();
        }
        #[cfg(not(unix))]
        let _ = path;
    }

    pub(super) fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-rc-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
