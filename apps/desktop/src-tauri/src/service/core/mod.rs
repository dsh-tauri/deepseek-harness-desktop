mod legacy;
mod local;
mod native;
mod runtime;
mod source;
mod version;

pub(crate) use legacy::is_directory_core;
pub use legacy::retire_directory_core;
pub use local::{local_core_package_dir, update_local_core};
pub(crate) use native::prepare_native_bridge;
pub(crate) use runtime::prepare_active_runtime;
#[allow(unused_imports)]
pub use source::{
    CoreSource, HarnessCore, active_core_dir, active_dsh_binary, active_source, active_version,
};
pub(crate) use source::{
    app_core_meets_baseline, app_core_version, core_supports_bundled_plugins,
    ensure_app_core_supported,
};
pub(crate) use version::switch_format;
pub use version::{download_version, has_installed_version, list, remove_version, set_active};
// 目录链接实现（Windows 符号链接 → 无特权时的 junction 回退）供插件模块复用：
// pnpm 建链后回读失败时，桌面端自行落盘内置插件入口（见 plugin::internal::materialize）。
pub(crate) use runtime::create_directory_link;
