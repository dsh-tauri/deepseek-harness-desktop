
use crate::{AppHandle};
use std::path::{Path, PathBuf};

use tauri::{ Manager};

/// 允许打开/定位的根目录集合。
pub fn allowed_roots(app_handle: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(download_dir) = app_handle.path().download_dir() {
        roots.push(download_dir);
    }
    if let Ok(data_dir) = app_handle.path().app_data_dir() {
        roots.push(data_dir);
    }
    let dsh_home = crate::config::get_dsh_data_path(app_handle);
    roots.push(dsh_home);
    // 自定义缓存根下的恢复导出也允许定位，不扩大到该根下的其他文件。
    roots.push(crate::config::get_base_dir(app_handle).join("recovery-backups"));
    // 本地核心（用户通过 CLI 安装）的包目录：由后端检测得到的可信路径，
    // 允许「核心」面板的「打开目录」打开它（否则会因不在任何允许根内被拒）。
    if let Some(dir) = crate::service::core::local_core_package_dir(app_handle) {
        roots.push(dir);
    }
    // 依赖映射表解析出的安装根：依赖可被映射到任意位置（含 `resources/*` 捆绑
    // 副本），核心/环境面板的「打开目录」必须能打开它们。
    for key in [
        crate::config::dependencies::DEP_PNPM,
        crate::config::dependencies::DEP_DSH,
    ] {
        roots.push(crate::config::dependencies::active_root(app_handle, key));
    }
    roots
}

/// 实际用于前缀匹配的根：仅保留当前已存在（`is_dir`）的根（下载目录/数据目录
/// 在全新安装时可能尚未创建）；最终比较仍以 canonicalize 后的结果为准。
fn existing_roots(app_handle: &AppHandle) -> Vec<PathBuf> {
    allowed_roots(app_handle)
        .into_iter()
        .filter(|root| root.is_dir())
        .collect()
}

/// `path` canonicalize 后是否位于任一允许根目录内。
///
/// 用 `dunce::canonicalize`（内部是 std `fs::canonicalize`）把路径与根统一归一到
/// 常规形式（Windows 上 `fs::canonicalize` 会带 `\\?\` verbatim 前缀，dunce 剥掉），
/// 避免某侧带前缀、另一侧不带导致 `starts_with` 边界失配。
pub fn is_allowed_path(app_handle: &AppHandle, path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    let Ok(real) = dunce::canonicalize(path) else {
        return false;
    };
    existing_roots(app_handle)
        .iter()
        .filter_map(|root| dunce::canonicalize(root).ok())
        .any(|root| real.starts_with(&root))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    /// 前缀匹配必须尊重组件边界：`/data/app2/x` 不是 `/data/app` 的子路径
    /// （字符串前缀判断易在 canonicalize 前误判；canonicalize 后 components 对齐可避免）。
    #[test]
    fn prefix_match_respects_component_boundary() {
        let inside = PathBuf::from("/data/app/dependencies/dsh");
        let root = PathBuf::from("/data/app");
        assert!(inside.starts_with(&root));
        let sibling = PathBuf::from("/data/app2/x");
        assert!(!sibling.starts_with(&root));
    }
}
