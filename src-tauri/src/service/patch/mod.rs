//! dsh 包文件补丁集。
//!
//! 集中存放对活动核心安装目录下 `node_modules/<包>/...` 里的 JS 文件做的一次性
//! 幂等补丁。每个补丁是一个子模块，只提供「纯函数式补丁判定 + apply 触发」；
//! 「定位文件 → 读取 → 打补丁 → 写回」与对应日志由 [`crate::utils::patch_dsh`]
//! 统一处理，避免每个补丁重复这份样板。
//!
//! 命名约定：子模块名不带 `_patch` 后缀（`renderer` / `session` / `workspace` /
//! `client_hmr`），挂点统一为 `service::workflow::launch`，均为最佳努力、失败仅告警。
//!
//! [`patched_paths`] 是补丁写入目标的**唯一声明**：离线安装包的链接层据此决定哪些
//! 目录必须是真实文件（补丁写不穿目录链接，见 `service::bundle`），并逐项校验。
//! 新增补丁时只要把常量登记进去，链接层自动跟随——绝不能在链接层里另抄一份清单。

pub(crate) mod alpha_auth;
pub(crate) mod client_hmr;
pub(crate) mod llm_session;
pub(crate) mod renderer;
pub(crate) mod session;
pub(crate) mod workspace;
pub(crate) mod workspace_view;

/// 桌面端会改写的核心内相对路径（相对活动核心目录，形如
/// `node_modules/<包>/lib/index.js`）。
///
/// 这些路径在离线安装包里必须是**真实可写文件**：补丁通过目录链接写入时，写入会
/// 透传到只读的随包资源上（macOS `.app` / Linux AppImage·deb），而 `patch_dsh` 对
/// 失败只记日志——`alpha_auth` 的补丁落不了地，`--skip-auth` 就不会下发，内嵌页面
/// 会要求登录。因此链接层必须按这份声明把这些目录复制成真实内容。
pub(crate) fn patched_paths() -> Vec<&'static str> {
    let mut paths = vec![
        alpha_auth::WEB_STARTUP_REL,
        alpha_auth::CONNECTION_INDEX_JS,
        client_hmr::CLIENT_HMR_CLIENT_JS,
        llm_session::PI_AI_INDEX_JS,
        renderer::RENDERER_CLIENT_JS,
        session::SESSION_INDEX_JS,
        workspace::WORKSPACE_INDEX_JS,
        workspace_view::WORKSPACE_CLIENT_JS,
    ];
    paths.sort_unstable();
    paths.dedup();
    paths
}

#[cfg(test)]
mod tests {
    use super::patched_paths;
    use std::collections::HashSet;

    /// 声明必须覆盖每个补丁模块实际使用的常量：常量改名/新增补丁而漏登记时，
    /// 离线包的链接层会把补丁目标留在只读链接后面，补丁静默失效。
    #[test]
    fn patched_paths_are_core_relative_and_unique() {
        let paths = patched_paths();
        assert_eq!(paths.len(), 8, "每个补丁常量都必须在声明里出现一次");
        assert_eq!(paths.iter().collect::<HashSet<_>>().len(), paths.len());

        for path in paths {
            assert!(
                path.starts_with("node_modules/") && path.ends_with(".js"),
                "补丁目标必须是核心内的 JS 文件: {path}"
            );
            assert!(!path.contains(".."), "补丁目标不得越出核心目录: {path}");
        }
    }
}
