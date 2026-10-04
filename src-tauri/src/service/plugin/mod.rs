//! 预装插件：首次启动引导安装官方推荐插件（当前为 DSH Market）。
//!
//! 安装通过 `dsh plugin --profile <当前档案> add <pkg>` 完成：该子命令是 pnpm
//! 转发器，会在 `$DSH_HOME/profiles/<当前档案>` 初始化 profile 并执行 `pnpm add`，
//! 随后把声明了 `dsh.bundle` 的依赖写入 profile 的 bundles 层，使插件在下次
//! 启动时加载。进程输出逐行通过 `preinstall-log` 事件实时推送给前端日志面板。
//! 调用 dsh 前会先按需补齐捆绑 pnpm（老版本升级后可能缺失，安装流程内自愈）。
//!
//! 社区预设与内部插件分别存放在随安装包分发的 `resources/manifest.jsonc` 的
//! `plugins.preset` 与 `plugins.built-in` 两节；新增条目无需改动 Rust 代码。
//!
//! **重新进入引导的判定**：清单随安装包发布、每次安装都被强制覆盖，旧内容不可比对，
//! 因此引导结束（确认/跳过）时把清单 `plugins` 节的内容指纹（FNV-1a）写入 app-data 的 `.store.dat`；
//! 每次启动重新计算当前指纹，不一致（插件节有变更）即重新进入预设引导；老用户无基线时
//! 弹一次建立基线（见 [`preset::preinstall_pending`]）。指纹只覆盖插件节，改宠物或
//! 依赖映射不会把用户重新拉回引导。
//!
//! 模块划分（参考 `service/cli/`、`service/download/`）：
//! - [`preset`]：预设与内部插件清单读取、合并及资源目录定位
//! - [`installed`]：profile 内已安装插件检测（解析 package.json 的依赖与 bundles）
//! - [`internal`]：内置插件启动自愈（随包分发产物缺失/路径变更时强制重装）
//! - [`verify`]：预装插件完整性自检（清单引用但 node_modules 产物缺失时 `pnpm install` 修复）
//! - [`install`]：对外安装/升级/卸载编排（目录模块 `install/`：编排入口、spec 准备、
//!   子进程环境、pnpm 选版、allowBuilds 白名单、错误诊断与产物核验），
//!   以及启动时对 `plugins.depercated` 登记的社区插件自动卸载
//! - [`errors`]：插件错误记录（安装/升级/卸载失败 + 页面运行期上报，持久化）
//! - [`process`]：dsh 子进程启动与输出流逐行转发
//! - [`recovery`]：插件异常定位与一键离线卸载
//! - [`safe`]：安全档案启动前的用户插件清除（只留内置插件与核心包）
//! - [`patch_guard`]：补丁层 YAML 语法错误的显式隔离（安全模式 / 错误页恢复入口）
//! - [`patch_entries`]：补丁层悬空 `insert` 条目的启动前预检与显式清理（错误页恢复入口）
//! - [`cancel`]：Windows 下取消正在进行的安装
//! - [`watch`]：已安装插件文件监控（轮询指纹比对 + `dsh-plugins-updated` 事件推送）
//! - [`hmr`]：本地路径插件的热重载（把已挂载的本地插件源码目录写进桌面端独占的
//!   补丁层，随启动以 `--patch` 注入核心 HMR，源码改动即时生效）

mod cancel;
pub mod compat;
pub mod disable;
pub mod errors;
mod hmr;
mod install;
mod installed;
mod internal;
mod patch_entries;
mod patch_guard;
mod preset;
mod process;
pub mod recovery;
mod safe;
pub mod snapshot;
pub mod update;
pub mod verify;
pub mod watch;

pub(crate) use crate::service::profile::ensure_profile_pnpm_policy;
pub use cancel::cancel;
pub(crate) use cancel::terminate_active_installs_blocking;
pub(crate) use process::acquire_operation_lock;
pub(crate) use install::harness_prefer_bundled_pnpm;
pub(crate) use install::local_spec_from_path;
pub(crate) use install::uninstall_deprecated_plugins;
pub use install::{
    allow_policy_versions, allow_version_exemptions, inspect_specs, install, install_specs,
    remove_many, update_many, IncompatibleVersion, PolicyBlockedVersion,
};
pub(crate) use installed::{
    declared_packages, ensure_profile_npmrc, installed_name, list_installed, profile_dir,
};
pub use installed::{list, PreinstallPlugin};
pub(crate) use hmr::{status as local_plugin_hmr_status, sync_layer as local_plugin_hmr_sync};
pub use hmr::LocalHmrStatus;
pub(crate) use internal::cancel as cancel_internal_plugins;
pub(crate) use internal::ensure as ensure_internal_plugins;
pub use preset::repo_url_of;
pub(crate) use preset::{
    bundled_plugin_dir, current_preset_hash, load_presets, preinstall_pending,
    remove_legacy_bundled_plugins,
};
pub(crate) use safe::purge_user_plugins_in_safe_profile;
pub(crate) use patch_guard::{
    patch_layer_paths, quarantine_active_patch_layers, quarantine_failure_message,
    quarantine_patch_layers_in, PatchQuarantineReport,
};
pub(crate) use patch_entries::{
    preflight_active_patch_entries, strip_active_unresolved_entries, PatchEntryStripReport,
};
pub use disable::{disable, enable};
pub use recovery::{
    detect as detect_recovery, uninstall as uninstall_recovery, PluginRecoveryInfo,
};
pub(crate) use verify::ensure_preset_plugins;
pub use watch::DshPlugin;
