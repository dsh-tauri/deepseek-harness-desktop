//! 核心页面从后台回到前台时重同步会话并校准运行计时。
//!
//! WebKit 与浏览器都会节流后台页面的定时器和事件投递。连接仍显示为打开时，核心不会
//! 走断线重连路径，页面因此可能停在旧 step，运行计时也停在旧秒数，直至手动刷新。
//! 本补丁在页面重新可见时重建连接代次，并让运行计时立即按墙钟重算。

use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const CONNECTION_CLIENT: &str =
    "node_modules/@deepseek-ai/dsh-client-connection/lib/client.js";
const TIMER_CLIENT: &str = "node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";

const CONNECTION_MARKER: &str = "dsh-tauri-desktop: foreground connection resync";
const TIMER_MARKER: &str = "dsh-tauri-desktop: foreground running timer";

const CONNECTION_ANCHOR: &str = concat!(
    "browser.addEventListener(\"offline\", offline);\n",
    "\t\t\treturn () => {\n",
    "\t\t\t\tbrowser.removeEventListener(\"online\", online);\n",
    "\t\t\t\tbrowser.removeEventListener(\"offline\", offline);\n",
    "\t\t\t};",
);

const CONNECTION_PATCHED: &str = concat!(
    "browser.addEventListener(\"offline\", offline);\n",
    "\t\t\t/* dsh-tauri-desktop: foreground connection resync */\n",
    "\t\t\tconst foreground = () => {\n",
    "\t\t\t\tif (browser.document.visibilityState === \"visible\" && browser.navigator.onLine !== false) controller.reconnect();\n",
    "\t\t\t};\n",
    "\t\t\tbrowser.document.addEventListener(\"visibilitychange\", foreground);\n",
    "\t\t\treturn () => {\n",
    "\t\t\t\tbrowser.removeEventListener(\"online\", online);\n",
    "\t\t\t\tbrowser.removeEventListener(\"offline\", offline);\n",
    "\t\t\t\tbrowser.document.removeEventListener(\"visibilitychange\", foreground);\n",
    "\t\t\t};",
);

const TIMER_ANCHOR: &str = concat!(
    "setNow(Date.now());\n",
    "\t\t\t\tconst timer = setInterval(() => {\n",
    "\t\t\t\t\tsetNow(Date.now());\n",
    "\t\t\t\t}, LIVE_RUN_CLOCK_INTERVAL_MS);\n",
    "\t\t\t\treturn () => {\n",
    "\t\t\t\t\tclearInterval(timer);\n",
    "\t\t\t\t};",
);

const TIMER_PATCHED: &str = concat!(
    "/* dsh-tauri-desktop: foreground running timer */\n",
    "\t\t\t\tconst tick = () => {\n",
    "\t\t\t\t\tsetNow(Date.now());\n",
    "\t\t\t\t};\n",
    "\t\t\t\tconst foreground = () => {\n",
    "\t\t\t\t\tif (document.visibilityState === \"visible\") tick();\n",
    "\t\t\t\t};\n",
    "\t\t\t\ttick();\n",
    "\t\t\t\tconst timer = setInterval(tick, LIVE_RUN_CLOCK_INTERVAL_MS);\n",
    "\t\t\t\tdocument.addEventListener(\"visibilitychange\", foreground);\n",
    "\t\t\t\treturn () => {\n",
    "\t\t\t\t\tclearInterval(timer);\n",
    "\t\t\t\t\tdocument.removeEventListener(\"visibilitychange\", foreground);\n",
    "\t\t\t\t};",
);

fn patch_exact(source: &str, marker: &str, anchor: &str, patched: &str) -> PatchOutcome {
    if source.contains(marker) {
        return PatchOutcome::AlreadyPatched;
    }
    if source.matches(anchor).count() != 1 {
        return PatchOutcome::AnchorMissing;
    }
    PatchOutcome::Patched(source.replacen(anchor, patched, 1))
}

fn patch_connection(source: &str) -> PatchOutcome {
    patch_exact(
        source,
        CONNECTION_MARKER,
        CONNECTION_ANCHOR,
        CONNECTION_PATCHED,
    )
}

fn patch_timer(source: &str) -> PatchOutcome {
    patch_exact(source, TIMER_MARKER, TIMER_ANCHOR, TIMER_PATCHED)
}

/// 对显式给定的核心目录施加前台恢复补丁。
pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, CONNECTION_CLIENT, patch_connection)?;
    patch_core_file(core_dir, TIMER_CLIENT, patch_timer)
}

/// 对当前活动核心施加前台恢复补丁。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CONNECTION_CLIENT, patch_connection)?;
    patch_dsh(app_handle, TIMER_CLIENT, patch_timer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_resume_reconnects_and_disposes_listener() {
        let PatchOutcome::Patched(patched) = patch_connection(CONNECTION_ANCHOR) else {
            panic!("expected connection patch")
        };
        assert!(patched.contains(CONNECTION_MARKER));
        assert!(patched.contains("controller.reconnect()"));
        assert!(patched.contains("browser.navigator.onLine !== false"));
        assert!(patched.contains(
            "browser.document.addEventListener(\"visibilitychange\", foreground)"
        ));
        assert!(patched.contains(
            "browser.document.removeEventListener(\"visibilitychange\", foreground)"
        ));
        assert_eq!(patch_connection(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn foreground_resume_recalculates_and_disposes_timer_listener() {
        let PatchOutcome::Patched(patched) = patch_timer(TIMER_ANCHOR) else {
            panic!("expected timer patch")
        };
        assert!(patched.contains(TIMER_MARKER));
        assert!(patched.contains("const timer = setInterval(tick, LIVE_RUN_CLOCK_INTERVAL_MS)"));
        assert!(patched.contains("if (document.visibilityState === \"visible\") tick()"));
        assert!(patched.contains(
            "document.addEventListener(\"visibilitychange\", foreground)"
        ));
        assert!(patched.contains(
            "document.removeEventListener(\"visibilitychange\", foreground)"
        ));
        assert_eq!(patch_timer(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn changed_or_ambiguous_anchors_do_not_apply_partial_patches() {
        assert_eq!(patch_connection(""), PatchOutcome::AnchorMissing);
        assert_eq!(patch_timer(""), PatchOutcome::AnchorMissing);
        assert_eq!(
            patch_connection(&format!("{CONNECTION_ANCHOR}{CONNECTION_ANCHOR}")),
            PatchOutcome::AnchorMissing
        );
        assert_eq!(
            patch_timer(&format!("{TIMER_ANCHOR}{TIMER_ANCHOR}")),
            PatchOutcome::AnchorMissing
        );
    }
}
