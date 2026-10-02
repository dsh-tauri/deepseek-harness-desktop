use std::collections::{HashMap, HashSet};
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

#[derive(Default)]
struct Monitor {
    system: System,
    sampled_at: Option<Instant>,
    cpu_ready: HashSet<(u32, u64)>,
}

fn monitor() -> &'static Mutex<Monitor> {
    static MONITOR: OnceLock<Mutex<Monitor>> = OnceLock::new();
    MONITOR.get_or_init(|| Mutex::new(Monitor::default()))
}

fn ensure_shell(webview: &tauri::Webview) -> Result<(), String> {
    let url = webview
        .url()
        .map_err(|error| format!("TASK_MANAGER_ORIGIN: {error}"))?;
    let packaged = matches!(url.scheme(), "tauri" | "http" | "https")
        && matches!(url.host_str(), Some("tauri.localhost" | "localhost"))
        && (url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"));
    let dev = cfg!(debug_assertions)
        && webview
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|dev| dev.origin() == url.origin());
    if webview.label() != "pet" && (packaged || dev) {
        Ok(())
    } else {
        Err("TASK_MANAGER_ORIGIN: only the desktop shell can manage processes".into())
    }
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
        let warm = self
            .sampled_at
            .is_some_and(|at| at.elapsed() < Duration::from_secs(10));
        let previous: HashSet<_> = self
            .system
            .processes()
            .values()
            .map(|process| (process.pid().as_u32(), process.start_time()))
            .collect();
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_cpu()
                .with_memory(),
        );
        self.cpu_ready = if warm { previous } else { HashSet::new() };
        self.sampled_at = Some(Instant::now());
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
                let cpu_percent = self
                    .cpu_ready
                    .contains(&(pid, process.start_time()))
                    .then_some(process.cpu_usage());
                Some(TaskManagerProcess {
                    pid,
                    parent_pid: process.parent().map(Pid::as_u32),
                    name: process.name().to_string_lossy().into_owned(),
                    kind,
                    cpu_percent,
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
    webview: tauri::Webview,
) -> Result<Vec<TaskManagerProcess>, String> {
    ensure_shell(&webview)?;
    tauri::async_runtime::spawn_blocking(|| {
        let mut monitor = monitor().lock().unwrap_or_else(|error| error.into_inner());
        monitor.refresh();
        Ok(monitor.rows(std::process::id(), workflow::owned_process_pid()))
    })
    .await
    .map_err(|error| format!("TASK_MANAGER_READ: {error}"))?
}

#[tauri::command]
pub async fn end_task_manager_process(
    webview: tauri::Webview,
    pid: u32,
    start_time: u64,
) -> Result<(), String> {
    ensure_shell(&webview)?;
    let _transition = workflow::acquire_core_transition().await?;
    tauri::async_runtime::spawn_blocking(move || {
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
        monitor().lock().unwrap_or_else(|error| error.into_inner()).sampled_at = None;
        Ok(())
    }).await.map_err(|error| format!("TASK_MANAGER_END: {error}"))?
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
}
