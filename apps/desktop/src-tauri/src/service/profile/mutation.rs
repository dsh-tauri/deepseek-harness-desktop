use crate::service::{plugin, workflow};
use futures_util::FutureExt;
use tokio::sync::OwnedMutexGuard;

pub(crate) struct MutationGuard {
    _process: OwnedMutexGuard<()>,
    _operation: OwnedMutexGuard<()>,
    _transition: OwnedMutexGuard<()>,
}

pub(crate) async fn acquire() -> Result<MutationGuard, String> {
    loop {
        let transition = workflow::acquire_core_transition().await?;
        let mut plugin_locks = std::pin::pin!(async {
            let operation = plugin::acquire_operation_lock().await?;
            let process = plugin::acquire_process_lock().await?;
            Ok::<_, String>((operation, process))
        });
        if let Some(result) = plugin_locks.as_mut().now_or_never() {
            let (operation, process) = result?;
            return Ok(MutationGuard {
                _process: process,
                _operation: operation,
                _transition: transition,
            });
        }
        // 等待插件时让出核心锁；就绪后释放试探锁，再按原顺序获取。
        drop(transition);
        drop(plugin_locks.await?);
    }
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
