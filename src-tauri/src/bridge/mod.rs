//! bridge：Tauri 命令的对外出口。
//!
//! 按领域把命令拆成若干子模块（生命周期 / 插件 / 核心 / 档案 / 应用配置 /
//! 系统集成 / 更新），此处统一声明并重导出为「干净 API」，供 `generate_handler!`
//! 以 `crate::bridge::<cmd>` 形式注册。

pub mod backup;
pub mod clipboard;
pub mod config;
pub mod core;
pub mod guard;
pub mod lifecycle;
pub mod pet;
pub mod plugin;
pub mod preset_pet;
pub mod profile;
pub mod remote;
pub mod system_os;
pub mod updater;

pub use backup::*;
pub use clipboard::*;
pub use config::*;
pub use core::*;
pub use lifecycle::*;
pub use pet::*;
pub use plugin::*;
pub use preset_pet::*;
pub use profile::*;
pub use remote::*;
pub use system_os::*;
pub use updater::*;
