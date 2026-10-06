//! Harness 核心管理。
//!
//! 核心来源：
//! - `local`：用户通过 CLI（npm/pnpm 全局安装）自行安装的 dsh，安装目录与
//!   配置（`$DSH_HOME`）都不归桌面端管理；
//! - `app`：桌面端预打包管理的 deepseek-harness-pkg 多版本副本。激活版本固定
//!   位于 `dependencies/dsh`（既有代码全部依赖该路径），通过「核心」面板下载的
//!   历史版本存放在 `dependencies/dsh-<tag>` 槽位，切换时两个目录互换。debug 与
//!   release 的整个 AppData 根目录不同，因此两套构建不会互换或覆盖对方核心。
//!
//! 启动优先级（需求）：本地核心存在且不低于内置插件基线时优先使用本地核心；未检测到
//! 或低于基线（随包内置插件按推荐核心版本编译，见 [`source`]）才走预打包。用户在
//! 「核心」面板可显式切回预打包；显式选择持久化在 store 设置（`active_core`），
//! `None` = 自动（本地优先）。
//!
//! 本地核心更新通过其包管理器 CLI 完成（npm `update -g` / pnpm `add -g`），
//! 不触碰用户安装本身之外的文件。
//!
//! 模块划分（参考 `service/cli/`、`service/download/`）：
//! - [`local`]：本地核心发现（PATH/全局安装目录探测、包目录解析、更新本地核心）
//! - [`importer`]：本地安装包导入（内网机无法访问 GitHub 时用预先下载的官方
//!   发行资产装配核心，见 issue #138）
//! - [`source`]：核心来源与活动入口（`CoreSource` / `HarnessCore` / 活动核心）
//! - [`version`]：预打包核心多版本管理（列出 / 切换 / 下载 / 卸载）

mod importer;
mod local;
mod runtime;
mod source;
mod version;

pub use importer::{import_local_package, CoreImportPlan};
pub use local::{local_core_package_dir, update_local_core};
// 以下重导出为对外公开 API（部分项当前链路未直接引用，属有意保留，见模块头）。
#[allow(unused_imports)]
pub use source::{active_dsh_binary, active_source, active_version, CoreSource, HarnessCore};
pub use version::{download_version, has_installed_version, list, remove_version, set_active};
pub(crate) use runtime::prepare_active_runtime;
// 目录链接实现（Windows 符号链接 → 无特权时的 junction 回退）供插件模块复用：
// pnpm 建链后回读失败时，桌面端自行落盘内置插件入口（见 plugin::internal::materialize）。
pub(crate) use runtime::create_directory_link;
