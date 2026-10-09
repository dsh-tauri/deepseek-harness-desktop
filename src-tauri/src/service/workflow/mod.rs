//! Harness 服务进程生命周期编排（workflow）。
//!
//! 模块划分：
//! - [`process`]：本应用持有的 Harness 根进程登记（PID + Windows 句柄成对）、
//!   启动守卫、停止/退出回收、进程树终止与按 dsh 安装路径清扫历史残留
//! - [`launch`]：start / restart / launch 编排（端口自愈、补丁挂点、
//!   Windows 隐藏控制台启动）
//! - [`sweep`]：孤儿 Harness 清扫（`.harness.pid` + 端口/PID 双重确认）与
//!   Windows RedirectionGuard(448) 逃逸重拉
//! - [`install`]：安装环境（Node.js 运行时 + Harness 发行版 + pnpm + MinGit）
//! - [`health`]：健康检查（Rust 代理，避免 WebView CORS 问题）
//! - [`startup`]：启动耗时观测（spawn → 首个 HTTP 响应 → 客户端模块就绪）
//! - [`status`] / [`utils`] / [`win_inspector`] / [`win_spawn`]：既有子模块

pub mod status;
pub mod utils;
pub(crate) mod win_inspector;
#[cfg(windows)]
pub(crate) mod win_spawn;

mod health;
mod heap;
mod install;
mod launch;
mod process;
mod startup;
mod sweep;

pub use health::{proxy_health_check, recheck_ownership};
pub(crate) use heap::effective_heap_limit_mb;
pub use install::install;
pub use launch::{launch, restart, start};
pub use process::{
    acquire_core_transition, has_owned_process, owned_process_pid, stop, stop_for_installer,
    stop_on_exit, terminate_stale_harness_processes,
};
pub use sweep::sweep_orphan_harness;
