use crate::AppHandle;
use serde::Serialize;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{Manager, Runtime};

use super::constants::*;
use super::dependencies;
use super::{detect_region, Region};

/// 获取当前构建专用的 AppData 基础目录。
///
/// debug 与 release 不能共用核心安装目录：更新或切换 debug 核心时，可能替换
/// release 正在加载的 Node 原生模块。用户数据目录另由 `get_dsh_data_path` 隔离。
///
/// 环境与核心都装在本根之下。`DOWNLOAD_CACHE_ENV_VAR` 可覆盖它——E2E 每次使用
/// 全新 scratch home，不覆盖就会反复重下；指向稳定目录即可让首次下载在后续
/// 运行中复用（清空该目录即回到「首次装配」状态，用于测启动 setup 流程）。
pub fn get_base_dir<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    base_dir_from(|| {
        app_handle
            .path()
            .app_data_dir()
            .expect("Failed to resolve app data directory")
    })
}

pub(crate) fn base_dir_from(app_data: impl FnOnce() -> PathBuf) -> PathBuf {
    if let Some(dir) = env::var_os(DOWNLOAD_CACHE_ENV_VAR).filter(|dir| !dir.is_empty()) {
        return PathBuf::from(dir);
    }
    let base = app_data();
    if cfg!(debug_assertions) {
        base.join(APP_DATA_DEV_DIR_NAME)
    } else {
        base
    }
}

/// 旧版独立 Node 运行时的托管根（`$AppData/runtime`）。
///
/// 仅用于启动时清理：dsh 与 pnpm 已改为以随包 Electron 的 Node 模式运行，这个
/// 目录只可能是历史安装留下的残留。
pub fn legacy_node_root<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    get_base_dir(app_handle).join(LEGACY_NODE_ROOT_DIR)
}

/// Harness 发行版资产文件名（按平台与架构）
fn dsh_pkg_asset_filename(os: &str, arch: &str) -> Result<String, String> {
    match (os, arch) {
        ("windows", _) => Ok("deepseek-harness-pkg-windows.zip".to_string()),
        ("macos", "aarch64") => Ok("deepseek-harness-pkg-macos-arm64.zip".to_string()),
        ("macos", "x86_64") => Ok("deepseek-harness-pkg-macos-x64.zip".to_string()),
        ("linux", "x86_64") => Ok("deepseek-harness-pkg-linux.zip".to_string()),
        ("linux", "aarch64") => Ok("deepseek-harness-pkg-linux-arm64.zip".to_string()),
        _ => Err(format!("Unsupported platform: {} {}", os, arch)),
    }
}

/// 打包的 DeepSeek Harness 发行版下载地址（GitHub 官方直连，首选源）
pub fn get_dsh_download_url() -> Result<String, String> {
    Ok(format!(
        "{}{}",
        DSH_CORE_URL,
        dsh_pkg_asset_filename(env::consts::OS, env::consts::ARCH)?
    ))
}

/// 为任意 GitHub Release 资产 URL 生成全部镜像兜底地址
/// （透传原 URL，下载内容一致，仍可做 SHA-256 完整性校验）。
pub fn mirror_download_urls(asset_url: &str) -> Vec<String> {
    DSH_MIRROR_PREFIXES
        .iter()
        .map(|prefix| format!("{prefix}{asset_url}"))
        .collect()
}

/// 指定 tag 的 DeepSeek Harness 发行版下载地址。
///
/// 把 latest 下载地址中的 `releases/latest/download/` 替换为
/// `releases/download/<tag>/`，镜像/直连与平台文件名逻辑与最新版完全一致
/// （GitHub 的 tag 下载路径是固定的 release 资产地址，可被确定性推导）。
pub fn get_dsh_download_url_for_tag(tag: &str) -> Result<String, String> {
    let base = DSH_CORE_URL.replace(
        "releases/latest/download/",
        &format!("releases/download/{tag}/"),
    );
    Ok(format!(
        "{}{}",
        base,
        dsh_pkg_asset_filename(env::consts::OS, env::consts::ARCH)?
    ))
}

fn node_version_output(node: &Path, args: &[&str]) -> Option<std::process::Output> {
    let mut command = std::process::Command::new(node);
    // 版本查询不应执行用户的 preload；真实服务仍沿用其 NODE_OPTIONS。
    command
        .args(args)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .env_remove("NODE_OPTIONS");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.output().ok()
}

fn probe_node_version(node: &Path) -> Option<(String, Option<PathBuf>)> {
    if let Some(output) = node_version_output(
        node,
        &[
            "-p",
            "JSON.stringify([process.versions.node,process.execPath])",
        ],
    ) {
        if output.status.success() {
            if let Ok((version, actual)) =
                serde_json::from_slice::<(String, PathBuf)>(&output.stdout)
            {
                if semver::Version::parse(&version).is_ok() && actual.is_absolute() {
                    return Some((version, Some(actual)));
                }
            }
        }
    }
    let output = node_version_output(node, &["--version"])?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout.trim().trim_start_matches('v');
    (!version.is_empty()).then(|| (version.to_string(), None))
}

type NodeVersionIdentity = (PathBuf, u64, std::time::SystemTime);

static NODE_VERSION_CACHE: std::sync::Mutex<Option<(NodeVersionIdentity, String)>> =
    std::sync::Mutex::new(None);

fn cached_node_version(
    node: &Path,
    cache: &std::sync::Mutex<Option<(NodeVersionIdentity, String)>>,
    probe: impl FnOnce() -> Option<(String, Option<PathBuf>)>,
) -> Option<String> {
    let identity = || {
        let path = dunce::canonicalize(node).ok()?;
        let meta = fs::metadata(&path).ok()?;
        meta.is_file()
            .then_some((path, meta.len(), meta.modified().ok()?))
    };
    // ponytail: 串行版本探测；多运行时高并发时再按文件身份分锁。
    let mut guard = cache.lock().unwrap_or_else(|error| error.into_inner());
    let Some(key) = identity() else {
        drop(guard);
        return probe().map(|(version, _)| version);
    };
    if let Some((cached_key, version)) = guard.as_ref() {
        if cached_key == &key {
            return Some(version.clone());
        }
    }
    let (version, actual) = probe()?;
    // 静态转发器可不改自身文件就切换 Node，只有实际执行文件一致才可复用版本。
    if actual
        .and_then(|path| dunce::canonicalize(path).ok())
        .as_ref()
        == Some(&key.0)
        && identity().as_ref() == Some(&key)
    {
        *guard = Some((key, version.clone()));
    }
    Some(version)
}

/// 获取指定可执行文件的 Node 版本号（例如 "24.21.0"）
///
/// Electron 在 Node 模式下报告的是它内置的 Node 版本，探测方式与独立 node 相同。
pub fn get_node_version_of_path(node: &Path) -> Option<String> {
    cached_node_version(node, &NODE_VERSION_CACHE, || probe_node_version(node))
}

/// 运行 dsh/pnpm 的唯一运行时：随包分发的 Electron（`ELECTRON_RUN_AS_NODE=1`）。
///
/// 拉起进程一律经 [`crate::service::workflow::launch::node_command`]，它由
/// `ElectronClient` 给出同一个二进制并已带好 Node 模式环境；本函数只服务需要
/// 提前知道路径的场景（CLI shim 烘焙、诊断展示）。
pub fn node_executable<R: Runtime>(app_handle: &AppHandle<R>) -> Result<PathBuf, String> {
    crate::service::workflow::electron_executable(app_handle)
}

/// Harness 发行版安装目录
pub fn get_dsh_install_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    dependencies::active_root(app_handle, dependencies::DEP_DSH)
}

/// dsh CLI 入口
pub fn get_dsh_binary_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    dependencies::binary_path(app_handle, dependencies::DEP_DSH)
}

/// pnpm 安装目录
pub fn get_pnpm_install_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    dependencies::active_root(app_handle, dependencies::DEP_PNPM)
}

/// 捆绑 pnpm CLI 入口（纯 JS 发行，用 node 运行）
pub fn get_pnpm_binary_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    dependencies::binary_path(app_handle, dependencies::DEP_PNPM)
}

/// pnpm 官方/镜像下载前缀：国内走 npmmirror registry，其他直连 npmjs.org
fn pnpm_base_url(region: Region) -> &'static str {
    match region {
        Region::Domestic => PNPM_MIRROR_BASE_URL,
        Region::Overseas => PNPM_BASE_URL,
    }
}

/// pnpm 下载地址（纯 JS 发行，全平台同一 URL）
pub fn get_pnpm_download_url() -> String {
    format!(
        "{}pnpm-{}.tgz",
        pnpm_base_url(detect_region()),
        PNPM_VERSION
    )
}

/// Windows 免安装 Git 的安装目录。
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 Git 运行时探测使用
pub fn get_mingit_install_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    dependencies::active_root(app_handle, dependencies::DEP_GIT)
}

/// Windows 免安装 Git 的 CLI 入口。
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 Git 运行时探测使用
pub fn get_mingit_binary_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    dependencies::binary_path(app_handle, dependencies::DEP_GIT)
}

/// Windows MinGit 官方发行包文件名。
#[cfg_attr(all(not(windows), not(test)), allow(dead_code))] // 仅 Windows 的 MinGit 任务与单测使用
fn mingit_pkg_filename(arch: &str) -> Result<String, String> {
    match arch {
        "x86_64" => Ok(format!("MinGit-{MINGIT_VERSION}-64-bit.zip")),
        "aarch64" => Ok(format!("MinGit-{MINGIT_VERSION}-arm64.zip")),
        _ => Err(format!("MINGIT_PLATFORM_UNSUPPORTED: windows {arch}")),
    }
}

/// Windows MinGit 官方发行包下载地址。
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 MinGit 任务使用
pub fn get_mingit_download_url() -> Result<String, String> {
    Ok(format!(
        "{MINGIT_BASE_URL}{}",
        mingit_pkg_filename(env::consts::ARCH)?
    ))
}

/// Windows MinGit 官方发行包固定 SHA-256。
#[cfg_attr(not(windows), allow(dead_code))] // 仅 Windows 的 MinGit 任务使用
pub fn get_mingit_sha256() -> Result<&'static str, String> {
    match env::consts::ARCH {
        "x86_64" => Ok(MINGIT_X64_SHA256),
        "aarch64" => Ok(MINGIT_ARM64_SHA256),
        arch => Err(format!("MINGIT_PLATFORM_UNSUPPORTED: windows {arch}")),
    }
}

/// 在 PATH 中寻找可直接运行的系统 Git。
#[cfg(windows)]
pub fn find_system_git_binary() -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join("git.exe"))
        .find(|candidate| candidate.is_file() && git_binary_works(candidate))
}

/// 运行 Git 并捕获输出；GUI 进程下禁止闪现控制台窗口。
#[cfg(windows)]
fn git_output(binary: &Path, arg: &str) -> Option<std::process::Output> {
    use std::os::windows::process::CommandExt;

    std::process::Command::new(binary)
        .arg(arg)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok()
}

/// 检查 Git HTTPS transport helper 的两种 Windows 发行布局。
///
/// 完整安装版通常把 helper 放在 `--exec-path`，而官方 MinGit 2.53 把它放在
/// 同一平台根目录（`mingw64` 或 `clangarm64`）下的 `bin`。只检查前者会在每次
/// 启动时把已安装且可用的 MinGit 误判为缺失，反复进入依赖安装流程（issue #166）。
#[cfg(any(windows, test))]
fn git_https_helper_exists(exec_path: &Path) -> bool {
    const HELPER: &str = "git-remote-https.exe";

    if exec_path.join(HELPER).is_file() {
        return true;
    }

    exec_path
        .parent()
        .and_then(Path::parent)
        .is_some_and(|platform_root| platform_root.join("bin").join(HELPER).is_file())
}

/// 检查 Git CLI 与 HTTPS transport helper 是否完整，避免 PATH 中只有残缺壳程序
/// （`git --version` 可成功但无法执行 `ls-remote`）阻止自动修复。
#[cfg(windows)]
fn git_binary_works(binary: &Path) -> bool {
    if !git_output(binary, "--version").is_some_and(|output| output.status.success()) {
        return false;
    }
    let Some(output) = git_output(binary, "--exec-path").filter(|output| output.status.success())
    else {
        return false;
    };
    let exec_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    !exec_path.is_empty() && git_https_helper_exists(Path::new(&exec_path))
}

/// 返回桌面端应注入子进程 PATH 的已选 Git `cmd` 目录。
pub fn get_git_cmd_dir<R: Runtime>(app_handle: &AppHandle<R>) -> Option<PathBuf> {
    git_cmd_dir_from(|| get_mingit_binary_path(app_handle))
}

pub(crate) fn git_cmd_dir_from(_bundled: impl FnOnce() -> PathBuf) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(system_git) = find_system_git_binary() {
            return system_git.parent().map(Path::to_path_buf);
        }
        let bundled = _bundled();
        if bundled.is_file() && git_binary_works(&bundled) {
            return bundled.parent().map(Path::to_path_buf);
        }
        None
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// 当前环境是否已有可供插件 Git 依赖使用的 Git。
///
/// 随包资源构建（离线安装包）只随包运行 dsh 必需的 Node / pnpm / 内核，不随包 MinGit：
/// 启动 dsh 本身不需要 Git，而内网补装必然失败，把 Git 当成启动前置条件只会把应用卡在
/// 安装界面（见 [`dependencies::bundled_core_dir`]）。git 托管的能力（worktree、
/// `github:` 插件）在真正使用时给出明确失败。
#[cfg(windows)]
pub fn git_runtime_ready<R: Runtime>(app_handle: &AppHandle<R>) -> bool {
    find_system_git_binary().is_some()
        || git_binary_works(&get_mingit_binary_path(app_handle))
        || dependencies::bundled_core_dir(app_handle).is_some()
}

/// 非 Windows 平台不属于本次空白 Windows 环境的自动配置范围。
#[cfg(not(windows))]
pub fn git_runtime_ready<R: Runtime>(_app_handle: &AppHandle<R>) -> bool {
    true
}

/// Harness 发行版清单路径
pub fn get_dsh_package_json_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    get_dsh_install_path(app_handle).join(DSH_MANIFEST_RELATIVE)
}

/// 用户主目录（Windows 取 `%USERPROFILE%`，Unix 取 `$HOME`）。
///
/// 不使用 dirs crate（未引入该依赖），与官方 dsh 的 `$HOME/.dsh` 语义保持一致。
pub(crate) fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    let key = "USERPROFILE";
    #[cfg(not(windows))]
    let key = "HOME";
    std::env::var_os(key).map(PathBuf::from)
}

/// Harness 用户数据目录（$DSH_HOME）。
///
/// 与官方 dsh（`${DSH_HOME:-$HOME/.dsh}`）保持一致：
/// - release 构建使用非空环境变量 `DSH_HOME`，否则默认 `~/.dsh`；
/// - debug 构建始终使用 `~/.dsh.dev`，忽略从旧 desktop checkout、终端或 release
///   shim 继承的 `DSH_HOME`，避免两个构建误用同一 profile 并发改写；
/// - debug 子进程由 launch 显式收到同一个 `~/.dsh.dev`，开发版与生产版的会话、档案、
///   插件与主题因此互不干扰。
pub fn get_dsh_data_path<R: Runtime>(_app_handle: &AppHandle<R>) -> PathBuf {
    dsh_data_path_from_env()
}

pub(crate) fn dsh_data_path_from_env() -> PathBuf {
    let dir_name = if cfg!(debug_assertions) {
        DSH_HOME_DEV_DIR_NAME
    } else {
        if let Some(home) = std::env::var_os("DSH_HOME") {
            if !home.is_empty() {
                return PathBuf::from(home);
            }
        }
        DSH_HOME_DIR_NAME
    };
    user_home_dir()
        .map(|home| home.join(dir_name))
        .unwrap_or_else(|| PathBuf::from(dir_name))
}

/// dsh 服务日志文件路径
///
/// debug 构建写入独立的 `dsh-web.dev.log`：开发版每次启动都会轮转日志，若与
/// 生产共用同一个文件，会把正在运行的生产版日志记录轮转覆盖掉。
pub fn get_service_log_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
    service_log_path_from(
        &get_base_dir(app_handle),
        crate::service::workflow::instances::current_profile().as_deref(),
    )
}

pub(crate) fn service_log_path_from(base: &Path, profile: Option<&str>) -> PathBuf {
    let name = if cfg!(debug_assertions) {
        "dsh-web.dev.log"
    } else {
        "dsh-web.log"
    };
    let logs = base.join("logs");
    match profile {
        Some(profile) => logs.join(profile).join(name),
        None => logs.join(name),
    }
}

/// 当前实际使用的 Node.js 版本号
///
/// 运行时只有一个：随包 Electron（Node 模式）。直接探测它自己报告的版本，界面
/// 展示与实际拉起 dsh 的可执行文件必然一致；探测失败时回落空串（前端显示 `-`）。
pub fn get_active_node_version<R: Runtime>(app_handle: &AppHandle<R>) -> String {
    node_executable(app_handle)
        .ok()
        .and_then(|node| get_node_version_of_path(&node))
        .unwrap_or_default()
}

/// 从打包的 Harness 清单读取 dsh 版本（界面展示用）
pub fn get_dsh_version<R: Runtime>(app_handle: &AppHandle<R>) -> Option<String> {
    dsh_version_at(&get_dsh_package_json_path(app_handle))
}

pub(crate) fn dsh_version_at(manifest_path: &Path) -> Option<String> {
    let read = |path: &Path| {
        serde_json::from_slice::<serde_json::Value>(&fs::read(path).ok()?).ok()
    };
    let manifest = read(manifest_path);
    if let Some(package) = manifest.as_ref().filter(|package| {
        package.get("name").and_then(|value| value.as_str()) == Some("@deepseek-ai/dsh")
    }) {
        return package.get("version")?.as_str().map(str::to_string);
    }
    manifest_path
        .parent()
        .and_then(|dir| read(&dir.join("node_modules/@deepseek-ai/dsh/package.json")))
        .filter(|package| {
            package.get("name").and_then(|value| value.as_str()) == Some("@deepseek-ai/dsh")
        })
        .and_then(|package| package.get("version")?.as_str().map(str::to_string))
        .or_else(|| {
            manifest?
                .get("dependencies")?
                .get("@deepseek-ai/dsh")?
                .as_str()
                .map(|value| value.trim_start_matches(['^', '~', '=', '>', '<']).to_string())
        })
}

/// 侧边栏展示的运行时/版本/诊断信息
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeInfo {
    pub app_version: String,
    pub dsh_version: Option<String>,
    pub node_version: String,
    pub service_url: String,
    pub data_dir: String,
    pub log_path: String,
    pub platform: String,
    pub arch: String,
}

pub fn runtime_info<R: Runtime>(app: &AppHandle<R>, port: u16) -> RuntimeInfo {
    RuntimeInfo {
        app_version: app.package_info().version.to_string(),
        dsh_version: get_dsh_version(app),
        node_version: get_active_node_version(app),
        service_url: get_dsh_service_url(port),
        // 用户数据所在目录 = $DSH_HOME（release 为官方 ~/.dsh，debug 为独立
        // ~/.dsh.dev，见 get_dsh_data_path），不再是 AppData
        data_dir: get_dsh_data_path(app).to_string_lossy().into_owned(),
        log_path: get_service_log_path(app).to_string_lossy().into_owned(),
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_directory_preserves_build_split_and_cache_short_circuit() {
        let override_dir = env::var_os(DOWNLOAD_CACHE_ENV_VAR).filter(|dir| !dir.is_empty());
        let base = base_dir_from(|| {
            assert!(
                override_dir.is_none(),
                "cache override must not resolve AppData"
            );
            PathBuf::from("app-data")
        });
        let expected = override_dir.map(PathBuf::from).unwrap_or_else(|| {
            if cfg!(debug_assertions) {
                PathBuf::from("app-data").join(APP_DATA_DEV_DIR_NAME)
            } else {
                PathBuf::from("app-data")
            }
        });
        assert_eq!(base, expected);
    }

    #[test]
    fn service_log_path_keeps_profile_and_build_filename() {
        let base = Path::new("app-data");
        let name = if cfg!(debug_assertions) {
            "dsh-web.dev.log"
        } else {
            "dsh-web.log"
        };
        assert_eq!(
            service_log_path_from(base, None),
            base.join("logs").join(name)
        );
        assert_eq!(
            service_log_path_from(base, Some("profile-a")),
            base.join("logs").join("profile-a").join(name)
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn git_cmd_dir_does_not_resolve_bundled_on_unix() {
        assert_eq!(
            git_cmd_dir_from(|| panic!("system Git needs no bundled path")),
            None
        );
    }

    #[test]
    fn node_version_cache_runs_probe_once_for_the_same_resolved_file() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        fs::write(&node, b"fixture").unwrap();
        let cache = std::sync::Mutex::new(None);
        let calls = std::cell::Cell::new(0);
        for path in [&node, &root.path().join(".").join("node")] {
            assert_eq!(
                cached_node_version(path, &cache, || {
                    calls.set(calls.get() + 1);
                    Some(("24.0.0".into(), Some(node.clone())))
                }),
                Some("24.0.0".into())
            );
        }
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn node_version_cache_merges_concurrent_probes_of_the_same_file() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        fs::write(&node, b"fixture").unwrap();
        let cache = std::sync::Mutex::new(None);
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(4);
        use std::sync::atomic::Ordering;
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    barrier.wait();
                    assert_eq!(
                        cached_node_version(&node, &cache, || {
                            calls.fetch_add(1, Ordering::SeqCst);
                            Some(("24.0.0".into(), Some(node.clone())))
                        }),
                        Some("24.0.0".into())
                    );
                });
            }
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn node_version_cache_invalidates_when_size_mtime_or_path_changes() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        fs::write(&node, b"first").unwrap();
        let cache = std::sync::Mutex::new(None);
        let calls = std::cell::Cell::new(0);
        let probe = |path: &Path| {
            calls.set(calls.get() + 1);
            Some((format!("24.0.{}", calls.get()), Some(path.to_path_buf())))
        };
        assert_eq!(
            cached_node_version(&node, &cache, || probe(&node)),
            Some("24.0.1".into())
        );
        let original_modified = fs::metadata(&node).unwrap().modified().unwrap();
        fs::write(&node, b"replacement").unwrap();
        fs::File::options()
            .write(true)
            .open(&node)
            .unwrap()
            .set_modified(original_modified)
            .unwrap();
        assert_eq!(
            cached_node_version(&node, &cache, || probe(&node)),
            Some("24.0.2".into())
        );
        let modified = fs::metadata(&node).unwrap().modified().unwrap();
        fs::File::options()
            .write(true)
            .open(&node)
            .unwrap()
            .set_modified(modified + std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(
            cached_node_version(&node, &cache, || probe(&node)),
            Some("24.0.3".into())
        );
        let other = root.path().join("other-node");
        fs::copy(&node, &other).unwrap();
        fs::File::options()
            .write(true)
            .open(&other)
            .unwrap()
            .set_modified(fs::metadata(&node).unwrap().modified().unwrap())
            .unwrap();
        assert_eq!(
            cached_node_version(&other, &cache, || probe(&other)),
            Some("24.0.4".into())
        );
        assert_eq!(calls.get(), 4);
    }

    #[test]
    fn node_version_cache_does_not_store_a_probe_if_the_file_changes_during_it() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        fs::write(&node, b"first").unwrap();
        let cache = std::sync::Mutex::new(None);
        assert_eq!(
            cached_node_version(&node, &cache, || {
                fs::write(&node, b"replacement").unwrap();
                Some(("24.0.0".into(), Some(node.clone())))
            }),
            Some("24.0.0".into())
        );
        assert_eq!(
            cached_node_version(&node, &cache, || Some((
                "24.0.1".into(),
                Some(node.clone())
            ))),
            Some("24.0.1".into())
        );
    }

    #[test]
    fn node_version_cache_does_not_reuse_a_fixed_shim_after_its_target_version_changes() {
        let root = tempfile::tempdir().unwrap();
        let node = root
            .path()
            .join(if cfg!(windows) { "node.cmd" } else { "node" });
        let script = if cfg!(windows) {
            "@echo off\r\nif \"%~1\"==\"-p\" (type \"%~dp0identity\") else (type \"%~dp0version\")\r\n"
        } else {
            "#!/bin/sh\nif [ \"$1\" = '-p' ]; then cat \"${0%/*}/identity\"; else cat \"${0%/*}/version\"; fi\n"
        };
        fs::write(&node, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let actual = root.path().join("actual-node");
        fs::write(&actual, b"target").unwrap();
        let before = fs::metadata(&node).unwrap();
        fs::write(root.path().join("version"), "v22.19.0\n").unwrap();
        fs::write(
            root.path().join("identity"),
            serde_json::to_vec(&("22.19.0", &actual)).unwrap(),
        )
        .unwrap();
        let first = get_node_version_of_path(&node).unwrap();
        assert_eq!(first, "22.19.0");
        fs::write(root.path().join("version"), "v23.0.0\n").unwrap();
        fs::write(
            root.path().join("identity"),
            serde_json::to_vec(&("23.0.0", &actual)).unwrap(),
        )
        .unwrap();
        let second = get_node_version_of_path(&node).unwrap();
        assert_eq!(second, "23.0.0");
        let after = fs::metadata(&node).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        fs::write(root.path().join("identity"), b"invalid JSON").unwrap();
        for version in ["22.19.0", "23.0.0"] {
            fs::write(root.path().join("version"), format!("v{version}\n")).unwrap();
            assert_eq!(get_node_version_of_path(&node).as_deref(), Some(version));
        }
    }

    #[test]
    fn node_version_cache_requires_an_existing_matching_exec_path() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        fs::write(&node, b"fixture").unwrap();
        let cache = std::sync::Mutex::new(None);
        for actual in [None, Some(root.path().join("missing-node"))] {
            for version in ["22.19.0", "23.0.0"] {
                assert_eq!(
                    cached_node_version(&node, &cache, || Some((version.into(), actual.clone()))),
                    Some(version.into())
                );
            }
        }
    }

    #[test]
    fn node_version_cache_executes_the_actual_node_probe_once() {
        let Some(candidate) = crate::service::workflow::test_runtime_executable() else {
            return;
        };
        let (_, actual) = probe_node_version(&candidate).expect("working Node.js required");
        let node = actual.expect("Node.js must expose its real executable path");
        let output = node_version_output(&node, &["--version"]).unwrap();
        assert!(output.status.success());
        let expected = String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .trim_start_matches('v')
            .to_string();
        let cache = std::sync::Mutex::new(None);
        let calls = std::cell::Cell::new(0);
        for _ in 0..3 {
            assert_eq!(
                cached_node_version(&node, &cache, || {
                    calls.set(calls.get() + 1);
                    let result = probe_node_version(&node).unwrap();
                    assert_eq!(
                        dunce::canonicalize(result.1.as_ref().unwrap()).unwrap(),
                        dunce::canonicalize(&node).unwrap()
                    );
                    Some(result)
                }),
                Some(expected.clone())
            );
        }
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn node_version_cache_does_not_remember_failed_probes() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        fs::write(&node, b"fixture").unwrap();
        let cache = std::sync::Mutex::new(None);
        assert_eq!(cached_node_version(&node, &cache, || None), None);
        assert_eq!(
            cached_node_version(&node, &cache, || Some((
                "24.0.0".into(),
                Some(node.clone())
            ))),
            Some("24.0.0".into())
        );
        assert_eq!(
            cached_node_version(&node, &cache, || panic!("success must be cached")),
            Some("24.0.0".into())
        );
    }

    #[test]
    fn node_version_cache_never_hits_when_file_identity_is_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let node = root.path().join("node");
        fs::write(&node, b"fixture").unwrap();
        let cache = std::sync::Mutex::new(None);
        assert_eq!(
            cached_node_version(&node, &cache, || Some((
                "24.0.0".into(),
                Some(node.clone())
            ))),
            Some("24.0.0".into())
        );
        fs::remove_file(&node).unwrap();
        for version in ["24.0.1", "24.0.2"] {
            assert_eq!(
                cached_node_version(&node, &cache, || Some((version.into(), Some(node.clone())))),
                Some(version.into())
            );
        }
        fs::create_dir(&node).unwrap();
        for version in ["24.0.3", "24.0.4"] {
            assert_eq!(
                cached_node_version(&node, &cache, || Some((version.into(), Some(node.clone())))),
                Some(version.into())
            );
        }
    }

    /// 为文件布局测试生成互不冲突的临时目录。
    fn unique_runtime_test_dir(name: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("dsh-runtime-{name}-{}-{nonce}", std::process::id()))
    }

    /// 完整 Git 安装版把 HTTPS helper 直接放在 exec path 时仍应识别。
    #[test]
    fn git_https_helper_accepts_exec_path_layout() {
        let root = unique_runtime_test_dir("git-exec-helper");
        let exec_path = root.join("mingw64").join("libexec").join("git-core");
        fs::create_dir_all(&exec_path).expect("create exec path");
        fs::write(exec_path.join("git-remote-https.exe"), b"stub").expect("write helper");

        assert!(git_https_helper_exists(&exec_path));

        let _ = fs::remove_dir_all(root);
    }

    /// 官方 MinGit 2.53 的 helper 位于平台根目录下的 `bin`；缺失时仍必须拒绝。
    #[test]
    fn git_https_helper_accepts_mingit_bin_layout_and_rejects_missing() {
        for platform_root in ["mingw64", "clangarm64"] {
            let root = unique_runtime_test_dir(platform_root);
            let exec_path = root.join(platform_root).join("libexec").join("git-core");
            fs::create_dir_all(&exec_path).expect("create exec path");
            assert!(!git_https_helper_exists(&exec_path));

            let helper = root
                .join(platform_root)
                .join("bin")
                .join("git-remote-https.exe");
            fs::create_dir_all(helper.parent().expect("helper parent")).expect("create MinGit bin");
            fs::write(helper, b"stub").expect("write helper");

            assert!(git_https_helper_exists(&exec_path));

            let _ = fs::remove_dir_all(root);
        }
    }

    /// 当前 DSH 明确支持 22.19+ 与 24+，不支持 22.18 及整个 Node 23 系列。
    #[test]
    fn mirror_urls_expand_every_prefix() {
        let asset = "https://github.com/dsh-tauri-desk/deepseek-harness-pkg/releases/download/v1.0.0/deepseek-harness-pkg-windows.zip";
        let urls = mirror_download_urls(asset);
        assert_eq!(urls.len(), DSH_MIRROR_PREFIXES.len());
        for (url, prefix) in urls.iter().zip(DSH_MIRROR_PREFIXES) {
            assert_eq!(url, &format!("{prefix}{asset}"));
        }
    }

    #[test]
    fn pnpm_base_url_switches_on_region() {
        assert_eq!(pnpm_base_url(Region::Overseas), PNPM_BASE_URL);
        assert_eq!(pnpm_base_url(Region::Domestic), PNPM_MIRROR_BASE_URL);
    }

    #[test]
    fn download_urls_keep_platform_filename_shape() {
        // 无论哪个地域，URL 都以 https 开头并保留平台文件名（镜像只是换前缀）
        let dsh = get_dsh_download_url().expect("dsh url");
        assert!(dsh.starts_with("https://"));
        assert!(dsh.ends_with(".zip"));
    }

    #[test]
    fn mingit_pkg_filename_covers_supported_windows_architectures() {
        assert_eq!(
            mingit_pkg_filename("x86_64").expect("x64 MinGit asset"),
            format!("MinGit-{MINGIT_VERSION}-64-bit.zip")
        );
        assert_eq!(
            mingit_pkg_filename("aarch64").expect("ARM64 MinGit asset"),
            format!("MinGit-{MINGIT_VERSION}-arm64.zip")
        );
    }

    #[test]
    fn mingit_pkg_filename_rejects_unsupported_architecture() {
        let error = mingit_pkg_filename("x86").expect_err("unsupported MinGit architecture");
        assert_eq!(error, "MINGIT_PLATFORM_UNSUPPORTED: windows x86");
    }

    #[test]
    fn mingit_release_metadata_is_pinned_and_https() {
        assert!(MINGIT_BASE_URL.starts_with("https://github.com/git-for-windows/git/releases/"));
        assert!(MINGIT_BASE_URL.contains("v2.53.0.windows.2"));
        assert_eq!(MINGIT_X64_SHA256.len(), 64);
        assert_eq!(MINGIT_ARM64_SHA256.len(), 64);
        assert_ne!(MINGIT_X64_SHA256, MINGIT_ARM64_SHA256);
    }

    #[test]
    fn dsh_pkg_asset_filename_matches_linux_architecture() {
        assert_eq!(
            dsh_pkg_asset_filename("linux", "x86_64").unwrap(),
            "deepseek-harness-pkg-linux.zip"
        );
        assert_eq!(
            dsh_pkg_asset_filename("linux", "aarch64").unwrap(),
            "deepseek-harness-pkg-linux-arm64.zip"
        );
        assert!(dsh_pkg_asset_filename("linux", "riscv64").is_err());
    }

}
