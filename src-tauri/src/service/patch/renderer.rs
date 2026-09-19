//! renderer 一行导出补丁：给活动核心的 dsh-client-ui-renderer 补上 SlotOutlet 导出。
//!
//! dsh-tauri-ui 插件的设置侧边栏依赖 `<SlotOutlet>`（任意槽渲染入口）。官方
//! renderer 的 `lib/client.js` 只导出 `{apply, inject}`——SlotOutlet 实现完整
//! 却未公开，上游也没提供跨键渲染 API（插件只能 shadow 官方条目再自己渲染他人
//! 声明的槽，而这必须经过 SlotOutlet）。补丁在文件末尾的 `return module.exports;`
//! 前插入一行 `exports.SlotOutlet = SlotOutlet;`，与开发期手工补丁逐字节一致。
//!
//! 目标选择：**活动核心**（本地核心或预打包核心），读写与幂等判定统一交给
//! [`crate::utils::patch_dsh`]；本模块只提供纯函数式补丁判定 [`patch_source`]。
//!
//! 幂等与容错：
//! - 目标已含 `exports.SlotOutlet` 即跳过——上游将来自己导出（或已提的一行 PR
//!   合入）后本模块自动退休，零维护；
//! - 文件缺失或锚点（`return module.exports;`）因上游布局变更而找不到 → 跳过
//!   并告警，不阻断启动——插件侧另有降级（SlotOutlet 不可用时保留官方设置 dialog，
//!   绝不白屏）。
//!
//! 挂点：`service::workflow::launch` 启动 dsh 进程前，与 win_inspector / ensure_*
//! 自愈链同一位置（最佳努力，失败只告警）。

use crate::utils::{patch_dsh, PatchOutcome};

/// 导出锚点的关键字（所在行的前导缩进随版本变化，不做硬编码）。
const ANCHOR_KEYWORD: &str = "return module.exports;";

/// 相对活动核心安装目录的 renderer `lib/client.js` 包内路径。
pub(super) const RENDERER_CLIENT_JS: &str = "node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js";

/// 幂等补丁逻辑的纯函数部分（便于单测，不触碰文件系统）。
///
/// 定位 `return module.exports;` 所在行，按其**实际前导缩进**（tab/空格数随上游
/// 打包产物变化）插入同缩进的导出行——旧实现硬编码单 tab 锚点，upstream 产物
/// 用双 tab 时会在字符串内部命中、插出缩进错乱的坏行。
fn patch_source(source: &str) -> PatchOutcome {
    if source.contains("exports.SlotOutlet") {
        return PatchOutcome::AlreadyPatched;
    }
    let Some((line_start, indent)) = locate_return_module_exports(source) else {
        return PatchOutcome::AnchorMissing;
    };
    let mut patched = source.to_string();
    patched.insert_str(
        line_start,
        &format!("{indent}exports.SlotOutlet = SlotOutlet;\n"),
    );
    PatchOutcome::Patched(patched)
}

/// 定位 `return module.exports;` 所在行的行首字节偏移与其前导缩进。
///
/// 返回 `(行首偏移, 前导空白)`；行首到关键字之间必须是纯空白，否则不是锚行
/// （防御上游后续把 `return module.exports;` 挪进表达式里）。
fn locate_return_module_exports(source: &str) -> Option<(usize, &str)> {
    let match_start = source.find(ANCHOR_KEYWORD)?;
    let line_start = source[..match_start]
        .rfind('\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let indent = &source[line_start..match_start];
    if !indent.chars().all(|c| c == '\t' || c == ' ') {
        return None;
    }
    Some((line_start, indent))
}

/// 对活动核心的 dsh-client-ui-renderer `lib/client.js` 应用补丁（幂等）。
/// 返回 Err 表示读/写失败；文件缺失、已打过、锚点变更均静默跳过（Ok）。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, RENDERER_CLIENT_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实打包产物末尾的五行（单 tab 缩进；与旧实现测试锚点一致）。
    const TAIL: &str = "\t\t//#endregion\n\t\texports.apply = apply;\n\t\texports.inject = inject;\n\treturn module.exports;\n\t}\n});\n";

    /// 上游产物双 tab 缩进（回归：旧硬编码单 tab 锚点在此处命中坏位置）。
    const TAIL_DOUBLE_TAB: &str = "\t\t//#endregion\n\t\texports.apply = apply;\n\t\texports.inject = inject;\n\t\treturn module.exports;\n\t}\n});\n";

    #[test]
    fn patch_inserts_export_before_return() {
        match patch_source(TAIL) {
            PatchOutcome::Patched(patched) => {
                assert!(patched.contains("exports.SlotOutlet = SlotOutlet;"));
                assert!(patched.contains(
                    "\t\texports.inject = inject;\n\texports.SlotOutlet = SlotOutlet;\n\treturn module.exports;\n"
                ));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn patch_matches_double_tab_indentation() {
        // 回归：upstream 产物用双 tab 缩进，旧实现会命中 `\treturn` 子串、插出
        // 缩进错乱的坏行。新实现按行首缩进插入，导出行与 `return` 对齐（双 tab）。
        match patch_source(TAIL_DOUBLE_TAB) {
            PatchOutcome::Patched(patched) => {
                assert!(patched.contains(
                    "\t\texports.inject = inject;\n\t\texports.SlotOutlet = SlotOutlet;\n\t\treturn module.exports;\n"
                ));
                // 不产生把 return 缩进削掉一格的坏行
                assert!(!patched.contains("\n\texports.SlotOutlet = SlotOutlet;\n\treturn"));
            }
            other => panic!("expected Patched, got {other:?}"),
        }
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(TAIL) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn patch_skips_when_anchor_missing() {
        let altered = "\t\texports.apply = apply;\n\t\texports.inject = inject;\n";
        assert_eq!(patch_source(altered), PatchOutcome::AnchorMissing);
    }
}
