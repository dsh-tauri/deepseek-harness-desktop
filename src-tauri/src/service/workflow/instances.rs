use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use super::status::Status;

tokio::task_local! {
    static PROFILE: String;
}

#[derive(Default)]
struct Registry {
    windows: HashMap<String, String>,
    instances: HashMap<String, Arc<Instance>>,
}

pub(super) struct Instance {
    pub process: Mutex<Option<super::process::OwnedProcess>>,
    pub launching: Arc<std::sync::atomic::AtomicBool>,
    pub status: Mutex<Status>,
    pub port: Mutex<Option<u16>>,
}

impl Default for Instance {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            launching: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            status: Mutex::new(Status::Initial),
            port: Mutex::new(None),
        }
    }
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

pub(super) fn registration_gate() -> &'static Mutex<bool> {
    static SHUTTING_DOWN: Mutex<bool> = Mutex::new(false);
    &SHUTTING_DOWN
}

pub(crate) fn begin_shutdown() {
    begin_shutdown_at(registration_gate());
}

pub(super) fn begin_shutdown_at(gate: &Mutex<bool>) {
    *gate.lock().unwrap_or_else(|error| error.into_inner()) = true;
}

pub fn current_profile() -> Option<String> {
    PROFILE.try_with(Clone::clone).ok()
}

pub async fn scope<T>(profile: String, future: impl Future<Output = T>) -> T {
    PROFILE.scope(profile, future).await
}

pub fn scope_sync<T>(profile: String, operation: impl FnOnce() -> T) -> T {
    PROFILE.sync_scope(profile, operation)
}

pub(super) fn instance() -> Arc<Instance> {
    let profile = current_profile().unwrap_or_else(|| "web".into());
    instance_of(&profile)
}

pub(super) fn instance_of(profile: &str) -> Arc<Instance> {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .instances
        .entry(profile.to_string())
        .or_default()
        .clone()
}

pub fn profiles() -> Vec<String> {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .instances
        .keys()
        .cloned()
        .collect()
}

pub fn window_profile(app: &tauri::AppHandle, label: &str) -> String {
    let mut registry = registry().lock().unwrap_or_else(|error| error.into_inner());
    registry
        .windows
        .entry(label.to_string())
        .or_insert_with(|| crate::service::profile::active_profile(app))
        .clone()
}

pub fn window_uses_profile(label: &str, profile: &str) -> bool {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .windows
        .get(label)
        .is_some_and(|value| value == profile)
}

pub fn bind_window(label: &str, profile: &str) -> Option<String> {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .windows
        .insert(label.into(), profile.into())
}

pub fn release_window(label: &str) -> Option<String> {
    let mut registry = registry().lock().unwrap_or_else(|error| error.into_inner());
    let profile = registry.windows.remove(label)?;
    (!registry.windows.values().any(|value| value == &profile)).then_some(profile)
}

pub fn attached_elsewhere(profile: &str, label: &str) -> bool {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .windows
        .iter()
        .any(|(window, value)| window != label && value == profile)
}

pub fn require_exclusive_profile() -> Result<(), String> {
    let profile = current_profile().unwrap_or_else(|| "web".into());
    let _gate = registration_gate()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (foreign_window, instances) = {
        let registry = registry().lock().unwrap_or_else(|error| error.into_inner());
        (
            registry.windows.values().any(|value| value != &profile),
            registry
                .instances
                .iter()
                .filter(|(id, _)| *id != &profile)
                .map(|(_, instance)| Arc::clone(instance))
                .collect::<Vec<_>>(),
        )
    };
    if foreign_window
        || instances.iter().any(|instance| {
            instance
                .process
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_some()
        })
    {
        return Err("CORE_IN_USE: close windows using other profiles before changing shared core or data files".into());
    }
    Ok(())
}

pub fn is_attached(profile: &str) -> bool {
    registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .windows
        .values()
        .any(|value| value == profile)
}

pub fn emit<R: tauri::Runtime, S: serde::Serialize + Clone>(
    app: &tauri::AppHandle<R>,
    event: &str,
    payload: S,
) {
    use tauri::Emitter;
    let Some(profile) = current_profile() else {
        let _ = app.emit(event, payload);
        return;
    };
    let labels: Vec<String> = registry()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .windows
        .iter()
        .filter(|(_, value)| **value == profile)
        .map(|(label, _)| label.clone())
        .collect();
    for label in labels {
        let _ = app.emit_to(
            tauri::EventTarget::webview_window(label),
            event,
            payload.clone(),
        );
    }
}

pub fn port(app: &tauri::AppHandle) -> u16 {
    instance()
        .port
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .unwrap_or_else(|| crate::config::get_store_dat_setting(app).port)
}

pub fn set_port(port: u16) {
    *instance()
        .port
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(port);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn profile_instances_reuse_and_isolate_runtime_state() {
        scope("instance-test-a".into(), async {
            set_port(41001);
            *instance().status.lock().unwrap() = Status::Running;
            let first = instance();
            assert!(Arc::ptr_eq(&first, &instance()));
            scope("instance-test-b".into(), async {
                assert!(!Arc::ptr_eq(&first, &instance()));
                assert_eq!(*instance().port.lock().unwrap(), None);
                assert_eq!(*instance().status.lock().unwrap(), Status::Initial);
                set_port(41002);
            })
            .await;
            assert_eq!(*instance().port.lock().unwrap(), Some(41001));
            assert_eq!(*instance().status.lock().unwrap(), Status::Running);
        })
        .await;
        assert_eq!(current_profile(), None);
    }

    #[tokio::test]
    async fn concurrent_profiles_keep_scope_and_launch_guards_separate() {
        let (a, b) = tokio::join!(
            scope("concurrent-profile-a".into(), async {
                instance()
                    .launching
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                tokio::task::yield_now().await;
                assert_eq!(current_profile().as_deref(), Some("concurrent-profile-a"));
                instance()
                    .launching
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                instance()
            }),
            scope("concurrent-profile-b".into(), async {
                tokio::task::yield_now().await;
                assert!(!instance()
                    .launching
                    .load(std::sync::atomic::Ordering::SeqCst));
                assert_eq!(current_profile().as_deref(), Some("concurrent-profile-b"));
                instance()
            })
        );
        assert!(!Arc::ptr_eq(&a, &b));
    }

    #[tokio::test]
    async fn synchronous_override_restores_async_scope_even_after_panic() {
        scope("outer-scope".into(), async {
            scope_sync("inner-scope".into(), || {
                assert_eq!(current_profile().as_deref(), Some("inner-scope"));
            });
            assert_eq!(current_profile().as_deref(), Some("outer-scope"));
            let _ =
                std::panic::catch_unwind(|| scope_sync("panic-scope".into(), || panic!("test")));
            assert_eq!(current_profile().as_deref(), Some("outer-scope"));
        })
        .await;
        assert_eq!(current_profile(), None);
    }

    #[test]
    fn window_release_only_reclaims_last_profile_reference() {
        bind_window("instance-window-a", "window-profile-a");
        bind_window("instance-window-b", "window-profile-a");
        assert_eq!(release_window("instance-window-a"), None);
        bind_window("instance-window-b", "window-profile-b");
        assert!(!is_attached("window-profile-a"));
        assert!(is_attached("window-profile-b"));
        assert_eq!(
            release_window("instance-window-b"),
            Some("window-profile-b".into())
        );
    }
}
