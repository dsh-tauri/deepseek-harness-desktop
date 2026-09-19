//! alpha 核心的桌面嵌入鉴权补丁：为 `dsh --profile web` 补上可选的
//! `--skip-auth` 参数，而不是像旧实现那样无条件下发绕过。
//!
//! alpha 的 `dsh-client-connection` 默认要求浏览器先用启动 token 换取
//! `SameSite=Strict` Cookie。桌面端通过沙箱跨源 iframe 承载 Web UI，无法稳定完成
//! 该 Cookie 交换。旧补丁直接改写鉴权方法体、对所有请求放行；本补丁改为：只有
//! 显式传入 `--skip-auth` 时跳过 browser-session 层，其余场景保持上游完整鉴权：
//!
//! - `dsh-web-app/lib/startup.js`：给 web 命令补上 `--skip-auth` 选项；命中时设置
//!   `DSH_SKIP_AUTH=1`（进程级开关，桌面端在启动参数里显式传该标志）。
//! - `dsh-client-connection/lib/index.js`：仅当 `DSH_SKIP_AUTH=1` 时跳过
//!   browser-session 层（`authorizeIndex` 直接放行 index、`requestRejection` 不再
//!   校验 cookie），Host/Origin 信任边界仍由 `isTrustedApiRequest` 保留。
//!
//! 锚点兼容两种核心布局（issue #358）：
//! - pkg 打包核心（deepseek-harness-pkg）：`startup.js` 的 action 在
//!   `const options = program.opts();` 之后有 `const allowLan =
//!   process.env.DSH_PKG_ALLOW_LAN === "1";` 一行（pkg 构建注入的 0.0.0.0 护栏）；
//! - npm 全局原版核心（`npm i -g @deepseek-ai/dsh`）：没有 allowLan 行，`opts()`
//!   之后直接是 `--host`/`--port` 校验。
//!
//! 因此 action 锚点只匹配 `const options = program.opts();` 这一行，注入
//! `--skip-auth` 处理并把 allowLan 等后续行原样保留；两种布局都能命中。
//!
//! 普通用户运行 `dsh web`（不带 `--skip-auth`）时鉴权行为与上游一致；旧核心无
//! 上述锚点时 `patch_dsh` 安全跳过，不改变旧版行为。

use crate::utils::{dsh_rel_contains, patch_dsh, PatchOutcome};

const PATCH_MARKER: &str = "dsh-tauri-desktop: alpha embedded auth --skip-auth flag";

// ── dsh-web-app/lib/startup.js ────────────────────────────────────────────────
pub(super) const WEB_STARTUP_REL: &str = "node_modules/@deepseek-ai/dsh-web-app/lib/startup.js";
const STARTUP_OPTION_ANCHOR: &str =
    ".option(\"--no-open\", \"do not open the Web UI in the default browser\")";
const STARTUP_OPTION_REPLACEMENT: &str = ".option(\"--no-open\", \"do not open the Web UI in the default browser\")\n\t\t.option(\"--skip-auth\", \"skip the browser-session token/cookie exchange; keeps the Host/Origin trust fence (for embedded UIs)\")";
const STARTUP_ACTION_ANCHOR: &str = "\t\tconst options = program.opts();";
const STARTUP_ACTION_REPLACEMENT: &str = "\t\tconst options = program.opts();\n\t\t/* dsh-tauri-desktop: alpha embedded auth --skip-auth flag */\n\t\tif (options.skipAuth) process.env.DSH_SKIP_AUTH = \"1\";";

// ── dsh-client-connection/lib/index.js ────────────────────────────────────────
pub(super) const CONNECTION_INDEX_JS: &str =
    "node_modules/@deepseek-ai/dsh-client-connection/lib/index.js";
const REJECTION_ANCHOR: &str = "\trequestRejection(request) {\n\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;\n\t}";
const REJECTION_PATCHED: &str = "\trequestRejection(request) {\n\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\tif (process.env.DSH_SKIP_AUTH === \"1\") return void 0;\n\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;\n\t} /* dsh-tauri-desktop: alpha embedded auth --skip-auth flag */";
const AUTHORIZE_ANCHOR: &str = "\tauthorizeIndex(request, response) {\n\t\treturn this.browserAuth.authorizeIndex(request, response);\n\t}";
const AUTHORIZE_PATCHED: &str = "\tauthorizeIndex(request, response) {\n\t\tif (process.env.DSH_SKIP_AUTH === \"1\") return true;\n\t\treturn this.browserAuth.authorizeIndex(request, response);\n\t} /* dsh-tauri-desktop: alpha embedded auth --skip-auth flag */";

/// 替换 web 启动命令：接受 `--skip-auth`；命中时写入 `DSH_SKIP_AUTH=1` 作为与
/// connection 层之间的进程级开关。
fn patch_startup(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(STARTUP_OPTION_ANCHOR) || !source.contains(STARTUP_ACTION_ANCHOR) {
        return PatchOutcome::AnchorMissing;
    }

    let patched = source
        .replacen(STARTUP_OPTION_ANCHOR, STARTUP_OPTION_REPLACEMENT, 1)
        .replacen(STARTUP_ACTION_ANCHOR, STARTUP_ACTION_REPLACEMENT, 1);
    PatchOutcome::Patched(patched)
}

/// 替换 alpha 的 connection 鉴权：仅在 `DSH_SKIP_AUTH=1` 时跳过 browser-session，
/// 始终保留 Host/Origin trust fence；未设置时行为与上游一致。
fn patch_connection(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(REJECTION_ANCHOR) || !source.contains(AUTHORIZE_ANCHOR) {
        return PatchOutcome::AnchorMissing;
    }

    let patched = source
        .replacen(REJECTION_ANCHOR, REJECTION_PATCHED, 1)
        .replacen(AUTHORIZE_ANCHOR, AUTHORIZE_PATCHED, 1);
    PatchOutcome::Patched(patched)
}

/// 对活动核心应用「`--skip-auth` 可选鉴权」补丁。目标缺失或任一锚点变化时安全
/// 跳过，不阻断启动。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, WEB_STARTUP_REL, patch_startup)?;
    patch_dsh(app_handle, CONNECTION_INDEX_JS, patch_connection)?;
    Ok(())
}

/// 活动核心是否已具备完整的 `--skip-auth` 支持（选项层与 connection 层都已命中，
/// 或上游官方合并）。
///
/// 供 launch 判定是否往服务参数追加 `--skip-auth`：必须两层都生效才传，否则只传
/// 了选项、connection 层不认，会造成「看似跳过、实则仍拦」的半吊子状态；同时避免
/// 旧核心把未知选项当作错误而直接退出。
pub fn web_startup_supports_skip_auth(app_handle: &tauri::AppHandle) -> bool {
    dsh_rel_contains(app_handle, WEB_STARTUP_REL, "--skip-auth")
        && dsh_rel_contains(app_handle, CONNECTION_INDEX_JS, "DSH_SKIP_AUTH")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection_fixture() -> String {
        let mut source = String::new();
        source.push_str("\trequestRejection(request) {\n");
        source.push_str("\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n");
        source.push_str("\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;\n");
        source.push_str("\t}\n");
        source.push_str("\t/** Authenticate an index request through the process-token exchange or cookie. */\n");
        source.push_str(AUTHORIZE_ANCHOR);
        source.push_str("\n\tdsh web authentication required; reopen the URL printed by dsh web.\n");
        source
    }

    fn startup_fixture() -> String {
        let mut source = String::new();
        source.push_str("function webCommand() {\n");
        source.push_str(
            "\treturn new Command().name(\"dsh --profile web\").description(\"Serve the DeepSeek Harness browser UI.\").helpOption(\"-h, --help\", \"show this help\").option(\"--host <host>\", \"bind host\").option(\"--no-open\", \"do not open the Web UI in the default browser\").option(\"--port <port>\", \"listen port; pass 0 to let the OS pick a free one\").option(\"--trusted-host <authority...>\", \"extra authority the /api browser-trust fence accepts (host or host:port; repeatable)\").addHelpText(\"after\", `\nExamples:\n`);\n",
        );
        source.push_str("}\n\n");
        source.push_str("function apply(ctx) {\n");
        source.push_str("\tconst program = webCommand();\n");
        source.push_str("\tprogram.action(() => {\n");
        source.push_str(STARTUP_ACTION_ANCHOR);
        source.push_str("\n\t});\n");
        source.push_str("}\n");
        source
    }

    /// pkg 打包核心（deepseek-harness-pkg）布局：`opts()` 之后紧跟 pkg 注入的
    /// allowLan 护栏行（issue #358 中 dev 核心正是此布局，补丁必须保留该行）。
    fn startup_fixture_pkg_layout() -> String {
        let mut source = startup_fixture();
        source = source.replace(
            STARTUP_ACTION_ANCHOR,
            "\t\tconst options = program.opts();\n\t\tconst allowLan = process.env.DSH_PKG_ALLOW_LAN === \"1\";",
        );
        source
    }

    #[test]
    fn connection_patch_keeps_trust_fence_and_gates_browser_session() {
        let PatchOutcome::Patched(patched) = patch_connection(&connection_fixture()) else {
            panic!("expected connection patch");
        };
        assert!(patched.contains(PATCH_MARKER));
        // 信任边界保留。
        assert!(
            patched.contains("if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;")
        );
        // 命中开关时不返回 401。
        assert!(patched.contains("if (process.env.DSH_SKIP_AUTH === \"1\") return void 0;"));
        // 未命中时仍走原鉴权。
        assert!(patched.contains("this.browserAuth.isAuthenticated(request) ? void 0 : 401"));
        // 未命中 index 仍交给上游。
        assert!(patched
            .contains("if (process.env.DSH_SKIP_AUTH === \"1\") return true;\n\t\treturn this.browserAuth.authorizeIndex(request, response);"));
    }

    #[test]
    fn startup_patch_adds_option_and_env_handoff() {
        let PatchOutcome::Patched(patched) = patch_startup(&startup_fixture()) else {
            panic!("expected startup patch");
        };
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched.contains(".option(\"--skip-auth\", \"skip the browser-session token/cookie exchange; keeps the Host/Origin trust fence (for embedded UIs)\")"));
        assert!(patched
            .contains("\t\tif (options.skipAuth) process.env.DSH_SKIP_AUTH = \"1\";"));
    }

    /// 回归（issue #358）：npm 全局原版核心的 startup.js 在 `opts()` 之后**没有**
    /// allowLan 行，旧锚点（要求两行紧邻）导致 AnchorMissing、`--skip-auth` 未注入，
    /// boot page 返回 401。现在锚点只匹配 `opts()` 单行，npm 布局必须可打补丁。
    #[test]
    fn startup_patch_applies_to_npm_original_layout_without_allow_lan() {
        let fixture = startup_fixture();
        // npm 原版无 allowLan 行
        assert!(!fixture.contains("DSH_PKG_ALLOW_LAN"));

        let PatchOutcome::Patched(patched) = patch_startup(&fixture) else {
            panic!("expected startup patch on npm original layout");
        };
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched
            .contains("\t\tif (options.skipAuth) process.env.DSH_SKIP_AUTH = \"1\";"));
    }

    /// 回归（issue #358）：pkg 打包核心的 allowLan 行必须在打补丁后原样保留，
    /// 不能因锚点放宽而被吞掉。
    #[test]
    fn startup_patch_preserves_pkg_allow_lan_line() {
        let fixture = startup_fixture_pkg_layout();
        assert!(fixture.contains("DSH_PKG_ALLOW_LAN"));

        let PatchOutcome::Patched(patched) = patch_startup(&fixture) else {
            panic!("expected startup patch on pkg layout");
        };
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched
            .contains("\t\tconst allowLan = process.env.DSH_PKG_ALLOW_LAN === \"1\";"));
        assert!(patched
            .contains("\t\tif (options.skipAuth) process.env.DSH_SKIP_AUTH = \"1\";"));
    }

    #[test]
    fn patches_are_idempotent() {
        let PatchOutcome::Patched(startup) = patch_startup(&startup_fixture()) else {
            panic!("expected startup patch");
        };
        assert_eq!(patch_startup(&startup), PatchOutcome::AlreadyPatched);

        let PatchOutcome::Patched(connection) = patch_connection(&connection_fixture()) else {
            panic!("expected connection patch");
        };
        assert_eq!(patch_connection(&connection), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn legacy_or_changed_layout_is_untouched() {
        assert_eq!(
            patch_connection("requestRejection(request) { return 401; }"),
            PatchOutcome::AnchorMissing
        );
        assert_eq!(patch_startup("no web command here"), PatchOutcome::AnchorMissing);

        // `opts()` 行本身不存在（旧核心/上游布局彻底变化）→ 跳过
        let partial = startup_fixture().replace(
            STARTUP_ACTION_ANCHOR,
            "\t\tconst options = program.parse();",
        );
        assert_eq!(patch_startup(&partial), PatchOutcome::AnchorMissing);

        let partial = connection_fixture().replace(
            REJECTION_ANCHOR,
            "requestRejection(request) { return 401; }",
        );
        assert_eq!(patch_connection(&partial), PatchOutcome::AnchorMissing);
    }
}
