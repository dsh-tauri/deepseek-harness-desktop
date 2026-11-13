//! GitHub 发行版元数据：查询最新/指定 tag 的 Harness 发行信息（版本 tag、
//! commit、资产 URL 与可信 SHA-256 摘要），以及更新判定（`resolve_update`）。
//!
//! 所有访问 api.github.com 的调用统一经 `download::utils::github_api` 冷却器收敛；
//! API 限流/不可用时逐级兜底到 releases.atom / expanded_assets HTML /
//! tag 内嵌 build-id，保证更新提示与完整性校验不因 403 而失效。
//!
//! 预览版（GitHub Release 标记 Pre-release、或 tag 命名含预览标记，见
//! [`is_preview_tag`]）**不参与更新判定**：`/releases/latest` 按 label 自动排除，
//! releases.atom 兜底按 tag 命名跳过；但核心列表（`fetch_dsh_pkg_releases`）
//! 仍会列出预览版供用户手动下载安装。

use crate::config;

/// GitHub API 地址（未认证限流 60 次/小时/IP，仅供每次启动检查一次）
const DSH_PKG_GITHUB_API: &str = "https://api.github.com/repos/dsh-tauri/deepseek-harness-pkg";
/// pkg 仓库 HTML 来源；`releases.atom` 走 github.com 而非 api.github.com，不受未认证限流约束。
const DSH_PKG_REPO: &str = "https://github.com/dsh-tauri/deepseek-harness-pkg";
const GITHUB_RELEASES_PAGE_SIZE: usize = 100;

/// 最新 Harness 发行版信息（版本 tag + 对应 commit hash）
#[derive(Debug, Clone, serde::Serialize)]
pub struct LatestDshPkg {
    pub tag: String,
    pub commit: String,
    pub asset_url: String,
    /// 可信 SHA-256 摘要。为 `None` 表示 GitHub API 限流/不可用未能取得可信摘要，
    /// 此时该信息**仅可作更新提示**（tag/commit 仍有效），不可用于自动重装——
    /// 重装路径会因完整性校验缺失而中止（沿用 DSH_INTEGRITY_UNAVAILABLE 安全设计）。
    pub digest: Option<String>,
}

/// 构造带 User-Agent 与超时的 GitHub 请求客户端。
fn github_client<R: tauri::Runtime>(
    app_handle: &crate::AppHandle<R>,
) -> Result<reqwest::Client, String> {
    config::proxy::http_client_builder(app_handle)?
        .user_agent("deepseek-harness-desktop")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// 访问 api.github.com 的 GET 请求（所有 API 调用统一走这里）。
///
/// 带 GitHub 未认证限流（403）冷却：冷却期内直接返回 Err（由调用方走兜底来源），
/// 命中 403 时记录冷却开始。返回的 `reqwest::Response` 已通过 `error_for_status`，
/// 403 已被拦截并标记冷却，不会作为普通错误继续向下传输。
async fn github_api_get(client: &reqwest::Client, url: &str) -> Result<reqwest::Response, String> {
    if crate::service::download::github_api::rate_limited() {
        return Err("GitHub API rate limited (cached, using fallback sources)".to_string());
    }
    let res = client.get(url).send().await.map_err(|e| e.to_string())?;
    if res.status() == reqwest::StatusCode::FORBIDDEN {
        crate::service::download::github_api::mark_rate_limited();
        return Err(format!("GitHub API rate limited: HTTP {}", res.status()));
    }
    res.error_for_status().map_err(|e| e.to_string())
}

/// 拉取最新 release 的 JSON（含 tag、资产、摘要）。
async fn fetch_releases_latest(client: &reqwest::Client) -> Result<serde_json::Value, String> {
    github_api_get(client, &format!("{DSH_PKG_GITHUB_API}/releases/latest"))
        .await
        .map_err(|e| format!("Latest release request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse latest release response: {e}"))
}

fn supported_release_tag(tag: &str) -> bool {
    parse_version_from_tag(tag)
        .is_some_and(|version| crate::service::core::core_supports_bundled_plugins(&version, None))
}

/// 从 Releases 页面 HTML 中解析 release 标签及 Pre-release 标记。
///
/// 页面可能为同一 release 渲染桌面端和移动端两个链接，因此按 tag 去重。
/// 这是 API 限流时的列表级兜底，不能依赖页面的 CSS 结构以外的接口。
fn parse_release_list_from_html(body: &str) -> Vec<DshPkgReleaseMeta> {
    let mut releases = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let marker = "releases/tag/";
    let mut cursor = 0;
    while let Some(relative) = body[cursor..].find(marker) {
        let start = cursor + relative + marker.len();
        let Some(end) = body[start..].find(['"', '\'', '?']) else {
            break;
        };
        let tag = &body[start..start + end];
        let next = body[start + end..]
            .find(marker)
            .map(|offset| start + end + offset)
            .unwrap_or(body.len());
        // 从当前 tag 开始截取到下一个 tag，避免把上一个 release 的
        // `Pre-release` 文案带入当前条目（尤其是 alpha 后面的 rc）。
        let entry = &body[start..next];
        if supported_release_tag(tag) && seen.insert(tag.to_string()) {
            releases.push(DshPkgReleaseMeta {
                tag: tag.to_string(),
                prerelease: entry.contains("Pre-release"),
            });
        }
        cursor = next;
    }
    releases
}

/// 通过 commits 端点把 release tag 解析为完整 commit hash。
async fn fetch_tag_commit(client: &reqwest::Client, tag: &str) -> Result<String, String> {
    let commit: serde_json::Value =
        github_api_get(client, &format!("{DSH_PKG_GITHUB_API}/commits/{tag}"))
            .await
            .map_err(|e| format!("Release commit request failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("Failed to parse release commit response: {e}"))?;
    commit
        .get("sha")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "Missing sha in release commit response".to_string())
}

/// 从 tag 内嵌的 build-id 提取 commit 标识：`dsh-0.1.0-rc.8-32331963388` → `32331963388`。
///
/// 当 `/commits/{tag}` 因 api.github.com 限流/网络失败时，用 build-id 兜底作为 commit，
/// 保证「版本升级」判定不因这一次要调用而整体中断（issue：rc.8 发布后无更新提示）。
fn commit_fallback_from_tag(tag: &str) -> String {
    tag.rsplit('-').next().unwrap_or(tag).to_string()
}

/// 从 releases.atom 正文中取出**第一条非预览版** release tag。
///
/// GitHub 的 releases.atom（github.com，非 api.github.com，不受未认证限流约束）
/// 会包含 Pre-release 与手动测试 release，但 entry 里不含 Pre-release label——
/// 只能按 tag 命名兜底（[`is_preview_tag`]）跳过预览版，取最新一条非预览版作为
/// 「最新可用 release」。纯函数，便于单元测试。
fn first_non_preview_tag_from_atom(body: &str) -> Option<String> {
    let mut rest = body;
    while let Some(start) = rest.find("<entry>") {
        let end = rest[start..]
            .find("</entry>")
            .map(|e| start + e)
            .unwrap_or(rest.len());
        let entry = &rest[start..end];
        let tag = entry
            .split("releases/tag/")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .filter(|t| !t.is_empty());
        if let Some(tag) = tag {
            if is_preview_tag(tag) || !supported_release_tag(tag) {
                log::debug!("DSH_ATOM: skip unsupported or preview release {tag}");
            } else {
                return Some(tag.to_string());
            }
        }
        rest = &rest[end..];
    }
    None
}

/// 从 releases.atom（github.com，非 api.github.com）解析最新**非预览版** release tag。
///
/// 用作 API 限流/不可用时的兜底来源，仅在 API 完全不可达时调用。逐条扫描
/// atom 条目：预览版（Pre-release label 发布、tag 命名含预览标记）一律跳过，
/// 只取最新一条非预览版——避免限流窗口内把预览版误当「最新 release」推给用户
/// （见 [`is_preview_tag`]）。
async fn fetch_latest_dsh_tag_from_atom(app_handle: &crate::AppHandle) -> Result<String, String> {
    let client = github_client(app_handle)?;
    let body = client
        .get(format!("{DSH_PKG_REPO}/releases.atom"))
        .send()
        .await
        .map_err(|e| format!("DSH_ATOM: {e}"))?
        .error_for_status()
        .map_err(|e| format!("DSH_ATOM: {e}"))?
        .text()
        .await
        .map_err(|e| format!("DSH_ATOM: {e}"))?;
    first_non_preview_tag_from_atom(&body)
        .ok_or_else(|| "DSH_ATOM: no supported non-preview release in atom feed".to_string())
}

/// 从 expanded_assets HTML 片段中解析指定资产文件名后的 `sha256:<64hex>` 摘要。
///
/// 纯函数，便于对真实页面片段做离线单元测试；解析失败返回 `None`。
fn parse_digest_from_expanded_assets(body: &str, expected_name: &str) -> Option<String> {
    let asset_path = format!("/{expected_name}\"");
    let window = body
        .split("<li ")
        .skip(1)
        .filter_map(|row| row.split_once("</li>").map(|(row, _)| row))
        .find(|row| row.contains(&asset_path))?;
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

/// 从 release 的 expanded_assets HTML（github.com，非 api.github.com，不受未认证
/// 限流 403 约束）解析指定资产的 SHA-256 摘要。
///
/// GitHub release 资产的 `digest` 字段默认只由 api.github.com 的 JSON 返回，一旦
/// API 被限流就拿不到可信摘要，更新会因完整性校验缺失被 `DSH_INTEGRITY_UNAVAILABLE`
/// 卡死。但 GitHub 的 `expanded_assets` 页面片段同样呈现作者填写的 `sha256:<hex>`
/// 摘要（发行版页面资产区展开时的 HTML），且走 github.com 普通请求、不受 API 配额
/// 限制——以它作为 API 限流时的非限流兜底来源，保证完整性校验不因 403 而失效。
async fn fetch_dsh_digest_from_expanded_assets(
    client: &reqwest::Client,
    tag: &str,
    expected_name: &str,
) -> Result<Option<String>, String> {
    let body = client
        .get(format!("{DSH_PKG_REPO}/releases/expanded_assets/{tag}"))
        .send()
        .await
        .map_err(|e| format!("DSH_EXPANDED: {e}"))?
        .error_for_status()
        .map_err(|e| format!("DSH_EXPANDED: {e}"))?
        .text()
        .await
        .map_err(|e| format!("DSH_EXPANDED: {e}"))?;
    Ok(parse_digest_from_expanded_assets(&body, expected_name))
}

/// 查询 GitHub 上最新 Harness 发行版信息。
///
/// 优先走 api.github.com（`/releases/latest` + `/commits/{tag}`），拿到可用的 tag、
/// 资产地址与可信 SHA-256 摘要。API 限流/网络失败时**不整体中断**：
/// - tag 兜底用 releases.atom（github.com，不受未认证限流约束）；
/// - commit 兜底用 tag 内嵌 build-id；
/// - 资产 URL 由平台确定性推导；
/// - digest 置 `None`（仅可提示、不可自动重装，重装时重取摘要或安全中止）。
///
/// 修复前：api.github.com 一限流 `fetch_latest_dsh_pkg_info` 直接返回 Err，
/// `check_dsh_update` 静默跳过，导致上游 rc.8 发布后桌面端迟迟不出现更新提示。
///
/// 预览版（Pre-release label 或 tag 命名，见 [`is_preview_tag`]）不参与更新判定：
/// 最新 release 恰好是预览版时**不直接推给用户**，而是由 [`fetch_latest_non_preview`]
/// 回退到最新一条非预览版 release 供更新/安装判定（issue #299：最新 alpha 发布后
/// 旧实现直接回 Err，导致初始化流程报 `DSH_INTEGRITY_UNAVAILABLE` 卡死）。仅当所有
/// release 都是预览版（找不到非预览版）时才返回 Err，由调用方保持本地安装、不提示。
pub async fn fetch_latest_dsh_pkg_info(
    app_handle: &crate::AppHandle,
) -> Result<LatestDshPkg, String> {
    let client = github_client(app_handle)?;
    let core_asar = config::get_store_dat_setting(app_handle).core_asar;
    let expected_name = config::dsh_pkg_asset_name(core_asar)?;

    // 1. 首选 GitHub API 拉最新 release（含 tag + 资产 + 可信摘要）
    let api_release = match fetch_releases_latest(&client).await {
        Ok(release) => Some(release),
        Err(e) => {
            // 限流冷却期内不重复打 403 警告（进入冷却时已提示一次），静默走兜底
            if crate::service::download::github_api::rate_limited() {
                log::debug!(
                    "GitHub API latest release unavailable (rate-limited), using fallback sources: {e}"
                );
            } else {
                log::warn!(
                    "GitHub API latest release unavailable ({}), falling back to atom feed",
                    e
                );
            }
            None
        }
    };

    // 2. tag：优先 API，失败则从 releases.atom 兜底
    let tag_name = match &api_release {
        Some(release) => release
            .get("tag_name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing tag_name in latest release response".to_string())?
            .to_string(),
        None => fetch_latest_dsh_tag_from_atom(app_handle).await?,
    };

    // 2b. 预览版不参与更新判定：`/releases/latest` 已按 label 排除 Pre-release，
    //     这里按 tag 命名再兜底拦一道（发布时漏标 Pre-release label 的预览版
    //     同样不会推给用户自动更新）。但「最新 release 恰好是预览版」时不能因此
    //     让初始化/更新流程整体卡死（issue #299），改为回退到最新非预览版 release，
    //     仍然绝不把预览版推给用户自动更新。
    if is_preview_tag(&tag_name)
        || !supported_release_tag(&tag_name)
        || api_release
            .as_ref()
            .and_then(|release| release.get("prerelease"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    {
        log::info!(
            "DSH_SKIP_RELEASE: latest release {} is unsupported or a preview, falling back to latest supported non-preview release",
            tag_name
        );
        return fetch_latest_non_preview(app_handle).await;
    }

    // 3. commit：优先 API /commits/{tag}，失败用 tag 内嵌 build-id 兜底
    let commit = match fetch_tag_commit(&client, &tag_name).await {
        Ok(sha) => sha,
        Err(e) => {
            if crate::service::download::github_api::rate_limited() {
                log::debug!("GitHub API commit resolution rate-limited, using build-id fallback");
            } else {
                log::warn!(
                    "Failed to resolve commit for tag {} ({}), using build-id fallback",
                    tag_name,
                    e
                );
            }
            commit_fallback_from_tag(&tag_name)
        }
    };

    // 4. 资产 URL 与摘要：URL 与摘要必须始终来自同一个 release。
    // API 不可用时 tag 来自 Atom，因此下载地址也必须按该 tag 确定性构造，
    // 不能继续使用 latest 地址，否则会把别的 release 内容拿来匹配当前摘要。
    let (asset_url, mut digest) =
        release_asset_metadata(api_release.as_ref(), &tag_name, &expected_name, core_asar)?;

    // 4b. API 限流/不可用导致取不到可信摘要时，改从 expanded_assets HTML
    // （github.com，非 api.github.com，不受 403 限流）解析作者填写的 sha256，
    // 保证完整性校验不因 api.github.com 限流而失效、更新不被卡死。
    if digest.is_none() {
        match fetch_dsh_digest_from_expanded_assets(&client, &tag_name, &expected_name).await {
            Ok(Some(d)) => {
                log::info!(
                    "Trusted digest unavailable from GitHub API, recovered from release HTML for {}",
                    expected_name
                );
                digest = Some(d);
            }
            Ok(None) => {
                log::warn!(
                    "No digest found in release HTML for {} (tag {})",
                    expected_name,
                    tag_name
                );
            }
            Err(e) => {
                log::warn!("Failed to fetch digest from release HTML: {}", e);
            }
        }
    }

    Ok(LatestDshPkg {
        tag: tag_name,
        commit,
        asset_url,
        digest,
    })
}

fn latest_supported_non_preview_tag(releases: &[DshPkgReleaseMeta]) -> Option<&str> {
    releases
        .iter()
        .find(|meta| {
            !meta.prerelease && !is_preview_tag(&meta.tag) && supported_release_tag(&meta.tag)
        })
        .map(|meta| meta.tag.as_str())
}

/// 最新非预览版 release：仅当最新 release 不受支持或是预览版时调用。
///
/// 从完整 release 列表（[`fetch_dsh_pkg_releases`]，最新在前，含 Pre-release label）
/// 取最新一条「非预览」的 release（label 非 Pre-release 且 tag 命名非预览标记，
/// 见 [`is_preview_tag`]），再复用固定 tag 的资产/摘要查询，确保下载内容与校验摘要
/// 属于同一发布。找不到非预览版（全部是预览版）时返回错误，调用方保持不更新——
/// 不把预览版推给用户自动更新，也不再以「最新是预览版」整段卡死初始化流程。
async fn fetch_latest_non_preview(app_handle: &crate::AppHandle) -> Result<LatestDshPkg, String> {
    let releases = fetch_dsh_pkg_releases(app_handle).await?;
    let tag = latest_supported_non_preview_tag(&releases).ok_or_else(|| {
        "DSH_PREVIEW_RELEASE: no supported non-preview release available, not an update".to_string()
    })?;
    fetch_dsh_pkg_asset(app_handle, tag, None).await
}

fn release_asset_metadata(
    release: Option<&serde_json::Value>,
    tag: &str,
    expected_name: &str,
    core_asar: bool,
) -> Result<(String, Option<String>), String> {
    let Some(release) = release else {
        return Ok((config::get_dsh_download_url_for_tag(tag, core_asar)?, None));
    };
    let asset = release
        .get("assets")
        .and_then(|value| value.as_array())
        .and_then(|assets| {
            assets.iter().find(|asset| {
                asset.get("name").and_then(|value| value.as_str()) == Some(expected_name)
            })
        })
        .ok_or_else(|| format!("DSH_RELEASE_ASSET_MISSING: {expected_name} in release {tag}"))?;
    let asset_url = asset
        .get("browser_download_url")
        .and_then(|value| value.as_str())
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            format!("DSH_RELEASE_ASSET_MISSING: download URL for {expected_name} in release {tag}")
        })?
        .to_string();
    let digest = asset
        .get("digest")
        .and_then(|value| value.as_str())
        .filter(|value| value.starts_with("sha256:"))
        .map(str::to_string);
    Ok((asset_url, digest))
}

/// 拉取指定 tag 的发行版信息（资产 URL + 可信摘要），供核心面板按版本下载。
///
/// API 失败时资产 URL 按 tag 确定性构造，摘要从同一个 tag 的页面读取，避免
/// latest 地址与固定 tag 的摘要发生错配。
pub(crate) async fn fetch_dsh_pkg_asset<R: tauri::Runtime>(
    app_handle: &crate::AppHandle<R>,
    tag: &str,
    core_asar: Option<bool>,
) -> Result<LatestDshPkg, String> {
    if !supported_release_tag(tag) {
        return Err(format!(
            "CORE_APP_UNSUPPORTED: release {tag} is outside the supported 0.2.2 core series (minimum 0.2.2-rc.1)"
        ));
    }
    let client = github_client(app_handle)?;
    let core_asar = core_asar.unwrap_or_else(|| config::get_store_dat_setting(app_handle).core_asar);
    let expected_name = config::dsh_pkg_asset_name(core_asar)?;

    // 1. 优先 API 拉该 tag 的 release（含资产 + 可信摘要）；API 失败/限流或响应
    //    不可解析时不整体失败：资产 URL 回退到平台确定性推导（latest 地址的
    //    tag 位替换）、摘要走 expanded_assets HTML（github.com，不受未认证限流
    //    约束），保证按版本下载不因一次 API 错误而中断。
    let json: Option<serde_json::Value> = match github_api_get(
        &client,
        &format!("{DSH_PKG_GITHUB_API}/releases/tags/{tag}"),
    )
    .await
    {
        Ok(release) => match release.json().await {
            Ok(json) => Some(json),
            Err(e) => {
                log::warn!("Failed to parse release {tag} response: {e}");
                None
            }
        },
        Err(e) => {
            log::warn!("Release {tag} request failed ({e}), using deterministic asset URL");
            None
        }
    };

    let (asset_url, mut digest) =
        release_asset_metadata(json.as_ref(), tag, &expected_name, core_asar)?;

    // 2. 摘要兜底：expanded_assets HTML（github.com，非 api.github.com）
    if digest.is_none() {
        match fetch_dsh_digest_from_expanded_assets(&client, tag, &expected_name).await {
            Ok(Some(d)) => {
                log::info!(
                    "Trusted digest unavailable from GitHub API, recovered from release HTML for {}",
                    expected_name
                );
                digest = Some(d);
            }
            Ok(None) => {
                log::warn!(
                    "No digest found in release HTML for {} (tag {})",
                    expected_name,
                    tag
                );
            }
            Err(e) => {
                log::warn!("Failed to fetch digest from release HTML: {}", e);
            }
        }
    }

    Ok(LatestDshPkg {
        tag: tag.to_string(),
        commit: commit_fallback_from_tag(tag),
        asset_url,
        digest,
    })
}

/// 从核心 tag 中解析版本号：`dsh-0.1.0-rc.7-32054485373`、
/// `src-0.1.2-alpha.1` 或 `dsh-src-0.1.2-alpha.1-33260039971` → 对应的 SemVer。
pub fn parse_version_from_tag(tag: &str) -> Option<String> {
    let has_dsh_prefix = tag.starts_with("dsh-");
    let tag = tag.strip_prefix("dsh-").unwrap_or(tag);
    if let Some(version) = tag.strip_prefix("src-") {
        let version = if has_dsh_prefix {
            version.rsplit_once('-').map(|(version, _)| version)?
        } else {
            version
        };
        return semver::Version::parse(version)
            .ok()
            .map(|_| version.to_string());
    }
    let version = has_dsh_prefix.then(|| tag.rsplit_once('-').map(|(version, _)| version))??;
    (!version.is_empty()).then(|| version.to_string())
}

/// 是否「预览版」tag：预览版不参与自动更新判定（不提示用户更新），但核心列表
/// 仍会列出、可手动下载安装（见 [`fetch_dsh_pkg_releases`]）。
///
/// GitHub API 的 `/releases/latest` 已按 label 排除 Pre-release；但 releases.atom
/// 兜底（feed 无 label 字段）与核心列表的 git tags 兜底需要按 tag 命名判定。
/// 判定规则：tag 版本解析成功（`dsh-<version>-<build-id>`）且版本号的 pre-release
/// 段含**非 rc** 的预览标记（`preview`/`beta`/`alpha`/`canary`/`next`）→ 预览版。
/// rc（如 `0.1.1-rc.2`）不算预览版：pkg 仓库的 rc 发布会正常推送用户更新。
pub fn is_preview_tag(tag: &str) -> bool {
    let Some(version) = parse_version_from_tag(tag) else {
        return false;
    };
    let Ok(parsed) = semver::Version::parse(&version) else {
        return false;
    };
    const PREVIEW_MARKERS: [&str; 5] = ["preview", "beta", "alpha", "canary", "next"];
    parsed
        .pre
        .as_str()
        .split('.')
        .any(|id| PREVIEW_MARKERS.iter().any(|m| id.starts_with(m)))
}

/// 安装记录（`dsh_pkg_commit` / `dsh_pkg_tag`）是否对应「最新 release 的同一发布」。
///
/// commit 存在两种合法形态：完整 git SHA（api.github.com 正常时解析，如
/// `1eed6dd6c078…`）与 tag 内嵌 build-id（api.github.com 限流时兜底，见
/// [`commit_fallback_from_tag`]，如 `32485170079`）。同一 tag 的两种形态互不
/// 相等，而安装记录写成哪一种取决于安装当时 API 是否可用：限流期安装会把
/// build-id 写进记录，API 恢复后的检查却解析出完整 SHA。若只按字符串相等比对，
/// API 状态在两次启动之间翻转（限流 ↔ 恢复）会让同一 release 永远比对不上，
/// `resolve_update` 把同版本误判为「同版本热修」→ 每次启动都提示更新
/// （issue #92）。因此需归一化：记录 tag 与最新 tag 相同（同一次发布，任何
/// 形态的 commit 都来自该 tag），或记录 commit 与 release 的任一合法标识一致。
pub fn record_matches_latest_release(
    record_commit: Option<&str>,
    record_tag: Option<&str>,
    latest: &LatestDshPkg,
) -> bool {
    record_tag == Some(latest.tag.as_str())
        || record_commit.is_some_and(|rc| {
            rc == latest.commit.as_str() || rc == commit_fallback_from_tag(&latest.tag)
        })
}

/// 更新判定结果
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateCheck {
    /// 无更新
    UpToDate,
    /// 无更新，但本地记录滞后于实际安装文件，需要修正记录
    HealUpToDate,
    /// 有更新
    UpdateAvailable,
}

/// 结合本地记录与实际安装文件判定是否有新版 Harness 可用。
///
/// 本地记录（release commit + tag）由安装流程写入；但当安装文件被外围途径
/// 更新、或安装时 GitHub API 失败未落盘，记录会滞后于文件，造成每次都误报
/// 更新。这里以磁盘上实际的 `@deepseek-ai/dsh` 版本为准核对：
/// - 最新 release 版本号与已装版本不同 → 有更新（不论 commit）；
/// - 版本号相同且记录对应同一 release（commit 任一形态匹配，或记录 tag 相同）→ 无更新；
/// - 版本号相同但记录是同一版本的另一发布（不同 build-id 的 tag）→ 同版本热修 → 有更新；
///   记录 tag 版本更旧（或记录无 tag，经 `legacy_tags` 反查）→ 记录滞后 → 修正记录。
///
/// 注意必须先比版本、再比 commit：dsh 仓库的 rc 发布会重打同一 git commit，
/// 因此「最新 release 的 commit 等于已装记录的 commit」并不代表没有更新，
/// 只有 tag 里的版本号才能正确区分（如 rc.8 之于 rc.7）。
///
/// `legacy_tags` 是 pkg 仓库的 tags 列表（tag, commit），仅用于反查历史安装
/// 记录的版本；反查不到时以实际文件为准（视为记录滞后）。
pub fn resolve_update(
    record_commit: Option<&str>,
    record_tag: Option<&str>,
    installed_version: Option<&str>,
    latest: &LatestDshPkg,
    legacy_tags: &[(String, String)],
) -> UpdateCheck {
    let (Some(installed), Some(latest_version)) =
        (installed_version, parse_version_from_tag(&latest.tag))
    else {
        // 版本信息不可解析时回退旧行为：记录不一致即视为有更新
        return if record_matches_latest_release(record_commit, record_tag, latest) {
            UpdateCheck::UpToDate
        } else {
            UpdateCheck::UpdateAvailable
        };
    };

    // 先按“最新 release 的版本号”判定：与已装版本不同 → 有更新。
    // 不能先看 commit 相等就跳过：dsh 仓库的 rc 发布可能重打同一 git commit
    // （build-id 不同但 underlying commit 相同），此时 commit 不是可分辨信号，
    // 只有 tag 里的版本号才能正确识别 rc.8 之于 rc.7 是更新。
    // 版本号按语义化比较：字符串序会把 rc.9 误判为大于 rc.10（'9' > '1'）。
    let same_version = match (
        semver::Version::parse(installed).ok(),
        semver::Version::parse(&latest_version).ok(),
    ) {
        (Some(installed), Some(latest)) => installed == latest,
        // 任一无法解析 → 回退字符串比较（保持旧行为）
        _ => installed == latest_version,
    };
    if !same_version {
        return UpdateCheck::UpdateAvailable;
    }
    // 版本相同 → 确认是否「同一发布」再判免打扰：记录与最新 release 对应
    // （见 [`record_matches_latest_release`]）即文件已是最新，无更新。
    if record_matches_latest_release(record_commit, record_tag, latest) {
        return UpdateCheck::UpToDate;
    }
    // 文件已经是“最新版本”，此时需要甄别记录是否滞后（同样按语义化版本比较）
    let record_behind_latest = |record_version: &str| -> bool {
        match (
            semver::Version::parse(record_version).ok(),
            semver::Version::parse(&latest_version).ok(),
        ) {
            (Some(record), Some(latest)) => record < latest,
            _ => record_version < latest_version.as_str(),
        }
    };
    match record_tag.and_then(parse_version_from_tag) {
        Some(record_version) if record_behind_latest(&record_version) => UpdateCheck::HealUpToDate,
        Some(_) => UpdateCheck::UpdateAvailable,
        None => {
            // 收集所有反查命中 record_commit 的 tag（不仅首条）：同一个 git commit
            // 可能被多个 tag 指向（stable / latest 别名、不同命名规范的同源 tag），
            // `.find()` 只取首个会在 alias 场景错过 latest.tag 的对齐。
            let matches: Vec<&(String, String)> = legacy_tags
                .iter()
                .filter(|(_, commit)| Some(commit.as_str()) == record_commit)
                .collect();
            match matches.as_slice() {
                // 唯一命中且 tag 与最新 release 同名 → 同一发布（API 限流 commit 兜底
                // 造成的 tag 差异，承接 #379 的修复场景）。
                [(tag, _)] if tag.as_str() == latest.tag.as_str() => UpdateCheck::UpToDate,
                // 唯一命中但 tag 与最新 release 不一致 → 同版本热修或滞后记录。
                [(tag, _)] => match parse_version_from_tag(tag) {
                    Some(record_version) if record_behind_latest(&record_version) => {
                        UpdateCheck::HealUpToDate
                    }
                    // 反查到的版本与最新版本相同（或解析失败）→ 视为同版本热修
                    _ => UpdateCheck::UpdateAvailable,
                },
                // 多 tag 共指同一 commit → 模糊，按更新提示以免漏报。
                _ if matches.len() > 1 => UpdateCheck::UpdateAvailable,
                // 无法考证记录对应的版本 → 以实际安装文件为准，修正记录
                _ => UpdateCheck::HealUpToDate,
            }
        }
    }
}

/// 单个 pkg release 的列表元数据（核心面板多版本列表用）。
#[derive(Debug, Clone)]
pub struct DshPkgReleaseMeta {
    pub tag: String,
    /// GitHub Release 是否标记为 Pre-release（预览版）
    pub prerelease: bool,
}

/// 通过 Releases 页面获取 pkg 发行列表。
///
/// 页面位于 github.com，不消耗 api.github.com 的未认证配额；页面上的
/// `Pre-release` 标签也能保留预览版信息。页面结构变化或网络失败时返回错误，
/// 由调用方继续回退到 Tags API。
async fn fetch_dsh_pkg_releases_from_html(
    client: &reqwest::Client,
) -> Result<Vec<DshPkgReleaseMeta>, String> {
    let body = client
        .get(format!("{DSH_PKG_REPO}/releases"))
        .send()
        .await
        .map_err(|e| format!("Release page request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Release page request failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Failed to read release page: {e}"))?;
    let releases = parse_release_list_from_html(&body);
    if releases.is_empty() {
        return Err("Release page contained no release tags".to_string());
    }
    Ok(releases)
}

/// 拉取 pkg 仓库的完整 release 列表（最新在前），含 GitHub 的 Pre-release label。
///
/// 核心面板的多版本列表以此作为远程数据源（替代 git tags）：git tags 不含
/// Pre-release label，无法区分预览版；releases 列表还能天然排除 draft（未发布
/// 对匿名请求不可见）。API 失败时先读取 github.com Releases 页面，再失败时
/// 由调用方回退 git tags，预览标记按 tag 命名（[`is_preview_tag`]）兜底。
pub async fn fetch_dsh_pkg_releases(
    app_handle: &crate::AppHandle,
) -> Result<Vec<DshPkgReleaseMeta>, String> {
    let client = github_client(app_handle)?;
    let mut all_releases = Vec::new();
    let mut page = 1;
    loop {
        let response = match github_api_get(
            &client,
            &format!(
                "{DSH_PKG_GITHUB_API}/releases?per_page={GITHUB_RELEASES_PAGE_SIZE}&page={page}"
            ),
        )
        .await
        {
            Ok(response) => response,
            Err(api_error) => {
                if page > 1 {
                    return Err(format!(
                        "DSH_RELEASE_LIST_INCOMPLETE: page {page} request failed before pagination completed: {api_error}"
                    ));
                }
                log::warn!(
                    "GitHub API release list unavailable ({}), falling back to Releases page",
                    api_error
                );
                return fetch_dsh_pkg_releases_from_html(&client)
                    .await
                    .map_err(|page_error| {
                        format!("Release list request failed: {api_error}; {page_error}")
                    });
            }
        };
        let releases: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Failed to parse release list response: {e}"))?;
        let entries = releases
            .as_array()
            .ok_or_else(|| "DSH_RELEASE_LIST_INVALID: response was not an array".to_string())?;
        let last_page = entries.len() < GITHUB_RELEASES_PAGE_SIZE;
        let page_releases = entries
            .iter()
            .filter_map(|entry| {
                let tag = entry.get("tag_name")?.as_str()?.to_string();
                if !supported_release_tag(&tag) {
                    return None;
                }
                let prerelease = entry
                    .get("prerelease")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                Some(DshPkgReleaseMeta { tag, prerelease })
            })
            .collect::<Vec<_>>();
        all_releases.extend(page_releases);
        if last_page {
            return Ok(all_releases);
        }
        page += 1;
    }
}

/// 拉取 pkg 仓库的 release tag 列表（tag, commit），用于反查历史记录对应的版本。
///
/// 仅在更新判定需要反查“无 tag 的老记录”时调用，失败时由调用方回退到
/// “以实际文件为准”的保守分支。
pub async fn fetch_dsh_pkg_tags(
    app_handle: &crate::AppHandle,
) -> Result<Vec<(String, String)>, String> {
    let client = github_client(app_handle)?;
    let tags: serde_json::Value = github_api_get(
        &client,
        &format!("{}/tags?per_page=100", DSH_PKG_GITHUB_API),
    )
    .await
    .map_err(|e| format!("Release tags request failed: {e}"))?
    .json()
    .await
    .map_err(|e| format!("Failed to parse release tags response: {e}"))?;

    Ok(tags
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let name = entry.get("name")?.as_str()?.to_string();
            let sha = entry.get("commit")?.get("sha")?.as_str()?.to_string();
            Some((name, sha))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOWS_ARM_ASSET_ROW: &str = r#"<li data-view-component="true" class="Box-row d-flex flex-column flex-md-row">
      <div data-view-component="true" class="d-flex flex-justify-start flex-items-center col-12 col-lg-6">
        <span class="d-flex flex-items-start">
          <a href="/dsh-tauri/deepseek-harness-pkg/releases/download/dsh-0.2.2-rc.1-41838008646/deepseek-harness-pkg-windows-arm64.asar.zip" rel="nofollow" data-turbo="false" class="wb-break-all">
            <span class="text-bold">deepseek-harness-pkg-windows-arm64.asar.zip</span>
          </a>
        </span>
      </div>
      <div data-view-component="true" class="d-flex flex-auto flex-justify-end flex-items-center col-md-6">
        <span data-view-component="true" class="Truncate-text">sha256:25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9da</span>
        <clipboard-copy aria-label="Copy to clipboard digest for deepseek-harness-pkg-windows-arm64.asar.zip" value="sha256:25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9da"></clipboard-copy>
      </div>
    </li>"#;

    #[test]
    fn digest_does_not_leak_from_next_asset_row() {
        let html = format!(
            r#"<li data-view-component="true" class="Box-row d-flex flex-column flex-md-row">
              <a href="/dsh-tauri/deepseek-harness-pkg/releases/download/dsh-0.2.2-rc.1-41838008646/deepseek-harness-pkg-windows.asar.zip" rel="nofollow" data-turbo="false" class="wb-break-all">
                <span class="text-bold">deepseek-harness-pkg-windows.asar.zip</span>
              </a>
            </li>{WINDOWS_ARM_ASSET_ROW}"#
        );
        assert_eq!(
            parse_digest_from_expanded_assets(&html, "deepseek-harness-pkg-windows.asar.zip"),
            None
        );
    }

    #[test]
    fn digest_matches_windows_arm_asset_row() {
        assert_eq!(
            parse_digest_from_expanded_assets(
                WINDOWS_ARM_ASSET_ROW,
                "deepseek-harness-pkg-windows-arm64.asar.zip"
            )
            .as_deref(),
            Some("sha256:25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9da")
        );
    }

    #[test]
    fn atom_rejects_out_of_series_releases() {
        let feed = concat!(
            "<feed>",
            r#"<entry><link href="/x/releases/tag/dsh-0.2.3-123"/></entry>"#,
            r#"<entry><link href="/x/releases/tag/dsh-0.2.2-rc.0-123"/></entry>"#,
            r#"<entry><link href="/x/releases/tag/dsh-0.2.1-123"/></entry>"#,
            r#"<entry><link href="/x/releases/tag/dsh-0.2.2-rc.1-41838008646"/></entry>"#,
            "</feed>"
        );
        assert_eq!(
            first_non_preview_tag_from_atom(feed).as_deref(),
            Some("dsh-0.2.2-rc.1-41838008646")
        );
    }

    #[test]
    fn release_metadata_rejects_missing_asar_asset() {
        for release in [
            serde_json::json!({"assets": []}),
            serde_json::json!({"assets": [{"name": "deepseek-harness-pkg-windows.zip", "browser_download_url": "https://example.invalid/old.zip"}]}),
            serde_json::json!({"assets": [{"name": "deepseek-harness-pkg-windows.asar.zip"}]}),
        ] {
            let error = release_asset_metadata(
                Some(&release),
                "dsh-0.2.2-rc.1-123",
                "deepseek-harness-pkg-windows.asar.zip",
                true,
            )
            .unwrap_err();
            assert!(error.starts_with("DSH_RELEASE_ASSET_MISSING:"), "{error}");
        }
    }

    #[test]
    fn supported_release_tags_stay_within_022_from_rc1() {
        for tag in [
            "dsh-0.2.2-rc.1-123",
            "dsh-0.2.2-rc.10-123",
            "dsh-0.2.2-123",
            "src-0.2.2+build.1",
        ] {
            assert!(supported_release_tag(tag), "{tag}");
        }
        for tag in [
            "dsh-0.2.1-123",
            "dsh-0.2.2-alpha.1-123",
            "dsh-0.2.2-rc.0-123",
            "dsh-0.2.3-123",
            "dsh-0.3.0-123",
            "dsh-1.0.0-123",
            "invalid",
        ] {
            assert!(!supported_release_tag(tag), "{tag}");
        }
    }

    #[tokio::test]
    async fn tag_download_rejects_unsupported_releases_before_network() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for tag in [
            "dsh-0.2.1-123",
            "dsh-0.2.2-rc.0-123",
            "dsh-0.2.3-123",
            "invalid",
        ] {
            let error = fetch_dsh_pkg_asset(app.handle(), tag, None).await.unwrap_err();
            assert!(error.starts_with("CORE_APP_UNSUPPORTED:"), "{error}");
        }
    }

    fn latest(tag: &str, commit: &str) -> LatestDshPkg {
        LatestDshPkg {
            tag: tag.to_string(),
            commit: commit.to_string(),
            asset_url: "https://example.invalid/dsh.zip".to_string(),
            digest: Some(format!("sha256:{}", "0".repeat(64))),
        }
    }

    #[test]
    fn atom_fallback_download_url_is_pinned_to_resolved_tag() {
        let tag = "dsh-0.2.2-rc.1-41838008646";
        let expected_name = config::dsh_pkg_asset_name(true).unwrap();
        let (url, digest) = release_asset_metadata(None, tag, &expected_name, true).unwrap();
        assert_eq!(digest, None);
        assert!(url.contains(&format!("/releases/download/{tag}/")));
        assert!(!url.contains("/releases/latest/download/"));
        assert!(
            url.ends_with("deepseek-harness-pkg-windows.asar.zip")
                || url.ends_with("deepseek-harness-pkg-windows-arm64.asar.zip")
                || url.ends_with("deepseek-harness-pkg-linux.asar.zip")
                || url.ends_with("deepseek-harness-pkg-linux-arm64.asar.zip")
                || url.ends_with("deepseek-harness-pkg-macos-arm64.asar.zip")
                || url.ends_with("deepseek-harness-pkg-macos-x64.asar.zip")
        );
    }

    #[test]
    fn commit_fallback_extracts_build_id_from_tag() {
        assert_eq!(
            commit_fallback_from_tag("dsh-0.1.0-rc.8-32331963388"),
            "32331963388"
        );
        // 无 build-id 的 tag 兜底取最后一段，仍为非空稳定标识，避免空 commit 破坏比对
        assert_eq!(commit_fallback_from_tag("dsh-0.2.0"), "0.2.0");
    }

    #[test]
    fn digest_requires_exact_asset_filename() {
        assert_eq!(
            parse_digest_from_expanded_assets(
                WINDOWS_ARM_ASSET_ROW,
                "deepseek-harness-pkg-windows.asar.zip"
            ),
            None
        );
        let signature_row =
            WINDOWS_ARM_ASSET_ROW.replace("windows-arm64.asar.zip", "windows-arm64.asar.zip.asc");
        assert_eq!(
            parse_digest_from_expanded_assets(
                &signature_row,
                "deepseek-harness-pkg-windows-arm64.asar.zip"
            ),
            None
        );
    }

    #[test]
    fn digest_handles_long_utf8_asset_rows() {
        let html = WINDOWS_ARM_ASSET_ROW.replace(
            "<span data-view-component=",
            &format!("{}<span data-view-component=", "中".repeat(1500)),
        );
        assert_eq!(
            parse_digest_from_expanded_assets(&html, "deepseek-harness-pkg-windows-arm64.asar.zip")
                .as_deref(),
            Some("sha256:25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9da")
        );
    }

    #[test]
    fn digest_rejects_invalid_hash_lengths() {
        for hash in [
            "abc",
            "25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9daa",
        ] {
            let html = WINDOWS_ARM_ASSET_ROW.replace(
                "25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9da",
                hash,
            );
            assert_eq!(
                parse_digest_from_expanded_assets(
                    &html,
                    "deepseek-harness-pkg-windows-arm64.asar.zip"
                ),
                None
            );
        }
    }

    #[test]
    fn release_metadata_selects_windows_arm_asar_url_and_digest() {
        let release = serde_json::json!({"assets": [
            {"name": "deepseek-harness-pkg-windows.asar.zip", "browser_download_url": "https://example.invalid/x64", "digest": "sha256:wrong-platform"},
            {"name": "deepseek-harness-pkg-windows-arm64.asar.zip", "browser_download_url": "https://github.com/dsh-tauri/deepseek-harness-pkg/releases/download/dsh-0.2.2-rc.1-41838008646/deepseek-harness-pkg-windows-arm64.asar.zip", "digest": "sha256:25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9da"}
        ]});
        assert_eq!(release_asset_metadata(Some(&release), "dsh-0.2.2-rc.1-41838008646", "deepseek-harness-pkg-windows-arm64.asar.zip", true).unwrap(), (
            "https://github.com/dsh-tauri/deepseek-harness-pkg/releases/download/dsh-0.2.2-rc.1-41838008646/deepseek-harness-pkg-windows-arm64.asar.zip".to_string(),
            Some("sha256:25cc1ab0a88818f30034e9d806d95bd743445eb9ce0e8ac62806ab6b51e6c9da".to_string())
        ));
    }

    #[test]
    fn release_metadata_follows_the_configured_core_format() {
        let release = serde_json::json!({"assets": [
            {"name": "deepseek-harness-pkg-windows.asar.zip", "browser_download_url": "https://example.invalid/asar", "digest": "sha256:asar"},
            {"name": "deepseek-harness-pkg-windows.zip", "browser_download_url": "https://example.invalid/directory", "digest": "sha256:directory"}
        ]});
        let tag = "dsh-0.2.2-rc.1-41838008646";
        assert_eq!(
            release_asset_metadata(Some(&release), tag, "deepseek-harness-pkg-windows.asar.zip", true).unwrap(),
            ("https://example.invalid/asar".to_string(), Some("sha256:asar".to_string()))
        );
        assert_eq!(
            release_asset_metadata(Some(&release), tag, "deepseek-harness-pkg-windows.zip", false).unwrap(),
            (
                "https://example.invalid/directory".to_string(),
                Some("sha256:directory".to_string())
            )
        );
        assert!(
            release_asset_metadata(Some(&release), tag, "deepseek-harness-pkg-windows-arm64.zip", false)
                .unwrap_err()
                .starts_with("DSH_RELEASE_ASSET_MISSING:")
        );
    }

    #[test]
    fn parse_version_from_tag_formats() {
        assert_eq!(
            parse_version_from_tag("dsh-0.1.0-rc.7-32054485373").as_deref(),
            Some("0.1.0-rc.7")
        );
        assert_eq!(
            parse_version_from_tag("dsh-0.1.0-rc.6-31773193667").as_deref(),
            Some("0.1.0-rc.6")
        );
        assert_eq!(parse_version_from_tag("dsh-0.2.0"), None);
        assert_eq!(parse_version_from_tag("0.1.0-rc.7-abc"), None);
        assert_eq!(parse_version_from_tag(""), None);
        assert_eq!(
            parse_version_from_tag("src-0.1.2-alpha.1").as_deref(),
            Some("0.1.2-alpha.1")
        );
        assert_eq!(
            parse_version_from_tag("dsh-src-0.1.2-alpha.1-33260039971").as_deref(),
            Some("0.1.2-alpha.1")
        );
    }

    #[test]
    fn preview_tag_detection_by_version_marker() {
        // 预览标记：preview/beta/alpha/canary/next → 预览版
        assert!(is_preview_tag("dsh-0.2.0-preview.1-32490000001"));
        assert!(is_preview_tag("dsh-0.2.0-beta.1-32490000002"));
        assert!(is_preview_tag("dsh-0.2.0-alpha.2-32490000003"));
        assert!(is_preview_tag("dsh-0.2.0-canary.1-32490000004"));
        assert!(is_preview_tag("dsh-0.2.0-next.3-32490000005"));
        // rc 不算预览版：pkg 仓库的 rc 发布会正常推送用户更新
        assert!(!is_preview_tag("dsh-0.1.1-rc.2-32485170079"));
        assert!(!is_preview_tag("dsh-0.1.0-rc.8-32342588166"));
        // 正式版 / 无法解析的 tag 均不算预览版
        assert!(!is_preview_tag("dsh-0.2.0-32490000006"));
        assert!(!is_preview_tag("dsh-0.2.0"));
        assert!(!is_preview_tag(""));
    }

    #[test]
    fn release_page_parser_filters_series_preserves_labels_and_deduplicates_links() {
        let html = concat!(
            r#"<a href="/x/releases/tag/dsh-0.2.3-1">Release</a>"#,
            r#"<a href="/x/releases/tag/dsh-0.2.2-rc.0-1">Release</a>"#,
            r#"<a href="/x/releases/tag/dsh-0.2.2-rc.2-1">Pre-release</a>"#,
            r#"<a href="/x/releases/tag/dsh-0.2.2-rc.2-1">same release</a>"#,
            r#"<a href="/x/releases/tag/dsh-0.2.2-rc.1-2">Release</a>"#,
        );
        let releases = parse_release_list_from_html(html);
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].tag, "dsh-0.2.2-rc.2-1");
        assert!(releases[0].prerelease);
        assert_eq!(releases[1].tag, "dsh-0.2.2-rc.1-2");
        assert!(!releases[1].prerelease);
    }

    #[test]
    fn non_preview_selection_skips_unsupported_tags_and_preview_labels() {
        let releases = [
            ("dsh-0.2.3-123", false),
            ("dsh-0.2.2-rc.0-123", false),
            ("dsh-0.2.2-alpha.3-123", false),
            ("dsh-0.2.2-rc.2-123", true),
            ("dsh-0.2.2-rc.1-41838008646", false),
        ]
        .map(|(tag, prerelease)| DshPkgReleaseMeta {
            tag: tag.to_string(),
            prerelease,
        });
        assert_eq!(
            latest_supported_non_preview_tag(&releases),
            Some("dsh-0.2.2-rc.1-41838008646")
        );
        assert_eq!(latest_supported_non_preview_tag(&releases[..4]), None);
        assert_eq!(latest_supported_non_preview_tag(&[]), None);
    }

    #[test]
    fn atom_fallback_skips_preview_and_picks_next_non_preview() {
        // 最新条目是预览版 → 必须跳过，取下一条非预览版（rc）
        let feed = concat!(
            "<feed>",
            "<entry><link rel=\"alternate\" href=\"/x/deepseek-harness-pkg/releases/tag/dsh-0.2.2-preview.1-32490000001\"/></entry>",
            "<entry><link rel=\"alternate\" href=\"/x/deepseek-harness-pkg/releases/tag/dsh-0.2.2-rc.1-41838008646\"/></entry>",
            "</feed>"
        );
        assert_eq!(
            first_non_preview_tag_from_atom(feed).as_deref(),
            Some("dsh-0.2.2-rc.1-41838008646")
        );
        // 全部是预览版 → None（调用方按「无可用 release」处理，不推更新）
        let all_preview = concat!(
            "<feed>",
            "<entry><link rel=\"alternate\" href=\"/x/deepseek-harness-pkg/releases/tag/dsh-0.2.2-preview.1-32490000001\"/></entry>",
            "<entry><link rel=\"alternate\" href=\"/x/deepseek-harness-pkg/releases/tag/dsh-0.2.2-beta.1-32490000002\"/></entry>",
            "</feed>"
        );
        assert_eq!(first_non_preview_tag_from_atom(all_preview), None);
        // 空 feed → None
        assert_eq!(first_non_preview_tag_from_atom(""), None);
    }

    #[test]
    fn resolve_matching_commit_is_up_to_date() {
        let latest = latest(
            "dsh-0.1.0-rc.7-32054485373",
            "6c659bb2636b3ad396a204c4c6ff110276fa3a09",
        );
        let decision = resolve_update(
            Some("6c659bb2636b3ad396a204c4c6ff110276fa3a09"),
            Some("dsh-0.1.0-rc.7-32054485373"),
            Some("0.1.0-rc.7"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::UpToDate);
    }

    #[test]
    fn resolve_build_id_record_vs_real_sha_latest_is_up_to_date() {
        // issue #92 现场：限流期安装把 build-id 写进记录，API 恢复后的检查解析出
        // 完整 SHA——同一 release（dsh-0.1.1-rc.2-32485170079）的两种标识互不相等，
        // 必须归一化判定为无更新，而不是每次启动都误报「同版本热修」。
        let latest = latest(
            "dsh-0.1.1-rc.2-32485170079",
            "1eed6dd6c0780000000000000000000000000000",
        );
        let decision = resolve_update(
            Some("32485170079"), // 记录 commit：限流期写入的 build-id
            Some("dsh-0.1.1-rc.2-32485170079"),
            Some("0.1.1-rc.2"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::UpToDate);
    }

    #[test]
    fn resolve_real_sha_record_vs_build_id_latest_is_up_to_date() {
        // 反向翻转：记录是完整 SHA，本次检查因 API 限流兜底出 build-id。
        // record_tag 与 latest.tag 相同即同一发布，不得误报更新。
        let latest = latest(
            "dsh-0.1.1-rc.2-32485170079",
            "32485170079", // 本次检查限流，commit 兜底为 build-id
        );
        let decision = resolve_update(
            Some("1eed6dd6c0780000000000000000000000000000"), // 记录：完整 SHA
            Some("dsh-0.1.1-rc.2-32485170079"),
            Some("0.1.1-rc.2"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::UpToDate);
    }

    #[test]
    fn resolve_different_installed_version_is_update() {
        let latest = latest(
            "dsh-0.1.0-rc.7-32054485373",
            "6c659bb2636b3ad396a204c4c6ff110276fa3a09",
        );
        let decision = resolve_update(
            Some("564019027fd9469991aef6e57bb0a96325491c4e"),
            Some("dsh-0.1.0-rc.6-31773193667"),
            Some("0.1.0-rc.6"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::UpdateAvailable);
    }

    #[test]
    fn resolve_same_version_hotfix_is_update() {
        // 记录正确（与文件一致），最新 release 是同版本热修：应提示更新
        let latest = latest(
            "dsh-0.1.0-rc.6-31773193667",
            "564019027fd9469991aef6e57bb0a96325491c4e",
        );
        let decision = resolve_update(
            Some("995e261e117617780dc50db16c70d445255978fd"),
            Some("dsh-0.1.0-rc.6-31762761461"),
            Some("0.1.0-rc.6"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::UpdateAvailable);
    }

    #[test]
    fn resolve_stale_record_behind_files_heals() {
        // 用户现场：记录停留在 rc.6，文件已是 rc.7 → 修正记录、免打扰
        let latest = latest(
            "dsh-0.1.0-rc.7-32054485373",
            "6c659bb2636b3ad396a204c4c6ff110276fa3a09",
        );
        let decision = resolve_update(
            Some("564019027fd9469991aef6e57bb0a96325491c4e"),
            Some("dsh-0.1.0-rc.6-31773193667"),
            Some("0.1.0-rc.7"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::HealUpToDate);
    }

    #[test]
    fn resolve_legacy_record_without_tag_heals_via_tags_lookup() {
        // 老记录没有 tag：反查 tags 列表发现记录版本低于文件版本 → 修正
        let latest = latest(
            "dsh-0.1.0-rc.7-32054485373",
            "6c659bb2636b3ad396a204c4c6ff110276fa3a09",
        );
        let tags = vec![(
            "dsh-0.1.0-rc.6-31773193667".to_string(),
            "564019027fd9469991aef6e57bb0a96325491c4e".to_string(),
        )];
        let decision = resolve_update(
            Some("564019027fd9469991aef6e57bb0a96325491c4e"),
            None,
            Some("0.1.0-rc.7"),
            &latest,
            &tags,
        );
        assert_eq!(decision, UpdateCheck::HealUpToDate);
    }

    #[test]
    fn resolve_legacy_same_version_still_updates() {
        // 老记录无 tag 但反查为同版本热修：仍应提示
        let latest = latest(
            "dsh-0.1.0-rc.6-31773193667",
            "564019027fd9469991aef6e57bb0a96325491c4e",
        );
        let tags = vec![(
            "dsh-0.1.0-rc.6-31762761461".to_string(),
            "995e261e117617780dc50db16c70d445255978fd".to_string(),
        )];
        let decision = resolve_update(
            Some("995e261e117617780dc50db16c70d445255978fd"),
            None,
            Some("0.1.0-rc.6"),
            &latest,
            &tags,
        );
        assert_eq!(decision, UpdateCheck::UpdateAvailable);
    }

    #[test]
    fn resolve_without_version_metadata_falls_back_to_update() {
        // 最新 tag 无法解析出版本时回退旧行为：记录不一致即提示
        let latest = latest("0.1.0-rc.7", "6c659bb2636b3ad396a204c4c6ff110276fa3a09");
        let decision = resolve_update(
            Some("564019027fd9469991aef6e57bb0a96325491c4e"),
            None,
            Some("0.1.0-rc.7"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::UpdateAvailable);
    }

    #[test]
    fn resolve_rc7_installed_rc8_released_is_update() {
        // 用户现场（已实测真实网络）：已装 rc.7，上游发布 rc.8。仓库 rc 发布会
        // 重打同一 git commit（/commits/{tag} 解析出的 rc.8 commit 与 rc.7 完全相同
        // 6c659bb...），因此 commit 相等不能当作“无更新”——版本号 rc.8 > rc.7
        // 才是有更新。正是这个 commit 相等快路径导致更新提示被吞。
        let latest = latest(
            "dsh-0.1.0-rc.8-32331963388",
            "6c659bb2636b3ad396a204c4c6ff110276fa3a09", // 与已装记录相同 commit
        );
        let decision = resolve_update(
            Some("6c659bb2636b3ad396a204c4c6ff110276fa3a09"), // rc.7 记录
            Some("dsh-0.1.0-rc.7-32054485373"),
            Some("0.1.0-rc.7"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::UpdateAvailable);
    }

    #[test]
    fn resolve_rc9_record_behind_rc10_heals() {
        // 回归（CodeRabbit）：字符串序会把 rc.9 判为大于 rc.10（'9' > '1'），
        // 从而把「记录滞后于 rc.10」误判成同版本热修。语义化比较应识别为滞后。
        let latest = latest(
            "dsh-0.1.0-rc.10-40000000000",
            "aabbccddeeff00112233445566778899aabbccdd",
        );
        let decision = resolve_update(
            Some("112233445566778899aabbccddeeff0011223344"),
            Some("dsh-0.1.0-rc.9-39000000000"),
            Some("0.1.0-rc.10"),
            &latest,
            &[],
        );
        assert_eq!(decision, UpdateCheck::HealUpToDate);
    }

    #[test]
    fn resolve_legacy_tag_match_latest_tag_is_up_to_date() {
        // 回归：record_tag 缺失 + record_commit 为完整 SHA（API 正常时安装写入），
        // 本次检查 API 限流 → latest.commit 兜底成 build-id。两种 commit 形态互不相等，
        // `record_matches_latest_release` 提前判定为不匹配；进入 legacy_tags 反查后
        // 必须再对齐一次 tag（同名即同一发布），不再盲目按「同版本热修」误报更新。
        let latest = latest(
            "dsh-0.1.2-rc.1-33729514615",
            "33729514615", // 限流兜底
        );
        let tags = vec![(
            "dsh-0.1.2-rc.1-33729514615".to_string(),
            "abc123def4567890abcdef1234567890abcdef12".to_string(),
        )];
        let decision = resolve_update(
            Some("abc123def4567890abcdef1234567890abcdef12"),
            None,
            Some("0.1.2-rc.1"),
            &latest,
            &tags,
        );
        assert_eq!(decision, UpdateCheck::UpToDate);
    }

    #[test]
    fn resolve_legacy_tag_older_build_is_still_hotfix_update() {
        // 反向回归：legacy_tags 反查到的是真正的同版本旧 build（不是 latest），
        // 必须仍然报告 UpdateAvailable（hotfix），不能让上面的修复误伤这一支。
        let latest = latest("dsh-0.1.2-rc.1-33729514615", "33729514615");
        let tags = vec![(
            "dsh-0.1.2-rc.1-33600000000".to_string(), // 旧 build，不是 latest
            "11122233344455556666777788899900aaaabbbb".to_string(),
        )];
        let decision = resolve_update(
            Some("11122233344455556666777788899900aaaabbbb"),
            None,
            Some("0.1.2-rc.1"),
            &latest,
            &tags,
        );
        assert_eq!(decision, UpdateCheck::UpdateAvailable);
    }
    #[test]
    fn resolve_legacy_tag_match_not_first_in_list_is_up_to_date() {
        // 顺序无关：legacy_tags 把匹配项放在末尾，前面的非匹配项不能让 `.find()`
        // 提前截走、必须仍然识别为同一发布。
        let latest = latest("dsh-0.1.2-rc.1-33729514615", "33729514615");
        let tags = vec![
            (
                "unrelated/v0.0.1".to_string(),
                "fff000fff000fff000fff000fff000fff000f0000".to_string(),
            ),
            (
                "dsh-0.1.2-rc.1-33729514615".to_string(),
                "abc123def4567890abcdef1234567890abcdef12".to_string(),
            ),
        ];
        let decision = resolve_update(
            Some("abc123def4567890abcdef1234567890abcdef12"),
            None,
            Some("0.1.2-rc.1"),
            &latest,
            &tags,
        );
        assert_eq!(decision, UpdateCheck::UpToDate);
    }

    #[test]
    fn resolve_legacy_tag_multiple_matches_is_update_available() {
        // 防御：同一 commit 被多个 tag 指向（stable / latest 别名、不同命名规范的
        // 同源 tag），反查不唯一 → 模糊场景，按更新提示以免漏报。
        let latest = latest("dsh-0.1.2-rc.1-33729514615", "33729514615");
        let tags = vec![
            (
                "dsh-0.1.2-rc.1-stable".to_string(),
                "abc123def4567890abcdef1234567890abcdef12".to_string(),
            ),
            (
                "dsh-0.1.2-rc.1-33729514615".to_string(),
                "abc123def4567890abcdef1234567890abcdef12".to_string(),
            ),
        ];
        let decision = resolve_update(
            Some("abc123def4567890abcdef1234567890abcdef12"),
            None,
            Some("0.1.2-rc.1"),
            &latest,
            &tags,
        );
        assert_eq!(decision, UpdateCheck::UpdateAvailable);
    }
}
