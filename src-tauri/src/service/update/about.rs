//! About 对话框信息：版本来自编译常量，发布时间实时查询最新正式版 Release（不缓存）。

use super::meta::fetch_latest_stable_published_at;
use super::version::current_version;
use super::{COPYRIGHT, POWERED_BY, REPO_URL};

/// 关于对话框信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAboutInfo {
    pub version: String,
    pub published_at: String,
    pub copyright: String,
    pub repo: String,
    pub powered_by: String,
}

/// 关于信息：版本来自编译常量，发布时间每次实时查询最新**正式版** Release（不缓存），
/// 查询失败则留空、不影响展示。
pub async fn about(app_handle: &tauri::AppHandle) -> DesktopAboutInfo {
    let published_at = fetch_latest_stable_published_at(app_handle)
        .await
        .unwrap_or_default();
    DesktopAboutInfo {
        version: current_version(),
        published_at,
        copyright: COPYRIGHT.to_string(),
        repo: REPO_URL.to_string(),
        powered_by: POWERED_BY.to_string(),
    }
}
