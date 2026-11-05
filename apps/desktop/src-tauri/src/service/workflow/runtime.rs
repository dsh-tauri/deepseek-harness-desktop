//! Node 模式运行时入口：dsh 与 pnpm 的唯一可执行文件来源。
//!
//! 独立 Node 运行时已废弃。这里的两个函数都从当前 `ElectronClient` 取值——与
//! 显示窗口的是同一个二进制，`ElectronClient::node()` 已带上
//! `ELECTRON_RUN_AS_NODE=1`、独立 stdio 与 kill-on-drop，因此不需要（也不应该）
//! 在别处另立路径解析。

use crate::AppHandle;
use std::path::PathBuf;
use tauri::Manager;

fn client<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<tauri_runtime_electron::ElectronClient, String> {
    app_handle
        .try_state::<tauri_runtime_electron::ElectronClient>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "ELECTRON_CLIENT_UNAVAILABLE: runtime client is not registered".to_string())
}

/// 以 Node 模式运行随包 Electron 的 `Command`。
///
/// 调用方只补参数、工作目录与环境。所有拉起 JS 入口的地方都必须走这里。
pub(crate) fn node_command<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<std::process::Command, String> {
    Ok(client(app_handle)?.node().into_std())
}

/// 随包 Electron 可执行文件的路径（CLI shim 烘焙与诊断展示用）。
///
/// 从同一个 `node()` 命令对象上取程序名，保证与 [`node_command`] 拉起的是同一个
/// 二进制。
pub(crate) fn electron_executable<R: tauri::Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<PathBuf, String> {
    let path = PathBuf::from(node_command(app_handle)?.get_program());
    path.is_file()
        .then_some(path.clone())
        .ok_or_else(|| format!("ELECTRON_EXECUTABLE_MISSING: {}", path.display()))
}

/// 测试用：本机随包 Electron 可执行文件（Node 模式）。
///
/// 单元测试拿不到 `AppHandle`，但版本探测等用例需要一个真能跑的运行时。测试
/// 可执行文件在 `target/debug/deps/`，而分发的 Electron 在 `target/electron/
/// <platform>-<arch>/`（构建产物）或 `target/debug/runtime/`（捆绑布局），因此
/// 两条路径都试；都没有时用例自行跳过。
#[cfg(test)]
pub(crate) fn test_runtime_executable() -> Option<PathBuf> {
    let executable = std::env::current_exe().ok()?;
    let deps = executable.parent()?;
    let target_root = deps.parent()?;
    let mut roots = vec![
        target_root.join("runtime"),
        target_root.join("electron"),
        target_root.join("debug").join("runtime"),
    ];
    if let Ok(profile) = std::env::var("PROFILE") {
        roots.push(target_root.join(profile).join("runtime"));
    }
    roots.into_iter().find_map(|root| {
        electron_rs::electron_binary(&root)
            .ok()
            .filter(|path| path.is_file())
    })
}
