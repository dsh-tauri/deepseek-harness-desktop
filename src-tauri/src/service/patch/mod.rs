//! dsh 包文件补丁集。
//!
//! 集中存放对活动核心安装目录下 `node_modules/<包>/...` 里的 JS 文件做的一次性
//! 幂等补丁。每个补丁是一个子模块，只提供「纯函数式补丁判定 + apply 触发」；
//! 「定位文件 → 读取 → 打补丁 → 写回」与对应日志由 [`crate::utils::patch_dsh`]
//! 统一处理，避免每个补丁重复这份样板。
//!
//! 命名约定：子模块名不带 `_patch` 后缀（`renderer` / `session` / `workspace` /
//! `workspace_view` 等），挂点统一为 `service::workflow::launch`，均为最佳努力、
//! 失败仅告警。

pub(crate) mod composer;
pub(crate) mod llm_session;
pub(crate) mod mobile_composer;
pub(crate) mod mobile_sidebar;
pub(crate) mod model_selection;
pub(crate) mod pi_ai_thinking;
pub(crate) mod plugin_visibility;
pub(crate) mod renderer;
pub(crate) mod session;
pub(crate) mod theme_settings;
pub(crate) mod workspace;
pub(crate) mod workspace_view;

use std::path::Path;

/// 对显式给定的核心安装目录一次性施加全部补丁。
///
/// 与启动路径（`workflow::launch` 里逐个 `apply(&app_handle)`）等价，区别只是核心目录
/// 由调用方给出。E2E 编排用它把 npm 装来的核心打成与桌面端装配核心同样的形态——
/// 少了这些补丁，插件在 L2 里的行为与桌面端并不一致。
///
/// 单个补丁失败不阻断其余：与启动路径一样是「最佳努力」，但这里把错误汇总返回，
/// 让编排层能看见哪一条出了问题。
pub(crate) fn apply_all_at(core_dir: &Path) -> Result<(), String> {
    #[allow(clippy::type_complexity)]
    let patches: [(&str, fn(&Path) -> Result<(), String>); 12] = [
        ("renderer", renderer::apply_at),
        ("composer", composer::apply_at),
        ("mobile_composer", mobile_composer::apply_at),
        ("mobile_sidebar", mobile_sidebar::apply_at),
        ("session", session::apply_at),
        ("llm_session", llm_session::apply_at),
        ("pi_ai_thinking", pi_ai_thinking::apply_at),
        ("model_selection", model_selection::apply_at),
        ("theme_settings", theme_settings::apply_at),
        ("workspace", workspace::apply_at),
        ("workspace_view", workspace_view::apply_at),
        ("plugin_visibility", plugin_visibility::apply_at),
    ];
    let mut failures = Vec::new();
    for (name, apply) in patches {
        if let Err(e) = apply(core_dir) {
            if e.contains("DSH_PATCH_") {
                failures.push(format!("{name}: {e}"));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}
