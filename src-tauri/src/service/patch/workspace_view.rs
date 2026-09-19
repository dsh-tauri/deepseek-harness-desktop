//! workspace view 持久化状态补丁：降级核心读到新核心写下的形状时不再崩溃。
//!
//! 现象（0.1.5-rc.1 / 0.1.5-rc.2 一进页面就报
//! `slot entry crashed in 'sidebar.workspaces': TypeError: Cannot convert undefined or null to object`，
//! 工作区列表整条槽渲染失败）：核心 0.1.6-alpha.1 起
//! `@deepseek-ai/dsh-client-ui-workspace` 的浏览视图 store 去掉了
//! `sessionUpdatedAtByAccount`，持久化键却仍是同一个 `dsh.workspace.view.v5`。
//! 于是「先跑 0.1.6 + 再切回旧核心」时，旧核心 rehydrate 到的 state 没有该字段，
//! 而 `retainAccountKeys` 直接 `Object.entries(d.sessionUpdatedAtByAccount)` → 必抛；
//! 存储里的形状又不会自愈（每次进入都崩），工作区在旧核心上等于永久不可用。
//!
//! 本补丁只把该 action 里三处 `Object.entries(d.X)` 改成 `Object.entries(d.X ?? {})`
//! ——与上游 0.1.6 的定义对齐（0.1.6 直接删掉这个字段，消费方不再引用）。三处同属
//! 一个 action，任一字段缺失都该退化成空表，所以一起放宽；`?? {}` 对正常路径是 no-op。
//!
//! 目标选择：**活动核心**的 `dsh-client-ui-workspace/lib/client.js`（web 侧由 dsh 的
//! web 服务直接读该文件），读写与幂等判定统一交给 [`crate::utils::patch_dsh`]。
//! 锚点缺失（上游换了实现，或已经是 0.1.6 的 `delete` 写法）一律安全跳过，不阻断启动。
//!
//! 挂点：`service::workflow::launch` 启动 dsh 进程前的补丁链（最佳努力，失败只告警）。

use crate::utils::{patch_dsh, PatchOutcome};

/// 幂等/自识别标记：出现在被改写的三条语句末尾。
const PATCH_MARKER: &str = "dsh-tauri: tolerate workspace view state written by a newer core";

/// `retainAccountKeys` 里按账号收敛的三条语句（锚点绑定 rc.1/rc.2 的压缩后源码）。
const GROUP_EXPANSION_ORIGINAL: &str =
    "d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));";
const SESSION_ORDER_ORIGINAL: &str =
    "d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));";
const SESSION_UPDATED_AT_ORIGINAL: &str =
    "d.sessionUpdatedAtByAccount = Object.fromEntries(Object.entries(d.sessionUpdatedAtByAccount).filter(([key]) => retained.has(key)));";

const GROUP_EXPANSION_PATCHED: &str =
    "d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion ?? {}).filter(([key]) => retained.has(key))); /* dsh-tauri: tolerate workspace view state written by a newer core */";
const SESSION_ORDER_PATCHED: &str =
    "d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount ?? {}).filter(([key]) => retained.has(key))); /* dsh-tauri: tolerate workspace view state written by a newer core */";
const SESSION_UPDATED_AT_PATCHED: &str =
    "d.sessionUpdatedAtByAccount = Object.fromEntries(Object.entries(d.sessionUpdatedAtByAccount ?? {}).filter(([key]) => retained.has(key))); /* dsh-tauri: tolerate workspace view state written by a newer core */";

/// 相对活动核心安装目录的 workspace 客户端 `lib/client.js` 包内路径。
pub(super) const WORKSPACE_CLIENT_JS: &str =
    "node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(GROUP_EXPANSION_ORIGINAL)
        || !source.contains(SESSION_ORDER_ORIGINAL)
        || !source.contains(SESSION_UPDATED_AT_ORIGINAL)
    {
        return PatchOutcome::AnchorMissing;
    }
    let patched = source
        .replacen(GROUP_EXPANSION_ORIGINAL, GROUP_EXPANSION_PATCHED, 1)
        .replacen(SESSION_ORDER_ORIGINAL, SESSION_ORDER_PATCHED, 1)
        .replacen(SESSION_UPDATED_AT_ORIGINAL, SESSION_UPDATED_AT_PATCHED, 1);
    PatchOutcome::Patched(patched)
}

/// 对活动核心的 dsh-client-ui-workspace `lib/client.js` 应用补丁（幂等）。
/// 返回 Err 表示读/写失败；文件缺失、已打过、锚点变更均静默跳过（Ok）。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, WORKSPACE_CLIENT_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rc.1/rc.2 产物的真实片段（`retainAccountKeys` 三连，含上游缩进）。
    fn fixture() -> String {
        format!(
            "\t\t\t\t\tretainAccountKeys: (d, workspaceKeys) => {{\n\t\t\t\t\t\tconst retained = new Set(workspaceKeys);\n\t\t\t\t\t\t{GROUP_EXPANSION_ORIGINAL}\n\t\t\t\t\t\t{SESSION_ORDER_ORIGINAL}\n\t\t\t\t\t\t{SESSION_UPDATED_AT_ORIGINAL}\n\t\t\t\t\t}},\n"
        )
    }

    #[test]
    fn relaxes_all_three_retained_keys() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patched source");
        };
        assert!(patched.contains("Object.entries(d.groupExpansion ?? {})"));
        assert!(patched.contains("Object.entries(d.sessionOrderByAccount ?? {})"));
        assert!(patched.contains("Object.entries(d.sessionUpdatedAtByAccount ?? {})"));
        assert!(!patched.contains("Object.entries(d.sessionUpdatedAtByAccount).filter"));
        // 补丁只放宽取值，收敛逻辑本身（filter + fromEntries）保持不变。
        assert_eq!(patched.matches("filter(([key]) => retained.has(key)))").count(), 3);
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_when_anchor_missing() {
        // 0.1.6 及以后：字段被删，`retainAccountKeys` 只剩两条语句。
        let newer = format!(
            "const retained = new Set(workspaceKeys);\n{GROUP_EXPANSION_ORIGINAL}\n{SESSION_ORDER_ORIGINAL}\ndelete d.sessionUpdatedAtByAccount;\n"
        );
        assert_eq!(patch_source(&newer), PatchOutcome::AnchorMissing);
    }

    #[test]
    fn skips_partial_upstream_layout() {
        assert_eq!(patch_source(GROUP_EXPANSION_ORIGINAL), PatchOutcome::AnchorMissing);
    }
}
