use std::sync::{Arc, OnceLock};

struct Preparation {
    worker: tokio::sync::watch::Receiver<Option<Result<bool, String>>>,
    settled: tokio::sync::watch::Receiver<Option<Result<(), String>>>,
    setup_done: std::sync::Mutex<Option<tokio::sync::watch::Sender<Option<Result<(), String>>>>>,
}

static PREPARATION: OnceLock<Preparation> = OnceLock::new();

#[cfg(windows)]
struct Probe {
    job: Arc<super::win_spawn::ProcessJob>,
    failed: bool,
    fatal: Option<String>,
}

#[cfg(windows)]
thread_local! {
    static PROBE: std::cell::RefCell<Option<Probe>> = const { std::cell::RefCell::new(None) };
}

#[cfg(windows)]
pub(crate) fn probe_output(
    program: &std::path::Path,
    args: &[&str],
    remove_node_options: bool,
) -> Option<std::io::Result<std::process::Output>> {
    let job = PROBE
        .with(|probe| {
            probe.borrow().as_ref().map(|probe| match &probe.fatal {
                Some(error) => Err(std::io::Error::other(error.clone())),
                None => Ok(probe.job.clone()),
            })
        })
        .or_else(|| {
            PREPARATION.get().and_then(|preparation| {
                let error = match preparation.worker.borrow().as_ref() {
                    Some(Err(error)) => Some(error.clone()),
                    None if preparation.worker.has_changed().is_err() => {
                        Some("STARTUP_PREPARATION_INTERRUPTED".to_string())
                    }
                    _ => preparation
                        .settled
                        .borrow()
                        .as_ref()
                        .and_then(|result| result.as_ref().err())
                        .cloned(),
                };
                error.map(|error| Err(std::io::Error::other(error)))
            })
        })?;
    let job = match job {
        Ok(job) => job,
        Err(error) => return Some(Err(error)),
    };
    let args: Vec<_> = args.iter().map(std::ffi::OsString::from).collect();
    let started = std::time::Instant::now();
    let result = super::win_spawn::probe_in_job(
        program,
        &args,
        &job,
        super::instances::registration_gate(),
        remove_node_options,
    );
    log::info!(
        "STARTUP_EARLY_PROBE: program={} ms={} success={}",
        program.display(),
        started.elapsed().as_millis(),
        result.as_ref().is_ok_and(|output| output.status.success())
    );
    if let Err(error) = &result {
        PROBE.with(|probe| {
            if let Some(probe) = probe.borrow_mut().as_mut() {
                probe.failed = true;
                if error
                    .get_ref()
                    .is_some_and(|error| error.is::<super::win_spawn::ProcessCleanupFailed>())
                {
                    probe.fatal = Some(format!("STARTUP_PROBE_CLEANUP_FAILED: {error}"));
                }
            }
        });
    }
    Some(result)
}

#[cfg(windows)]
fn prepare_in_job(
    app_data: &std::path::Path,
    resources: &std::path::Path,
    job: Arc<super::win_spawn::ProcessJob>,
) -> Result<Option<super::launch::LaunchPlan>, String> {
    struct Restore(Option<Probe>);
    impl Drop for Restore {
        fn drop(&mut self) {
            PROBE.with(|probe| *probe.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(PROBE.with(|probe| {
        probe.replace(Some(Probe {
            job,
            failed: false,
            fatal: None,
        }))
    }));
    let plan = super::early_plan::prepare(app_data, resources);
    if !probes_ready()? {
        Ok(None)
    } else {
        plan
    }
}

#[cfg(windows)]
pub(super) fn probes_ready() -> Result<bool, String> {
    PROBE.with(|probe| match probe.borrow().as_ref() {
        Some(probe) => match &probe.fatal {
            Some(error) => Err(error.clone()),
            None => Ok(!probe.failed),
        },
        None => Ok(true),
    })
}

impl Preparation {
    async fn wait(&self) -> Result<(), String> {
        let mut receiver = self.settled.clone();
        let result = receiver
            .wait_for(Option::is_some)
            .await
            .map_err(|_| "STARTUP_PREPARATION_INTERRUPTED".to_string())?
            .as_ref()
            .expect("settled preparation")
            .clone();
        result
    }

    async fn setup(&self, setup: impl FnOnce(bool)) {
        let mut receiver = self.worker.clone();
        let complete = self
            .setup_done
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        let prepared = receiver
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|ready| ready.as_ref().cloned())
            .unwrap_or_else(|| Err("STARTUP_PREPARATION_INTERRUPTED".to_string()));
        let result = prepared.map(|prepared| setup(prepared));
        if let Err(error) = &result {
            log::error!("STARTUP_PREPARATION_FAILED: {error}");
        }
        if let Some(complete) = complete {
            let _ = complete.send(Some(result));
        }
    }
}

pub(crate) async fn wait_preparation() -> Result<(), String> {
    if let Some(preparation) = PREPARATION.get() {
        preparation.wait().await?;
    }
    Ok(())
}

pub(crate) fn setup(setup: impl FnOnce(bool) + Send + 'static) {
    if let Some(preparation) = PREPARATION.get() {
        tauri::async_runtime::spawn(preparation.setup(setup));
    } else {
        setup(false);
    }
}

#[cfg(windows)]
struct Cleanup {
    profile: String,
    marker: std::path::PathBuf,
    port: u16,
    entry: std::path::PathBuf,
}

pub(crate) struct Startup {
    notifications: Arc<OnceLock<tauri::AppHandle>>,
    #[cfg(windows)]
    job: Option<Arc<super::win_spawn::ProcessJob>>,
    #[cfg(windows)]
    cleanup: Arc<std::sync::Mutex<Option<Cleanup>>>,
}

impl Startup {
    pub(crate) fn begin(
        context: &tauri::Context<tauri::Wry>,
        #[cfg(all(windows, not(debug_assertions)))] single_instance: Arc<
            crate::desktop::single_instance::SingleInstance,
        >,
    ) -> Self {
        let startup = Self {
            notifications: Arc::new(OnceLock::new()),
            #[cfg(windows)]
            job: None,
            #[cfg(windows)]
            cleanup: Arc::default(),
        };
        #[cfg(windows)]
        return startup.start(
            context,
            #[cfg(not(debug_assertions))]
            single_instance,
        );
        #[cfg(not(windows))]
        {
            let _ = context;
            startup
        }
    }

    pub(crate) fn attach(&self, app: &tauri::AppHandle) {
        let _ = self.notifications.set(app.clone());
    }

    pub(crate) fn shutdown(&self) {
        super::instances::begin_shutdown();
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                if let Err(error) = job.terminate() {
                    log::error!("STARTUP_JOB_CLEANUP_FAILED: {error}");
                }
            }
            let cleanup = self
                .cleanup
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(cleanup) = cleanup.as_ref() {
                super::instances::scope_sync(cleanup.profile.clone(), || {
                    if let Err(error) = super::process::stop_instance_at(
                        &cleanup.marker,
                        cleanup.port,
                        &cleanup.entry,
                    ) {
                        log::error!("STARTUP_CLEANUP_FAILED: {error}");
                    }
                });
            }
        }
    }

    #[cfg(windows)]
    fn start(
        mut self,
        context: &tauri::Context<tauri::Wry>,
        #[cfg(not(debug_assertions))] single_instance: Arc<
            crate::desktop::single_instance::SingleInstance,
        >,
    ) -> Self {
        let started = std::time::Instant::now();
        let Some(app_data) = app_data_dir(context.config()) else {
            return self;
        };
        if crate::config::detect_first_install_at(Some(&app_data)) {
            return self;
        }
        let Ok(resources) = tauri::utils::platform::resource_dir(
            context.package_info(),
            &tauri::utils::Env::default(),
        ) else {
            return self;
        };
        let Some(profile) = super::early_plan::profile(&app_data) else {
            return self;
        };
        let Some(entry) = super::early_plan::entry(&app_data, &resources) else {
            return self;
        };
        let job = match super::win_spawn::ProcessJob::new() {
            Ok(job) => Arc::new(job),
            Err(error) => {
                log::warn!("STARTUP_JOB_UNAVAILABLE: {error}");
                return self;
            }
        };
        let (complete, worker) = tokio::sync::watch::channel(None);
        let (setup_done, settled) = tokio::sync::watch::channel(None);
        if PREPARATION
            .set(Preparation {
                worker,
                settled,
                setup_done: std::sync::Mutex::new(Some(setup_done)),
            })
            .is_err()
        {
            return self;
        }
        let notifications = self.notifications.clone();
        let cleanup = self.cleanup.clone();
        let worker_job = job.clone();
        let worker_complete = complete.clone();
        self.job = Some(job);
        if let Err(error) = std::thread::Builder::new()
            .name("harness-prepare".into())
            .spawn(move || {
                #[cfg(not(debug_assertions))]
                let _single_instance = single_instance;
                log::info!(
                    "STARTUP_EARLY_PHASE: name=worker_started elapsed_ms={}",
                    started.elapsed().as_millis()
                );
                let result = super::instances::scope_sync(profile.clone(), || {
                    tauri::async_runtime::block_on(async {
                        let transition = super::process::acquire_core_transition().await?;
                        let flag = super::process::launch_guard();
                        if flag
                            .compare_exchange(
                                false,
                                true,
                                std::sync::atomic::Ordering::SeqCst,
                                std::sync::atomic::Ordering::SeqCst,
                            )
                            .is_err()
                        {
                            return Ok(false);
                        }
                        let guard = super::process::LaunchGuard(flag);
                        let _operation = crate::service::plugin::acquire_operation_lock().await;
                        if super::early_plan::entry(&app_data, &resources).as_ref() != Some(&entry)
                        {
                            return Ok(false);
                        }
                        log::info!(
                            "STARTUP_EARLY_PHASE: name=prepare_started elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                        if super::process::take_startup_sweep() {
                            if let Err(error) =
                                super::process::terminate_stale_harness_processes_at(&entry)
                            {
                                super::process::retry_startup_sweep();
                                return Err(error);
                            }
                        }
                        let home = crate::config::dsh_data_path_from_env();
                        crate::service::perm::ensure_dir_writable(&home, "DSH_HOME_MKDIR_FAILED")?;
                        crate::service::perm::ensure_writable_path(
                            &home.join("profiles").join(&profile),
                            &home,
                            "PROFILE_NOT_WRITABLE",
                        )?;
                        let Some(plan) = prepare_in_job(&app_data, &resources, worker_job.clone())?
                        else {
                            log::debug!("STARTUP_EARLY_DEFER: normal preparation required");
                            return Ok(false);
                        };
                        if plan.dsh_binary != entry
                            || super::utils::is_port_in_use(plan.setting.port)
                        {
                            return Ok(false);
                        }
                        {
                            let shutdown = super::instances::registration_gate()
                                .lock()
                                .unwrap_or_else(|error| error.into_inner());
                            if *shutdown {
                                return Ok(false);
                            }
                            *cleanup.lock().unwrap_or_else(|error| error.into_inner()) =
                                Some(Cleanup {
                                    profile: profile.clone(),
                                    marker: plan.pid_path.clone(),
                                    port: plan.setting.port,
                                    entry,
                                });
                        }
                        super::instances::set_port(plan.setting.port);
                        super::status::set_status(super::status::Status::Starting);
                        log::info!(
                            "STARTUP_EARLY_PHASE: name=prepared elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                        super::launch::launch_prepared(
                            plan,
                            (guard, transition),
                            notifications,
                            Some(worker_job),
                        )
                        .await?;
                        log::info!(
                            "STARTUP_EARLY_PHASE: name=registered elapsed_ms={}",
                            started.elapsed().as_millis()
                        );
                        Ok(true)
                    })
                });
                if let Err(error) = &result {
                    log::error!("STARTUP_EARLY_FAILED: {error}");
                }
                let _ = worker_complete.send(Some(result));
            })
        {
            log::warn!("STARTUP_EARLY_THREAD_FAILED: {error}");
            let _ = complete.send(Some(Ok(false)));
        }
        self
    }
}

impl Drop for Startup {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(windows)]
fn app_data_dir(config: &tauri::utils::config::Config) -> Option<std::path::PathBuf> {
    use tauri::utils::config::AppDirectoriesOverride;

    let path = match config.app.app_directories_override.as_ref() {
        Some(AppDirectoriesOverride::Root(path)) => Some(path),
        Some(AppDirectoriesOverride::Directories(paths)) => paths.data.as_ref(),
        None => None,
    };
    if let Some(path) = path {
        return path.is_absolute().then(|| path.components().collect());
    }
    roaming_app_data_dir(&config.identifier)
}

#[cfg(windows)]
fn roaming_app_data_dir(identifier: &str) -> Option<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_RoamingAppData, SHGetKnownFolderPath};

    let mut path = std::ptr::null_mut();
    let result = unsafe {
        SHGetKnownFolderPath(&FOLDERID_RoamingAppData, 0, std::ptr::null_mut(), &mut path)
    };
    let directory = if result >= 0 && !path.is_null() {
        let length = (0..)
            .take_while(|offset| unsafe { *path.add(*offset) != 0 })
            .count();
        Some(
            std::path::PathBuf::from(std::ffi::OsString::from_wide(unsafe {
                std::slice::from_raw_parts(path, length)
            }))
            .join(identifier),
        )
    } else {
        None
    };
    unsafe { CoTaskMemFree(path.cast()) };
    directory
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn absolute_app_data_overrides_match_tauri() {
        use tauri::utils::config::{AppDirectoriesOverride, AppDirectoryOverrides};
        use tauri::Manager;

        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".").join("data").join("..").join("store");
        for directory in [
            AppDirectoriesOverride::Root(path.clone()),
            AppDirectoriesOverride::Directories(AppDirectoryOverrides {
                data: Some(path.clone()),
                ..Default::default()
            }),
        ] {
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().app.app_directories_override = Some(directory);
            let early = super::app_data_dir(context.config()).unwrap();
            let app = tauri::test::mock_builder().build(context).unwrap();
            assert_eq!(early, app.path().app_data_dir().unwrap());
            assert_eq!(early, path.components().collect::<std::path::PathBuf>());
        }
        let mut context: tauri::Context<tauri::test::MockRuntime> =
            tauri::test::mock_context(tauri::test::noop_assets());
        for path in ["relative", "$DATA/store", r"C:store", r"\store"] {
            context.config_mut().app.app_directories_override =
                Some(AppDirectoriesOverride::Root(path.into()));
            assert_eq!(super::app_data_dir(context.config()), None, "{path}");
        }
    }

    #[tokio::test]
    async fn preparation_blocks_launch_until_worker_and_setup_finish() {
        for result in [
            Some(Ok(true)),
            Some(Ok(false)),
            Some(Err("STARTUP_PROBE_CLEANUP_FAILED: fixture".to_string())),
            None,
        ] {
            let (worker_done, worker) = tokio::sync::watch::channel(None);
            let (setup_done, settled) = tokio::sync::watch::channel(None);
            let preparation = super::Preparation {
                worker,
                settled,
                setup_done: std::sync::Mutex::new(Some(setup_done)),
            };
            let called = std::cell::Cell::new(None);
            let setup = preparation.setup(|prepared| called.set(Some(prepared)));
            tokio::pin!(setup);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(10), &mut setup)
                    .await
                    .is_err()
            );
            assert_eq!(called.get(), None);
            if let Some(result) = &result {
                worker_done.send(Some(result.clone())).unwrap();
            }
            drop(worker_done);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(10), preparation.wait())
                    .await
                    .is_err()
            );
            setup.await;
            let expected =
                result.unwrap_or_else(|| Err("STARTUP_PREPARATION_INTERRUPTED".to_string()));
            assert_eq!(called.get(), expected.as_ref().ok().copied());
            assert_eq!(
                tokio::time::timeout(std::time::Duration::from_millis(100), preparation.wait())
                    .await
                    .unwrap(),
                expected.map(|_| ())
            );
        }
    }
}
