//! 桌面应用的系统登录启动集成。
//!
//! 跨平台注册交给 Tauri 官方插件；Windows 只补齐其底层库对缺失注册表键和
//! 重复禁用不幂等的问题，并清理由任务管理器维护的残留状态。

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

#[cfg(windows)]
use std::io::ErrorKind;
#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
#[cfg(windows)]
use winreg::RegKey;

#[cfg(windows)]
const RUN_REGISTRY_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
#[cfg(windows)]
const STARTUP_APPROVED_REGISTRY_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";

/// 稳定版保留旧启动项名称，避免改名后丢失已启用状态；夜间版和开发态独立注册。
pub fn app_name(identifier: &str) -> &'static str {
    match (identifier, cfg!(debug_assertions)) {
        ("dsh-tauri-nightly", true) => "DSH Tauri Nightly Dev",
        ("dsh-tauri-nightly", false) => "DSH Tauri Nightly",
        (_, true) => "Deepseek Harness Desktop Dev",
        (_, false) => "Deepseek Harness Desktop",
    }
}

/// macOS 应用改名会移动可执行文件，启动时仅刷新原已启用的登录启动项。
pub fn init<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    app.plugin(
        tauri_plugin_autostart::Builder::new()
            .app_name(app_name(&app.config().identifier))
            .build(),
    )?;
    #[cfg(target_os = "macos")]
    if let Err(error) = is_enabled(app).and_then(|enabled| {
        if enabled {
            set_enabled(app, true)
        } else {
            Ok(false)
        }
    }) {
        log::warn!("[autostart] failed to refresh enabled login item: {error}");
    }
    Ok(())
}

#[cfg(windows)]
fn windows_run_entry_exists(name: &str) -> Result<bool, String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let run_key = match current_user.open_subkey_with_flags(RUN_REGISTRY_KEY, KEY_READ) {
        Ok(key) => key,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    };
    match run_key.get_raw_value(name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    }
}

#[cfg(windows)]
fn ensure_windows_run_key() -> Result<(), String> {
    RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN_REGISTRY_KEY)
        .map(|_| ())
        .map_err(|error| format!("AUTOSTART_REGISTRY_FAILED: {error}"))
}

#[cfg(windows)]
fn remove_windows_startup_approval(name: &str) -> Result<(), String> {
    let current_user = RegKey::predef(HKEY_CURRENT_USER);
    let key =
        match current_user.open_subkey_with_flags(STARTUP_APPROVED_REGISTRY_KEY, KEY_SET_VALUE) {
            Ok(key) => key,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
        };
    match key.delete_value(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("AUTOSTART_REGISTRY_FAILED: {error}")),
    }
}

/// 从系统读取当前登录启动状态，允许用户在系统设置中直接修改它。
pub fn is_enabled<R: Runtime>(app_handle: &AppHandle<R>) -> Result<bool, String> {
    #[cfg(windows)]
    if !windows_run_entry_exists(app_name(&app_handle.config().identifier))? {
        return Ok(false);
    }

    app_handle
        .autolaunch()
        .is_enabled()
        .map_err(|error| format!("AUTOSTART_STATUS_FAILED: {error}"))
}

/// 写入登录启动状态并复查结果，禁用操作保持幂等。
pub fn set_enabled<R: Runtime>(app_handle: &AppHandle<R>, enabled: bool) -> Result<bool, String> {
    let manager = app_handle.autolaunch();
    if enabled {
        #[cfg(windows)]
        ensure_windows_run_key()?;
        manager
            .enable()
            .map_err(|error| format!("AUTOSTART_ENABLE_FAILED: {error}"))?;
    } else {
        #[cfg(windows)]
        {
            if windows_run_entry_exists(app_name(&app_handle.config().identifier))? {
                manager
                    .disable()
                    .map_err(|error| format!("AUTOSTART_DISABLE_FAILED: {error}"))?;
            }
            remove_windows_startup_approval(app_name(&app_handle.config().identifier))?;
        }
        #[cfg(not(windows))]
        manager
            .disable()
            .map_err(|error| format!("AUTOSTART_DISABLE_FAILED: {error}"))?;
    }

    let actual = is_enabled(app_handle)?;
    if actual != enabled {
        return Err(format!(
            "AUTOSTART_STATE_MISMATCH: requested {enabled}, actual {actual}"
        ));
    }
    Ok(actual)
}

#[cfg(test)]
mod tests {
    use auto_launch::{AutoLaunch, AutoLaunchBuilder};
    use std::path::PathBuf;

    #[cfg(windows)]
    use super::{
        ensure_windows_run_key, remove_windows_startup_approval, windows_run_entry_exists,
        RUN_REGISTRY_KEY, STARTUP_APPROVED_REGISTRY_KEY,
    };
    #[cfg(windows)]
    use winreg::enums::{RegType, HKEY_CURRENT_USER, KEY_READ};
    #[cfg(windows)]
    use winreg::{RegKey, RegValue};

    const TEST_APP_NAME: &str = "Deepseek Harness Desktop Autostart Test";
    const SYSTEM_TEST_ENV: &str = "DSH_RUN_AUTOSTART_TESTS";
    #[cfg(windows)]
    const STARTUP_APPROVED_ENABLED_VALUE: [u8; 12] = [
        0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];

    struct AutostartCleanup {
        manager: AutoLaunch,
    }

    impl Drop for AutostartCleanup {
        fn drop(&mut self) {
            let _ = clear_test_entry(&self.manager);
        }
    }

    fn test_manager() -> (AutoLaunch, PathBuf) {
        let executable = std::env::current_exe().expect("test executable path should be available");
        let manager = AutoLaunchBuilder::new()
            .set_app_name(TEST_APP_NAME)
            .set_app_path(executable.to_string_lossy().as_ref())
            .set_use_launch_agent(true)
            .build()
            .expect("test autostart manager should build");
        (manager, executable)
    }

    /// 系统级测试只在 CI 或显式启用时运行，避免受限环境误报失败。
    fn system_test_enabled() -> bool {
        std::env::var_os("CI").is_some() || std::env::var_os(SYSTEM_TEST_ENV).is_some()
    }

    fn is_restricted_error(error: &str) -> bool {
        let error = error.to_ascii_lowercase();
        error.contains("access is denied")
            || error.contains("permission denied")
            || error.contains("operation not permitted")
            || error.contains("os error 5")
            || error.contains("os error 13")
    }

    /// 权限受限时跳过系统集成测试，其它错误仍视为真实失败。
    fn system_test_result<T, E: std::fmt::Display>(
        result: Result<T, E>,
        action: &str,
    ) -> Option<T> {
        match result {
            Ok(value) => Some(value),
            Err(error) if is_restricted_error(&error.to_string()) => {
                eprintln!("skipped: {action} is unavailable in this environment: {error}");
                None
            }
            Err(error) => panic!("{action} failed: {error}"),
        }
    }

    #[cfg(windows)]
    fn clear_test_entry(manager: &AutoLaunch) -> Result<(), String> {
        ensure_windows_run_key()?;
        if windows_run_entry_exists(TEST_APP_NAME)? {
            manager
                .disable()
                .map_err(|error| format!("AUTOSTART_TEST_CLEANUP_FAILED: {error}"))?;
        }
        remove_windows_startup_approval(TEST_APP_NAME)
    }

    #[cfg(not(windows))]
    fn clear_test_entry(manager: &AutoLaunch) -> Result<(), String> {
        manager
            .disable()
            .map_err(|error| format!("AUTOSTART_TEST_CLEANUP_FAILED: {error}"))
    }

    fn enable_test_entry() -> Option<(AutostartCleanup, PathBuf)> {
        let (manager, executable) = test_manager();
        system_test_result(
            clear_test_entry(&manager),
            "removing the stale test autostart entry",
        )?;
        let cleanup = AutostartCleanup { manager };

        let initially_enabled = system_test_result(
            cleanup.manager.is_enabled(),
            "reading the disabled autostart state",
        )?;
        assert!(
            !initially_enabled,
            "test autostart entry should start disabled"
        );
        system_test_result(
            cleanup.manager.enable(),
            "enabling the test autostart entry",
        )?;
        let enabled = system_test_result(
            cleanup.manager.is_enabled(),
            "reading the enabled autostart state",
        )?;
        assert!(enabled, "test autostart entry should be enabled");

        Some((cleanup, executable))
    }

    fn assert_disable_is_idempotent(cleanup: &AutostartCleanup) {
        clear_test_entry(&cleanup.manager).expect("test autostart entry should disable");
        assert!(
            !cleanup
                .manager
                .is_enabled()
                .expect("disabled state should be readable"),
            "test autostart entry should be disabled"
        );
        clear_test_entry(&cleanup.manager).expect("repeated disable should be idempotent");
    }

    #[test]
    fn stable_autostart_name_preserves_existing_registration() {
        #[cfg(debug_assertions)]
        assert_eq!(super::app_name("dsh-tauri"), "Deepseek Harness Desktop Dev");
        #[cfg(not(debug_assertions))]
        assert_eq!(super::app_name("dsh-tauri"), "Deepseek Harness Desktop");
    }

    #[test]
    fn nightly_autostart_name_has_separate_registration() {
        #[cfg(debug_assertions)]
        assert_eq!(
            super::app_name("dsh-tauri-nightly"),
            "DSH Tauri Nightly Dev"
        );
        #[cfg(not(debug_assertions))]
        assert_eq!(super::app_name("dsh-tauri-nightly"), "DSH Tauri Nightly");
    }

    #[cfg(windows)]
    #[test]
    fn windows_autostart_registration_round_trip() {
        if !system_test_enabled() {
            eprintln!("skipped: set {SYSTEM_TEST_ENV}=1 to run the Windows autostart system test");
            return;
        }

        let startup_approved = system_test_result(
            RegKey::predef(HKEY_CURRENT_USER).create_subkey(STARTUP_APPROVED_REGISTRY_KEY),
            "opening the StartupApproved Run key",
        );
        let Some((startup_approved, _)) = startup_approved else {
            return;
        };
        if system_test_result(
            startup_approved.set_raw_value(
                TEST_APP_NAME,
                &RegValue {
                    vtype: RegType::REG_BINARY,
                    bytes: vec![0x03; 12],
                },
            ),
            "writing the disabled test approval value",
        )
        .is_none()
        {
            return;
        }

        let Some((cleanup, executable)) = enable_test_entry() else {
            return;
        };
        let value: String = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(RUN_REGISTRY_KEY, KEY_READ)
            .expect("Windows Run key should be readable")
            .get_value(TEST_APP_NAME)
            .expect("test Run value should exist");
        assert!(
            value.contains(executable.to_string_lossy().as_ref()),
            "Run value should contain the current test executable"
        );
        let approval = startup_approved
            .get_raw_value(TEST_APP_NAME)
            .expect("enabled StartupApproved value should exist");
        assert_eq!(approval.vtype, RegType::REG_BINARY);
        assert_eq!(approval.bytes, STARTUP_APPROVED_ENABLED_VALUE);

        assert_disable_is_idempotent(&cleanup);
        assert!(
            startup_approved.get_raw_value(TEST_APP_NAME).is_err(),
            "StartupApproved value should be removed after disabling"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_init_refreshes_only_enabled_login_items() {
        use tauri::test::{mock_builder, mock_context, noop_assets};

        const CHILD_HOME: &str = "DSH_TEST_AUTOSTART_HOME";
        let Some(home) = std::env::var_os(CHILD_HOME).map(PathBuf::from) else {
            let home = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "desktop::autostart::tests::macos_init_refreshes_only_enabled_login_items",
                    "--nocapture",
                ])
                .env(CHILD_HOME, home.path())
                .env("HOME", home.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated autostart init failed: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(String::from_utf8_lossy(&output.stdout).contains("AUTOSTART_INIT_VERIFIED"));
            return;
        };
        assert_eq!(
            std::env::var_os("HOME"),
            Some(home.clone().into_os_string())
        );
        std::fs::create_dir_all(home.join("Library")).unwrap();
        let name = if cfg!(debug_assertions) {
            "Deepseek Harness Desktop Dev"
        } else {
            "Deepseek Harness Desktop"
        };
        let plist = home
            .join("Library/LaunchAgents")
            .join(format!("{name}.plist"));
        let old_executable = home.join(
            "Applications/Deepseek Harness Desktop.app/Contents/MacOS/deepseek-harness-desktop",
        );
        std::fs::create_dir_all(old_executable.parent().unwrap()).unwrap();
        std::fs::write(&old_executable, b"").unwrap();
        let previous = AutoLaunchBuilder::new()
            .set_app_name(name)
            .set_app_path(old_executable.to_string_lossy().as_ref())
            .set_use_launch_agent(true)
            .build()
            .unwrap();
        let executable = std::env::current_exe().unwrap().canonicalize().unwrap();

        for enabled in [false, true] {
            if enabled {
                previous.enable().unwrap();
                let content = std::fs::read_to_string(&plist).unwrap();
                assert!(content.contains(&format!("<string>{}</string>", old_executable.display())));
            }
            let mut context = mock_context(noop_assets());
            context.config_mut().identifier = "dsh-tauri".into();
            context.config_mut().product_name = Some("DSH Tauri".into());
            let app = mock_builder().build(context).unwrap();
            super::init(app.handle()).unwrap();
            assert_eq!(super::is_enabled(app.handle()).unwrap(), enabled);
            if enabled {
                let content = std::fs::read_to_string(&plist).unwrap();
                assert!(
                    content.contains(&format!("<string>{}</string>", executable.display())),
                    "enabled login item must target the current executable"
                );
                assert!(!content.contains(old_executable.to_string_lossy().as_ref()));
            } else {
                assert!(
                    !plist.exists(),
                    "init must not enable a disabled login item"
                );
            }
        }
        println!("AUTOSTART_INIT_VERIFIED");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_autostart_registration_round_trip() {
        if !system_test_enabled() {
            eprintln!("skipped: set {SYSTEM_TEST_ENV}=1 to run the macOS autostart system test");
            return;
        }

        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            eprintln!("skipped: HOME is unavailable in this environment");
            return;
        };
        if system_test_result(
            std::fs::create_dir_all(home.join("Library")),
            "preparing the macOS user Library directory",
        )
        .is_none()
        {
            return;
        }
        let Some((cleanup, executable)) = enable_test_entry() else {
            return;
        };
        let plist = home
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{TEST_APP_NAME}.plist"));
        let Some(content) = system_test_result(
            std::fs::read_to_string(&plist),
            "reading the LaunchAgent plist",
        ) else {
            return;
        };
        assert!(content.contains(&format!("<string>{TEST_APP_NAME}</string>")));
        assert!(content.contains(&format!("<string>{}</string>", executable.display())));
        let Some(status) = system_test_result(
            std::process::Command::new("plutil")
                .args(["-lint", plist.to_string_lossy().as_ref()])
                .status(),
            "running plutil",
        ) else {
            return;
        };
        assert!(status.success(), "LaunchAgent plist should be valid");
        assert_disable_is_idempotent(&cleanup);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_autostart_registration_round_trip() {
        if !system_test_enabled() {
            eprintln!("skipped: set {SYSTEM_TEST_ENV}=1 to run the Linux autostart system test");
            return;
        }

        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            eprintln!("skipped: HOME is unavailable in this environment");
            return;
        };
        if system_test_result(
            std::fs::create_dir_all(home.join(".config")),
            "preparing the Linux user config directory",
        )
        .is_none()
        {
            return;
        }
        let Some((cleanup, executable)) = enable_test_entry() else {
            return;
        };
        let desktop_entry = home
            .join(".config")
            .join("autostart")
            .join(format!("{TEST_APP_NAME}.desktop"));
        let Some(content) = system_test_result(
            std::fs::read_to_string(desktop_entry),
            "reading the Linux desktop entry",
        ) else {
            return;
        };
        assert!(content.contains(&format!("Name={TEST_APP_NAME}")));
        assert!(content.contains(&format!("Exec={}", executable.display())));
        assert_disable_is_idempotent(&cleanup);
    }
}
