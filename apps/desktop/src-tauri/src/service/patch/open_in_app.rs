//! 「打开方式」补丁：启动被受理后让出桌面端前台。
//!
//! 上游 `dsh-client-ui-open-in-app` 的 `launch` 只把 busy 恢复成 idle，`dsh-host-open-in-app`
//! 的 `launchDetachedApp` 也只在观察窗内以「启动失败 / 提前退出」判定失败：两者都说明不了
//! 目标窗口已经激活，进程起来不等于窗口在前台（issue #1346）。用户诉求是「打开外部软件后
//! 让出前台」，语义因此定在壳侧——启动被受理（HTTP 2xx、未早退）之后由桌面端最小化当前
//! 窗口，失败时保持原样并照常提示。
//!
//! 窗口处理限定在本地桌面端：调用前要求 `__TAURI_INTERNALS__` 存在，远端窗口与普通浏览器
//! 没有这个全局，不会因为别人的打开请求隐藏无关窗口。
//!
//! 挂点与其它补丁一致：`service::workflow::launch` 启动 dsh 进程前，最佳努力、失败仅告警；
//! 锚点缺失（上游改写布局）时安全跳过。

use std::path::Path;

use crate::utils::{patch_dsh, PatchOutcome};

/// 官方客户端 bundle（相对活动核心安装目录的包内路径）。
const CLIENT_JS: &str = "node_modules/@deepseek-ai/dsh-client-ui-open-in-app/lib/client.js";

/// `launch` 成功分支唯一的那次 idle 提交，插入点就是它的末尾。
const SETTLE_ANCHOR: &str = "phase: \"idle\",\n\t\t\t\t\t\tpath\n\t\t\t\t\t});";

/// 插入的语句：仅本地桌面端让出前台，它本身兼作补丁标记（幂等判据）。
const YIELD_STATEMENT: &str =
    "if (globalThis.__TAURI_INTERNALS__) void globalThis.__TAURI_INTERNALS__.invoke(\"yield_foreground\");";

/// 在启动受理后插入「让出前台」。失败分支（`phase: "error"`）不动：打开失败必须保留 DSH
/// 在前台并显示错误。找不到锚点时安全跳过。
pub(crate) fn patch_client_launch(source: &str) -> PatchOutcome {
    if source.contains(YIELD_STATEMENT) {
        return PatchOutcome::AlreadyPatched;
    }
    let Some(start) = source.find(SETTLE_ANCHOR) else {
        return PatchOutcome::AnchorMissing;
    };
    let insert_at = start + SETTLE_ANCHOR.len();
    let mut patched = source.to_string();
    patched.insert_str(insert_at, "\n\t\t\t\t\t");
    patched.insert_str(insert_at + "\n\t\t\t\t\t".len(), YIELD_STATEMENT);
    PatchOutcome::Patched(patched)
}

/// 让「打开方式」受理启动后让出桌面端前台（最佳努力、幂等）。
pub fn apply(app_handle: &crate::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CLIENT_JS, patch_client_launch)
}

/// 对显式给定的核心安装目录施加同一个补丁（E2E 编排复用）。
pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    crate::utils::patch_core_file(core_dir, CLIENT_JS, patch_client_launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 上游 0.2.1-rc.5 产物里的 `launch`：成功分支提交 idle，失败分支提交 error。
    const SOURCE: &str = "async launch(appId, path) {\n\t\t\t\ttry {\n\t\t\t\t\tthis.operation.set({\n\t\t\t\t\t\tphase: \"busy\",\n\t\t\t\t\t\tpath\n\t\t\t\t\t});\n\t\t\t\t\tif (!response.ok) throw new Error();\n\t\t\t\t\tthis.operation.set({\n\t\t\t\t\t\tphase: \"idle\",\n\t\t\t\t\t\tpath\n\t\t\t\t\t});\n\t\t\t\t} catch (error) {\n\t\t\t\t\tthis.operation.set({\n\t\t\t\t\t\tphase: \"error\",\n\t\t\t\t\t\tpath\n\t\t\t\t\t});\n\t\t\t\t\tthrow error;\n\t\t\t\t}\n\t\t\t}";

    #[test]
    fn yield_is_inserted_after_the_idle_commit_only() {
        let PatchOutcome::Patched(patched) = patch_client_launch(SOURCE) else {
            panic!("expected Patched");
        };
        assert!(patched.contains(&format!("}});\n\t\t\t\t\t{YIELD_STATEMENT}")), "{patched}");
        assert_eq!(patched.matches(YIELD_STATEMENT).count(), 1, "只在成功分支插入一次");
        let error_at = patched.find("phase: \"error\",").unwrap();
        assert!(
            patched.find(YIELD_STATEMENT).unwrap() < error_at,
            "失败分支必须保持原样"
        );
    }

    #[test]
    fn patching_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_client_launch(SOURCE) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_client_launch(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn missing_settle_anchor_is_skipped() {
        assert_eq!(
            patch_client_launch("async launch() { return null }\n"),
            PatchOutcome::AnchorMissing
        );
    }
}
