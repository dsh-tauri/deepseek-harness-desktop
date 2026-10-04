//! 数据目录环境变量、默认目录、时间戳与磁盘空间。
//!
//! 用户级环境变量的读写按平台分流：
//! - Windows：复用 CLI 集成模块已泛化的 `service::cli::{read_user_env,
//!   write_user_env, delete_user_env}`，注册表 `HKCU\Environment` 全仓库只有一处
//!   写点，这里不再造第二份 Windows API 调用；
//! - macOS / Linux：落点是纯文本（`~/.profile` 标记块、macOS LaunchAgent、
//!   Linux `environment.d`），实现集中在 [`super::unix_env`]。
//!
//! 本文件只保留「与平台无关的语义」：默认目录、时间戳格式、可用空间预检，
//! 三个平台的时间戳与空间探测都必须产出同一形状的结果。

use std::path::PathBuf;

use crate::config::{DSH_HOME_DEV_DIR_NAME, DSH_HOME_DIR_NAME};

/// 数据目录环境变量名（官方 dsh、桌面端与 CLI shim 共用同一个值）
pub(super) const DATA_DIR_ENV: &str = "DSH_HOME";

/// 未设置 `DSH_HOME` 时的默认数据目录（release `~/.dsh`，debug `~/.dsh.dev`）。
///
/// 必须与 `config::get_dsh_data_path` 的默认分支逐字一致：回滚时靠它判断
/// 「原位置就是默认目录」并据此决定是清空环境变量还是写回一个具体路径。
pub(super) fn default_home() -> PathBuf {
    let name = if cfg!(debug_assertions) {
        DSH_HOME_DEV_DIR_NAME
    } else {
        DSH_HOME_DIR_NAME
    };
    crate::config::user_home_dir()
        .map(|home| home.join(name))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// 读取用户级 `DSH_HOME`（空白值视为未设置：注册表里可能留着空字符串）。
#[cfg(windows)]
pub(super) fn read_user_home() -> Result<Option<String>, String> {
    Ok(normalize(crate::service::cli::read_user_env(DATA_DIR_ENV)?))
}

/// Unix：值可能来自进程环境、~/.profile 的标记块或平台自己的会话文件
/// （macOS LaunchAgent / Linux environment.d），三者由 unix_env 统一处理。
#[cfg(not(windows))]
pub(super) fn read_user_home() -> Result<Option<String>, String> {
    Ok(normalize(super::unix_env::read_value()))
}

/// 写入用户级 `DSH_HOME` 并广播 `WM_SETTINGCHANGE`。
///
/// 广播只影响此后新建的进程：已经在跑的终端不会刷新环境变量，所以迁移完成后
/// 必须重开终端（面板文案里要写明这一点）。
#[cfg(windows)]
pub(super) fn write_user_home(value: &str) -> Result<(), String> {
    crate::service::cli::write_user_env(DATA_DIR_ENV, value)?;
    crate::service::cli::notify_environment_change();
    Ok(())
}

/// Unix：三处落点一起写（~/.profile 标记块、平台会话文件、当前进程环境），
/// 详见 unix_env。与 Windows 的注册表广播一样，只影响此后新建的进程。
#[cfg(not(windows))]
pub(super) fn write_user_home(value: &str) -> Result<(), String> {
    super::unix_env::write_value(value)
}

/// 清除用户级 `DSH_HOME`（回滚到默认目录时用）。
///
/// 默认目录不该在注册表里留一条冗余记录：`config::get_dsh_data_path` 在未设置时
/// 本来就会落到默认目录，写一条指向默认目录的值反而会掩盖用户后来的自定义设置。
#[cfg(windows)]
pub(super) fn clear_user_home() -> Result<(), String> {
    crate::service::cli::delete_user_env(DATA_DIR_ENV)?;
    crate::service::cli::notify_environment_change();
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn clear_user_home() -> Result<(), String> {
    super::unix_env::clear_value()
}

/// 本地时间戳 `yyyy-MM-ddTHH-mm-ss`。
///
/// 与恢复脚本的 `Get-Date -Format 'yyyy-MM-ddTHH-mm-ss'` 逐字一致：两边留下的
/// `.moved-*` 目录必须能互相识别（脚本用正则 `[0-9T-]+` 反推原路径，字符集必须一致）。
#[cfg(windows)]
pub(super) fn now_stamp() -> String {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;

    let mut time: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut time) };
    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}",
        time.wYear, time.wMonth, time.wDay, time.wHour, time.wMinute, time.wSecond
    )
}

/// Unix：本地时间戳，格式与 Windows 分支逐字一致（`yyyy-MM-ddTHH-mm-ss`）。
///
/// 用 `localtime_r` 而不是 UTC：`.moved-*` 目录名要能和用户看到的本地时间对上，
/// 同一天里的两次迁移也才在肉眼上可排序。取不到本地时间（极端情况下 tzdata 缺失）
/// 时退回 UTC，**绝不返回空串**——空串会让旧目录名退化成 `.moved-`，
/// `state::moved_stamp` 与 `find_moved_dirs` 的长度判据随之全部失效。
#[cfg(not(windows))]
pub(super) fn now_stamp() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as libc::time_t)
        .unwrap_or_default();
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    let filled = unsafe {
        libc::localtime_r(
            &seconds as *const libc::time_t,
            &mut local as *mut libc::tm,
        )
    };
    if !filled.is_null() {
        return format!(
            "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}",
            local.tm_year + 1900,
            local.tm_mon + 1,
            local.tm_mday,
            local.tm_hour,
            local.tm_min,
            local.tm_sec
        );
    }
    let utc = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}-{:02}-{:02}",
        utc.year(),
        u8::from(utc.month()),
        utc.day(),
        utc.hour(),
        utc.minute(),
        utc.second()
    )
}

/// 目标所在卷的可用字节数。
///
/// 目标目录通常还不存在，因此从最近的存在祖先取卷信息；连祖先都探不到
/// （相对路径、非法字符）时返回 `None`，调用方跳过预检而不是误报空间不足。
#[cfg(windows)]
pub(super) fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut probe = path.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let wide: Vec<u16> = probe
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut free = 0u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut free,
        )
    };
    (ok != 0).then_some(free)
}

/// Unix：`statvfs` 取目标所在文件系统的可用字节数（与 Windows 的 `GetDiskFreeSpaceExW`
/// 同款语义：从最近的存在祖先取卷信息）。
#[cfg(not(windows))]
pub(super) fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let mut probe = path.to_path_buf();
    while !probe.exists() {
        probe = probe.parent()?.to_path_buf();
    }
    let c_path = CString::new(probe.as_os_str().as_bytes()).ok()?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    // f_bavail 是非特权用户可用块数、f_frsize 是块大小；先转 u64 再乘，
    // 免得在 32 位平台上先乘后溢出。
    Some((stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64))
}

/// 空白字符串统一视为「未设置」。
fn normalize(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_treats_blank_as_unset() {
        assert_eq!(normalize(Some("  ".to_string())), None);
        assert_eq!(normalize(Some(String::new())), None);
        assert_eq!(normalize(None), None);
        assert_eq!(
            normalize(Some(" D:\\DSHHome ".to_string())),
            Some("D:\\DSHHome".to_string())
        );
    }

    #[test]
    fn default_home_matches_the_build_mode() {
        let home = default_home();
        let expected = if cfg!(debug_assertions) {
            DSH_HOME_DEV_DIR_NAME
        } else {
            DSH_HOME_DIR_NAME
        };
        assert_eq!(home.file_name().unwrap().to_str().unwrap(), expected);
    }

    #[test]
    fn stamp_has_the_script_compatible_shape() {
        let stamp = now_stamp();
        // yyyy-MM-ddTHH-mm-ss：脚本用 [0-9T-]+ 匹配，字符集必须完全一致，
        // 且三个平台都要真的产出时间戳（Unix 曾经返回空串，旧目录名会退化成
        // `.moved-`，`find_moved_dirs` 的长度判据随之失效）。
        assert_eq!(stamp.len(), 19);
        assert!(stamp
            .chars()
            .all(|c| c.is_ascii_digit() || c == 'T' || c == '-'));
        assert_eq!(&stamp[10..11], "T");
    }

    #[test]
    fn free_bytes_probes_the_nearest_existing_ancestor() {
        let missing = std::env::temp_dir()
            .join("dsh-data-dir-not-created")
            .join("deep");
        let free = free_bytes(&missing);
        assert!(free.is_some_and(|bytes| bytes > 0));
        assert_eq!(free_bytes(std::path::Path::new("relative-only")), None);
    }
}
