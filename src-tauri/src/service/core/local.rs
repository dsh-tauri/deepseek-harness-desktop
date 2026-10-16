//! 本地核心发现：探测用户通过 CLI（npm/pnpm 全局安装）自行安装的 dsh。
//!
//! 只基于文件系统与 PATH 探测，不派生子进程。核心来源判定见
//! [`crate::service::core`] 模块头的说明。

use crate::service::cli;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
#[cfg(unix)]
use tauri::Manager;

/// 解析出的本地核心信息
pub(super) struct LocalCore {
    /// 包目录（`node_modules/@deepseek-ai/dsh`）
    pub(super) package_dir: PathBuf,
    pub(super) version: String,
    /// `lib/bin.js` 入口
    pub(super) bin: PathBuf,
}

/// 用户 dsh 可执行文件：扫描 PATH 及常见安装目录，仅跳过本应用生成的 shim；
/// 其余未带生成标记的同名 `dsh`（含 bin 目录下用户自行安装的）视为用户本地安装。
///
/// 与 pnpm shim 的"用户优先"策略一致，只排除我们自己生成的 shim，而非整个 bin
/// 目录——用户可能恰好把 npm/pnpm 全局 dsh 装进 `~/.local/bin`（Unix XDG 约定，
/// 与本应用 shim 目录相同），若整目录跳过会误判为"无本地 dsh"（issue #54）。
pub(super) fn find_user_dsh_bin(app_handle: &AppHandle) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["dsh.cmd", "dsh.exe", "dsh.bat"]
    } else {
        &["dsh"]
    };

    // 0. 用户显式指定路径（`DSH_CLI_PATH`，发现优先级最高）
    if let Some(cli_path) = std::env::var_os("DSH_CLI_PATH") {
        let p = PathBuf::from(cli_path);
        let matches = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| candidates.contains(&n))
            .unwrap_or(false);
        if matches && p.is_file() {
            return Some(p);
        }
    }

    let path_dirs: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|dir| !dir.as_os_str().is_empty())
            .collect();

    // Unix 上从 Finder/launchd 启动时 PATH 可能不完整，补充 `~/.local/bin`
    // （XDG 约定下用户安装 CLI 的常见位置，且与本应用 shim 目录相同）；
    // macOS 额外补充 Homebrew 常见安装目录。
    #[cfg(unix)]
    let dirs: Vec<PathBuf> = {
        let mut dirs = path_dirs;
        if let Ok(home) = app_handle.path().home_dir() {
            dirs.push(home.join(".local").join("bin"));
            append_unix_dsh_dirs(&mut dirs, &home);
        }
        #[cfg(target_os = "macos")]
        dirs.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
        dirs
    };

    // Windows：GUI 进程不读取交互式 shell 配置，fnm（及部分 nvm 衍生）通过
    // shell 初始化把 node 安装目录（含 npm 全局 bin）注入继承 PATH —— 桌面端
    // 补不到这份环境，导致 fnm 全局安装的 `dsh` 漏检（issue #229）。因此在
    // 继承 PATH 之后补充 npm / fnm 的标准用户目录，与 pnpm 探测策略一致。
    #[cfg(windows)]
    let dirs = {
        let _ = &app_handle;
        let mut dirs = path_dirs;
        append_windows_dsh_dirs(&mut dirs);
        dirs
    };

    scan_dirs_for_user_dsh(&dirs, candidates)
}

/// 在给定目录列表中查找用户 dsh（跳过本应用生成的 shim）。
fn scan_dirs_for_user_dsh(dirs: &[PathBuf], candidates: &[&str]) -> Option<PathBuf> {
    for dir in dirs {
        for name in candidates {
            let candidate = dir.join(name);
            // 仅跳过本应用生成的 shim（内容含生成标记）；用户手动安装的 dsh 命中
            if candidate.is_file() && !cli::is_generated_shim(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// Unix GUI 进程的 PATH 可能早于用户安装（且 nvm/volta/asdf/fnm 等版本管理器
/// 只把 node 目录注入 shell 内 PATH，桌面菜单/自启的 GUI 进程看不到），补充这些
/// 工具的标准用户目录。
///
/// 覆盖的布局（issue #302 只修了 Windows，Unix 侧漏检，见 issue #229 / #443）：
/// - nvm：`~/.nvm/versions/node/<version>/bin`；
/// - volta：`~/.volta/bin`；
/// - asdf：`~/.asdf/shims`；
/// - fnm：`$XDG_DATA_HOME/fnm/node-versions/<version>/installation/bin`，
///   XDG 未设置时按平台回退 Linux `~/.local/share/fnm`、macOS
///   `~/Library/Application Support/fnm`（见 fnm README 的 `FNM_DIR` 默认值）。
///
/// 只补充能确定存在的绝对目录，且按顺序去重。继承 PATH 仍优先。
#[cfg(unix)]
fn append_unix_dsh_dirs(dirs: &mut Vec<PathBuf>, home: &Path) {
    let mut append = |dir: PathBuf| {
        if dir.is_absolute() && dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };

    append(home.join(".volta").join("bin"));
    append(home.join(".asdf").join("shims"));

    append_version_dirs(
        &mut append,
        &home.join(".nvm").join("versions").join("node"),
    );

    let xdg = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from);
    for root in fnm_version_roots(home, xdg.as_deref()) {
        append_version_dirs(&mut append, &root);
    }
}

/// fnm 的 `node-versions` 根目录候选（按优先级）：`$XDG_DATA_HOME/fnm`，以及
/// 平台默认目录。多列一个不存在的根无害（`append_version_dirs` 会静默跳过），
/// 因此不做平台条件编译，避免漏掉 XDG 已设置但位于非默认位置的情况。
#[cfg(unix)]
fn fnm_version_roots(home: &Path, xdg_data_home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(xdg) = xdg_data_home {
        roots.push(xdg.join("fnm").join("node-versions"));
    }
    roots.push(
        home.join(".local")
            .join("share")
            .join("fnm")
            .join("node-versions"),
    );
    roots.push(
        home.join("Library")
            .join("Application Support")
            .join("fnm")
            .join("node-versions"),
    );
    roots
}

/// 遍历 `<root>/<version>/` 形态的版本目录，把各版本下的 `bin` 目录追加进去。
///
/// 按语义化版本**降序**（较新版本先被扫描到，多版本并存时优先命中新装的 dsh）；
/// 版本名无法解析时排在其后，仍保证不漏检。目录缺失或不可读时静默跳过——
/// 探测失败不应阻断启动。
#[cfg(unix)]
fn append_version_dirs(append: &mut impl FnMut(PathBuf), root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut versions: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    versions.sort_by_key(|dir| std::cmp::Reverse(version_key(dir)));
    for version in versions {
        // nvm：`<version>/bin`；fnm：`<version>/installation/bin` 与 `<version>/bin`
        append(version.join("bin"));
        append(version.join("installation").join("bin"));
    }
}

/// 版本目录名的排序键：解析为 `(semver, 原名)`，解析失败时 semver 视为最小，
/// 从而排在所有可解析版本之后（`Option<Version>` 的 `Ord` 已满足该语义）。
#[cfg(unix)]
fn version_key(dir: &Path) -> (Option<semver::Version>, String) {
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let parsed = semver::Version::parse(name.trim_start_matches('v')).ok();
    (parsed, name)
}

/// Windows GUI 进程的 PATH 可能早于用户安装（且 fnm 等版本管理器只把 node 目录
/// 注入 shell 内 PATH，GUI 进程看不到），补充这些工具的标准用户目录。
///
/// 覆盖两类常见布局：
/// - npm 全局：`%APPDATA%\npm`（`dsh.cmd` 与 `node_modules\@deepseek-ai\dsh` 同级）；
/// - fnm 全局：`%LOCALAPPDATA%\fnm\node-versions\<version>\installation`
///   （`node_modules\.bin\dsh.cmd` shim，包目录位于 `node_modules\@deepseek-ai\dsh`，
///   见 issue #229；`~/.fnm` 在 Windows 上极少使用，本函数只在 LOCALAPPDATA 下探测）。
///
/// 只补充能确定存在的绝对目录，且按顺序去重。继承 PATH 仍优先。
#[cfg(windows)]
fn append_windows_dsh_dirs(dirs: &mut Vec<PathBuf>) {
    let mut append = |dir: PathBuf| {
        if dir.is_absolute() && dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    };

    if let Some(appdata) = std::env::var_os("APPDATA") {
        // npm 全局 bin 目录（标准 npm 布局：shim 与 node_modules 同级）
        append(PathBuf::from(appdata).join("npm"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let fnm_versions = PathBuf::from(&local_app_data)
            .join("fnm")
            .join("node-versions");
        if let Ok(entries) = std::fs::read_dir(&fnm_versions) {
            for entry in entries.flatten() {
                // 版本目录下 `installation` 是 node 实际安装根；npm 全局包位于其
                // `node_modules\@deepseek-ai\dsh`，shim 在 `node_modules\.bin\dsh.cmd`
                //（fnm 也可能放到 `installation\bin`，一并补充）。
                let installation = entry.path().join("installation");
                if installation.is_dir() {
                    append(installation.join("node_modules").join(".bin"));
                    append(installation.join("bin"));
                    append(installation);
                }
            }
        }
    }
}

/// 在给定前缀下探测 `node_modules/@deepseek-ai/dsh` 包目录。
fn probe_package_dir(prefix: &Path) -> Option<PathBuf> {
    let p = prefix.join("node_modules").join("@deepseek-ai").join("dsh");
    p.join("package.json").is_file().then_some(p)
}

/// 由 dsh 可执行文件路径推导候选"安装前缀"（npm/pnpm 全局安装根目录）：
/// - bin 目录本身（node_modules 与 bin 同级）；
/// - bin 目录的父目录（标准 npm 全局布局：`<prefix>/bin/dsh`，包目录位于
///   `<prefix>/lib/node_modules` 或 `<prefix>/node_modules`）；
/// - `node_modules/.bin` 的父目录（fnm/pnpm 全局布局：shim 位于
///   `<prefix>/node_modules/.bin/dsh`，包目录位于 `<prefix>/node_modules/@deepseek-ai/dsh`）。
fn prefix_candidates(bin: &Path) -> Vec<PathBuf> {
    let Some(bin_dir) = bin.parent() else {
        return Vec::new();
    };
    let mut prefixes = vec![bin_dir.to_path_buf()];
    let dir_name = bin_dir.file_name().and_then(|n| n.to_str());
    // 仅当 bin 目录名为 `bin` 时才把父目录作为前缀候选，避免无关目录被误判
    if dir_name == Some("bin") {
        if let Some(parent) = bin_dir.parent() {
            prefixes.push(parent.to_path_buf());
        }
    }
    // fnm/pnpm 全局布局：shim 位于 `<prefix>/node_modules/.bin`，包目录位于
    // `<prefix>/node_modules/@deepseek-ai/dsh`，故前缀候选取 `.bin` 的祖父目录
    // （即 `node_modules` 的父目录 `<prefix>`）。
    if dir_name == Some(".bin")
        && bin_dir
            .parent()
            .and_then(|n| n.file_name())
            .and_then(|n| n.to_str())
            == Some("node_modules")
    {
        if let Some(prefix) = bin_dir.parent().and_then(Path::parent) {
            prefixes.push(prefix.to_path_buf());
        }
    }
    prefixes
}

/// 解析用户 dsh 的包目录（npm / pnpm 全局布局探测，纯文件系统、不派生子进程）。
///
/// 从 bin 路径推导候选前缀，依次探测：
/// 1. npm 布局 `<prefix>/node_modules/@deepseek-ai/dsh`；
/// 2. npm 标准全局布局 `<prefix>/lib/node_modules/@deepseek-ai/dsh`
///    （bin 位于 `<prefix>/bin`，包目录位于 `<prefix>/lib`）；
/// 3. pnpm 全局布局 `<prefix>/global/<n>/node_modules/@deepseek-ai/dsh`。
fn user_dsh_package_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    let bin = find_user_dsh_bin(app_handle)?;
    package_dir_from_bin(&bin)
}

/// 由 dsh bin 路径推导包目录（纯文件系统探测，便于测试）。
fn package_dir_from_bin(bin: &Path) -> Option<PathBuf> {
    let prefixes = prefix_candidates(bin);
    for prefix in &prefixes {
        // npm 布局：`<prefix>/node_modules/@deepseek-ai/dsh`
        if let Some(dir) = probe_package_dir(prefix) {
            return Some(dir);
        }
        // npm 标准全局布局：`<prefix>/lib/node_modules/@deepseek-ai/dsh`
        if let Some(dir) = probe_package_dir(&prefix.join("lib")) {
            return Some(dir);
        }
    }
    // pnpm 布局：`<prefix>/global/<n>/node_modules/@deepseek-ai/dsh`
    for prefix in &prefixes {
        if let Ok(entries) = std::fs::read_dir(prefix.join("global")) {
            for entry in entries.flatten() {
                if let Some(dir) = probe_package_dir(&entry.path()) {
                    return Some(dir);
                }
            }
        }
    }
    None
}

/// 读取包目录 package.json 的 version 字段
fn read_package_version(dir: &Path) -> Option<String> {
    let content = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&content).ok()?;
    v.get("version")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_start_matches('v').to_string())
}

/// 本地核心：包目录 + 版本 + bin.js 入口。任一环节缺失视为不存在。
pub(super) fn local_core(app_handle: &AppHandle) -> Option<LocalCore> {
    let package_dir = user_dsh_package_dir(app_handle)?;
    let version = read_package_version(&package_dir)?;
    let bin = package_dir.join("lib").join("bin.js");
    if !bin.is_file() {
        return None;
    }
    Some(LocalCore {
        package_dir,
        version,
        bin,
    })
}

/// 本地核心的包目录（「打开目录」入口用）；未检测到本地核心时返回 None。
pub fn local_core_package_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    local_core(app_handle).map(|c| c.package_dir)
}

/// 本地核心是否由 pnpm 全局布局管理（决定更新走 pnpm 还是 npm）。
fn local_core_uses_pnpm(app_handle: &AppHandle) -> bool {
    let Some(bin) = find_user_dsh_bin(app_handle) else {
        return false;
    };
    let prefixes = prefix_candidates(&bin);
    // npm 布局命中（node_modules 包存在）→ npm 管理
    let npm_layout = prefixes
        .iter()
        .any(|p| probe_package_dir(p).is_some() || probe_package_dir(&p.join("lib")).is_some());
    // pnpm 布局：`<prefix>/global/<n>/node_modules/@deepseek-ai/dsh` 命中 → pnpm 管理
    let pnpm_layout = prefixes.iter().any(|p| {
        std::fs::read_dir(p.join("global"))
            .map(|entries| {
                entries
                    .flatten()
                    .any(|e| probe_package_dir(&e.path()).is_some())
            })
            .unwrap_or(false)
    });
    !npm_layout && pnpm_layout
}

/// 通过用户包管理器 CLI 更新本地核心（npm `update -g` / pnpm `add -g`）。
///
/// 返回更新后的版本号。失败返回错误（附进程输出尾部，便于排查）。
pub async fn update_local_core(app_handle: AppHandle) -> Result<String, String> {
    crate::service::workflow::instances::require_exclusive_profile()?;
    let Some(core) = local_core(&app_handle) else {
        return Err("CORE_LOCAL_NOT_FOUND: no local core to update".to_string());
    };
    log::info!("Updating local dsh core at {}", core.package_dir.display());

    let uses_pnpm = local_core_uses_pnpm(&app_handle);
    // 更新到最新：pnpm 用 `add -g @latest`，npm 用 `install -g @latest`
    // （npm update 对已固定版本号的安装可能不生效，install @latest 才能升级）
    let (pm, args): (&str, Vec<String>) = if uses_pnpm {
        (
            "pnpm",
            vec![
                "add".to_string(),
                "-g".to_string(),
                "@deepseek-ai/dsh@latest".to_string(),
            ],
        )
    } else {
        (
            "npm",
            vec![
                "install".to_string(),
                "-g".to_string(),
                "@deepseek-ai/dsh@latest".to_string(),
            ],
        )
    };
    log::info!("Updating local dsh core via `{pm} {args:?}`");

    // GUI 进程下 npm/pnpm 均以控制台程序方式派生子进程，Windows 上需隐藏窗口
    let program = if cfg!(windows) {
        format!("{pm}.cmd")
    } else {
        pm.to_string()
    };
    let (status, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(&program);
        cmd.args(&args);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match cmd.output() {
            Ok(out) => (out.status.success(), out.stdout, out.stderr),
            Err(e) => (false, Vec::new(), format!("spawn failed: {e}").into_bytes()),
        }
    })
    .await
    .map_err(|e| format!("CORE_UPDATE_JOIN: {e}"))?;

    let tail = |bytes: Vec<u8>| -> String {
        String::from_utf8_lossy(&bytes)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .rev()
            .take(12)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n")
    };

    if !status {
        let output = tail(stdout.into_iter().chain(stderr).collect());
        return Err(format!("CORE_UPDATE_FAILED: {output}"));
    }

    // 更新成功后按新包目录回读版本
    let version = local_core(&app_handle)
        .map(|c| c.version)
        .unwrap_or_default();
    if version.is_empty() {
        log::warn!("Local core updated but version could not be re-read");
    }
    Ok(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_package_version_parses_manifest() {
        let dir = std::env::temp_dir().join(format!("dsh-core-ver-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        assert_eq!(read_package_version(&dir).as_deref(), Some("0.1.0-rc.8"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// 独立临时目录，避免测试间互相干扰
    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-core-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// 构造一个"用户 dsh"可执行文件（不含生成标记）
    fn write_foreign_dsh(dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("dsh");
        std::fs::write(&p, "#!/bin/sh\necho user dsh\n").unwrap();
        p
    }

    /// 构造一个"本应用生成的 shim"（含生成标记）
    fn write_our_shim(dir: &std::path::Path) -> std::path::PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let p = dir.join("dsh");
        std::fs::write(
            &p,
            "# DeepSeek Harness Desktop - dsh command shim (generated)\n",
        )
        .unwrap();
        p
    }

    /// issue #54：本应用 shim 目录（Unix `~/.local/bin`）下用户自行安装的 dsh
    /// 必须被识别——旧逻辑整目录跳过，导致本机 dsh 漏检。
    #[test]
    fn scan_dir_finds_foreign_dsh_inside_shim_dir() {
        let dir = temp_dir("foreign-in-shim");
        let dsh = write_foreign_dsh(&dir);
        assert_eq!(
            scan_dirs_for_user_dsh(std::slice::from_ref(&dir), &["dsh"]),
            Some(dsh)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 本应用生成的 shim 不应被误判为用户本地 dsh。
    #[test]
    fn scan_dir_skips_our_own_shim() {
        let shim_dir = temp_dir("our-shim");
        let bin_dir = temp_dir("foreign-bin");
        let ours = write_our_shim(&shim_dir);
        let theirs = write_foreign_dsh(&bin_dir);
        // 只扫 shim 目录 → 跳过本应用 shim，无命中
        assert_eq!(
            scan_dirs_for_user_dsh(std::slice::from_ref(&shim_dir), &["dsh"]),
            None
        );
        // 同时扫两个目录 → 命中用户 dsh（不是本应用 shim）
        assert_eq!(
            scan_dirs_for_user_dsh(&[shim_dir.clone(), bin_dir.clone()], &["dsh"]),
            Some(theirs)
        );
        let _ = ours;
        let _ = std::fs::remove_dir_all(&shim_dir);
        let _ = std::fs::remove_dir_all(&bin_dir);
    }

    /// `is_generated_shim`：按内容区分本应用 shim 与用户同名文件。
    #[test]
    fn is_generated_shim_detects_marker() {
        let dir = temp_dir("marker");
        let ours = write_our_shim(&dir.join("ours"));
        let theirs = write_foreign_dsh(&dir.join("theirs"));
        assert!(cli::is_generated_shim(&ours));
        assert!(!cli::is_generated_shim(&theirs));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// bin 位于 `<prefix>/bin` 的标准 npm 全局布局 → 父目录也应作为候选前缀。
    #[test]
    fn prefix_candidates_include_bin_parent() {
        let root = temp_dir("prefix-candidates");
        let bin = root.join("bin").join("dsh");
        let candidates = prefix_candidates(&bin);
        assert_eq!(candidates, vec![root.join("bin"), root.clone()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 标准 npm 全局布局：`<prefix>/bin/dsh` + `<prefix>/lib/node_modules/@deepseek-ai/dsh`。
    #[test]
    fn package_dir_from_bin_resolves_npm_lib_layout() {
        let root = temp_dir("npm-lib");
        let pkg = root
            .join("lib")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        std::fs::write(pkg.join("bin.js"), "").unwrap();
        let bin = root.join("bin").join("dsh");
        // npm 布局命中 `~/.local` 前缀下的 `<prefix>/lib/node_modules/...`
        assert_eq!(
            package_dir_from_bin(&bin),
            Some(
                root.join("lib")
                    .join("node_modules")
                    .join("@deepseek-ai")
                    .join("dsh")
            )
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Windows npm 扁平布局：`<prefix>/dsh.cmd` + `<prefix>/node_modules/@deepseek-ai/dsh`。
    #[test]
    fn package_dir_from_bin_resolves_npm_flat_layout() {
        let root = temp_dir("npm-flat");
        let pkg = root.join("node_modules").join("@deepseek-ai").join("dsh");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        let bin = root.join("dsh.cmd");
        assert_eq!(
            package_dir_from_bin(&bin),
            Some(root.join("node_modules").join("@deepseek-ai").join("dsh"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// fnm 全局布局：shim 位于 `<prefix>/node_modules/.bin/dsh.cmd`，包目录位于
    /// `<prefix>/node_modules/@deepseek-ai/dsh`（issue #229）。包目录解析必须能从
    /// `.bin` shim 上溯到安装前缀。
    #[test]
    fn package_dir_from_bin_resolves_fnm_node_modules_bin_layout() {
        let root = temp_dir("fnm-bin-layout");
        let pkg = root.join("node_modules").join("@deepseek-ai").join("dsh");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"@deepseek-ai/dsh","version":"0.1.0-rc.8"}"#,
        )
        .unwrap();
        let bin = root.join("node_modules").join(".bin").join("dsh.cmd");
        assert_eq!(
            package_dir_from_bin(&bin),
            Some(root.join("node_modules").join("@deepseek-ai").join("dsh"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// `prefix_candidates` 必须把 `node_modules/.bin` 的祖父目录（安装前缀）纳入候选，
    /// 否则 fnm 全局 shim 无法定位包目录。
    #[test]
    fn prefix_candidates_include_grandparent_of_node_modules_bin() {
        let root = temp_dir("fnm-prefix-candidates");
        let bin = root.join("node_modules").join(".bin").join("dsh.cmd");
        let candidates = prefix_candidates(&bin);
        assert!(candidates.contains(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// issue #229 / #443：nvm 全局安装的 `dsh` 必须被发现——GUI 进程拿不到
    /// nvm 注入的 PATH，旧逻辑只补 `~/.local/bin`，导致 Unix 侧漏检。
    /// 多版本并存时较新的版本目录必须先于较旧的被扫描到。
    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_finds_nvm_version_bins_newest_first() {
        let home = temp_dir("unix-nvm");
        let older = home.join(".nvm/versions/node/v22.19.0/bin");
        let newer = home.join(".nvm/versions/node/v24.19.0/bin");
        std::fs::create_dir_all(&older).unwrap();
        std::fs::create_dir_all(&newer).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        let newer_pos = dirs.iter().position(|d| d == &newer);
        let older_pos = dirs.iter().position(|d| d == &older);
        assert!(newer_pos.is_some(), "较新版本 bin 未纳入: {dirs:?}");
        assert!(older_pos.is_some(), "较旧版本 bin 未纳入: {dirs:?}");
        assert!(newer_pos < older_pos, "较新版本应先于较旧版本: {dirs:?}");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// volta / asdf 的标准目录同样纳入；不存在的目录不得被追加（避免无谓 stat）。
    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_covers_volta_asdf_and_skips_missing() {
        let home = temp_dir("unix-managers");
        let volta = home.join(".volta/bin");
        let asdf = home.join(".asdf/shims");
        std::fs::create_dir_all(&volta).unwrap();
        std::fs::create_dir_all(&asdf).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        assert!(dirs.contains(&volta), "volta bin 未纳入: {dirs:?}");
        assert!(dirs.contains(&asdf), "asdf shims 未纳入: {dirs:?}");
        assert!(
            !dirs.iter().any(|d| d.ends_with("node-versions")),
            "不应追加不存在的根目录"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// fnm（Unix 布局）的 `<version>/installation/bin` 也要能定位到。
    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_finds_fnm_installation_bin() {
        let home = temp_dir("unix-fnm");
        let installation = home.join(".local/share/fnm/node-versions/v24.19.0/installation/bin");
        std::fs::create_dir_all(&installation).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        assert!(
            dirs.contains(&installation),
            "fnm installation bin 未纳入: {dirs:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// fnm 在 macOS 的默认根是 `~/Library/Application Support/fnm`（而非 Linux 的
    /// `~/.local/share/fnm`），必须一并覆盖，否则 macOS 上 fnm 装的 dsh 仍漏检。
    #[cfg(unix)]
    #[test]
    fn append_unix_dirs_finds_fnm_macos_installation_bin() {
        let home = temp_dir("unix-fnm-macos");
        let installation =
            home.join("Library/Application Support/fnm/node-versions/v24.19.0/installation/bin");
        std::fs::create_dir_all(&installation).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        assert!(
            dirs.contains(&installation),
            "macOS fnm installation bin 未纳入: {dirs:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// fnm 尊重 `$XDG_DATA_HOME`；该变量指向自定义根时也要能定位到。
    #[cfg(unix)]
    #[test]
    fn fnm_version_roots_includes_xdg_data_home() {
        let home = temp_dir("unix-fnm-xdg");
        let xdg = temp_dir("unix-fnm-xdg-root");
        let roots = fnm_version_roots(&home, Some(&xdg));
        assert!(
            roots.contains(&xdg.join("fnm").join("node-versions")),
            "XDG 根未纳入候选: {roots:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&xdg);
    }

    /// 版本排序必须按语义而非字符串：`v9.0.0` 字符串序在 `v24.0.0` 之前，但语义上
    /// 更旧，必须排在后面——否则多版本并存时会优先命中旧版本的 dsh。
    #[cfg(unix)]
    #[test]
    fn append_version_dirs_orders_semantically_not_lexically() {
        let home = temp_dir("unix-semver-order");
        let newer = home.join(".nvm/versions/node/v24.0.0/bin");
        let older = home.join(".nvm/versions/node/v9.0.0/bin");
        std::fs::create_dir_all(&newer).unwrap();
        std::fs::create_dir_all(&older).unwrap();

        let mut dirs: Vec<PathBuf> = Vec::new();
        append_unix_dsh_dirs(&mut dirs, &home);

        let newer_pos = dirs.iter().position(|d| d == &newer).unwrap();
        let older_pos = dirs.iter().position(|d| d == &older).unwrap();
        assert!(newer_pos < older_pos, "v24 应排在 v9 之前: {dirs:?}");
        let _ = std::fs::remove_dir_all(&home);
    }
}
