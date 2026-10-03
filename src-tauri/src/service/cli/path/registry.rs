//! Windows 注册表辅助：HKCU\\Environment 下用户级环境变量的读取、写入与删除、
//! WM_SETTINGCHANGE 广播，以及 PATH token 的展开与匹配。仅 Windows 编译
//! （mod registry 已在 mod.rs 门控）。
//!
//! 变量名只是同一个注册表入口的参数：read_user_env / write_user_env /
//! delete_user_env 是唯一实现；read_user_path / write_user_path 是旧 PATH 语义的
//! 薄封装，保留 Option<String> 返回值以兼容既有调用方。

/// 将 Rust 字符串转为 Win32 API 需要的 NUL 结尾 UTF-16 缓冲
#[inline]
pub(super) fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 读取用户 PATH。既有调用方以 None 表示读取失败、空串表示未设置，因此把
/// Ok(None) 映射回空串以保持语义不变。
pub(super) fn read_user_path() -> Option<String> {
    match read_user_env("Path") {
        Ok(Some(value)) => Some(value),
        Ok(None) => Some(String::new()),
        Err(_) => None,
    }
}

/// 读取用户环境变量：Ok(None) 表示该变量未设置，Err 表示注册表读取失败。
///
/// 失败必须与「未设置/空值」区分：把读取失败当成空值会让上层覆盖用户已有设置，
/// PATH 注册逻辑正是靠 None 才敢中止写入。值类型不做限制，REG_SZ 与 REG_EXPAND_SZ
/// 都按字符串返回，其中的 %VAR% 原样保留。
pub(crate) fn read_user_env(name: &str) -> Result<Option<String>, String> {
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key_name = to_wide_null("Environment");
        let ret = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_QUERY_VALUE,
            &mut hkey,
        );
        if ret != 0 {
            log::warn!("failed to open HKCU\\Environment (error {ret})");
            return Err(format!(
                "REG_OPEN_FAILED: failed to open HKCU\\Environment (error {ret})"
            ));
        }

        let value_name = to_wide_null(name);
        let mut value_type: u32 = 0;
        let mut size: u32 = 0;
        let mut ret = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut size,
        );

        if ret == ERROR_FILE_NOT_FOUND {
            RegCloseKey(hkey);
            return Ok(None);
        }
        if ret != ERROR_MORE_DATA && ret != 0 {
            RegCloseKey(hkey);
            log::warn!("failed to query HKCU\\Environment\\{name} (error {ret})");
            return Err(format!(
                "REG_QUERY_FAILED: failed to query HKCU\\Environment\\{name} (error {ret})"
            ));
        }

        let mut buf = vec![0u16; (size as usize / 2).max(1) + 1];
        ret = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            buf.as_mut_ptr() as *mut u8,
            &mut size,
        );
        RegCloseKey(hkey);

        if ret != 0 {
            log::warn!("failed to read HKCU\\Environment\\{name} (error {ret})");
            return Err(format!(
                "REG_QUERY_FAILED: failed to read HKCU\\Environment\\{name} (error {ret})"
            ));
        }
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Ok(Some(String::from_utf16_lossy(&buf[..end])))
    }
}

/// 写入用户 PATH
pub(super) fn write_user_path(new_value: &str) -> Result<(), String> {
    write_user_env("Path", new_value)
}

/// 写入（或新建）用户环境变量。
///
/// 沿用已有值的数据类型（REG_SZ / REG_EXPAND_SZ）；值不存在时按 REG_EXPAND_SZ
/// 创建，与 Windows 自身写用户环境变量的行为一致。写注册表不会通知已运行的
/// 进程，需要新值对后续进程生效时由调用方广播 notify_environment_change。
pub(crate) fn write_user_env(name: &str, value: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key_name = to_wide_null("Environment");
        let ret = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_SET_VALUE,
            &mut hkey,
        );
        if ret != 0 {
            return Err(format!(
                "REG_OPEN_FAILED: failed to open HKCU\\Environment (error {ret})"
            ));
        }

        let value_name = to_wide_null(name);
        let mut value_type: u32 = REG_EXPAND_SZ;
        let mut size: u32 = 0;
        RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null(),
            &mut value_type,
            std::ptr::null_mut(),
            &mut size,
        );
        if value_type != REG_SZ && value_type != REG_EXPAND_SZ {
            value_type = REG_EXPAND_SZ;
        }

        let wide_value = to_wide_null(value);
        let bytes = (wide_value.len() * 2) as u32;
        let ret = RegSetValueExW(
            hkey,
            value_name.as_ptr(),
            0,
            value_type,
            wide_value.as_ptr() as *const u8,
            bytes,
        );
        RegCloseKey(hkey);

        if ret != 0 {
            return Err(format!(
                "REG_WRITE_FAILED: failed to write HKCU\\Environment\\{name} (error {ret})"
            ));
        }
        Ok(())
    }
}

/// 删除用户环境变量；变量本就不存在时视为成功（删除是幂等收尾动作）。
pub(crate) fn delete_user_env(name: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    };

    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let key_name = to_wide_null("Environment");
        let ret = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            key_name.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut hkey,
        );
        if ret != 0 {
            return Err(format!(
                "REG_OPEN_FAILED: failed to open HKCU\\Environment (error {ret})"
            ));
        }

        let value_name = to_wide_null(name);
        let ret = RegDeleteValueW(hkey, value_name.as_ptr());
        RegCloseKey(hkey);

        if ret != 0 && ret != ERROR_FILE_NOT_FOUND {
            return Err(format!(
                "REG_DELETE_FAILED: failed to delete HKCU\\Environment\\{name} (error {ret})"
            ));
        }
        Ok(())
    }
}

/// 广播 WM_SETTINGCHANGE，让资源管理器与后续启动的程序重新读取环境变量
pub(crate) fn notify_environment_change() {
    use windows_sys::Win32::Foundation::{LPARAM, WPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let wide = to_wide_null("Environment");
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0 as WPARAM,
            wide.as_ptr() as LPARAM,
            SMTO_ABORTIFHUNG,
            5000,
            std::ptr::null_mut(),
        );
    }
}

/// 展开字符串中的 %VAR%（Windows）
fn expand_env(value: &str) -> String {
    use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
    let wide = to_wide_null(value);
    let mut buf = vec![0u16; 32768];
    let n = unsafe { ExpandEnvironmentStringsW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if n == 0 || n > buf.len() as u32 {
        return value.to_string();
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// PATH 值（分号分隔）中是否已包含指定目录（大小写不敏感，先展开 %VAR%）
pub(super) fn path_contains_token(path_value: &str, token: &str) -> bool {
    let expanded = expand_env(path_value);
    let token_lower = token.to_lowercase();
    expanded
        .split(';')
        .any(|p| !p.is_empty() && p.trim_end_matches('\\').to_lowercase() == token_lower)
}

/// 从 PATH 值中移除指定目录 token（同时处理 %LOCALAPPDATA% 未展开形式）
pub(super) fn remove_path_token(path_value: &str, token: &str) -> String {
    let token_lower = token.to_lowercase();
    let unexpanded_lower = token_lower.replace(
        &std::env::var("LOCALAPPDATA")
            .unwrap_or_default()
            .to_lowercase(),
        "%localappdata%",
    );
    let kept: Vec<&str> = path_value
        .split(';')
        .filter(|p| {
            if p.is_empty() {
                return false;
            }
            let norm = p.trim_end_matches('\\').to_lowercase();
            norm != token_lower && norm != unexpanded_lower
        })
        .collect();
    kept.join(";")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_wide_null_is_nul_terminated_utf16() {
        let wide = to_wide_null("D:\\DSHHome");
        assert_eq!(wide.last().copied(), Some(0));
        assert_eq!(
            String::from_utf16_lossy(&wide[..wide.len() - 1]),
            "D:\\DSHHome"
        );
    }

    /// 匹配规则是「整段比较 + 大小写归一 + PATH 项尾部反斜杠归一」，不做前缀匹配：
    /// D:\\Tools 不应命中 D:\\Tools2，否则注册表写入会误判为「已注册」。
    /// 归一发生在 PATH 项一侧，因此调用方传入的 token 必须本身不带尾部反斜杠
    /// （get_bin_dir 由 PathBuf::join 拼出，满足该前提）。
    #[test]
    fn path_token_match_normalizes_case_and_trailing_separator() {
        let value = "C:\\Windows;D:\\Tools\\;E:\\Tools2";
        assert!(path_contains_token(value, "d:\\tools"));
        assert!(path_contains_token(value, "D:\\Tools"));
        assert!(!path_contains_token(value, "D:\\Tool"));
        assert!(!path_contains_token(value, "E:\\Tool"));
    }

    #[test]
    fn remove_path_token_drops_empty_segments() {
        let value = "C:\\Windows;D:\\Tools;;";
        assert_eq!(remove_path_token(value, "D:\\Tools"), "C:\\Windows");
    }
}
