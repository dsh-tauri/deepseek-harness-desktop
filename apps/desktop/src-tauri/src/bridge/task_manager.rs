use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::Manager;

use crate::service::workflow;

#[derive(Clone, Serialize)]
pub struct TaskManagerProcess {
    pid: u32,
    parent_pid: Option<u32>,
    name: String,
    kind: &'static str,
    cpu_percent: Option<f32>,
    memory_bytes: u64,
    run_time: u64,
    start_time: u64,
    can_end: bool,
}

type SampleKey = (u32, u64);

#[derive(Default)]
struct Monitor {
    system: System,
    sampled_at: Option<Instant>,
    samples: HashMap<SampleKey, (u64, Instant)>,
    cpu: HashMap<SampleKey, f32>,
}

fn cores() -> f32 {
    static CORES: OnceLock<f32> = OnceLock::new();
    *CORES
        .get_or_init(|| std::thread::available_parallelism().map_or(1, |count| count.get()) as f32)
}

/// sysinfo 的 `cpu_usage` 以单核 100% 计，且进程首次采样会把累计 CPU 时间当成一次采样。
/// 这里按累计 CPU 毫秒自己算差值并除以逻辑核数，与系统任务管理器的整机利用率同口径。
fn cpu_percent(previous_ms: u64, current_ms: u64, elapsed_ms: u128, cores: f32) -> Option<f32> {
    if elapsed_ms == 0 || cores <= 0.0 {
        return None;
    }
    let used = current_ms.saturating_sub(previous_ms) as f32;
    Some(used / elapsed_ms as f32 * 100.0 / cores)
}

fn monitor() -> &'static Mutex<Monitor> {
    static MONITOR: OnceLock<Mutex<Monitor>> = OnceLock::new();
    MONITOR.get_or_init(|| Mutex::new(Monitor::default()))
}

fn ensure_shell(webview: &crate::Webview) -> Result<(), String> {
    crate::desktop::window::require_shell(webview)
        .map_err(|error| format!("TASK_MANAGER_ORIGIN: {error}"))
}

fn descends_from(pid: u32, root: u32, parents: &HashMap<u32, (Option<u32>, u64)>) -> bool {
    let mut current = pid;
    for _ in 0..parents.len() {
        if current == root {
            return true;
        }
        let Some(&(Some(parent), started)) = parents.get(&current) else {
            return false;
        };
        let Some(&(_, parent_started)) = parents.get(&parent) else {
            return false;
        };
        if parent == current || parent_started > started {
            return false;
        }
        current = parent;
    }
    false
}

fn process_kind(
    pid: u32,
    desktop: u32,
    harness: Option<u32>,
    parents: &HashMap<u32, (Option<u32>, u64)>,
) -> Option<(&'static str, bool)> {
    if !descends_from(pid, desktop, parents) {
        return None;
    }
    if pid == desktop {
        return Some(("desktop", false));
    }
    if Some(pid) == harness {
        return Some(("harness", false));
    }
    let can_end = harness.is_some_and(|root| descends_from(pid, root, parents));
    Some(("child", can_end))
}

impl Monitor {
    fn refresh(&mut self) {
        if self
            .sampled_at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(1))
        {
            return;
        }
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_cpu()
                .with_memory(),
        );
        let now = Instant::now();
        let cores = cores();
        let mut samples = HashMap::with_capacity(self.system.processes().len());
        let mut cpu = HashMap::with_capacity(self.system.processes().len());
        for process in self.system.processes().values() {
            let key = (process.pid().as_u32(), process.start_time());
            let total = process.accumulated_cpu_time();
            if let Some((previous, at)) = self.samples.get(&key) {
                if let Some(value) = cpu_percent(*previous, total, at.elapsed().as_millis(), cores)
                {
                    cpu.insert(key, value);
                }
            }
            samples.insert(key, (total, now));
        }
        self.samples = samples;
        self.cpu = cpu;
        self.sampled_at = Some(now);
    }

    fn reset(&mut self) {
        *self = Self::default();
    }

    fn rows(&self, desktop: u32, harness: Option<u32>) -> Vec<TaskManagerProcess> {
        let parents = self
            .system
            .processes()
            .values()
            .map(|process| {
                (
                    process.pid().as_u32(),
                    (process.parent().map(Pid::as_u32), process.start_time()),
                )
            })
            .collect();
        let mut rows: Vec<_> = self
            .system
            .processes()
            .values()
            .filter_map(|process| {
                let pid = process.pid().as_u32();
                let (kind, can_end) = process_kind(pid, desktop, harness, &parents)?;
                Some(TaskManagerProcess {
                    pid,
                    parent_pid: process.parent().map(Pid::as_u32),
                    name: process.name().to_string_lossy().into_owned(),
                    kind,
                    cpu_percent: self.cpu.get(&(pid, process.start_time())).copied(),
                    memory_bytes: process.memory(),
                    run_time: process.run_time(),
                    start_time: process.start_time(),
                    can_end,
                })
            })
            .collect();
        rows.sort_by_key(|process| process.pid);
        rows
    }
}

fn validate_end(process: &TaskManagerProcess, start_time: u64) -> Result<(), String> {
    if start_time == 0 || process.start_time != start_time {
        return Err("TASK_MANAGER_STALE: process identity changed; refresh the list".into());
    }
    if !process.can_end {
        return Err("TASK_MANAGER_PROTECTED: only Harness child processes can be ended".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn get_task_manager_processes(
    webview: crate::Webview,
) -> Result<Vec<TaskManagerProcess>, String> {
    ensure_shell(&webview)?;
    let profile =
        workflow::instances::window_profile(webview.app_handle(), webview.window().label());
    tauri::async_runtime::spawn_blocking(move || {
        workflow::instances::scope_sync(profile, || {
            let mut monitor = monitor().lock().unwrap_or_else(|error| error.into_inner());
            monitor.refresh();
            Ok(monitor.rows(std::process::id(), workflow::owned_process_pid()))
        })
    })
    .await
    .map_err(|error| format!("TASK_MANAGER_READ: {error}"))?
}

#[tauri::command]
pub async fn end_task_manager_process(
    webview: crate::Webview,
    pid: u32,
    start_time: u64,
) -> Result<(), String> {
    ensure_shell(&webview)?;
    let profile =
        workflow::instances::window_profile(webview.app_handle(), webview.window().label());
    let _transition = workflow::acquire_core_transition().await?;
    tauri::async_runtime::spawn_blocking(move || workflow::instances::scope_sync(profile, || {
        let mut current = Monitor::default();
        current.refresh();
        let rows = current.rows(std::process::id(), workflow::owned_process_pid());
        let row = rows.iter().find(|process| process.pid == pid)
            .ok_or("TASK_MANAGER_MISSING: process exited or no longer belongs to this app")?;
        validate_end(row, start_time)?;
        let process = current.system.process(Pid::from_u32(pid))
            .ok_or("TASK_MANAGER_MISSING: process exited")?;
        if !process.kill() {
            return Err("TASK_MANAGER_END: could not end the process; it may have exited or access was denied".into());
        }
        monitor().lock().unwrap_or_else(|error| error.into_inner()).reset();
        Ok(())
    })).await.map_err(|error| format!("TASK_MANAGER_END: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_processes_to_the_app_and_protects_service_and_shell() {
        let parents = HashMap::from([
            (10, (Some(1), 100)),
            (20, (Some(10), 101)),
            (30, (Some(20), 102)),
            (40, (Some(30), 103)),
            (50, (Some(10), 104)),
            (60, (Some(1), 104)),
        ]);
        assert_eq!(
            process_kind(10, 10, Some(20), &parents),
            Some(("desktop", false))
        );
        assert_eq!(
            process_kind(20, 10, Some(20), &parents),
            Some(("harness", false))
        );
        assert_eq!(
            process_kind(40, 10, Some(20), &parents),
            Some(("child", true))
        );
        assert_eq!(
            process_kind(50, 10, Some(20), &parents),
            Some(("child", false))
        );
        assert_eq!(process_kind(60, 10, Some(20), &parents), None);
        assert_eq!(process_kind(40, 10, None, &parents), Some(("child", false)));
    }

    #[test]
    fn excludes_reused_parents_missing_parents_and_cycles() {
        let parents = HashMap::from([
            (10, (None, 100)),
            (20, (Some(10), 99)),
            (30, (Some(99), 102)),
            (40, (Some(50), 103)),
            (50, (Some(40), 103)),
        ]);
        for pid in [20, 30, 40, 50, 99] {
            assert!(!descends_from(pid, 10, &parents));
        }
        assert!(!descends_from(1, 10, &HashMap::new()));
    }

    #[test]
    fn rejects_stale_identity_and_protected_processes() {
        let mut process = TaskManagerProcess {
            pid: 30,
            parent_pid: Some(20),
            name: "worker".into(),
            kind: "child",
            cpu_percent: None,
            memory_bytes: 0,
            run_time: 1,
            start_time: 102,
            can_end: true,
        };
        assert!(validate_end(&process, 101)
            .unwrap_err()
            .starts_with("TASK_MANAGER_STALE:"));
        assert!(validate_end(&process, 0)
            .unwrap_err()
            .starts_with("TASK_MANAGER_STALE:"));
        assert_eq!(validate_end(&process, 102), Ok(()));
        process.can_end = false;
        assert!(validate_end(&process, 102)
            .unwrap_err()
            .starts_with("TASK_MANAGER_PROTECTED:"));
    }

    #[test]
    fn normalizes_cpu_to_the_whole_machine() {
        assert_eq!(cpu_percent(1_000, 1_500, 1_000, 8.0), Some(6.25));
        assert_eq!(cpu_percent(1_000, 1_000, 1_000, 8.0), Some(0.0));
        assert_eq!(cpu_percent(1_500, 1_000, 1_000, 8.0), Some(0.0));
        assert_eq!(cpu_percent(0, 800, 1_000, 1.0), Some(80.0));
        assert_eq!(cpu_percent(0, 500, 0, 8.0), None);
        assert_eq!(cpu_percent(0, 500, 1_000, 0.0), None);
    }

    #[test]
    fn reads_real_current_process_without_exposing_other_processes() {
        let mut monitor = Monitor::default();
        monitor.refresh();
        let rows = monitor.rows(std::process::id(), None);
        let desktop = rows
            .iter()
            .find(|process| process.pid == std::process::id())
            .unwrap();
        assert_eq!(desktop.kind, "desktop");
        assert!(desktop.memory_bytes > 0);
        assert!(desktop.start_time > 0);
        assert_eq!(desktop.cpu_percent, None);
        assert!(rows.iter().all(|process| !process.can_end));
    }

    #[test]
    fn second_sample_reports_machine_wide_cpu() {
        let mut monitor = Monitor::default();
        monitor.refresh();
        std::thread::sleep(Duration::from_millis(1_100));
        monitor.refresh();
        let rows = monitor.rows(std::process::id(), None);
        let desktop = rows
            .iter()
            .find(|process| process.pid == std::process::id())
            .unwrap();
        let usage = desktop.cpu_percent.unwrap();
        assert!((0.0..=100.0).contains(&usage), "unexpected cpu: {usage}");
    }
}
