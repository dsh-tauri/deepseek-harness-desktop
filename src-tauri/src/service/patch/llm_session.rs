//! OpenCode Go 会话标识头补丁（仅限 OpenCode 路由）。
//!
//! OpenCode Go 要求客户端为每段对话发送稳定的会话 ID，缺失时请求被拒绝
//! （`400 MissingSessionID`），它认可 Harness 原生头 `x-deepseek-harness-session-id`。
//! 上游 `@deepseek-ai/dsh-llm-deepseek` 直连适配器已发送该头，但 pi-ai 适配器的
//! `requestHeaders(headers)` 只把 `sessionId` 透传给 SDK、不写成请求头，因此走 pi-ai
//! 的 OpenCode Go 请求全部失败。本补丁让 `requestHeaders` 接收并使用当前会话 ID。
//!
//! 作用范围限定为 OpenCode 路由：provider id 以 `opencode` 开头（内置 `opencode-go`
//! 与 `opencode`），或其生效 baseURL 的主机为 `opencode.ai` 或 `*.opencode.ai`（自定义
//! 路由显式指向 OpenCode 的情形）。其它 provider 的请求头逐字节不变；没有会话 ID 的
//! 调用（例如模型发现）不发送该头。判定按 URL 主机名解析而非子串匹配，`opencode.ai`
//! 之外的域名（包括 `opencode.ai.evil.com` 这类前缀伪装）不会被误判。
//!
//! 幂等与容错：目标已含补丁标记（包括上一发布版本注入的同一标记）或锚点缺失时
//! `patch_dsh` 安全跳过、不回写文件，不阻断启动。补丁只改写打包内核中
//! `dsh-llm-pi-ai` 的 `lib/index.js` 一个文件；内核升级重新解压后会在干净文件上重新
//! 应用。已被上一发布版本改写过的内核保持原状，待核心重装或升级后自动切换到本版本。

use crate::utils::{patch_dsh, PatchOutcome};

/// 补丁标记：写入注入内容首行的注释，用于幂等判定。与上一发布版本保持一致，因此已经
/// 被上一版补丁改写过的内核会命中该标记并跳过（保持原状，直到核心重装或升级）。
const PATCH_MARKER: &str = "dsh-tauri-desktop: OpenCode Go session header";

/// 相对活动核心安装目录的 pi-ai 适配器包内路径。
pub(super) const PI_AI_INDEX_JS: &str = "node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js";

/// 原始 `requestHeaders` 定义：单参数、直接取 attribution。
const HEADERS_ANCHOR: &str =
    "function requestHeaders(headers) {\n\tconst attribution = attributionHeaders();";
/// 门控注入：新增 `isOpenCodeRoute` 判定，仅 OpenCode 路由把会话头并入 attribution。
/// `reserved` 集合由 attribution 的键推导，因此命中路由上配置的同名头会被会话值覆盖；
/// 未命中路由不含该键，配置里的同名头原样透传。
const HEADERS_PATCHED: &str = r#"/* dsh-tauri-desktop: OpenCode Go session header */
function isOpenCodeRoute(provider, baseURL) {
	if (typeof provider === "string" && provider.toLowerCase().startsWith("opencode")) return true;
	if (typeof baseURL !== "string") return false;
	try {
		const host = new URL(baseURL).hostname.toLowerCase();
		return host === "opencode.ai" || host.endsWith(".opencode.ai");
	} catch {
		return false;
	}
}
function requestHeaders(headers, sessionId, provider, baseURL) {
	const attribution = {
		...attributionHeaders(),
		...(sessionId === void 0 || !isOpenCodeRoute(provider, baseURL) ? {} : { "x-deepseek-harness-session-id": String(sessionId) })
	};"#;

/// 原始调用点：只透传 profile 配置头。
const CALL_ANCHOR: &str = "headers: requestHeaders(profile.headers)";
/// 门控调用点：把路由 id 与生效 baseUrl 一并传入，供 `isOpenCodeRoute` 判定。
const CALL_PATCHED: &str =
    "headers: requestHeaders(profile.headers, options.sessionId, profile.provider, model.baseUrl)";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(HEADERS_ANCHOR) || !source.contains(CALL_ANCHOR) {
        return PatchOutcome::AnchorMissing;
    }
    let patched = source
        .replacen(HEADERS_ANCHOR, HEADERS_PATCHED, 1)
        .replacen(CALL_ANCHOR, CALL_PATCHED, 1);
    PatchOutcome::Patched(patched)
}

/// 对活动核心的 dsh-llm-pi-ai `lib/index.js` 应用补丁（幂等）。
/// 返回 Err 表示读/写失败；文件缺失、已打过、锚点变更均静默跳过（Ok）。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, PI_AI_INDEX_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小可打补丁样本：保留两处锚点所需的精确形式，其余内容无关紧要。
    fn fixture() -> String {
        format!(
            "{HEADERS_ANCHOR}\n\tconst reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));\n\treturn {{ ...headers }};\n}}\n\t\t\t\t\t{CALL_ANCHOR}\n"
        )
    }

    #[test]
    fn patches_pristine_source_with_scoped_injection() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patch")
        };
        assert!(patched.contains(PATCH_MARKER));
        assert!(patched.contains("function isOpenCodeRoute(provider, baseURL)"));
        assert!(patched.contains("provider.toLowerCase().startsWith(\"opencode\")"));
        assert!(patched.contains("host === \"opencode.ai\" || host.endsWith(\".opencode.ai\")"));
        assert!(patched.contains("!isOpenCodeRoute(provider, baseURL)"));
        assert!(patched.contains(
            "requestHeaders(profile.headers, options.sessionId, profile.provider, model.baseUrl)"
        ));
        assert!(!patched.contains(CALL_ANCHOR));
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(&fixture()) else {
            panic!("expected patch")
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn missing_headers_anchor_is_skipped() {
        assert_eq!(patch_source(CALL_ANCHOR), PatchOutcome::AnchorMissing);
    }

    #[test]
    fn missing_call_anchor_is_skipped() {
        assert_eq!(patch_source(HEADERS_ANCHOR), PatchOutcome::AnchorMissing);
    }
}
