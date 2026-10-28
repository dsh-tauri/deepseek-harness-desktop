use super::*;
use crate::config;
use crate::service::core::source::{active_source, CoreSource};
use crate::service::workflow;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::Manager;

#[test]
fn local_update_isolation_checks_real_state_before_running_the_package_manager() {
    for case in [
        "active-local",
        "automatic-local",
        "fallback-success",
        "fallback-failure",
        "automatic-fallback-success",
        "managed-success",
        "unchanged-version",
        "missing-version",
        "pnpm-success",
        "query-failure",
        "query-invalid",
        "query-array",
        "missing-app",
        "unsupported-app",
        "unreadable-app",
        "transition-reread",
        "holds-transition",
    ] {
        let scratch = tempfile::tempdir().unwrap();
        let home = scratch.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let bin = scratch.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let local_bin = bin.join(if cfg!(windows) { "dsh.cmd" } else { "dsh" });
        std::fs::write(&local_bin, "local dsh fixture").unwrap();
        let marker = scratch.path().join("pm-called");
        let script = if cfg!(windows) {
            "@echo off\r\nif \"%1\"==\"view\" goto query\r\necho %* > \"%DSH_TEST_LOCAL_UPDATE_MARKER%\"\r\n\"%DSH_TEST_LOCAL_UPDATE_EXE%\" --exact service::core::local::local_update_tests::local_update_package_manager_child --nocapture --test-threads=1\r\nexit /b %errorlevel%\r\n:query\r\necho %* > \"%DSH_TEST_LOCAL_UPDATE_SCRATCH%/pm-query\"\r\nif \"%DSH_TEST_LOCAL_UPDATE_CASE%\"==\"query-failure\" exit /b 1\r\nif \"%DSH_TEST_LOCAL_UPDATE_CASE%\"==\"query-invalid\" goto invalid\r\nif \"%DSH_TEST_LOCAL_UPDATE_CASE%\"==\"query-array\" goto array\r\necho \"0.2.1-rc.5\"\r\nexit /b 0\r\n:array\r\necho [\"0.2.1-rc.5\"]\r\nexit /b 0\r\n:invalid\r\necho invalid\r\nexit /b 0\r\n"
        } else {
            "#!/bin/sh\nif [ \"$1\" = view ]; then\n printf '%s\\n' \"$*\" > \"$DSH_TEST_LOCAL_UPDATE_SCRATCH/pm-query\"\n if [ \"$DSH_TEST_LOCAL_UPDATE_CASE\" = query-failure ]; then exit 1; fi\n if [ \"$DSH_TEST_LOCAL_UPDATE_CASE\" = query-invalid ]; then printf 'invalid\\n'; elif [ \"$DSH_TEST_LOCAL_UPDATE_CASE\" = query-array ]; then printf '[\"0.2.1-rc.5\"]\\n'; else printf '\"0.2.1-rc.5\"\\n'; fi\n exit 0\nfi\nprintf '%s\\n' \"$*\" > \"$DSH_TEST_LOCAL_UPDATE_MARKER\"\nexec \"$DSH_TEST_LOCAL_UPDATE_EXE\" --exact service::core::local::local_update_tests::local_update_package_manager_child --nocapture --test-threads=1\n"
        };
        for pm in ["npm", "pnpm"] {
            let path = bin.join(if cfg!(windows) {
                format!("{pm}.cmd")
            } else {
                pm.into()
            });
            std::fs::write(&path, script).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "service::core::local::local_update_tests::local_update_isolation_child",
                "--nocapture",
            ])
            .env("DSH_TEST_LOCAL_UPDATE_CASE", case)
            .env("DSH_TEST_LOCAL_UPDATE_SCRATCH", scratch.path())
            .env("DSH_TEST_LOCAL_UPDATE_MARKER", &marker)
            .env(
                "DSH_TEST_LOCAL_UPDATE_EXE",
                std::env::current_exe().unwrap(),
            )
            .env("DSH_CLI_PATH", &local_bin)
            .env("PATH", &bin)
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("APPDATA", home.join("AppData/Roaming"))
            .env("LOCALAPPDATA", home.join("AppData/Local"))
            .env("XDG_DATA_HOME", home.join(".local/share"))
            .env("DSH_HOME", home.join(".dsh"))
            .env("DSH_E2E_HOME", &home)
            .env("TAURI_WEBDRIVER_PORT", "4445")
            .env(
                "DSH_DOWNLOAD_CACHE_DIR",
                scratch.path().join("dependencies"),
            )
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        while child.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let taskkill = std::path::PathBuf::from(
                        std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
                    )
                    .join("System32/taskkill.exe");
                    let _ = Command::new(taskkill)
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .status();
                }
                let _ = child.kill();
                let _ = child.wait();
                panic!("local update isolation timed out: {case}");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "local update isolation failed ({case}): {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("LOCAL_UPDATE_ISOLATION_VERIFIED"));
    }
}

#[test]
fn local_update_package_manager_child() {
    let Ok(case) = std::env::var("DSH_TEST_LOCAL_UPDATE_CASE") else {
        return;
    };
    let scratch = PathBuf::from(std::env::var_os("DSH_TEST_LOCAL_UPDATE_SCRATCH").unwrap());
    if case == "holds-transition" {
        std::fs::write(scratch.join("pm-started"), "started").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !scratch.join("pm-release").exists() {
            assert!(
                Instant::now() < deadline,
                "fixture package manager was not released"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    if case == "fallback-failure" {
        eprintln!("fixture package manager failed");
        std::process::exit(1);
    }
    let package = if case == "pnpm-success" {
        scratch.join("bin/global/5/node_modules/@deepseek-ai/dsh")
    } else {
        scratch.join("node_modules/@deepseek-ai/dsh")
    };
    if case == "unchanged-version" {
        return;
    }
    if case == "missing-version" {
        std::fs::remove_file(package.join("package.json")).unwrap();
        return;
    }
    std::fs::write(
        package.join("package.json"),
        br#"{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.5"}"#,
    )
    .unwrap();
}

#[test]
fn local_update_isolation_child() {
    let Ok(case) = std::env::var("DSH_TEST_LOCAL_UPDATE_CASE") else {
        return;
    };
    let scratch = PathBuf::from(std::env::var_os("DSH_TEST_LOCAL_UPDATE_SCRATCH").unwrap());
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().app.app_directories_override = Some(
        tauri::utils::config::AppDirectoriesOverride::Root(scratch.join("app-data")),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_store::Builder::default().build())
        .build(context)
        .unwrap();
    assert!(app.path().app_data_dir().unwrap().starts_with(&scratch));
    let package = if case == "pnpm-success" {
        scratch.join("bin/global/5/node_modules/@deepseek-ai/dsh")
    } else {
        scratch.join("node_modules/@deepseek-ai/dsh")
    };
    std::fs::create_dir_all(package.join("lib")).unwrap();
    std::fs::write(package.join("lib/bin.js"), "local entry").unwrap();
    let local_version = if matches!(
        case.as_str(),
        "active-local" | "automatic-local" | "managed-success"
    ) {
        "0.2.1-rc.4"
    } else if matches!(
        case.as_str(),
        "unchanged-version" | "missing-version" | "pnpm-success"
    ) {
        "0.2.0-rc.2"
    } else {
        "0.1.6"
    };
    std::fs::write(
        package.join("package.json"),
        format!(r#"{{"name":"@deepseek-ai/dsh","version":"{local_version}"}}"#),
    )
    .unwrap();
    let managed = config::get_dsh_install_path(app.handle());
    let entry = config::get_dsh_binary_path(app.handle());
    assert!(managed.starts_with(&scratch));
    assert!(entry.starts_with(&managed));
    std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
    if case != "missing-app" {
        std::fs::write(&entry, "managed entry").unwrap();
    }
    let managed_manifest = if case == "unsupported-app" {
        br#"{"dependencies":{"@deepseek-ai/dsh":"0.1.6"}}"#.as_slice()
    } else if case == "unreadable-app" {
        b"not json".as_slice()
    } else {
        br#"{"dependencies":{"@deepseek-ai/dsh":"0.2.1-rc.4"}}"#.as_slice()
    };
    std::fs::write(managed.join("package.json"), managed_manifest).unwrap();
    let profile = config::get_dsh_data_path(app.handle()).join("profiles/keep-profile");
    assert!(profile.starts_with(&scratch));
    std::fs::create_dir_all(&profile).unwrap();
    std::fs::write(profile.join("config.jsonc"), "keep config").unwrap();
    std::fs::write(profile.join("session.jsonl"), "keep session").unwrap();
    let original = config::update_store_dat_setting(app.handle(), |setting| {
        setting.active_profile = "keep-profile".into();
        setting.active_core = if matches!(
            case.as_str(),
            "automatic-local" | "automatic-fallback-success"
        ) {
            None
        } else if matches!(
            case.as_str(),
            "active-local" | "fallback-success" | "fallback-failure" | "holds-transition"
        ) {
            Some("local".into())
        } else {
            Some("app".into())
        };
    });
    assert_eq!(local_core(app.handle()).unwrap().version, local_version);
    let marker = scratch.join("pm-called");
    tauri::async_runtime::block_on(async {
        if case == "transition-reread" {
            let guard = workflow::acquire_core_transition().await.unwrap();
            let handle = app.handle().clone();
            let task = tokio::spawn(async move { update_local_core(handle).await });
            tokio::time::sleep(Duration::from_millis(40)).await;
            assert!(
                !task.is_finished(),
                "update must wait for the shared transition lock"
            );
            std::fs::write(
                package.join("package.json"),
                br#"{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.4"}"#,
            )
            .unwrap();
            config::update_store_dat_setting(app.handle(), |setting| {
                setting.active_core = Some("local".into());
            });
            drop(guard);
            let error = task.await.unwrap().unwrap_err();
            assert!(
                error.starts_with("CORE_LOCAL_UPDATE_REQUIRES_APP:"),
                "{error}"
            );
            assert!(!marker.exists());
        } else if case == "holds-transition" {
            let handle = app.handle().clone();
            let task = tokio::spawn(async move { update_local_core(handle).await });
            tokio::time::timeout(Duration::from_secs(5), async {
                while !scratch.join("pm-started").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            assert_eq!(
                config::get_store_dat_setting(app.handle())
                    .active_core
                    .as_deref(),
                Some("app")
            );
            let mut stale = original.clone();
            stale.language = "en-US".into();
            config::set_store_dat_setting(app.handle(), stale);
            assert_eq!(
                config::get_store_dat_setting(app.handle())
                    .active_core
                    .as_deref(),
                Some("app")
            );
            assert!(tokio::time::timeout(
                Duration::from_millis(40),
                workflow::acquire_core_transition()
            )
            .await
            .is_err());
            std::fs::write(scratch.join("pm-release"), "release").unwrap();
            assert_eq!(task.await.unwrap().unwrap(), "0.2.1-rc.5");
            let _guard =
                tokio::time::timeout(Duration::from_secs(1), workflow::acquire_core_transition())
                    .await
                    .unwrap()
                    .unwrap();
            assert_eq!(active_source(app.handle()), CoreSource::App);
        } else {
            let result = update_local_core(app.handle().clone()).await;
            if matches!(
                case.as_str(),
                "active-local"
                    | "automatic-local"
                    | "missing-app"
                    | "unsupported-app"
                    | "unreadable-app"
            ) {
                let error = result.unwrap_err();
                assert!(
                    error.starts_with("CORE_LOCAL_UPDATE_REQUIRES_APP:"),
                    "{case}: {error}"
                );
                assert!(
                    !marker.exists(),
                    "rejected updates must not execute the package manager"
                );
                assert_eq!(
                    config::get_store_dat_setting(app.handle()).active_core,
                    original.active_core
                );
            } else if matches!(case.as_str(), "query-failure" | "query-invalid") {
                let error = result.unwrap_err();
                let prefix = if case == "query-failure" {
                    "CORE_UPDATE_TARGET_FAILED:"
                } else {
                    "CORE_UPDATE_TARGET_INVALID:"
                };
                assert!(error.starts_with(prefix), "{case}: {error}");
                assert!(!marker.exists());
                assert_eq!(local_core(app.handle()).unwrap().version, local_version);
            } else if case == "fallback-failure" {
                let error = result.unwrap_err();
                assert!(error.starts_with("CORE_UPDATE_FAILED:"), "{case}: {error}");
                assert!(error.contains("fixture package manager failed"), "{error}");
            } else if matches!(case.as_str(), "unchanged-version" | "missing-version") {
                let error = result.unwrap_err();
                assert!(
                    error.starts_with("CORE_UPDATE_VERSION_MISMATCH:"),
                    "{case}: {error}"
                );
                assert!(error.contains("0.2.1-rc.5"), "{error}");
            } else {
                assert_eq!(result.unwrap(), "0.2.1-rc.5");
            }
        }
    });
    if marker.exists() {
        assert_eq!(
            std::fs::read_to_string(scratch.join("pm-query"))
                .unwrap()
                .trim(),
            "view @deepseek-ai/dsh@latest version --json --prefer-online"
        );
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap().trim(),
            if case == "pnpm-success" {
                "add -g @deepseek-ai/dsh@0.2.1-rc.5"
            } else {
                "install -g @deepseek-ai/dsh@0.2.1-rc.5"
            }
        );
        assert_eq!(
            config::get_store_dat_setting(app.handle())
                .active_core
                .as_deref(),
            Some("app")
        );
        assert_eq!(active_source(app.handle()), CoreSource::App);
        if matches!(case.as_str(), "fallback-failure" | "unchanged-version") {
            assert_eq!(local_core(app.handle()).unwrap().version, local_version);
        } else if case == "missing-version" {
            assert!(local_core(app.handle()).is_none());
        } else {
            assert_eq!(local_core(app.handle()).unwrap().version, "0.2.1-rc.5");
        }
    }
    assert_eq!(
        config::get_store_dat_setting(app.handle()).active_profile,
        "keep-profile"
    );
    assert_eq!(
        std::fs::read(profile.join("config.jsonc")).unwrap(),
        b"keep config"
    );
    assert_eq!(
        std::fs::read(profile.join("session.jsonl")).unwrap(),
        b"keep session"
    );
    assert_eq!(
        std::fs::read(managed.join("package.json")).unwrap(),
        managed_manifest
    );
    if case != "missing-app" {
        assert_eq!(std::fs::read(entry).unwrap(), b"managed entry");
    }
    println!("LOCAL_UPDATE_ISOLATION_VERIFIED");
}
