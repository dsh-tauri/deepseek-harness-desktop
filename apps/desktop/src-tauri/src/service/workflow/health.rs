use std::sync::atomic::Ordering;

use crate::config;

use super::process::{has_owned_process, launch_guard};

#[derive(serde::Serialize)]
pub struct HealthCheck {
    pub status: String,
    pub boot_html: String,
    pub service_url: String,
}

fn not_owned_probe_signal(launch_in_progress: bool) -> &'static str {
    if launch_in_progress {
        "HARNESS_NOT_READY: Harness service is still starting"
    } else {
        "HARNESS_NOT_OWNED: no Harness process is owned by this app"
    }
}

pub async fn proxy_health_check(port: u16) -> Result<HealthCheck, String> {
    if !has_owned_process() {
        return Err(not_owned_probe_signal(launch_guard().load(Ordering::SeqCst)).to_string());
    }
    super::auth::launch_url(port)?;
    Ok(HealthCheck {
        status: "healthy - Harness process ready".into(),
        boot_html: String::new(),
        service_url: config::get_dsh_service_url(port),
    })
}

fn ownership_recheck_signal(owned: bool, launch_in_progress: bool) -> Result<(), String> {
    if owned || launch_in_progress {
        return Ok(());
    }
    Err(not_owned_probe_signal(false).to_string())
}

pub fn recheck_ownership() -> Result<(), String> {
    ownership_recheck_signal(has_owned_process(), launch_guard().load(Ordering::SeqCst))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_owned_is_retryable_during_launch_not_fatal() {
        // launch 仍在进行（守卫未释放）：无持有进程是启动中的临时状态，前端继续轮询
        assert!(not_owned_probe_signal(true).starts_with("HARNESS_NOT_READY"));
        // 启动已结束（守卫释放）却仍无持有进程：进程已退出/从未拉起 → 快速失败
        assert!(not_owned_probe_signal(false).starts_with("HARNESS_NOT_OWNED"));
    }

    /// 提交窗口的 ownership 复核只读内存状态：仍持有进程、或 launch 仍在进行都应
    /// 放行，只有两者都不成立才判为退出，且文案与探测路径一致（错误页据此识别）。
    #[test]
    fn ownership_recheck_only_fails_when_process_is_gone() {
        assert!(ownership_recheck_signal(true, false).is_ok());
        assert!(ownership_recheck_signal(true, true).is_ok());
        assert!(ownership_recheck_signal(false, true).is_ok());
        assert_eq!(
            ownership_recheck_signal(false, false).unwrap_err(),
            "HARNESS_NOT_OWNED: no Harness process is owned by this app"
        );
    }
}
