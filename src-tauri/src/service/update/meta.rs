//! GitHub Release 元数据拉取（走 HTML/atom 页面，绕开未认证 API 限流）。
//!
//! 不依赖 api.github.com，仅通过 `releases.atom` 与 `releases/expanded_assets/<tag>`
//! 轻量解析最新 tag、发布时间、资产名与作者填写的 SHA-256 摘要。摘要缺失不阻断
//! 官方直连下载，但会禁用镜像兜底（见 [`super::install`]）。
//!
//! 更新判定只接受**正式版**（纯数字版本，见 [`super::version::is_stable`]）：
//! rc/beta/alpha 等 pre-release 与手动测试 release（`test-*` tag）一律跳过，
//! 用户不会收到非正式版的更新通知；装了 rc 的用户仍会按 semver 收到之后的正式版。
//!
//! 夜间构建（`nightly-YYYYMMDD` 的滚动 pre-release，见 `.github/workflows/release-nightly.yml`）
//! 同样被跳过，但 `releases.atom` 只保留最近 10 条：夜间版按天滚动后会把窗口占满，
//! 正式版全部被挤出，更新检查会静默失效（用户永远停在当前版本）。因此窗口里一条正式版
//! 都看不见时会再问一次 `/releases/latest`——该端点由 GitHub 保证指向最新正式版；若它
//! 恰好没有当前平台的安装包，再翻 `releases` 列表页（HTML，支持 `?page=`）继续找更旧的
//! 正式版——这是唯一能枚举历史的入口（atom feed 不接受 `?page=`，实测仍返回同一批 10 条）。

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

/// 从 atom feed 里筛出「严格高于当前版本的正式版」候选，按 feed 顺序（最新在前）。
///
/// 同时回报窗口里是否出现过正式版：`releases.atom` 只保留最近 10 条，夜间版把窗口
/// 占满后该值为 false，调用方必须改用 `/releases/latest` 兜底。纯函数，便于测试。
fn stable_candidates(releases: &[(String, String)], current: &str) -> (Vec<(String, String)>, bool) {
    let mut candidates = Vec::new();
    let mut saw_stable = false;
    for (tag, published_at) in releases {
        let version = tag.trim_start_matches('v');
        let Some(parsed) = parse_version(version) else {
            log::debug!("UPDATE_SKIP: {tag} 非法 semver（手动测试 release?），跳过");
            continue;
        };
        if !is_stable(&parsed) {
            log::debug!("UPDATE_SKIP: {tag} 为 pre-release（非正式版），不通知用户");
            continue;
        }
        saw_stable = true;
        if !is_newer(version, current) {
            log::debug!("UPDATE_SKIP: {tag} 不高于当前版本 {current}");
            continue;
        }
        candidates.push((tag.clone(), published_at.clone()));
    }
    (candidates, saw_stable)
}

/// tag 是否为正式版（纯数字版本，`v` 前缀可选）——与 [`stable_candidates`] 同一套判定。
fn is_stable_tag(tag: &str) -> bool {
    parse_version(tag.trim_start_matches('v')).is_some_and(|parsed| is_stable(&parsed))
}

/// 从 `/releases/latest` 302 之后的最终 URL 解析 tag（纯函数，便于测试）。
///
/// 该端点由 GitHub 保证排除 pre-release 与草稿，解析结果必然是正式版 tag；tag 自带
/// `/` 的极端情况会被截断，本仓正式版 tag 形如 `v0.22.3`，不受影响。
fn parse_latest_tag(url: &str) -> Option<String> {
    const MARKER: &str = "/releases/tag/";
    let rest = &url[url.find(MARKER)? + MARKER.len()..];
    let end = rest
        .find(|c| matches!(c, '?' | '#' | '/'))
        .unwrap_or(rest.len());
    let tag = &rest[..end];
    (!tag.is_empty()).then(|| tag.to_string())
}

/// 从 releases 列表页（HTML，支持 `?page=N`）解析出现的 tag，按页面顺序去重。
///
/// `releases.atom` 只有最近 10 条且**不接受 `?page=`**（实测第 2 页与第 1 页内容相同），
/// 夜间版滚满窗口后 atom 里再也看不到正式版，而 `/releases/latest` 只能给一个 tag：
/// 当它没有当前平台安装包时，只有这个可翻页的 HTML 列表能继续往更旧的正式版找。
fn parse_release_listing_tags(html: &str) -> Vec<String> {
    const MARKER: &str = "/releases/tag/";
    let mut tags: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some(offset) = html[from..].find(MARKER) {
        let start = from + offset + MARKER.len();
        let tail = &html[start..];
        // 形如 `…/releases/tag/v0.22.3"`（相对链接）或 `…/releases/tag/v0.22.3?expanded=true`
        let end = tail
            .find(|c: char| matches!(c, '"' | '\'' | '?' | '#' | '>'))
            .unwrap_or(tail.len());
        let tag = &tail[..end];
        if !tag.is_empty() && !tags.iter().any(|t| t == tag) {
            tags.push(tag.to_string());
        }
        // 必须前进：`end == 0` 时退回到 tag 起点，也至少比上一轮的 from 前进了一个 MARKER
        from = start + end;
    }
    tags
}

/// 从列表页解析出的 tag 里筛出可用的更旧正式版候选（最新在前），剔除已试过的 tag。
///
/// 与 [`stable_candidates`] 同一套过滤规则（非法 semver / pre-release / 不高于当前版本的
/// 全部跳过）；差别是列表页只有相对时间，不值得为发布时间再多请求一次，故透传空串。
fn listed_stable_candidates(tags: &[String], current: &str, skip: &[String]) -> Vec<(String, String)> {
    tags.iter()
        .filter(|tag| !skip.iter().any(|s| tag == &s))
        .filter(|tag| is_stable_tag(tag) && is_newer(tag.trim_start_matches('v'), current))
        .map(|tag| (tag.clone(), String::new()))
        .collect()
}

/// 形如 `2026-10-06T16:11:01Z` 的 ISO-8601 UTC 时间戳。
fn is_iso_utc(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && value.ends_with('Z')
        && value[..19]
            .bytes()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7 | 10 | 13 | 16) || b.is_ascii_digit())
}

/// 从 release 页面 HTML 解析发布时间：页面里第一个 ISO-8601 的 `datetime="…"`。
///
/// GitHub 在同一页里还会渲染提交时间等其它 `datetime`，其中展示用的那种形如
/// `2026-10-06 15:28:28 UTC`（不是 ISO），必须跳过，否则「发布日期」会取到提交时间。
fn parse_published_at(html: &str) -> Option<String> {
    const MARKER: &str = "datetime=\"";
    let mut rest = html;
    while let Some(pos) = rest.find(MARKER) {
        let tail = &rest[pos + MARKER.len()..];
        let end = tail.find('"')?;
        let value = &tail[..end];
        if is_iso_utc(value) {
            return Some(value.to_string());
        }
        rest = &tail[end..];
    }
    None
}

/// 查询 `/releases/latest`，返回最新正式版 tag（GitHub 侧已排除 pre-release 与草稿）。
///
/// 仓库一个正式版都没有时该端点直接 404：这是「无更新」而不是检查失败，必须返回
/// `Ok(None)`，否则界面会把「已是最新」显示成检查出错。
async fn fetch_latest_stable_tag(app_handle: &tauri::AppHandle) -> Result<Option<String>, String> {
    let response = http_client(app_handle)?
        .get(format!("{REPO_URL}/releases/latest"))
        .send()
        .await
        .map_err(|e| format!("UPDATE_LATEST: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response
        .error_for_status()
        .map_err(|e| format!("UPDATE_LATEST: {e}"))?;
    Ok(parse_latest_tag(response.url().as_str()))
}

/// 翻 `releases` 列表页（HTML，支持 `?page=`）找比兜底候选更旧的可用正式版。
///
/// 一页只有 10 条且夜间版会占满前几页，因此逐页翻到出现候选为止（最多 `LISTING_PAGES`
/// 页）——第一页就可能拿到多个更旧的正式版，多了没有意义。返回空表示确实没有更旧的
/// 正式版（此时「没有可用更新」是正确结论，不是检查失败）。
async fn fetch_listed_stable_candidates(
    app_handle: &tauri::AppHandle,
    current: &str,
    skip: &[String],
) -> Result<Vec<(String, String)>, String> {
    const LISTING_PAGES: u32 = 3;
    let client = http_client(app_handle)?;
    let mut found: Vec<(String, String)> = Vec::new();
    for page in 1..=LISTING_PAGES {
        let body = client
            .get(format!("{REPO_URL}/releases?page={page}"))
            .send()
            .await
            .map_err(|e| format!("UPDATE_LISTING: {e}"))?
            .error_for_status()
            .map_err(|e| format!("UPDATE_LISTING: {e}"))?
            .text()
            .await
            .map_err(|e| format!("UPDATE_LISTING: {e}"))?;
        let tags = parse_release_listing_tags(&body);
        if tags.is_empty() {
            // 页面结构变化或已到末页：再翻下去只会重复拿到空列表
            break;
        }
        found.extend(listed_stable_candidates(&tags, current, skip));
        if !found.is_empty() {
            break;
        }
    }
    Ok(found)
}

/// 拉取某个 release 的 tag 页面并解析发布时间（解析不出来返回 `None`，不阻断更新检查）。
async fn fetch_tag_published_at(app_handle: &tauri::AppHandle, tag: &str) -> Result<Option<String>, String> {
    let body = http_client(app_handle)?
        .get(format!("{REPO_URL}/releases/tag/{tag}"))
        .send()
        .await
        .map_err(|e| format!("UPDATE_TAG: {e}"))?
        .error_for_status()
        .map_err(|e| format!("UPDATE_TAG: {e}"))?
        .text()
        .await
        .map_err(|e| format!("UPDATE_TAG: {e}"))?;
    Ok(parse_published_at(&body))
}

/// 按顺序（最新在前）返回首个在当前平台有匹配安装包的正式版。
///
/// 没有匹配安装包时继续看下一个候选（见 [`fetch_latest_release`] 的语义说明）。
async fn first_matching_release(
    app_handle: &tauri::AppHandle,
    candidates: Vec<(String, String)>,
) -> Result<Option<LatestRelease>, String> {
    for (tag, published_at) in candidates {
        let version = tag.trim_start_matches('v');
        if let Some(release) = fetch_release_assets(app_handle, &tag, version, &published_at).await? {
            return Ok(Some(release));
        }
    }
    Ok(None)
}

/// 查询最新可用的**正式版** Release（无缓存，每次实时检查，走 HTML/atom 而非
/// api.github.com）。
///
/// 先按 feed 顺序（最新在前）扫描（见 [`stable_candidates`]）：跳过非法 semver（如手动
/// 测试 release 的 `test-*` tag）、pre-release（rc/beta/夜间版）与不高于当前版本的 tag，
/// 首个命中的正式版即返回；当前平台无匹配安装包时继续看更旧的正式版。
///
/// feed 里一条正式版都看不见时（窗口被夜间版占满）改问 `/releases/latest`：GitHub 保证
/// 它指向最新正式版。只要窗口里看得见任一正式版，最新正式版必然也在窗口内，因此不必兜底
/// ——这条捷径也保证正式版没被挤出时，更新检查行为与旧实现完全一致。
///
/// 兜底候选（最新正式版）自己缺当前平台安装包时，两条路径的语义必须一致：继续往更旧的
/// 正式版找（`/releases/latest` 只给一个 tag，历史只能靠可翻页的列表页枚举），否则该平台
/// 会在夜间版占满窗口期间静默停在旧版本，用户永远收不到更新。
///
/// 返回 `Ok(Some(LatestRelease))` 表示有更新且匹配到当前平台安装包；
/// `Ok(None)` 表示无更新（或未匹配到资产）。网络失败返回 Err。
pub(super) async fn fetch_latest_release(app_handle: &tauri::AppHandle) -> Result<Option<LatestRelease>, String> {
    if !super::version::supports_stable_updates(&app_handle.config().identifier) {
        return Ok(None);
    }
    let current = current_version();
    let (candidates, saw_stable) = stable_candidates(&fetch_releases_meta(app_handle).await?, &current);

    // 窗口里看得见正式版：与旧实现完全一致，只按 feed 顺序找（最新正式版必在窗口内）
    if saw_stable {
        return first_matching_release(app_handle, candidates).await;
    }

    // 窗口被夜间版占满：先问 `/releases/latest`
    let mut fallback: Vec<(String, String)> = Vec::new();
    if let Some(tag) = fetch_latest_stable_tag(app_handle).await? {
        if is_stable_tag(&tag) && is_newer(tag.trim_start_matches('v'), &current) {
            // 发布时间只有 feed 正文才有：兜底路径不为它再多请求一次页面。该字段仅随
            // 更新信息透传给前端、界面不展示（关于对话框的发布日期走 `about.rs`）。
            fallback.push((tag, String::new()));
        } else {
            log::debug!("UPDATE_SKIP: {tag} 非可用正式版（非法/预发布/不高于 {current}）");
        }
    }
    if fallback.is_empty() {
        // 一个正式版都没有（`/releases/latest` 404）或都不高于当前版本：确实没有更新
        return Ok(None);
    }
    let skip: Vec<String> = fallback.iter().map(|(tag, _)| tag.clone()).collect();
    if let Some(release) = first_matching_release(app_handle, fallback).await? {
        return Ok(Some(release));
    }

    // 兜底候选缺当前平台安装包：翻列表页继续找更旧的正式版
    let older = fetch_listed_stable_candidates(app_handle, &current, &skip).await?;
    first_matching_release(app_handle, older).await
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

/// 最新**正式版**的发布时间（关于对话框的「发布日期」）。
///
/// feed 里混着 pre-release（rc/夜间版）且会被夜间版占满，直接取首条会把夜间版的构建
/// 时间当成正式版发布时间，因此必须先按 [`super::version::is_stable`] 过滤再取。
///
/// 窗口被夜间版占满时 feed 里一条正式版都没有：此时改问 `/releases/latest` 并读它自己的
/// tag 页面拿发布时间，否则「关于」对话框的发布日期会在整个夜间版周期里一直空着。
///
/// 首条正式版自己没带时间时同样补读它的 tag 页面：顺着列表往下找会显示更旧版本的日期。
pub(super) async fn fetch_latest_stable_published_at(app_handle: &tauri::AppHandle) -> Result<String, String> {
    let releases = fetch_releases_meta(app_handle).await?;
    if let Some((tag, published_at)) = releases.into_iter().find(|(tag, _)| is_stable_tag(tag)) {
        if !published_at.is_empty() {
            return Ok(published_at);
        }
        return Ok(fetch_tag_published_at(app_handle, &tag).await?.unwrap_or_default());
    }
    let Some(tag) = fetch_latest_stable_tag(app_handle).await? else {
        // 仓库一个正式版都没有：没有发布日期可显示
        return Ok(String::new());
    };
    // 页面结构解析不出来时保持旧行为（空串 → 界面显示 `-`），不把更新检查拖成错误
    Ok(fetch_tag_published_at(app_handle, &tag).await?.unwrap_or_default())
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

    /// 回归：夜间版/滚动别名占满 feed 窗口时必须产出空候选，且 `saw_stable` 为 false
    /// —— 否则调用方不会走 `/releases/latest` 兜底，正式版用户的更新检查会静默失效
    /// （用户永远停在当前版本）。
    #[test]
    fn stable_candidates_reports_window_without_stable() {
        let nightlies: Vec<(String, String)> = (1..=10)
            .map(|day| {
                (
                    format!("nightly-202610{day:02}"),
                    format!("2026-10-{day:02}T18:00:00Z"),
                )
            })
            .collect();
        let (candidates, saw_stable) = stable_candidates(&nightlies, "0.22.3");
        assert!(candidates.is_empty());
        assert!(!saw_stable);

        // 滚动别名 tag（无日期）同样不参与判定，不得被误当成版本
        let mut mixed = nightlies.clone();
        mixed.insert(0, ("nightly".to_string(), "2026-10-11T18:00:00Z".to_string()));
        let (candidates, saw_stable) = stable_candidates(&mixed, "0.22.3");
        assert!(candidates.is_empty());
        assert!(!saw_stable);

        // 窗口里重新出现正式版：候选按 feed 顺序返回，且不再需要兜底
        mixed.push(("v0.22.4".to_string(), "2026-10-12T00:00:00Z".to_string()));
        let (candidates, saw_stable) = stable_candidates(&mixed, "0.22.3");
        assert_eq!(
            candidates,
            vec![("v0.22.4".to_string(), "2026-10-12T00:00:00Z".to_string())]
        );
        assert!(saw_stable);
    }

    /// 回归：rc/beta 与手动测试 tag 既不参与更新判定，也不影响「窗口里有正式版」的判定。
    #[test]
    fn stable_candidates_skips_prerelease_and_junk_tags() {
        let releases = vec![
            ("v0.23.0-rc.1".to_string(), "t1".to_string()),
            ("test-main-42".to_string(), "t2".to_string()),
            ("v0.22.3".to_string(), "t3".to_string()),
            ("v0.22.2".to_string(), "t4".to_string()),
        ];
        let (candidates, saw_stable) = stable_candidates(&releases, "0.22.3");
        assert!(candidates.is_empty());
        assert!(saw_stable);

        let (candidates, saw_stable) = stable_candidates(&releases, "0.22.2");
        assert_eq!(candidates, vec![("v0.22.3".to_string(), "t3".to_string())]);
        assert!(saw_stable);
    }

    /// `/releases/latest` 的最终 URL → tag；落到非 tag 页面时必须返回 None，不能猜一个 tag
    /// （无正式版时该端点 404，退回自身 URL 就是这种情况）。
    #[test]
    fn parse_latest_tag_reads_redirect_target() {
        assert_eq!(
            parse_latest_tag("https://github.com/x/y/releases/tag/v0.22.3").as_deref(),
            Some("v0.22.3")
        );
        assert_eq!(
            parse_latest_tag("https://github.com/x/y/releases/tag/v0.22.3?expanded=true").as_deref(),
            Some("v0.22.3")
        );
        assert_eq!(parse_latest_tag("https://github.com/x/y/releases/latest"), None);
        assert_eq!(parse_latest_tag("https://github.com/x/y/releases/tag/"), None);
    }

    /// 回归：`releases.atom` 不接受 `?page=`（实测第 2/3 页与第 1 页内容完全相同），夜间版
    /// 占满 10 条窗口后只能靠 HTML 列表页枚举历史正式版。解析要按页面顺序去重，不能把
    /// `releases/download/...` 之类的链接当成 tag，遇到空 tag 也不能原地打转。
    #[test]
    fn parse_release_listing_tags_extracts_unique_tags_in_order() {
        let html = r#"
            <a href="/x/y/releases/tag/nightly-20261007">n</a>
            <a href="/x/y/releases/tag/nightly">alias</a>
            <a href="/x/y/releases/tag/v0.22.3">a</a>
            <a href="/x/y/releases/tag/v0.22.3">dup</a>
            <a href="/x/y/releases/tag/v0.22.2?expanded=true">b</a>
            <a href="/x/y/releases/download/v0.22.2/x.dmg">asset</a>
        "#;
        assert_eq!(
            parse_release_listing_tags(html),
            vec!["nightly-20261007", "nightly", "v0.22.3", "v0.22.2"]
        );
        assert!(parse_release_listing_tags("").is_empty());
        assert!(parse_release_listing_tags(r#"<a href="/x/y/releases">list</a>"#).is_empty());
        assert!(parse_release_listing_tags(r#"<a href="/x/y/releases/tag/">x</a>"#).is_empty());
    }

    /// 回归：`/releases/latest` 只给一个 tag，它缺当前平台资产时要能继续枚举更旧的正式版。
    /// 候选过滤规则与 feed 路径一致，且必须剔除已经试过的 tag（否则会重复请求同一页面）。
    #[test]
    fn listed_stable_candidates_filters_and_skips_tried_tags() {
        let tags: Vec<String> = [
            "nightly-20261007",
            "nightly",
            "v0.23.0-rc.1",
            "test-main-42",
            "v0.22.3",
            "v0.22.2",
            "v0.22.1",
        ]
        .iter()
        .map(|tag| tag.to_string())
        .collect();
        let skip = vec!["v0.22.3".to_string()];
        assert_eq!(
            listed_stable_candidates(&tags, "0.22.0", &skip),
            vec![
                ("v0.22.2".to_string(), String::new()),
                ("v0.22.1".to_string(), String::new()),
            ]
        );
        // 不高于当前版本的一个都不返回：此时「没有更新」才是正确结论
        assert!(listed_stable_candidates(&tags, "0.22.3", &skip).is_empty());
    }

    /// 回归：release 页面里第一个 ISO 时间戳才是发布时间；同页展示用的
    /// `2026-10-06 15:28:28 UTC`（提交时间，非 ISO）不能被当成发布日期。
    #[test]
    fn parse_published_at_skips_display_only_datetimes() {
        let html = r#"<relative-time datetime="2026-10-06T16:11:01Z">last week</relative-time>
            <relative-time datetime="2026-10-06 15:28:28 UTC">committed</relative-time>"#;
        assert_eq!(parse_published_at(html).as_deref(), Some("2026-10-06T16:11:01Z"));
        // 页面结构变化时返回 None（调用方退回空串 → 界面显示 `-`），不猜一个时间
        assert_eq!(parse_published_at("<p>no datetime</p>"), None);
        assert_eq!(
            parse_published_at(r#"<p datetime="2026-10-06 15:28:28 UTC">x</p>"#),
            None
        );
    }

    /// 联网真实数据校验（默认 `#[ignore]`，不进 CI 门禁；CI 机器不依赖外网）。
    ///
    /// 手动运行：`cargo test --lib -- --ignored live_github_release_pages_are_parseable`
    /// 依次验证正式版更新链路依赖的 5 个端点——atom feed、`/releases/latest` 重定向、
    /// tag 页面发布时间、expanded_assets 资产清单、releases 列表页翻页。
    #[tokio::test]
    #[ignore = "联网测试：需手动 --ignored 运行，会访问真实 GitHub 页面"]
    async fn live_github_release_pages_are_parseable() {
        let client = reqwest::Client::builder()
            .user_agent("dsh-tauri-update-check-test")
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("构建测试用 HTTP 客户端失败");
        let fetch = |url: String| {
            let client = client.clone();
            async move {
                let response = client.get(url).send().await.expect("请求失败");
                assert!(response.status().is_success(), "HTTP {}", response.status());
                response.text().await.expect("读取正文失败")
            }
        };

        // 1) atom feed 仍能解析出 entry，且候选里的 tag 全部通过 is_stable 过滤
        let feed = fetch(format!("{REPO_URL}/releases.atom")).await;
        let entries = parse_atom_entries(&feed);
        assert!(!entries.is_empty(), "atom feed 解析不出 entry：页面结构可能已变化");
        let (candidates, _) = stable_candidates(&entries, "0.0.0");
        assert!(
            candidates.iter().all(|(tag, _)| is_stable_tag(tag)),
            "候选里混进了非正式版：{candidates:?}"
        );

        // 2) `/releases/latest` 跟随重定向后的 URL 能取出最新正式版 tag
        let response = client
            .get(format!("{REPO_URL}/releases/latest"))
            .send()
            .await
            .expect("请求 /releases/latest 失败");
        assert!(response.status().is_success(), "HTTP {}", response.status());
        let tag = parse_latest_tag(response.url().as_str()).expect("/releases/latest 未重定向到 tag 页面");
        assert!(is_stable_tag(&tag), "{tag} 不是正式版");

        // 3) tag 页面能解析出发布时间
        let page = fetch(format!("{REPO_URL}/releases/tag/{tag}")).await;
        assert!(parse_published_at(&page).is_some(), "解析不出 {tag} 的发布时间");

        // 4) expanded_assets 页面能列出该 release 的资产文件名
        let assets = fetch(format!("{REPO_URL}/releases/expanded_assets/{tag}")).await;
        let names = extract_asset_names(&assets, &tag);
        assert!(!names.is_empty(), "{tag} 的资产页解析不出文件名");

        // 5) 列表页能翻到更旧的正式版（兜底路径的枚举入口）
        let listing = fetch(format!("{REPO_URL}/releases?page=1")).await;
        let listed = listed_stable_candidates(&parse_release_listing_tags(&listing), "0.0.0", &[tag]);
        assert!(!listed.is_empty(), "列表页里找不到更旧的正式版");
    }
}
