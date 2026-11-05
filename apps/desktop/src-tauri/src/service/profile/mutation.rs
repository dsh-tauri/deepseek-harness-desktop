use crate::service::{plugin, workflow};
use tokio::sync::OwnedMutexGuard;

pub(crate) struct MutationGuard {
    _process: OwnedMutexGuard<()>,
    _operation: OwnedMutexGuard<()>,
    _transition: OwnedMutexGuard<()>,
}

pub(crate) async fn acquire() -> Result<MutationGuard, String> {
    let transition = workflow::acquire_core_transition().await?;
    let operation = plugin::acquire_operation_lock().await?;
    let process = plugin::acquire_process_lock().await?;
    Ok(MutationGuard {
        _process: process,
        _operation: operation,
        _transition: transition,
    })
}

impl MutationGuard {
    pub(crate) fn spawn_blocking<F, T>(
        self,
        profile: String,
        action: F,
    ) -> tauri::async_runtime::JoinHandle<T>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = self;
            workflow::instances::scope_sync(profile, action)
        })
    }
}
