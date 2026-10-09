pub(crate) fn verify() -> Result<(), String> {
    #[cfg(windows)]
    {
        let level = process_integrity_level()
            .map_err(|error| format!("STARTUP_INTEGRITY_CHECK_FAILED: {error}"))?;
        let executable = std::env::current_exe()
            .map_err(|error| format!("STARTUP_EXECUTABLE_PATH_FAILED: {error}"))?;
        if let Some(error) = integrity_error(level, &executable) {
            return Err(error);
        }
    }
    Ok(())
}

pub fn report(message: &str) {
    eprintln!("{message}");
    log::error!("{message}");
    #[cfg(windows)]
    rfd::MessageDialog::new()
        .set_title(format!(
            "{} — 启动失败 / Startup failed",
            env!("DSH_PRODUCT_NAME")
        ))
        .set_description(message)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

#[cfg(any(windows, test))]
fn integrity_error(level: u32, executable: &std::path::Path) -> Option<String> {
    (level < 0x2000).then(|| {
        format!(
            "STARTUP_LOW_INTEGRITY (RID {level})\n\n\
             当前进程的 Windows 完整性级别低于 Medium，无法安全写入正常用户的数据目录。\n\
             请检查可信安装目录及可执行文件的完整性标签，恢复为 Medium，或重新安装到正常目录后启动。\n\
             无需删除会话或修改 DSH_HOME。\n\n\
             This process runs below Medium integrity and cannot write normal user data.\n\
             Check the trusted installation folder and executable integrity labels; restore them to Medium or reinstall in a normal folder.\n\
             Do not delete sessions or change DSH_HOME.\n\n\
             Executable: {}",
            executable.display()
        )
    })
}

#[cfg(windows)]
fn process_integrity_level() -> std::io::Result<u32> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Security::{
        GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, IsValidSid,
        TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let token = OwnedHandle::from_raw_handle(token);
        let mut required = 0;
        GetTokenInformation(
            token.as_raw_handle(),
            TokenIntegrityLevel,
            std::ptr::null_mut(),
            0,
            &mut required,
        );
        if required < std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 {
            return Err(std::io::Error::last_os_error());
        }
        // TOKEN_MANDATORY_LABEL 含指针，缓冲区必须满足其对齐要求。
        let mut buffer = vec![0usize; (required as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(
            token.as_raw_handle(),
            TokenIntegrityLevel,
            buffer.as_mut_ptr().cast(),
            required,
            &mut required,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let sid = (*buffer.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
        if IsValidSid(sid) == 0 {
            return Err(std::io::Error::other("invalid process integrity SID"));
        }
        let count = *GetSidSubAuthorityCount(sid);
        if count == 0 {
            return Err(std::io::Error::other("empty process integrity SID"));
        }
        Ok(*GetSidSubAuthority(sid, u32::from(count - 1)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets};

    fn initialize_http(
        cache: &std::path::Path,
    ) -> tauri::Result<tauri::App<tauri::test::MockRuntime>> {
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = cache.to_string_lossy().into_owned();
        mock_builder()
            .plugin(tauri_plugin_http::init())
            .build(context)
    }

    #[test]
    fn public_asset_http_does_not_require_a_writable_cache_directory() {
        let scratch = tempfile::tempdir().unwrap();
        let cache = scratch.path().join("blocked-cache");
        std::fs::write(&cache, b"preserve this file").unwrap();
        let result = initialize_http(&cache);
        assert!(
            result.is_ok(),
            "HTTP initialization failed: {:?}",
            result.err()
        );
        assert_eq!(std::fs::read(cache).unwrap(), b"preserve this file");
    }

    #[test]
    fn public_asset_http_does_not_create_a_cookie_store() {
        let scratch = tempfile::tempdir().unwrap();
        let cache = scratch.path().join("unused-cache");
        let _app = initialize_http(&cache).unwrap();
        assert!(!cache.exists(), "public asset HTTP created a cookie cache");
    }

    #[test]
    fn only_below_medium_integrity_requires_repair() {
        let executable = std::path::Path::new("F:/Tool/DeepSeek Harness Desktop/app.exe");
        for level in [0, 0x1000, 0x1fff] {
            let error = integrity_error(level, executable).unwrap();
            assert!(error.starts_with("STARTUP_LOW_INTEGRITY"));
            assert!(error.contains(&executable.display().to_string()));
            assert!(error.contains("Do not delete sessions or change DSH_HOME"));
        }
        for level in [0x2000, 0x2010, 0x2100, 0x3000, 0x4000] {
            assert_eq!(integrity_error(level, executable), None);
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_low_integrity_process_shows_an_actionable_error_before_app_setup() {
        use std::os::windows::process::CommandExt;
        use windows_sys::core::BOOL;
        use windows_sys::Win32::Foundation::{HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, PostMessageW,
            WM_CLOSE,
        };

        unsafe extern "system" fn dismiss_error(window: HWND, parameter: LPARAM) -> BOOL {
            let probe = &mut *(parameter as *mut (u32, bool));
            let mut process = 0;
            GetWindowThreadProcessId(window, &mut process);
            if process == probe.0 && IsWindowVisible(window) != 0 {
                let mut title = [0u16; 256];
                let length = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
                let title = String::from_utf16_lossy(&title[..length as usize]);
                if title.contains(env!("DSH_PRODUCT_NAME")) && title.contains("Startup failed") {
                    probe.1 = PostMessageW(window, WM_CLOSE, 0, 0) != 0;
                    return 0;
                }
            }
            1
        }

        let home = tempfile::tempdir().unwrap();
        let local = home.path().join("AppData/Local");
        let roaming = home.path().join("AppData/Roaming");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(&roaming).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "desktop::startup::tests::low_integrity_child",
                "--nocapture",
            ])
            .env("DSH_TEST_LOW_INTEGRITY_CHILD", "1")
            .env("DSH_E2E_HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("HOME", home.path())
            .env("LOCALAPPDATA", local)
            .env("APPDATA", roaming)
            .creation_flags(0x08000000)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let mut probe = (child.id(), false);
        while child.try_wait().unwrap().is_none() {
            if !probe.1 {
                unsafe {
                    EnumWindows(Some(dismiss_error), std::ptr::addr_of_mut!(probe) as LPARAM);
                }
            }
            if std::time::Instant::now() >= deadline {
                child.kill().unwrap();
                let _ = child.wait();
                panic!("low-integrity startup did not return within 30 seconds");
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("LOW_INTEGRITY_GUARD_VERIFIED"));
        assert!(
            probe.1,
            "the low-integrity process did not display a native error dialog"
        );
    }

    #[cfg(windows)]
    #[test]
    fn low_integrity_child() {
        if std::env::var("DSH_TEST_LOW_INTEGRITY_CHILD").as_deref() != Ok("1") {
            return;
        }
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows_sys::Win32::Security::{
            SetTokenInformation, TokenIntegrityLevel, SID, SID_AND_ATTRIBUTES,
            SID_IDENTIFIER_AUTHORITY, TOKEN_ADJUST_DEFAULT, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::SystemServices::SE_GROUP_INTEGRITY;
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token = std::ptr::null_mut();
            assert_ne!(
                OpenProcessToken(
                    GetCurrentProcess(),
                    TOKEN_QUERY | TOKEN_ADJUST_DEFAULT,
                    &mut token
                ),
                0
            );
            let token = OwnedHandle::from_raw_handle(token);
            let mut sid = SID {
                Revision: 1,
                SubAuthorityCount: 1,
                IdentifierAuthority: SID_IDENTIFIER_AUTHORITY {
                    Value: [0, 0, 0, 0, 0, 16],
                },
                SubAuthority: [0x1000],
            };
            let label = TOKEN_MANDATORY_LABEL {
                Label: SID_AND_ATTRIBUTES {
                    Sid: std::ptr::addr_of_mut!(sid).cast(),
                    Attributes: SE_GROUP_INTEGRITY as u32,
                },
            };
            assert_ne!(
                SetTokenInformation(
                    token.as_raw_handle(),
                    TokenIntegrityLevel,
                    std::ptr::addr_of!(label).cast(),
                    (std::mem::size_of_val(&label) + std::mem::size_of_val(&sid)) as u32
                ),
                0,
                "{}",
                std::io::Error::last_os_error()
            );
        }
        assert_eq!(process_integrity_level().unwrap(), 0x1000);
        let error = crate::run().unwrap_err();
        assert!(error.starts_with("STARTUP_LOW_INTEGRITY"), "{error}");
        report(&error);
        println!("LOW_INTEGRITY_GUARD_VERIFIED");
    }
}
