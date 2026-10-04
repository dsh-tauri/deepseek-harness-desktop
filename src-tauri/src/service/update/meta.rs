//! GitHub Release 元数据拉取（走 HTML/atom 页面，绕开未认证 API 限流）。
//!
//! 不依赖 api.github.com，仅通过 `releases.atom` 与 `releases/expanded_assets/<tag>`
//! 轻量解析最新 tag、发布时间、资产名与作者填写的 SHA-256 摘要。摘要缺失不阻断
//! 官方直连下载，但会禁用镜像兜底（见 [`super::install`]）。
//!
//! 更新判定只接受**正式版**（纯数字版本，见 [`super::version::is_stable`]）：
//! rc/beta/alpha 等 pre-release 与手动测试 release（`test-*` tag）一律跳过，
//! 用户不会收到非正式版的更新通知；装了 rc 的用户仍会按 semver 收到之后的正式版。

use std::time::Duration;

use super::version::{current_version, is_newer, is_stable, parse_version, pick_asset};
use super::REPO_URL;

/// 最新可用发布信息（仅在有更新且匹配到当前平台安装包时才有意义）
#[derive(Debug, Clone)]
pub(super) struct LatestRelease {
    pub(super) version: String,
    pub(super) tag: String,
    pub(super) published_at: String,
    pub(super) url: String,
    pub(super) asset_name: String,
    /// release 资产页（expanded_assets）中作者填写的 SHA-256 摘要
    /// （`sha256:<64hex>`）。`None` 表示无法取得可信摘要——此时镜像源
    /// 不可用作下载（无完整性凭据），仅官方直连可按旧行为继续。
    pub(super) digest: Option<String>,
}

/// 构造带统一 UA 的 HTTP 客户端（并发小、超时短）。
fn http_client(app_handle: &tauri::AppHandle) -> Result<reqwest::Client, String> {
    crate::config::proxy::http_client_builder(app_handle)?
        .user_agent("deepseek-harness-desktop")
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("UPDATE_CLIENT: {e}"))
}

/// 定位 `marker` 之后到 `end_marker` 之间的内容（用于轻量解析 atom/HTML）。
fn find_token<'a>(s: &'a str, marker: &str, end_marker: &str) -> Option<&'a str> {
    let start = s.find(marker)? + marker.len();
    let end = s[start..].find(end_marker).map(|e| start + e)?;
    Some(&s[start..end])
}

/// 从 releases.atom 正文解析全部 (tag, 发布时间)，按 feed 顺序（最新在前）。
///
/// GitHub 的 atom feed 会包含 pre-release（rc/beta/alpha）与手动测试 release
/// （`prerelease: true`），是否参与更新判定由调用方按 [`super::version::is_stable`]
/// 过滤。纯函数，便于测试。
fn parse_atom_entries(body: &str) -> Vec<(String, String)> {
    let mut releases = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("<entry>") {
        let end = rest[start..]
            .find("</entry>")
            .map(|e| start + e)
            .unwrap_or(rest.len());
        let block = &rest[start..end];
        if let Some(tag) = find_token(block, "releases/tag/", "\"") {
            let published_at = find_token(block, "<updated>", "</updated>")
                .unwrap_or_default()
                .to_string();
            releases.push((tag.to_string(), published_at));
        }
        rest = &rest[end..];
    }
    releases
}

/// 拉取 releases.atom 并解析全部 release（不走 api.github.com，不受未认证限流约束）。
pub(super) async fn fetch_releases_meta(app_handle: &tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let body = http_client(app_handle)?
        .get(format!("{REPO_URL}/releases.atom"))
        .send()
        .await
        .map_err(|e| format!("UPDATE_ATOM: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_ATOM: {e}"))?
        .text()
        .await
        .map_err(|e| format!("UPDATE_ATOM: {e}"))?;
    let releases = parse_atom_entries(&body);
    if releases.is_empty() {
        return Err("UPDATE_PARSE: no releases found in atom feed".to_string());
    }
    Ok(releases)
}

/// 从 expanded_assets 页面 HTML 中提取给定 tag 的全部资产文件名（纯函数，便于测试）。
fn extract_asset_names(html: &str, tag: &str) -> Vec<String> {
    let needle = format!("releases/download/{tag}/");
    let mut names = Vec::new();
    let mut start = 0;
    while let Some(pos) = html[start..].find(&needle) {
        let after = start + pos + needle.len();
        let end = html[after..]
            .find('"')
            .map(|e| after + e)
            .unwrap_or(html.len());
        names.push(html[after..end].to_string());
        start = end;
    }
    names
}

/// 从 expanded_assets HTML 片段中解析指定资产文件名后的 `sha256:<64hex>` 摘要。
///
/// 与 `download::core` 中 dsh 包的解析算法保持一致（非签名，仅页面元数据兜底，
/// 不能替代独立信任根）；解析失败/缺失返回 `None`。
fn parse_digest_from_expanded_assets(body: &str, expected_name: &str) -> Option<String> {
    let pos = body.find(expected_name)?;
    // 4096 字节窗口的终点回退到 UTF-8 字符边界，避免切片落在多字节字符中间 panic
    let mut end = (pos + 4096).min(body.len());
    while end > pos && !body.is_char_boundary(end) {
        end -= 1;
    }
    let window = &body[pos..end];
    const START: &str = "sha256:";
    let hash_start = window.find(START)?;
    let hash = &window[hash_start + START.len()..];
    let hex_end = hash
        .find(|c: char| !c.is_ascii_hexdigit())
        .unwrap_or(hash.len());
    if hex_end != 64 {
        return None;
    }
    Some(format!("sha256:{}", &hash[..64]))
}

/// 一次性拉取 expanded_assets 页面，同时提取资产名列表与该页面的原始 HTML。
///
/// 返回页面正文供调用方按**选中的资产名**精确解析其摘要——多平台 release 的
/// expanded_assets 会列出所有平台的安装包，各带一个 `sha256:`，不能取「页面里
/// 第一个能解析出摘要的资产」，否则会把别的资产的摘要套到当前平台安装包上，
/// 导致完整性校验必然失败（见 `fetch_latest_release`）。
async fn fetch_expanded_assets(app_handle: &tauri::AppHandle, tag: &str) -> Result<(Vec<String>, String), String> {
    let body = http_client(app_handle)?
        .get(format!("{REPO_URL}/releases/expanded_assets/{tag}"))
        .send()
        .await
        .map_err(|e| format!("UPDATE_ASSETS: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_ASSETS: {e}"))?
        .text()
        .await
        .map_err(|e| format!("UPDATE_ASSETS: {e}"))?;
    let names = extract_asset_names(&body, tag);
    Ok((names, body))
}

/// 查询最新可用的**正式版** Release（无缓存，每次实时检查，走 HTML/atom 而非
/// api.github.com）。
///
/// 按 feed 顺序（最新在前）扫描：跳过非法 semver（如手动测试 release 的
/// `test-*` tag）与 pre-release（rc/beta/alpha），只接受**纯数字正式版**且严格
/// 高于当前版本。首个命中即返回；当前平台无匹配安装包时继续看更旧的正式版。
///
/// 返回 `Ok(Some(LatestRelease))` 表示有更新且匹配到当前平台安装包；
/// `Ok(None)` 表示无更新（或未匹配到资产）。网络失败返回 Err。
pub(super) async fn fetch_latest_release(app_handle: &tauri::AppHandle) -> Result<Option<LatestRelease>, String> {
    let current = current_version();
    for (tag, published_at) in fetch_releases_meta(app_handle).await? {
        let version = tag.trim_start_matches('v').to_string();
        let Some(parsed) = parse_version(&version) else {
            log::debug!("UPDATE_SKIP: {tag} 非法 semver（手动测试 release?），跳过");
            continue;
        };
        if !is_stable(&parsed) {
            log::debug!("UPDATE_SKIP: {tag} 为 pre-release（非正式版），不通知用户");
            continue;
        }
        if !is_newer(&version, &current) {
            log::debug!("UPDATE_SKIP: {tag} 不高于当前版本 {current}");
            continue;
        }
        if let Some(release) = fetch_release_assets(app_handle, &tag, &version, &published_at).await? {
            return Ok(Some(release));
        }
    }
    Ok(None)
}

/// 为选定的正式版 tag 挑选当前平台安装包并解析摘要。
///
/// 摘要必须按**当前平台选中的资产**解析：多平台 release 的页面里每个安装包
/// 各有各的 `sha256:`，取错资产（如页面里第一个）会拿别的包的摘要来校验，
/// 导致 `INTEGRITY_CHECK_FAILED` 误伤合法下载。摘要缺失不阻断官方直连下载，
/// 但镜像兜底需要可信摘要（见 [`super::install`]）防止投毒。
///
/// 返回 `None` 表示该 release 无匹配当前平台的安装包（调用方继续看更旧的正式版）。
async fn fetch_release_assets(
    app_handle: &tauri::AppHandle,
    tag: &str,
    version: &str,
    published_at: &str,
) -> Result<Option<LatestRelease>, String> {
    // 一次拉取 expanded_assets 页面，得到资产名列表与原始 HTML（避免两次请求）
    let (names, body) = fetch_expanded_assets(app_handle, tag).await?;
    let Some(asset_name) = pick_asset(&names) else {
        log::debug!("UPDATE_SKIP: {tag} 无当前平台安装包，继续看更旧的正式版");
        return Ok(None);
    };

    let digest = parse_digest_from_expanded_assets(&body, &asset_name);
    log::debug!(
        "Release {tag} digest for picked asset {}: {}",
        asset_name,
        digest.as_deref().map(|d| &d[..12]).unwrap_or("<none>")
    );

    // 下载地址由 tag + 资产名直接构造，无需 API
    let url = format!("{REPO_URL}/releases/download/{tag}/{asset_name}");
    Ok(Some(LatestRelease {
        version: version.to_string(),
        tag: tag.to_string(),
        published_at: published_at.to_string(),
        url,
        asset_name,
        digest,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_token_extracts_between_markers() {
        let s = r#"<link rel="alternate" href="https://github.com/x/releases/tag/v0.6.6"/>"#;
        assert_eq!(find_token(s, "releases/tag/", "\""), Some("v0.6.6"));
        let s2 = "<updated>2026-08-19T09:27:38Z</updated>";
        assert_eq!(
            find_token(s2, "<updated>", "</updated>"),
            Some("2026-08-19T09:27:38Z")
        );
        assert_eq!(find_token("no marker", "releases/tag/", "\""), None);
    }

    /// feed 解析回归：多 entry 按序解析；pre-release 与手动测试 tag 照常解析
    /// （是否参与更新判定由调用方按 `is_stable` 过滤）。
    #[test]
    fn parse_atom_entries_multiple_entries_in_order() {
        let feed = r#"<feed>
            <entry><id>1</id><link rel="alternate" href="/hairyf/deepseek-harness-desktop/releases/tag/v0.7.14-rc.1"/><updated>2026-08-20T01:00:00Z</updated></entry>
            <entry><id>2</id><link rel="alternate" href="/hairyf/deepseek-harness-desktop/releases/tag/v0.7.13"/><updated>2026-08-19T00:00:00Z</updated></entry>
            <entry><id>3</id><link rel="alternate" href="/hairyf/deepseek-harness-desktop/releases/tag/test-main-42"/></entry>
        </feed>"#;
        assert_eq!(
            parse_atom_entries(feed),
            vec![
                (
                    "v0.7.14-rc.1".to_string(),
                    "2026-08-20T01:00:00Z".to_string()
                ),
                ("v0.7.13".to_string(), "2026-08-19T00:00:00Z".to_string()),
                ("test-main-42".to_string(), String::new()),
            ]
        );
        assert!(parse_atom_entries("").is_empty());
        assert!(parse_atom_entries("<feed></feed>").is_empty());
    }

    #[test]
    fn extract_asset_names_parses_download_links() {
        let tag = "v0.6.6";
        let html = r#"
            <a href="/hairyf/deepseek-harness-desktop/releases/download/v0.6.6/x64-setup.exe">x</a>
            <a href="/hairyf/deepseek-harness-desktop/releases/download/v0.6.6/x64_en-US.msi">y</a>
            <a href="/hairyf/deepseek-harness-desktop/releases/download/v0.6.5/old.dmg">z</a>
        "#;
        let names = extract_asset_names(html, tag);
        assert_eq!(names, vec!["x64-setup.exe", "x64_en-US.msi"]);
        assert!(extract_asset_names(html, "v9.9.9").is_empty());
        assert!(extract_asset_names("", tag).is_empty());
    }

    /// 摘要解析回归：识别 `sha256:<64hex>`（含中文/多字节前缀），拒绝非法摘要。
    #[test]
    fn parse_digest_from_expanded_assets_extracts_sha256() {
        let hex = format!("sha256:{}", "a".repeat(64));
        let html = format!(
            r#"<td>设置包</td><td class="d-block">app.dmg</td><td>下载</td><td>{hex}</td>"#
        );
        let digest = parse_digest_from_expanded_assets(&html, "app.dmg");
        let expected = format!("sha256:{}", "a".repeat(64));
        assert_eq!(digest.as_deref(), Some(expected.as_str()));

        // 无匹配资产 → None
        assert!(parse_digest_from_expanded_assets(&html, "app-x86_64.dmg").is_none());
        // 摘要长度/字符不合法 → None
        let bad = r#"<td>app.dmg sha256:zz"#;
        assert!(parse_digest_from_expanded_assets(bad, "app.dmg").is_none());
        // 多字节内容前移后仍能解析（切片边界安全）
        let unicode = format!("中文说明app.dmg{}更多内容", hex);
        assert!(parse_digest_from_expanded_assets(&unicode, "app.dmg").is_some());
    }

    /// 回归：多平台 release 页面里每个资产各带一个 `sha256:`，摘要必须按**所选
    /// 资产**解析，绝不能拿页面里第一个资产的摘要 —— 否则校验会把别的安装包的
    /// 摘要套到当前平台包上（INTEGRITY_CHECK_FAILED）。
    #[test]
    fn digest_is_resolved_per_picked_asset_not_first_in_page() {
        let a = "a".repeat(64);
        let b = "b".repeat(64);
        // 模拟真实 expanded_assets：每个资产行 = 下载链接 + 紧跟其后的 sha256，
        // 页面顺序为 rpm（第一个）→ setup.exe（第二个），两者摘要不同。
        let body = format!(
            r#"<a href="/x/y/releases/download/v0.7.5/app.rpm">app.rpm</a><span>sha256:{a}</span>
               <a href="/x/y/releases/download/v0.7.5/setup.exe">setup.exe</a><span>sha256:{b}</span>"#
        );
        // 旧实现「取页面里第一个能解析的资产」会拿到 rpm 的摘要（a），
        // 而实际选中的是 setup.exe —— 修复后必须返回 setup.exe 自己的摘要（b）。
        let rpm_digest = parse_digest_from_expanded_assets(&body, "app.rpm");
        let picked_digest = parse_digest_from_expanded_assets(&body, "setup.exe");
        let expected_rpm = format!("sha256:{a}");
        let expected_picked = format!("sha256:{b}");
        assert_eq!(rpm_digest.as_deref(), Some(expected_rpm.as_str()));
        assert_eq!(picked_digest.as_deref(), Some(expected_picked.as_str()));
        // 两个摘要必须不同才是「多资产 + 各自摘要」的有效回归用例
        assert_ne!(rpm_digest, picked_digest);
    }
}
