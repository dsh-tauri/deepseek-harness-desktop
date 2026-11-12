mod core;
mod extractor;
mod github;
mod installable;
mod progress;
mod utils;

// 导出公共接口
pub use core::{
    download_file, download_file_from_sources, ensure_extract, verify_sha256,
};
pub use github::{
    DshPkgReleaseMeta, LatestDshPkg, UpdateCheck, fetch_dsh_pkg_releases,
    fetch_dsh_pkg_tags, fetch_latest_dsh_pkg_info, is_preview_tag, parse_version_from_tag,
    record_matches_latest_release, resolve_update,
};
// 供核心面板切换版本时使用（跨模块内部接口，不进公共 API）
pub(crate) use core::{commit_staged_install, remove_dir_with_retry, rename_with_retry};
pub(crate) use github::fetch_dsh_pkg_asset;
// 依赖任务清单与映射回写：安装流程与启动检测共用同一组任务定义。
pub use installable::{Dsh, InstallKind, Installable, Pnpm, record_mappings, tasks};
pub use progress::ProgressTracker;
// GitHub API 限流冷却器：任何访问 api.github.com 的服务都应收敛到这一个入口
pub use utils::github_api;
