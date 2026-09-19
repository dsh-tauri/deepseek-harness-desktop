//! Debug 客户端插件重载兼容补丁。
//!
//! 当前内置 DSH `0.1.1-rc.2` 的 client-HMR 在收到 `rebuilt` 后会卸载旧插件，
//! 但第三方插件的 Loader 条目不会重新挂载，表现为构建后插件消失、手动刷新才恢复。
//! debug 桌面端本来就直接联接本地插件源码，因此将该坏 hot-swap 降级为页面自动刷新：
//! 仍由 `/plugins/events` 精确触发，不轮询页面，也不会影响 release。

use crate::utils::{patch_dsh, PatchOutcome};

// HARDCODE：以下锚点绑定内置 DSH 0.1.1-rc.2 的 client-HMR bundle；仅 debug 生效。
const PATCH_MARKER: &str = "dsh-tauri-desktop: debug client plugin reload fallback";
const ORIGINAL: &str = r#"case "rebuilt":
						queue = queue.then(() => reload(frame.id)).catch((error) => {
							ctx.logger.error(`client-hmr: reload of "${frame.id}" failed`);
							ctx.logger.error(error);
						});
						break;"#;
const PATCHED: &str = r#"case "rebuilt":
						/* dsh-tauri-desktop: debug client plugin reload fallback */
						window.location.reload();
						break;"#;
// 上游已恢复完整的 invalidate → refresh 流程时，无需桌面端降级补丁。
// alpha 的压缩/格式化可能改变缩进，因此下面两个语句分别作为稳定锚点。
const UPSTREAM_INVALIDATE: &str = "modLoader.invalidate(id, rev);";
const UPSTREAM_PREFETCH: &str = "await modLoader.prefetch(id);";

/// 相对活动核心安装目录的 client-hmr `lib/client.js` 包内路径。
pub(super) const CLIENT_HMR_CLIENT_JS: &str = "node_modules/@deepseek-ai/dsh-client-hmr/lib/client.js";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if source.contains(UPSTREAM_INVALIDATE) && source.contains(UPSTREAM_PREFETCH) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(ORIGINAL) {
        return PatchOutcome::AnchorMissing;
    }
    PatchOutcome::Patched(source.replacen(ORIGINAL, PATCHED, 1))
}

/// debug 启动前把损坏的插件 hot-swap 降级为自动页面刷新。
#[cfg(debug_assertions)]
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CLIENT_HMR_CLIENT_JS, patch_source)
}

/// release 不修改客户端重载行为。
#[cfg(not(debug_assertions))]
pub fn apply(_app_handle: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_broken_hot_swap_with_page_reload() {
        let PatchOutcome::Patched(patched) = patch_source(ORIGINAL) else {
            panic!("expected patched source");
        };
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched.contains("window.location.reload();"));
        assert!(!patched.contains("queue = queue.then"));
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(ORIGINAL) else {
            panic!("expected patched source");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_unknown_upstream_layout() {
        assert_eq!(
            patch_source("case \"rebuilt\": break;"),
            PatchOutcome::AnchorMissing
        );
    }

    #[test]
    fn accepts_upstream_fixed_reload_flow() {
        let source = format!("{UPSTREAM_INVALIDATE} {UPSTREAM_PREFETCH}");
        assert_eq!(patch_source(&source), PatchOutcome::AlreadyPatched);
    }
}
