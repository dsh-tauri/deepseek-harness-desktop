//! 活动预打包核心的运行时自愈：补齐插件入口并检查原生依赖（含 ABI 兼容性）。
//!
//! dsh 的 loader 以核心安装目录作为裸包解析根，而 profile 中的插件实际位于
//! `$DSH_HOME/profiles/<profile>/node_modules`，应用内置插件则位于安装包资源目录。
//! 核心版本切换只移动 `dependencies/dsh`，不会自动重建这些入口，因此每次启动都要
//! 在启动 dsh 前按当前核心重新建立安全的目录链接。用户自行安装的 local 核心不归
//! 桌面端管理，明确跳过本模块。
//!
//! 除了入口链接，启动前还要确认核心的原生模块能真正被当前 Node 运行时加载：
//! 预打包核心的原生模块（`fs-ext` 这类 node-gyp 包）在 pkg 构建期编译，ABI 只与
//! 构建期 Node 大版本一致；而本地 Node 只按 semver 挑选（`is_supported_node_version`），
//! 因此 Node 25（ABI 141）会加载 ABI 137 的 `fs_ext.node` 失败，dsh 在插件树加载
//! 阶段退出、前端只看到 `HARNESS_NOT_OWNED`（issue #441）。这里在 spawn 之前探测，
//! 先尝试与核心对齐的捆绑运行时，再尝试重建，最后给出可读的 ABI 诊断。

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::fs::FileTypeExt;

use tauri::AppHandle;

use super::source::CoreSource;

/// 核心自有包所在的 scope。
const CORE_PACKAGE_SCOPE: &str = "@deepseek-ai";
/// 核心家族自身的包名前缀：`dsh` 与 `dsh-*`。
///
/// 同 scope 下的 cordis、cosmokit、schemastery 等共享框架库是插件可以合法依赖并
/// 锁定版本的对象（如 billion-context 锁 schemastery 3.18.4），不能按整个 scope 删除。
const CORE_PACKAGE_PREFIX: &str = "dsh";
const NATIVE_REPAIR_TIMEOUT: Duration = Duration::from_secs(120);
/// 原生模块重建（node-gyp 编译）可能远超安装耗时，单独放宽上限
const NATIVE_REBUILD_TIMEOUT: Duration = Duration::from_secs(300);
/// 探测脚本的挂起保护：脚本本身只做 require 与目录扫描
const NATIVE_PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const NODE_PROBE_SCRIPT: &str = "process.stdout.write(process.platform + ':' + process.arch)";
/// 旧版平台依赖探测：探测脚本结论不可信时的回退检查（sharp/koffi 均为 NAPI 包）
const NATIVE_IMPORT_SCRIPT: &str = "await import('sharp'); await import('koffi')";
/// 探测脚本的结果标记行前缀（脚本 stdout 里可能混有原生模块自身的输出）
const NATIVE_PROBE_MARKER: &str = "__DSH_NATIVE_PROBE__";
/// 已核验通过的原生依赖结论戳（issue #766）。
///
/// 探测要启动 node 子进程、把核心 `node_modules` 下每个原生包 require 一遍，前面还要
/// 再起一个子进程探测平台/架构，健康机器上这两步是纯开销。而结论在「同一个 node
/// 运行时 + 同一份核心 `node_modules`」下是稳定的，把结论连同输入指纹落到基础目录，
/// 命中即直接放行。
///
/// 只写 Ready：失败/未知一律不落盘，绝不把一次性修复结果固化成「以后都不用查」。
/// 指纹覆盖所有会造成结论变化的现实可变项——node 可执行文件身份（路径 + 大小 +
/// 修改时间）、核心目录与核心版本、`node_modules` 前两层的条目（名字 + 修改时间）：
/// 核心更新、node 升级/替换、平台包增删、`node_modules` 被重建都会失配，从而必然
/// 重新探测。清空依赖目录或删掉这个文件即可强制回到「每次探测」。
///
/// 指纹全部条目参与计算后压成 SHA-256 摘要再落盘：真实安装（pnpm 虚拟 store）
/// 的条目数已远超早先的固定上限，而摘要与条目数无关，比对精度不受规模影响。
const NATIVE_PROBE_STAMP_FILE: &str = "core-native-probe.stamp.json";
/// 指纹采集的条目上限：只在 `node_modules` 异常膨胀时兜底，正常安装远低于它
const NATIVE_PROBE_STAMP_MAX_ENTRIES: usize = 8192;
/// 原生模块探测脚本：列出无法被当前运行时加载的原生模块。
///
/// 1. `sharp` / `koffi`：NAPI 可选依赖，缺目标平台包时动态 import 失败（原有修复路径）；
/// 2. 原生包：带 `binding.gyp` 或自带原生产物目录（`build/Release`、`build/Debug`、
///    `prebuilds`、`prebuilt`）的包，逐个 require —— 与 dsh 自身的加载方式一致，
///    加载失败即为 dsh 启动时同样的失败（fs-ext 这类 node-gyp 包落在 build/Release）。
///    崩溃/异常退出时不会有标记行，Rust 侧按"结论未知"处理，不阻断启动。
const NATIVE_PROBE_SCRIPT: &str = r#"
const { createRequire } = await import('node:module');
const { existsSync, readdirSync } = await import('node:fs');
const { join } = await import('node:path');
const root = process.cwd();
const loader = createRequire(join(root, 'dsh-native-probe.cjs'));
const failures = [];
// 扫描中途抛错时置位：此时 failures 可能只是「还没扫到」的空清单，绝不能当成
// 「原生依赖都正常」报上去（见脚本末尾的标记行输出条件）。
let incomplete = false;
const describe = (error) => String((error && error.message) || error);
const isAbi = (text) => text.includes('NODE_MODULE_VERSION');
const attempt = (name, target) => {
  try { loader(target); return null; } catch (error) { return { name, message: describe(error) }; }
};
for (const name of ['sharp', 'koffi']) {
  const failure = attempt(name, name);
  if (failure) failures.push({ kind: 'import', name, message: failure.message, abi: isAbi(failure.message) });
}
try {
  const nodeModules = join(root, 'node_modules');
  const outputs = ['build/Release', 'build/Debug', 'prebuilds', 'prebuilt'];
  const candidates = [];
  const collect = (dir, name) => {
    if (existsSync(join(dir, 'binding.gyp')) || outputs.some((relative) => existsSync(join(dir, relative)))) {
      candidates.push({ dir, name });
    }
  };
  if (existsSync(nodeModules)) {
    // 目录链接（pnpm 布局 / 桌面端为插件建立的 junction）在 withFileTypes 下是
    // symbolic link 而非 directory，必须一并纳入，否则会漏掉链接形式的原生包。
    const isPackageDir = (entry) => entry.isDirectory() || entry.isSymbolicLink();
    for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
      if (!isPackageDir(entry)) continue;
      if (entry.name === '.bin' || entry.name === '.pnpm') continue;
      if (entry.name.startsWith('@')) {
        const scope = join(nodeModules, entry.name);
        for (const inner of readdirSync(scope, { withFileTypes: true })) {
          if (isPackageDir(inner)) collect(join(scope, inner.name), entry.name + '/' + inner.name);
        }
        continue;
      }
      collect(join(nodeModules, entry.name), entry.name);
    }
  }
  for (const pkg of candidates) {
    let failure = attempt(pkg.name, pkg.name);
    if (failure) {
      // 包入口不可 require（纯 ESM / 无 main）时退回直接加载 node-gyp 产物；
      // 只用来"洗清"失败，绝不覆盖包入口给出的错误信息（后者更完整，且
      // 直接加载 .node 可能报成"不是有效的 Win32 应用程序"而掩盖 ABI 差异）。
      const release = join(pkg.dir, 'build', 'Release');
      if (existsSync(release)) {
        const addon = readdirSync(release).find((file) => file.endsWith('.node'));
        if (addon && attempt(pkg.name, join(release, addon)) === null) failure = null;
      }
    }
    if (failure) failures.push({ kind: 'addon', name: pkg.name, message: failure.message, abi: isAbi(failure.message) });
  }
} catch (error) {
  process.stderr.write('native addon scan failed: ' + describe(error) + '\n');
  incomplete = true;
}
// 扫描没做完就不输出标记行：Rust 侧据此拿到「结论未知」（进而回退到 sharp/koffi
// 探测、不写结论戳），而不是一份「没有失败」的空清单被误判成 Ready。
if (!incomplete) process.stdout.write('__DSH_NATIVE_PROBE__' + JSON.stringify(failures) + '\n');
"#;

#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeTarget {
    platform: String,
    arch: String,
}

/// 单个原生模块的加载失败记录（由探测脚本以 JSON 输出）
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
struct NativeProbeFailure {
    /// `import`：sharp/koffi 可选依赖；`addon`：带 binding.gyp 的原生包
    #[serde(default)]
    kind: String,
    /// 包名（作用域包为 `@scope/name`）
    #[serde(default)]
    name: String,
    #[serde(default)]
    message: String,
    /// 是否为 Node ABI 不匹配（错误文本含 NODE_MODULE_VERSION）
    #[serde(default)]
    abi: bool,
}

impl NativeProbeFailure {
    fn is_platform_import(&self) -> bool {
        self.kind == "import"
    }
}

/// 原生模块探测结果
#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeProbe {
    /// 全部原生模块均可被当前运行时加载
    Ready,
    /// 探测完成，存在加载失败的模块
    Failed(Vec<NativeProbeFailure>),
    /// 探测无法得出结论（脚本崩溃/超时/输出不可解析）：不阻断启动，交由服务日志兜底
    Unknown(String),
}

impl NativeProbe {
    fn is_ready(&self) -> bool {
        matches!(self, Self::Ready)
    }

    fn failures(&self) -> &[NativeProbeFailure] {
        match self {
            Self::Failed(failures) => failures,
            _ => &[],
        }
    }

    fn has_abi_mismatch(&self) -> bool {
        self.failures().iter().any(|failure| failure.abi)
    }

    fn has_platform_import_failure(&self) -> bool {
        self.failures()
            .iter()
            .any(NativeProbeFailure::is_platform_import)
    }

    /// ABI 不匹配的包名（去重，保持探测顺序）
    fn abi_packages(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for failure in self.failures().iter().filter(|failure| failure.abi) {
            if !names.contains(&failure.name) {
                names.push(failure.name.clone());
            }
        }
        names
    }
}

/// 在启动预打包核心前修复其插件入口并验证原生依赖（含 Node ABI 兼容性）。
///
/// 该函数是幂等的：已有正确链接和可加载的原生模块不会触发写入或联网。原生包
/// 缺失时只按核心清单中的 optionalDependencies 动态构造安装参数，避免把某一台
/// 机器的版本、平台或架构写死在桌面端。失败返回诊断错误，调用方不应继续启动
/// 一个已知无法加载的 dsh 进程。
pub(crate) async fn prepare_active_runtime(app_handle: &AppHandle) -> Result<(), String> {
    if crate::service::core::active_source(app_handle) != CoreSource::App {
        log::debug!("Skipping core runtime repair for user-owned local core");
        return Ok(());
    }

    let core_root = crate::config::get_dsh_install_path(app_handle);
    let node = crate::config::get_node_binary_path(app_handle);
    if !core_root.is_dir() {
        return Err(format!(
            "CORE_RUNTIME_NOT_FOUND: bundled core directory is missing: {}",
            core_root.display()
        ));
    }
    if !node.is_file() {
        return Err(format!(
            "CORE_RUNTIME_NODE_NOT_FOUND: Node.js runtime is missing: {}",
            node.display()
        ));
    }

    link_required_plugins(app_handle, &core_root)?;

    // 档案里的核心包残留必须在 dsh 启动前清掉：Node 从 profile 目录向上查找裸包时
    // 会先命中它，核心自带的正确版本反而被跳过。清理失败不影响后续原生探测。
    if let Err(e) = prune_stale_core_packages(app_handle, &core_root) {
        log::warn!("{e}");
    }

    // 已核验过的运行时直接放行：跳过平台/架构探测与原生模块探测两个 node 子进程
    // （issue #766）。指纹失配、戳缺失或不可解析时一律走原探测路径；指纹本身不完整
    // （`None`）时既不比对也不落盘。
    let stamp_key = native_probe_stamp_key(app_handle, &node, &core_root);
    if let Some(key) = stamp_key.as_deref() {
        if let Some((stored, platform, arch)) = read_native_probe_stamp(app_handle) {
            if stored == key {
                log::debug!(
                    "Bundled core native dependencies are ready for {platform}:{arch} (cached)"
                );
                return Ok(());
            }
        }
    }

    let target = detect_node_target(&node, &core_root).await?;
    let mut probe = probe_native_modules(&node, &core_root).await;
    if probe.is_ready() {
        log::debug!(
            "Bundled core native dependencies are ready for {}:{}",
            target.platform,
            target.arch
        );
        if let Some(key) = stamp_key.as_deref() {
            write_native_probe_stamp(app_handle, key, &target);
        }
        return Ok(());
    }
    if let NativeProbe::Unknown(reason) = probe.clone() {
        // 探测脚本自身不可信（崩溃/超时/输出不可解析）时不能直接放行：先退回原有的
        // sharp/koffi 探测，仍失败则按平台包缺失处理，避免漏掉平台包修复。
        log::warn!("CORE_NATIVE_PROBE_UNKNOWN: {reason}");
        if native_imports_ready(&node, &core_root).await {
            return Ok(());
        }
        probe = NativeProbe::Failed(vec![NativeProbeFailure {
            kind: "import".into(),
            name: "sharp/koffi".into(),
            message: reason,
            abi: false,
        }]);
    }

    // 1) 平台可选依赖（sharp/koffi）缺失：沿用按核心清单安装目标平台包的修复路径。
    //    先做这一步：它只补平台/架构包、与运行时无关，补齐后再判断 ABI 才有意义。
    if probe.has_platform_import_failure() {
        let packages = native_package_plan(&core_root, &target);
        if packages.is_empty() {
            return Err(format!(
                "CORE_NATIVE_DEPENDENCY_UNRESOLVED: no optional package version matches {}:{} in {}",
                target.platform,
                target.arch,
                core_root.display()
            ));
        }
        log::warn!(
            "CORE_NATIVE_DEPENDENCY_REPAIR: importing sharp/koffi failed for {}:{}, installing {:?}",
            target.platform,
            target.arch,
            packages
        );
        install_native_packages(&core_root, &target, &packages).await?;
        let Some(next) = reprobe_after_repair(&node, &core_root).await else {
            return Ok(());
        };
        probe = next;
    }

    // 2) ABI 不匹配（issue #441）：本地 node 与核心原生模块的构建 ABI 不同。核心由
    //    pkg 在固定 Node 大版本下构建，捆绑运行时与之对齐，因此先验证捆绑运行时；
    //    探测通过则本进程内固定使用它（config::set_prefer_bundled_node_runtime）。
    if probe.has_abi_mismatch() && !is_bundled_runtime_node(&node, app_handle) {
        if let Some(bundled) = crate::config::bundled_node_binary(app_handle) {
            if probe_native_modules(&bundled, &core_root).await.is_ready() {
                log::warn!(
                    "CORE_NATIVE_ABI_MISMATCH: {:?} cannot load under {}; switching to the bundled Node.js runtime {}",
                    probe.abi_packages(),
                    node.display(),
                    bundled.display()
                );
                crate::config::set_prefer_bundled_node_runtime(true);
                return Ok(());
            }
        }
    }

    // 3) ABI 不匹配且捆绑运行时也救不了（核心由更高 ABI 的 Node 构建）：用所选运行时
    //    自带的 npm 重建这些包，装了 C++ 工具链的环境可以自愈。
    let abi_packages = probe.abi_packages();
    if !abi_packages.is_empty() {
        log::warn!(
            "CORE_NATIVE_ABI_MISMATCH: rebuilding {:?} for {} in {}",
            abi_packages,
            node.display(),
            core_root.display()
        );
        match rebuild_native_packages(&core_root, &node, &abi_packages).await {
            Ok(()) => {
                let Some(next) = reprobe_after_repair(&node, &core_root).await else {
                    log::info!(
                        "CORE_NATIVE_REBUILD: rebuilt {:?} for {}",
                        abi_packages,
                        node.display()
                    );
                    return Ok(());
                };
                probe = next;
            }
            Err(error) => log::warn!("CORE_NATIVE_REBUILD_FAILED: {error}"),
        }
    }

    // 4) 仍然无法加载：给出精确诊断（模块名 + ABI 差异），而不是让 dsh 在插件树加载
    //    阶段崩溃、前端只显示 HARNESS_NOT_OWNED。
    Err(native_failure_diagnostic(
        probe.failures(),
        &node,
        &core_root,
    ))
}

/// 清除档案里被旧版 dsh 投影进来、版本又与当前核心不一致的核心包。
///
/// 既有清理（上游 `removeLinkProjections` 与桌面端 `remove_legacy_profile_module_fallback`）
/// 都只认符号链接、且要求 `.dsh-module-fallback` 源目录仍然存在；用户「无视风险切换」
/// 升级核心时档案不重建，残留因此在 Node 的逐级查找里长期抢先命中，症状与病因脱钩。
fn prune_stale_core_packages(app_handle: &AppHandle, core_root: &Path) -> Result<(), String> {
    let profile = crate::service::plugin::profile_dir(app_handle);
    let Some(declared) = crate::service::plugin::declared_packages(app_handle) else {
        log::warn!(
            "CORE_PLUGIN_STALE_CORE_DECLARED_UNKNOWN: {} is unreadable, skipping cleanup",
            profile.display()
        );
        return Ok(());
    };
    prune_stale_core_entries(&profile, &core_root.join("node_modules"), &declared)
}

/// 逐个比对档案与锚点的同名核心包版本，清除版本错配且档案未声明的条目。
fn prune_stale_core_entries(
    profile_root: &Path,
    anchor_node_modules: &Path,
    declared: &HashSet<String>,
) -> Result<(), String> {
    let profile_node_modules = profile_root.join("node_modules");
    let scope = profile_node_modules.join(CORE_PACKAGE_SCOPE);
    let Some(scope_root) = containment_root(&scope, profile_root) else {
        return Ok(());
    };
    let entries = match std::fs::read_dir(&scope) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => {
            return Err(format!(
                "CORE_PLUGIN_STALE_CORE_SCAN_FAILED: {}: {e}",
                scope.display()
            ))
        }
    };

    for entry in entries {
        let entry = entry.map_err(|e| {
            format!(
                "CORE_PLUGIN_STALE_CORE_SCAN_FAILED: {}: {e}",
                scope.display()
            )
        })?;
        let name = format!(
            "{CORE_PACKAGE_SCOPE}/{}",
            entry.file_name().to_string_lossy()
        );
        if !is_safe_package_name(&name) || declared.contains(&name) {
            continue;
        }
        if !is_core_family_package(&name) {
            continue;
        }
        let path = entry.path();
        if !entry_is_contained(&path, &scope_root) {
            log::warn!(
                "CORE_PLUGIN_STALE_CORE_OUT_OF_SCOPE: {} escapes {}, skipping",
                path.display(),
                scope.display()
            );
            continue;
        }
        let Some(profile_version) = read_package_version(&path.join("package.json")) else {
            continue;
        };
        let Some(anchor_version) =
            read_package_version(&anchor_node_modules.join(&name).join("package.json"))
        else {
            continue;
        };
        if profile_version == anchor_version {
            continue;
        }
        if let Err(e) = remove_core_package_residue(&path) {
            log::warn!("{e}");
            continue;
        }
        log::info!(
            "CORE_PLUGIN_STALE_CORE_PRUNED: {name} {profile_version} (profile) != {anchor_version} (anchor), removed"
        );
    }
    Ok(())
}

/// 解析 scope 的真实位置，并确认它既不是重定向入口、也仍留在档案目录内。
///
/// 包含关系以**档案目录**（而非 `node_modules`）为锚点：`node_modules` 自身若被
/// 重定向成一个外部目录，以它为根就等于把「档案之外」当成了内部。返回 `None` 时
/// 整轮跳过扫描——顺着重定向递归删除会把删除目标落到档案之外，这比「这一轮没
/// 清干净」严重得多。
fn containment_root(scope: &Path, profile_root: &Path) -> Option<PathBuf> {
    let metadata = std::fs::symlink_metadata(scope).ok()?;
    let file_type = metadata.file_type();
    #[cfg(windows)]
    let is_link = file_type.is_symlink() || file_type.is_symlink_dir();
    #[cfg(not(windows))]
    let is_link = file_type.is_symlink();
    if is_link {
        log::warn!(
            "CORE_PLUGIN_STALE_CORE_SCOPE_REDIRECTED: {} is a link, skipping cleanup",
            scope.display()
        );
        return None;
    }

    let root = std::fs::canonicalize(profile_root).ok()?;
    let real = std::fs::canonicalize(scope).ok()?;
    if !real.starts_with(&root) {
        log::warn!(
            "CORE_PLUGIN_STALE_CORE_SCOPE_ESCAPED: {} resolves to {}, skipping cleanup",
            scope.display(),
            real.display()
        );
        return None;
    }
    Some(real)
}

/// 符号链接/junction 条目只需删除入口本身，不会触及目标；真实目录必须解析后仍在 scope 内。
fn entry_is_contained(path: &Path, scope_root: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    let file_type = metadata.file_type();
    #[cfg(windows)]
    if file_type.is_symlink() || file_type.is_symlink_dir() {
        return true;
    }
    #[cfg(not(windows))]
    if file_type.is_symlink() {
        return true;
    }
    match std::fs::canonicalize(path) {
        Ok(real) => real.starts_with(scope_root),
        Err(_) => false,
    }
}

fn remove_core_package_residue(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| {
        format!(
            "CORE_PLUGIN_STALE_CORE_REMOVE_FAILED: {}: {e}",
            path.display()
        )
    })?;
    let file_type = metadata.file_type();
    #[cfg(windows)]
    let is_link = file_type.is_symlink() || file_type.is_symlink_dir();
    #[cfg(not(windows))]
    let is_link = file_type.is_symlink();
    if is_link {
        return remove_link_only(path);
    }
    let result = if file_type.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| {
        format!(
            "CORE_PLUGIN_STALE_CORE_REMOVE_FAILED: {}: {e}",
            path.display()
        )
    })
}

/// 从活动 profile 与应用内置清单收集需要在核心根下解析的包，并逐个建立入口。
fn link_required_plugins(app_handle: &AppHandle, core_root: &Path) -> Result<(), String> {
    let core_node_modules = core_root.join("node_modules");
    std::fs::create_dir_all(&core_node_modules).map_err(|e| {
        format!(
            "CORE_PLUGIN_NODE_MODULES_CREATE_FAILED: {}: {e}",
            core_node_modules.display()
        )
    })?;

    let presets = crate::service::plugin::load_presets(app_handle);
    // 被核心吸收的内置插件（上限已被超越）不再链接到核心根：与启动退役、自愈的
    // 判定同源，避免为已卸载插件留下悬空入口。
    let core_version = crate::service::core::active_version(app_handle);
    let internal: Vec<_> = presets
        .iter()
        .filter(|preset| preset.internal && !preset.unsupported_on(core_version.as_deref()))
        .collect();
    let internal_ids: HashSet<String> = internal
        .iter()
        .map(|preset| crate::service::plugin::installed_name(preset).to_string())
        .collect();

    // 内置插件必须始终从当前安装包资源（debug 时为 workspace 源码）取源，不能信任
    // profile 中旧版本遗留的 link 路径。这样应用升级后旧 link 会被精确替换。
    for preset in internal {
        let name = crate::service::plugin::installed_name(preset);
        let Some(source) = crate::service::plugin::bundled_plugin_dir(app_handle, &preset.id)
        else {
            log::warn!(
                "CORE_PLUGIN_BUNDLE_MISSING: bundled source unavailable for {name}, skipping core link"
            );
            continue;
        };
        ensure_package_link(name, &source, &core_node_modules)?;
    }

    let profile = crate::service::plugin::profile_dir(app_handle);
    let manifest_path = profile.join("package.json");
    let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
        return Ok(());
    };
    let manifest = serde_json::from_str::<serde_json::Value>(&raw)
        .map_err(|e| format!("CORE_PLUGIN_PROFILE_MANIFEST_INVALID: {manifest_path:?}: {e}"))?;

    let mut names = HashSet::new();
    if let Some(dependencies) = manifest.get("dependencies").and_then(|v| v.as_object()) {
        names.extend(dependencies.keys().cloned());
    }
    if let Some(bundles) = manifest
        .get("dsh")
        .and_then(|v| v.get("profile"))
        .and_then(|v| v.get("bundles"))
        .and_then(|v| v.as_array())
    {
        names.extend(bundles.iter().filter_map(|v| v.as_str().map(str::to_owned)));
    }

    // Core 自有依赖（尤其 @deepseek-ai/*）由发行包自己提供，不能被 profile 中同名
    // 条目覆盖。internal 已按当前资源处理，剩余名字才从 profile 入口解析。
    for name in names {
        if internal_ids.contains(&name) || !is_safe_package_name(&name) {
            continue;
        }
        let source = profile.join("node_modules").join(&name);
        if !source.join("package.json").is_file() {
            if read_package_name(&core_node_modules.join(&name).join("package.json"))
                .ok()
                .flatten()
                .as_deref()
                == Some(name.as_str())
            {
                continue;
            }
            log::warn!(
                "CORE_PLUGIN_PROFILE_ENTRY_MISSING: {} is referenced by {}, source {} is unavailable",
                name,
                manifest_path.display(),
                source.display()
            );
            continue;
        }
        ensure_package_link(&name, &source, &core_node_modules)?;
    }
    Ok(())
}

/// 为 npm 包名建立目录链接；真实目录/文件从不覆盖，避免误删核心自有依赖。
fn ensure_package_link(name: &str, source: &Path, node_modules: &Path) -> Result<(), String> {
    if !is_safe_package_name(name) {
        return Err(format!("CORE_PLUGIN_NAME_INVALID: {name}"));
    }
    let source = source.canonicalize().map_err(|e| {
        format!(
            "CORE_PLUGIN_SOURCE_INVALID: {} ({name}): {e}",
            source.display()
        )
    })?;
    if !source.is_dir() || !source.join("package.json").is_file() {
        return Err(format!(
            "CORE_PLUGIN_SOURCE_INVALID: {name} is not a package directory: {}",
            source.display()
        ));
    }
    let package_name = read_package_name(&source.join("package.json"))?;
    if package_name.as_deref() != Some(name) {
        return Err(format!(
            "CORE_PLUGIN_SOURCE_NAME_MISMATCH: requested {name}, source declares {}",
            package_name.unwrap_or_else(|| "<missing>".to_string())
        ));
    }

    let destination = node_modules.join(name);
    let parent = destination
        .parent()
        .ok_or_else(|| format!("CORE_PLUGIN_DESTINATION_INVALID: {name}"))?;
    ensure_non_link_directory(parent, node_modules)?;

    let existing = match std::fs::symlink_metadata(&destination) {
        Ok(metadata) => Some(metadata),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            return Err(format!(
                "CORE_PLUGIN_DESTINATION_STAT_FAILED: {destination:?}: {e}"
            ))
        }
    };
    if let Some(metadata) = existing {
        if !metadata.file_type().is_symlink() {
            log::debug!(
                "CORE_PLUGIN_ENTRY_OCCUPIED: keeping core-owned entry {}",
                destination.display()
            );
            return Ok(());
        }
        let matches = std::fs::read_link(&destination)
            .ok()
            .map(|target| {
                let resolved = if target.is_absolute() {
                    target
                } else {
                    destination.parent().unwrap_or(Path::new(".")).join(target)
                };
                resolved.canonicalize().ok().as_deref() == Some(source.as_path())
            })
            .unwrap_or(false);
        if matches {
            return Ok(());
        }
        remove_link_only(&destination)?;
    }

    create_directory_link(&source, &destination).map_err(|e| {
        format!(
            "CORE_PLUGIN_LINK_FAILED: {} -> {}: {e}",
            source.display(),
            destination.display()
        )
    })?;
    log::info!(
        "CORE_PLUGIN_LINKED: {} -> {}",
        destination.display(),
        source.display()
    );
    Ok(())
}

/// 校验并创建 scope 目录；目录本身不能是链接，防止目的地逃逸核心根。
fn ensure_non_link_directory(path: &Path, root: &Path) -> Result<(), String> {
    if !path.starts_with(root) {
        return Err(format!(
            "CORE_PLUGIN_DESTINATION_ESCAPE: {}",
            path.display()
        ));
    }
    let relative = path.strip_prefix(root).unwrap_or(Path::new("."));
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "CORE_PLUGIN_DESTINATION_PARENT_LINK: {}",
                    current.display()
                ));
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "CORE_PLUGIN_DESTINATION_PARENT_INVALID: {}",
                    current.display()
                ))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|e| {
                    format!(
                        "CORE_PLUGIN_DESTINATION_PARENT_CREATE_FAILED: {}: {e}",
                        current.display()
                    )
                })?;
            }
            Err(e) => {
                return Err(format!(
                    "CORE_PLUGIN_DESTINATION_PARENT_STAT_FAILED: {}: {e}",
                    current.display()
                ))
            }
        }
    }
    Ok(())
}

fn remove_link_only(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    let result = std::fs::remove_dir(path).or_else(|_| std::fs::remove_file(path));
    #[cfg(not(windows))]
    let result = std::fs::remove_file(path);
    result.map_err(|e| format!("CORE_PLUGIN_LINK_REMOVE_FAILED: {}: {e}", path.display()))
}

#[cfg(unix)]
pub(crate) fn create_directory_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
}

#[cfg(windows)]
pub(crate) fn create_directory_link(source: &Path, destination: &Path) -> std::io::Result<()> {
    // 优先创建真正的符号链接：仅在启用 Developer Mode 或具备
    // SeCreateSymbolicLinkPrivilege（管理员）时才可用；普通用户（release 版
    // 默认非管理员启动）会得到 ERROR_PRIVILEGE_NOT_HELD（os error 1314），
    // 此时回退为目录联接（junction）。junction 是重解析点，创建不要求任何
    // 特权，与 pnpm `link:` 依赖在 Windows 上的实现一致。
    match std::os::windows::fs::symlink_dir(source, destination) {
        Ok(()) => Ok(()),
        Err(e) if is_privilege_error(&e) => {
            log::warn!(
                "CORE_PLUGIN_SYMLINK_FALLBACK: symlink_dir failed ({}), creating junction instead",
                e
            );
            create_directory_junction(source, destination)
        }
        // 非权限类失败（如路径无效、文件系统不支持符号链接）保留原始诊断，
        // 不把错误替换成 junction 的二次失败。
        Err(e) => Err(e),
    }
}

/// 判断符号链接创建失败是否源于权限不足：`ERROR_PRIVILEGE_NOT_HELD`（1314）
/// 与 `ERROR_ACCESS_DENIED`（5）。只有这类错误才值得回退 junction——其他失败
/// （路径无效、卷不支持重解析点等）回退同样会失败，且会掩盖原始原因。
#[cfg(windows)]
fn is_privilege_error(e: &std::io::Error) -> bool {
    matches!(e.raw_os_error(), Some(1314 | 5))
}

/// 用 `FSCTL_SET_REPARSE_POINT` 构造目录联接（junction），布局与 `mklink /J`
/// 完全一致：substitute name 使用 NT 命名空间绝对路径（`\??\` 前缀），print
/// name 为同一路径的 Win32 形式；两个名字的 `\0` 终止符通过名字之间的 gap
/// 与数据区末尾的 trailing 补零提供（length 字段本身不含 `\0`）。
#[cfg(windows)]
fn create_directory_junction(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_WRITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_REPARSE_POINT;
    use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_MOUNT_POINT;
    use windows_sys::Win32::System::IO::DeviceIoControl;

    // junction 目标必须是 NT 命名空间内的绝对路径：盘符路径映射为
    // `\??\G:\...`，UNC 路径映射为 `\??\UNC\server\share\...`。
    // dunce::simplified 去掉 canonicalize 产生的 verbatim（`\\?\`）前缀，
    // 避免双重前缀导致内核解析失败。
    let simplified = dunce::simplified(source);
    let print_name = simplified.to_string_lossy();
    let substitute_name = if print_name.starts_with("\\\\") {
        format!(r"\??\UNC\{}", print_name.trim_start_matches('\\'))
    } else {
        format!(r"\??\{}", print_name)
    };

    // 与 `mklink /J` 生成的挂载点完全一致的布局（实测比对 mklink 原始字节）：
    //   SubstituteNameLength / PrintNameLength 均不含结尾 `\0`；
    //   substitute 与 print 之间空出 2 字节作为 substitute 的 `\0` 终止符，
    //   数据区末尾再补 2 字节作为 print 的 `\0` 终止符；
    //   ReparseDataLength = 8（四个 u16 字段）+ 上述数据总长，传入
    //   DeviceIoControl 的缓冲区长度 = 16 + 数据总长。若 length 误含 `\0`，
    //   内核虽然接受（如 4392 之外的成功），但 `read_link` 会返回带 `\0` 的
    //   verbatim 路径，导致后续 canonicalize 报 InvalidFilename (123)。
    let substitute_wide: Vec<u16> = substitute_name.encode_utf16().collect();
    let print_wide: Vec<u16> = print_name.encode_utf16().collect();
    let substitute_bytes = substitute_wide.len() * 2;
    let print_bytes = print_wide.len() * 2;
    const REPARSE_GAP: usize = 2;
    const REPARSE_TRAILING: usize = 2;
    let data_length = 8 + substitute_bytes + REPARSE_GAP + print_bytes + REPARSE_TRAILING;
    let total = 16 + substitute_bytes + REPARSE_GAP + print_bytes + REPARSE_TRAILING;

    // REPARSE_DATA_BUFFER（MountPoint 变体）内存布局：
    //   0:  ReparseTag（u32）
    //   4:  ReparseDataLength（u16）
    //   6:  Reserved（u16）
    //   8:  SubstituteNameOffset（u16，相对 PathBuffer）
    //   10: SubstituteNameLength（u16，不含 \0）
    //   12: PrintNameOffset（u16，相对 PathBuffer）
    //   14: PrintNameLength（u16，不含 \0）
    //   16: PathBuffer[..]
    let mut buffer = vec![0u8; total];
    buffer[0..4].copy_from_slice(&IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer[4..6].copy_from_slice(&(data_length as u16).to_le_bytes());
    buffer[8..10].copy_from_slice(&0u16.to_le_bytes());
    buffer[10..12].copy_from_slice(&(substitute_bytes as u16).to_le_bytes());
    buffer[12..14].copy_from_slice(&((substitute_bytes + REPARSE_GAP) as u16).to_le_bytes());
    buffer[14..16].copy_from_slice(&(print_bytes as u16).to_le_bytes());
    // PathBuffer 依次写入 substitute、gap（substitute 的 `\0` 终止符）、
    // print；trailing 保持全零（print 的 `\0` 终止符）。
    let mut cursor = 16usize;
    for unit in substitute_wide.iter().copied() {
        buffer[cursor..cursor + 2].copy_from_slice(&unit.to_le_bytes());
        cursor += 2;
    }
    cursor += REPARSE_GAP;
    for unit in print_wide.iter().copied() {
        buffer[cursor..cursor + 2].copy_from_slice(&unit.to_le_bytes());
        cursor += 2;
    }

    // junction 的目标入口必须先存在：链接被移除后 destination 通常已不存在，
    // 这里按空目录创建，之后挂载重解析点。记录是否为本次创建，失败时只清理
    // 自己创建的目录，绝不删除已存在的真实目录。
    let created_dir = if !destination.is_dir() {
        std::fs::create_dir_all(destination)?;
        true
    } else {
        false
    };
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            destination_wide.as_ptr(),
            GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        // 打开失败同样要清掉刚创建的空目录（否则残留普通目录会被
        // ensure_package_link 误判为 core 自有条目而永久跳过链接）。
        if created_dir {
            let _ = std::fs::remove_dir(destination);
        }
        return Err(std::io::Error::last_os_error());
    }
    let mut bytes_returned: u32 = 0;
    let ok = unsafe {
        DeviceIoControl(
            handle,
            FSCTL_SET_REPARSE_POINT,
            buffer.as_ptr() as *const core::ffi::c_void,
            buffer.len() as u32,
            std::ptr::null_mut(),
            0,
            &mut bytes_returned,
            std::ptr::null_mut(),
        )
    };
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        // 挂载失败时清掉刚创建的空目录，避免留下会被误认为 core 自有条目的
        // 普通目录；目录原本就存在（未由本函数创建）时不做清理。
        if created_dir {
            let _ = std::fs::remove_dir(destination);
        }
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn is_safe_package_name(name: &str) -> bool {
    let parts: Vec<_> = name.split('/').collect();
    if parts.len() == 1 {
        return valid_package_component(parts[0]);
    }
    parts.len() == 2
        && parts[0].starts_with('@')
        && valid_package_component(parts[0])
        && valid_package_component(parts[1])
}

/// 是否属于核心家族（`@deepseek-ai/dsh` 或 `@deepseek-ai/dsh-*`）。
///
/// `dshmarket` 这类第三方插件虽在同一 scope 下，但既不是核心自带包也不是要清理的
/// 残留，必须排除；共享框架库（cordis、cosmokit、schemastery 等）同理由前缀天然排除。
fn is_core_family_package(name: &str) -> bool {
    let Some(package) = name
        .strip_prefix(CORE_PACKAGE_SCOPE)
        .and_then(|rest| rest.strip_prefix('/'))
    else {
        return false;
    };
    package == CORE_PACKAGE_PREFIX
        || package
            .strip_prefix(CORE_PACKAGE_PREFIX)
            .is_some_and(|suffix| suffix.starts_with('-'))
}

fn valid_package_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        // 单独的 `@` 不是合法 scope（`@scope` 中 scope 必须非空）。
        && value != "@"
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-@".contains(&byte))
}

fn read_package_name(path: &Path) -> Result<Option<String>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| {
        format!(
            "CORE_PLUGIN_PACKAGE_MANIFEST_READ_FAILED: {}: {e}",
            path.display()
        )
    })?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| {
        format!(
            "CORE_PLUGIN_PACKAGE_MANIFEST_INVALID: {}: {e}",
            path.display()
        )
    })?;
    Ok(value
        .get("name")
        .and_then(|value| value.as_str())
        .map(str::to_owned))
}

fn read_package_version(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    value
        .get("version")
        .and_then(|value| value.as_str())
        .map(str::to_owned)
}

/// 结论戳文件路径：放在依赖根下。清空依赖目录（等价于重新装配）会一并清掉它。
fn native_probe_stamp_path(app_handle: &AppHandle) -> PathBuf {
    crate::config::get_base_dir(app_handle).join(NATIVE_PROBE_STAMP_FILE)
}

/// 原生依赖探测的输入指纹：node 身份 + 核心目录与版本 + `node_modules` 前两层条目
/// （含原生包自带的产物目录）。
///
/// 全部是廉价的元数据读取（不启动子进程、不递归进包内部）。取「前两层」而不是只取
/// 顶层，是为了让 scope 包（`@scope/name`）的增删也能被感知；额外记录产物目录**与其
/// 内部文件**，是因为原地重写 `.node` 既不改包目录、也不改产物目录本身的时间。
///
/// 任何让指纹**不完整**的情况（目录读不到、条目数超过兜底上限）都返回 `None`：
/// 不完整的指纹可能刚好和上次的完整指纹撞上，反而跳过一次本该做的探测。宁可不缓存。
fn native_probe_stamp_key(app_handle: &AppHandle, node: &Path, core_root: &Path) -> Option<String> {
    use std::fmt::Write as _;

    let mut key = String::new();
    let _ = write!(key, "node={}", node.display());
    if let Ok(meta) = std::fs::metadata(node) {
        let _ = write!(key, ":{}", meta.len());
        let _ = write!(key, ":{}", file_modified_nanos(&meta));
    }
    let _ = write!(
        key,
        "\ncore={}\nversion={}",
        core_root.display(),
        crate::service::core::active_version(app_handle).unwrap_or_default()
    );

    let modules = probe_stamp_modules_digest(&core_root.join("node_modules"))?;
    let _ = write!(key, "\nmodules={modules}");
    Some(probe_stamp_digest(&key))
}

/// `node_modules` 指纹摘要：条目只受兜底上限约束（真实安装的规模远小于它），
/// 摘要长度与条目数无关，因此既不截断、也不因规模放弃缓存。
///
/// 上限在采集途中即时判定：越过上限的指纹注定作废，继续把整棵树读完只是白等 ——
/// 能触发这个上限的树动辄几十万条，而这段耗时正好压在启动关键路径上。
fn probe_stamp_modules_digest(modules: &Path) -> Option<String> {
    let mut entries: Vec<String> = Vec::new();
    collect_probe_stamp_entries(modules, &mut entries, NATIVE_PROBE_STAMP_MAX_ENTRIES)?;
    entries.sort_unstable();
    Some(probe_stamp_digest(&entries.join("\n")))
}

/// 指纹摘要：长度固定，与参与计算的条目数无关
fn probe_stamp_digest(key: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(key.as_bytes()))
}

/// 原生包自带的产物目录，与 `NATIVE_PROBE_SCRIPT` 的候选判定同源
const NATIVE_ARTIFACT_DIRS: [&str; 4] = ["build/Release", "build/Debug", "prebuilds", "prebuilt"];

/// 采集指纹条目：`node_modules` 顶层（`.bin` 跳过，`.pnpm` 只记自身）与 scope 目录的
/// 下一层，每项再带上其原生包产物目录。任一目录读不到即返回 `None` —— 不完整的指纹
/// 不能用来断言「和上次一样」，少记一项就可能漏掉一次真实变化。
///
/// 条目数一旦越过 `cap` 立刻返回 `None`，不再继续遍历：这份指纹无论如何都会作废，
/// 把剩下几十万条读完只是把启动关键路径拉长。
fn collect_probe_stamp_entries(dir: &Path, out: &mut Vec<String>, cap: usize) -> Option<()> {
    let reader = std::fs::read_dir(dir).ok()?;
    for entry in reader {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == ".bin" {
            continue;
        }
        push_probe_stamp_entry(&entry.path(), name, out, cap)?;
        if !name.starts_with('@') {
            continue;
        }
        let scope = std::fs::read_dir(entry.path()).ok()?;
        for inner in scope {
            let inner = inner.ok()?;
            let inner_name = inner.file_name();
            let Some(inner_name) = inner_name.to_str() else {
                continue;
            };
            push_probe_stamp_entry(&inner.path(), &format!("{name}/{inner_name}"), out, cap)?;
        }
    }
    Some(())
}

/// 记录一个包的目录时间与其产物目录、目录内文件的时间。产物目录不存在时只留包目录
/// 一项，避免为绝大多数非原生包平白拉长指纹。
fn push_probe_stamp_entry(
    dir: &Path,
    label: &str,
    out: &mut Vec<String>,
    cap: usize,
) -> Option<()> {
    push_probe_stamp_item(out, format!("{label}={}", path_modified_nanos(dir)), cap)?;
    for relative in NATIVE_ARTIFACT_DIRS {
        let artifact = dir.join(relative);
        if !artifact.is_dir() {
            continue;
        }
        push_probe_stamp_item(
            out,
            format!("{label}/{relative}={}", path_modified_nanos(&artifact)),
            cap,
        )?;
        push_probe_stamp_artifacts(&artifact, &format!("{label}/{relative}"), out, cap)?;
    }
    Some(())
}

/// 记入一项指纹条目；越过 `cap` 即放弃整份指纹。
///
/// 只有第一处越界会写日志（调用链随即逐层返回 `None`），因此一次采集最多一条。
fn push_probe_stamp_item(out: &mut Vec<String>, item: String, cap: usize) -> Option<()> {
    out.push(item);
    if out.len() > cap {
        log::warn!("core native probe stamp skipped: more than {cap} entries");
        return None;
    }
    Some(())
}

/// 记录产物目录内每一项的名字、大小与修改时间，并递归下钻嵌套产物目录：原地覆盖一个
/// 已存在的 `.node` 只改文件自身的时间，目录的修改时间不变，只记目录就会漏掉这次替换，
/// 进而跳过一次本该做的探测；`prebuilds/<platform>/addon.node` 这类文件连第一层都不在，
/// 只记一层同样会漏。元数据读不到即返回 `None`：读不到就不能断言「和上次一样」，宁可
/// 重跑探测。指向目录的链接同样返回 `None`：`artifact_stamp` 跟随链接、只记下目标的目录
/// 元数据，而链接本身不被下钻（防成环），目标里的 `.node` 被等长原地覆盖时目录元数据
/// 可以不变，这份指纹就不再完整。
fn push_probe_stamp_artifacts(
    dir: &Path,
    label: &str,
    out: &mut Vec<String>,
    cap: usize,
) -> Option<()> {
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let path = entry.path();
        let label = format!("{label}/{name}");
        // 链接判定必须和本文件其余四处一致：Windows 上 junction 是 mount point 重解析点，
        // 标准库的 `is_symlink()` 对它返回 false（实测本机 junction 会被当成普通目录），
        // 只有 `is_symlink_dir()` 认得。用 `DirEntry::file_type()` 同样漏 junction。
        let file_type = std::fs::symlink_metadata(&path).ok()?.file_type();
        #[cfg(windows)]
        let is_link = file_type.is_symlink() || file_type.is_symlink_dir();
        #[cfg(not(windows))]
        let is_link = file_type.is_symlink();
        if is_link && path.is_dir() {
            return None;
        }
        push_probe_stamp_item(out, format!("{label}={}", artifact_stamp(&path)?), cap)?;
        // 链接（pnpm 的包目录、junction）不下钻：跟随链接会把同一份内容记两次，
        // 自指的链接还会绕成死循环。链接自身的目标大小与时间已经记在上面一项里。
        if !is_link && file_type.is_dir() {
            push_probe_stamp_artifacts(&path, &label, out, cap)?;
        }
    }
    Some(())
}

/// 单个产物文件的指纹项：大小与修改时间缺一不可，读不到就没有可比的指纹。
fn artifact_stamp(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    Some(format!("{}:{}", meta.len(), file_modified_nanos(&meta)))
}

fn path_modified_nanos(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => file_modified_nanos(&meta),
        Err(_) => "-".to_string(),
    }
}

fn file_modified_nanos(meta: &std::fs::Metadata) -> String {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_nanos().to_string())
        .unwrap_or_else(|| "-".to_string())
}

/// 读取结论戳；文件缺失、不可解析或字段不全时返回 None（视为无戳）
fn read_native_probe_stamp(app_handle: &AppHandle) -> Option<(String, String, String)> {
    let raw = std::fs::read_to_string(native_probe_stamp_path(app_handle)).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    Some((
        value.get("key")?.as_str()?.to_string(),
        value.get("platform")?.as_str()?.to_string(),
        value.get("arch")?.as_str()?.to_string(),
    ))
}

/// 写结论戳：只在探测确认 Ready 后调用。写失败不影响启动，只降级为「下次仍探测」。
fn write_native_probe_stamp(app_handle: &AppHandle, key: &str, target: &NodeTarget) {
    let path = native_probe_stamp_path(app_handle);
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::debug!(
                "CORE_NATIVE_PROBE_STAMP_WRITE_FAILED: {}: {error}",
                parent.display()
            );
            return;
        }
    }
    let value = serde_json::json!({
        "key": key,
        "platform": &target.platform,
        "arch": &target.arch,
    });
    if let Err(error) = std::fs::write(&path, value.to_string()) {
        log::debug!(
            "CORE_NATIVE_PROBE_STAMP_WRITE_FAILED: {}: {error}",
            path.display()
        );
    }
}

async fn detect_node_target(node: &Path, core_root: &Path) -> Result<NodeTarget, String> {
    let node = node.to_path_buf();
    let core_root = core_root.to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        run_command(
            &node,
            &[
                "--input-type=module".into(),
                "-e".into(),
                NODE_PROBE_SCRIPT.into(),
            ],
            &core_root,
        )
    })
    .await
    .map_err(|e| format!("CORE_NODE_PLATFORM_PROBE_FAILED: {e}"))??;
    if !output.status.success() {
        return Err(format!(
            "CORE_NODE_PLATFORM_PROBE_FAILED: {}",
            command_output_tail(&output)
        ));
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let Some((platform, arch)) = value.split_once(':') else {
        return Err(format!("CORE_NODE_PLATFORM_UNSUPPORTED: {value}"));
    };
    let supported_platform = matches!(platform, "darwin" | "linux" | "win32");
    let supported_arch = matches!(
        arch,
        "x64" | "arm64" | "ia32" | "arm" | "ppc64" | "riscv64" | "s390x" | "loong64"
    );
    if !supported_platform || !supported_arch {
        return Err(format!("CORE_NODE_PLATFORM_UNSUPPORTED: {value}"));
    }
    Ok(NodeTarget {
        platform: platform.to_string(),
        arch: arch.to_string(),
    })
}

/// 用指定运行时执行原生模块探测脚本，返回结构化结论。
async fn probe_native_modules(node: &Path, core_root: &Path) -> NativeProbe {
    let node = node.to_path_buf();
    let core_root = core_root.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        let program = node.as_os_str().to_os_string();
        let args = vec![
            OsString::from("--input-type=module"),
            OsString::from("-e"),
            OsString::from(NATIVE_PROBE_SCRIPT),
        ];
        run_process_with_timeout(
            &program,
            &args,
            &core_root,
            NATIVE_PROBE_TIMEOUT,
            "native probe",
        )
    })
    .await;

    match result {
        Ok(Ok(output)) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            match parse_native_probe_failures(&stdout) {
                Some(failures) if failures.is_empty() => NativeProbe::Ready,
                Some(failures) => NativeProbe::Failed(failures),
                None => NativeProbe::Unknown(format!(
                    "probe output is not parseable: {}",
                    command_output_tail(&output)
                )),
            }
        }
        Ok(Ok(output)) => NativeProbe::Unknown(format!(
            "probe exited with {}: {}",
            output.status,
            command_output_tail(&output)
        )),
        Ok(Err(error)) => NativeProbe::Unknown(error),
        Err(error) => NativeProbe::Unknown(error.to_string()),
    }
}

/// 修复后的重新探测：Ready 或结论未知都放行（未知只告警，不因探测自身的问题阻断
/// 启动）。返回 Some 表示仍有明确的加载失败，需要继续处理。
async fn reprobe_after_repair(node: &Path, core_root: &Path) -> Option<NativeProbe> {
    match probe_native_modules(node, core_root).await {
        NativeProbe::Ready => None,
        NativeProbe::Unknown(reason) => {
            log::warn!("CORE_NATIVE_PROBE_UNKNOWN: {reason}");
            None
        }
        probe @ NativeProbe::Failed(_) => Some(probe),
    }
}

/// 旧版平台依赖探测（sharp/koffi 动态 import）：仅用于探测脚本结论不可信时兜底
async fn native_imports_ready(node: &Path, core_root: &Path) -> bool {
    let node = node.to_path_buf();
    let core_root = core_root.to_path_buf();
    tokio::task::spawn_blocking(move || {
        run_command(
            &node,
            &[
                "--input-type=module".into(),
                "-e".into(),
                NATIVE_IMPORT_SCRIPT.into(),
            ],
            &core_root,
        )
        .is_ok_and(|output| output.status.success())
    })
    .await
    .unwrap_or(false)
}

/// 解析探测脚本的标记行；缺失或不可解析时返回 None（视为结论未知）
fn parse_native_probe_failures(stdout: &str) -> Option<Vec<NativeProbeFailure>> {
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with(NATIVE_PROBE_MARKER))?;
    let json = line.trim_start_matches(NATIVE_PROBE_MARKER).trim();
    serde_json::from_str::<Vec<NativeProbeFailure>>(json).ok()
}

/// 当前 node 是否就是捆绑运行时（用于避免重复尝试同一个运行时）
fn is_bundled_runtime_node(node: &Path, app_handle: &AppHandle) -> bool {
    crate::config::bundled_node_binary(app_handle).is_some_and(|bundled| {
        bundled == node
            || bundled
                .to_string_lossy()
                .eq_ignore_ascii_case(&node.to_string_lossy())
    })
}

/// 生成原生模块加载失败的诊断信息：ABI 不匹配单独给出可读结论，其余按原样列出。
fn native_failure_diagnostic(
    failures: &[NativeProbeFailure],
    node: &Path,
    core_root: &Path,
) -> String {
    if failures.is_empty() {
        return format!(
            "CORE_NATIVE_DEPENDENCY_REPAIR_FAILED: native modules could not be verified in {}",
            core_root.display()
        );
    }
    let abi_failures: Vec<&NativeProbeFailure> =
        failures.iter().filter(|failure| failure.abi).collect();
    if !abi_failures.is_empty() {
        let names = abi_failures
            .iter()
            .map(|failure| failure.name.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        let version = crate::config::get_node_version_of_path(node)
            .unwrap_or_else(|| node.display().to_string());
        return format!(
            "CORE_NATIVE_ABI_MISMATCH: {names} cannot load under Node.js {version}: {detail} The Harness core's native modules were built for a different Node.js ABI; install the Node.js version the core was built with, or reinstall/upgrade the Harness core so it matches the bundled Node.js runtime. (core: {core})",
            names = names,
            version = version,
            detail = collapse_whitespace(&abi_failures[0].message),
            core = core_root.display()
        );
    }
    format!(
        "CORE_NATIVE_DEPENDENCY_REPAIR_FAILED: native modules still cannot load in {}: {}",
        core_root.display(),
        failures
            .iter()
            .map(|failure| format!(
                "{}: {}",
                failure.name,
                collapse_whitespace(&failure.message)
            ))
            .collect::<Vec<_>>()
            .join("; ")
    )
}

/// 折叠多行错误文本为单行，便于在界面提示里展示（Node 的 ABI 报错是跨行的）
fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 用所选运行时自带的 npm 重建 ABI 不匹配的原生包。
///
/// 必须用与运行时配套的 npm：PATH 里的 npm 可能属于另一个 Node 大版本，用它编译
/// 只会得到另一个不匹配的 ABI。捆绑运行时目录自带 npm-cli.js，优先直接以该 node
/// 运行；找不到时退回 PATH 中的 npm（本地 node 安装通常自带）。
async fn rebuild_native_packages(
    core_root: &Path,
    node: &Path,
    packages: &[String],
) -> Result<(), String> {
    let core_root = core_root.to_path_buf();
    let node = node.to_path_buf();
    let packages = packages.to_vec();
    let result = tokio::task::spawn_blocking(move || {
        let (program, mut args) = npm_command(&node);
        args.push(OsString::from("rebuild"));
        args.extend(packages.into_iter().map(OsString::from));
        run_process_with_timeout(
            &program,
            &args,
            &core_root,
            NATIVE_REBUILD_TIMEOUT,
            "npm rebuild",
        )
    })
    .await
    .map_err(|e| format!("CORE_NATIVE_REBUILD_FAILED: {e}"))??;
    if !result.status.success() {
        return Err(format!(
            "CORE_NATIVE_REBUILD_FAILED: npm rebuild exited with {}: {}",
            result.status,
            command_output_tail(&result)
        ));
    }
    Ok(())
}

/// 定位与给定 node 配套的 npm 命令：优先 `<node 目录>/node_modules/npm/bin/npm-cli.js`
/// （捆绑运行时与官方发行版都在 node 目录下自带 npm），否则退回 PATH 中的 npm。
fn npm_command(node: &Path) -> (OsString, Vec<OsString>) {
    if let Some(cli) = npm_cli_path_for(node) {
        return (node.as_os_str().to_os_string(), vec![cli.into_os_string()]);
    }
    let program = if cfg!(windows) {
        OsString::from("npm.cmd")
    } else {
        OsString::from("npm")
    };
    (program, Vec::new())
}

fn npm_cli_path_for(node: &Path) -> Option<PathBuf> {
    let dir = node.parent()?;
    // Windows 捆绑运行时：<runtime>/node.exe + <runtime>/node_modules/npm/bin/npm-cli.js
    // 官方发行版：<node>/bin/node + <node>/lib/node_modules/npm/bin/npm-cli.js
    // 少数布局把 lib 放在 node 目录之外，再补一个上级 lib 候选。
    let candidates = [
        dir.join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
        dir.join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
        dir.join("..")
            .join("lib")
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js"),
    ];
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// 决定需要补齐的原生依赖安装参数。
///
/// 优先从已安装的根包 `sharp`/`koffi` 的 `optionalDependencies` 取目标平台包的
/// 精确版本并显式安装（轻量、不改核心依赖声明）。任一根包缺失时退化为安装根包
/// 名（不带版本），由 npm 以核心 `package.json` + lockfile 解析正确版本 —— 这样
/// 即使整个核心闭包被删也能恢复，且不硬编码版本号。
fn native_package_plan(core_root: &Path, target: &NodeTarget) -> Vec<String> {
    let node_modules = core_root.join("node_modules");
    let sharp = node_modules.join("sharp");
    let koffi = node_modules.join("koffi");
    let sharp_optional = read_optional_dependencies(&sharp.join("package.json"));
    let koffi_optional = read_optional_dependencies(&koffi.join("package.json"));

    let mut packages = Vec::new();
    let sharp_runtime = format!("@img/sharp-{}-{}", target.platform, target.arch);
    let sharp_libvips = format!("@img/sharp-libvips-{}-{}", target.platform, target.arch);
    let koffi_runtime = format!("@koromix/koffi-{}-{}", target.platform, target.arch);

    for (name, optional) in [
        (sharp_runtime.as_str(), &sharp_optional),
        (sharp_libvips.as_str(), &sharp_optional),
        (koffi_runtime.as_str(), &koffi_optional),
    ] {
        if let Some(version) = optional.get(name) {
            packages.push(format!("{name}@{version}"));
        }
    }
    // 根包本身缺失（核心闭包被删/损坏）时无法从清单取版本，退化为安装根包名，
    // 由 npm 以核心 package.json + lockfile 解析正确版本（不硬编码版本号）。
    if !sharp.is_dir() && !packages.iter().any(|p| p == "sharp") {
        packages.push("sharp".to_string());
    }
    if !koffi.is_dir() && !packages.iter().any(|p| p == "koffi") {
        packages.push("koffi".to_string());
    }
    packages
}

/// 读取 optionalDependencies；清单缺失/损坏时返回空（由调用方决定回退策略）。
fn read_optional_dependencies(path: &Path) -> HashMap<String, String> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return HashMap::new();
    };
    value
        .get("optionalDependencies")
        .and_then(|value| value.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(name, value)| {
                    value
                        .as_str()
                        .map(|version| (name.clone(), version.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn install_native_packages(
    core_root: &Path,
    target: &NodeTarget,
    packages: &[String],
) -> Result<(), String> {
    let core_root = core_root.to_path_buf();
    let target = target.clone();
    let packages = packages.to_vec();
    let result = tokio::task::spawn_blocking(move || {
        let program = if cfg!(windows) {
            OsString::from("npm.cmd")
        } else {
            OsString::from("npm")
        };
        let mut args = vec![
            OsString::from("install"),
            OsString::from("--no-save"),
            OsString::from("--package-lock=false"),
            OsString::from("--include=optional"),
            OsString::from(format!("--os={}", target.platform)),
            OsString::from(format!("--cpu={}", target.arch)),
        ];
        args.extend(packages.into_iter().map(OsString::from));
        run_process_with_timeout(
            &program,
            &args,
            &core_root,
            NATIVE_REPAIR_TIMEOUT,
            "npm install",
        )
    })
    .await
    .map_err(|e| format!("CORE_NATIVE_DEPENDENCY_REPAIR_FAILED: {e}"))??;
    if !result.status.success() {
        return Err(format!(
            "CORE_NATIVE_DEPENDENCY_REPAIR_FAILED: npm exited with {}: {}",
            result.status,
            command_output_tail(&result)
        ));
    }
    Ok(())
}

fn run_command(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .output()
        .map_err(|e| format!("CORE_RUNTIME_COMMAND_FAILED: {}: {e}", program.display()))
}

fn run_process_with_timeout(
    program: &OsString,
    args: &[OsString],
    cwd: &Path,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("CORE_NATIVE_DEPENDENCY_REPAIR_SPAWN_FAILED: {e}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::BufReader::new(stdout).read_to_end(&mut bytes);
        bytes
    });
    let stderr_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = std::io::BufReader::new(stderr).read_to_end(&mut bytes);
        bytes
    });
    let started = Instant::now();
    loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("CORE_NATIVE_DEPENDENCY_REPAIR_WAIT_FAILED: {e}"))?
        {
            let stdout = stdout_thread.join().unwrap_or_default();
            let stderr = stderr_thread.join().unwrap_or_default();
            return Ok(std::process::Output {
                status,
                stdout,
                stderr,
            });
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let status = child
                .wait()
                .map_err(|e| format!("CORE_NATIVE_DEPENDENCY_REPAIR_KILL_FAILED: {e}"))?;
            // 排空管道，避免子进程因写满缓冲而挂起；输出在超时路径不作分析。
            let _ = stdout_thread.join().unwrap_or_default();
            let _ = stderr_thread.join().unwrap_or_default();
            return Err(format!(
                "CORE_NATIVE_DEPENDENCY_REPAIR_TIMEOUT: {label} exceeded {} seconds (exit {status})",
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn command_output_tail(output: &std::process::Output) -> String {
    let mut value = String::from_utf8_lossy(&output.stderr).to_string();
    if value.trim().is_empty() {
        value = String::from_utf8_lossy(&output.stdout).to_string();
    }
    value
        .trim()
        .chars()
        .rev()
        .take(2000)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 指纹摘要必须与条目规模无关：真实安装的条目数已超过早先的固定上限，
    /// 若还按条目数放弃缓存，结论戳永远写不下来（每次启动都重跑两个 node 子进程）。
    #[test]
    fn probe_stamp_digest_is_stable_and_size_independent() {
        let modules = std::env::temp_dir().join(format!("dsh-probe-stamp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&modules);
        std::fs::create_dir_all(modules.join(".bin")).unwrap();
        std::fs::create_dir_all(modules.join("@deepseek-ai/dsh-plugin")).unwrap();
        std::fs::create_dir_all(modules.join("sharp/build/Release")).unwrap();
        std::fs::write(modules.join(".bin/dsh"), "shim").unwrap();

        let entries = probe_stamp_entries(&modules);
        assert!(entries.iter().any(|entry| entry.starts_with("sharp=")));
        assert!(entries
            .iter()
            .any(|entry| entry.starts_with("sharp/build/Release=")));
        assert!(entries
            .iter()
            .any(|entry| entry.starts_with("@deepseek-ai/dsh-plugin=")));
        assert!(!entries.iter().any(|entry| entry.starts_with(".bin")));

        let digest = probe_stamp_modules_digest(&modules).expect("complete fingerprint");
        assert!(digest.starts_with("sha256:"));
        assert_eq!(digest.len(), "sha256:".len() + 64);
        assert_eq!(digest, probe_stamp_modules_digest(&modules).unwrap());

        std::fs::write(modules.join(".bin/dsh"), "another shim").unwrap();
        assert_eq!(digest, probe_stamp_modules_digest(&modules).unwrap());

        std::fs::create_dir_all(modules.join("plain")).unwrap();
        let with_plain = probe_stamp_modules_digest(&modules).unwrap();
        assert_ne!(digest, with_plain);

        std::fs::write(modules.join("sharp/build/Release/sharp.node"), "native").unwrap();
        assert_ne!(with_plain, probe_stamp_modules_digest(&modules).unwrap());

        std::fs::remove_dir_all(&modules).unwrap();
        assert!(probe_stamp_modules_digest(&modules).is_none());
    }

    /// 原地覆盖产物目录里已存在的 `.node` 必须改变指纹：目录的修改时间不变，只有文件
    /// 自身的时间会变（fixture 用等长的两份内容，只有时间戳能让摘要不同）。条目数超过
    /// 早先的 512 上限时同样如此 —— 那段规模正是这次改动才开始能缓存的。
    #[test]
    fn probe_stamp_detects_in_place_addon_overwrite_beyond_legacy_cap() {
        let modules = std::env::temp_dir().join(format!(
            "dsh-probe-stamp-overwrite-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&modules);
        let release = modules.join("sharp/build/Release");
        std::fs::create_dir_all(&release).unwrap();
        let addon = release.join("sharp.node");
        std::fs::write(&addon, "native-a").unwrap();
        for index in 0..520 {
            std::fs::create_dir_all(modules.join(format!("plain-{index}"))).unwrap();
        }

        let entries = probe_stamp_entries(&modules);
        assert!(
            entries.len() > 512,
            "fixture must exceed the legacy entry cap"
        );
        assert!(entries
            .iter()
            .any(|entry| entry.starts_with("sharp/build/Release/sharp.node=8:")));

        let digest = probe_stamp_modules_digest(&modules).expect("complete fingerprint");
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&addon, "native-b").unwrap();
        assert_ne!(digest, probe_stamp_modules_digest(&modules).unwrap());

        std::fs::remove_dir_all(&modules).unwrap();
    }

    /// 产物文件元数据读不到时必须让整份指纹作废（返回 `None`）：写占位符会让「这次
    /// 读不到」与「上次也没读到」得到同一个摘要，从而跳过一次本该做的探测。
    #[test]
    fn probe_stamp_requires_readable_artifact_metadata() {
        let dir = std::env::temp_dir().join(format!(
            "dsh-probe-stamp-artifact-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let addon = dir.join("sharp.node");

        assert!(artifact_stamp(&addon).is_none());
        std::fs::write(&addon, "native").unwrap();
        assert!(artifact_stamp(&addon).is_some());
        assert!(push_probe_stamp_artifacts(
            &dir,
            "sharp/build/Release",
            &mut Vec::new(),
            NATIVE_PROBE_STAMP_MAX_ENTRIES
        )
        .is_some());

        std::fs::remove_dir_all(&dir).unwrap();
        assert!(artifact_stamp(&addon).is_none());
        assert!(push_probe_stamp_artifacts(
            &dir,
            "sharp/build/Release",
            &mut Vec::new(),
            NATIVE_PROBE_STAMP_MAX_ENTRIES
        )
        .is_none());
    }

    /// 嵌套产物目录（`prebuilds/<platform>/addon.node`）里的原地覆盖同样必须改变指纹：
    /// 这个文件既不在产物目录的第一层、也不会改到任何已记录目录的时间，只记一层的实现
    /// 会漏掉它并跳过探测。
    #[test]
    fn probe_stamp_detects_in_place_overwrite_below_nested_artifact_directory() {
        let modules = std::env::temp_dir().join(format!(
            "dsh-probe-stamp-nested-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&modules);
        let nested = modules.join("sharp/prebuilds/win32-x64");
        std::fs::create_dir_all(&nested).unwrap();
        let addon = nested.join("addon.node");
        std::fs::write(&addon, "native-a").unwrap();

        let entries = probe_stamp_entries(&modules);
        assert!(entries
            .iter()
            .any(|entry| entry.starts_with("sharp/prebuilds=")));
        assert!(entries
            .iter()
            .any(|entry| entry.starts_with("sharp/prebuilds/win32-x64=")));
        assert!(entries
            .iter()
            .any(|entry| entry.starts_with("sharp/prebuilds/win32-x64/addon.node=8:")));

        let digest = probe_stamp_modules_digest(&modules).expect("complete fingerprint");
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&addon, "native-b").unwrap();
        assert_ne!(digest, probe_stamp_modules_digest(&modules).unwrap());

        std::fs::remove_dir_all(&modules).unwrap();
    }

    /// 越过条目上限时必须就地放弃，而不是把整棵树读完再作废：能触发上限的树动辄几十万
    /// 条，读完这一段只是白等（这份指纹注定作废）。断言采集恰好在越界处停手。
    #[test]
    fn probe_stamp_cap_aborts_traversal_immediately() {
        let dir = std::env::temp_dir().join(format!("dsh-probe-stamp-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..100 {
            std::fs::create_dir_all(dir.join(format!("pkg-{index}"))).unwrap();
        }

        let mut capped = Vec::new();
        assert!(collect_probe_stamp_entries(&dir, &mut capped, 4).is_none());
        assert_eq!(
            capped.len(),
            5,
            "traversal must stop right after crossing the cap"
        );

        let mut full = Vec::new();
        assert!(collect_probe_stamp_entries(&dir, &mut full, NATIVE_PROBE_STAMP_MAX_ENTRIES).is_some());
        assert_eq!(full.len(), 100);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// 指向目录的链接必须让整份指纹作废：链接不被下钻（防成环），而 `artifact_stamp`
    /// 跟随链接只记目标目录元数据，目标里的 `.node` 被等长原地覆盖时这份指纹会漏掉变化。
    ///
    /// 用仓库自带的 junction 构造器建链接：Windows 上 `symlink_dir` 需要开发者模式
    /// （实测本机被拒），junction 不需要特权，且同样以 reparse point 形态出现
    /// （`FileType::is_symlink()` 为真），正是这里要覆盖的形态。
    #[test]
    fn probe_stamp_rejects_a_directory_symlink_it_cannot_descend() {
        let root = std::env::temp_dir().join(format!("dsh-probe-stamp-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("pkg/prebuilds/real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("addon.node"), "native").unwrap();
        let linked = root.join("pkg/prebuilds/win32-x64");
        let canonical_real = real.canonicalize().unwrap();
        create_directory_link(&canonical_real, &linked)
            .unwrap_or_else(|e| panic!("link must be created without privileges: {e}"));
        assert!(
            std::fs::symlink_metadata(&linked)
                .unwrap()
                .file_type()
                .is_symlink(),
            "the link must be treated as a link"
        );
        let mut out = Vec::new();
        let rejected = push_probe_stamp_artifacts(
            &root.join("pkg/prebuilds"),
            "pkg/prebuilds",
            &mut out,
            NATIVE_PROBE_STAMP_MAX_ENTRIES
        )
        .is_none();
        // 先断开链接再删树：`remove_dir_all` 会跟随 junction 去删目标（这里恰好是同一棵树，
        // 于是删除中途树已被抽空而报错，并把 junction 留在原地污染下一次运行）。
        let _ = std::fs::remove_dir(&linked);
        let _ = std::fs::remove_dir_all(&root);
        assert!(rejected);
    }


    fn probe_stamp_entries(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        collect_probe_stamp_entries(dir, &mut out, NATIVE_PROBE_STAMP_MAX_ENTRIES).unwrap();
        out.sort_unstable();
        out
    }

    /// 指纹长度不随条目数增长：条目多寡只影响摘要输入，不影响落盘体积。
    #[test]
    fn probe_stamp_digest_length_does_not_grow_with_entries() {
        let wide = (0..4000)
            .map(|index| format!("pkg-{index}=1"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(probe_stamp_digest(&wide).len(), "sha256:".len() + 64);
        assert_ne!(probe_stamp_digest(&wide), probe_stamp_digest("pkg-0=1"));
    }

    #[test]
    fn package_names_allow_plain_and_scoped_names_only() {
        assert!(is_safe_package_name("dshmarket"));
        assert!(is_safe_package_name("@scope/plugin-name"));
        assert!(!is_safe_package_name("../escape"));
        assert!(!is_safe_package_name("@scope/../escape"));
        assert!(!is_safe_package_name("C:\\escape"));
        assert!(!is_safe_package_name("/absolute"));
        assert!(!is_safe_package_name("@/missing"));
    }

    #[test]
    fn native_plan_uses_manifest_versions_not_constants() {
        let root = std::env::temp_dir().join(format!("dsh-native-plan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules/sharp")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/koffi")).unwrap();
        std::fs::write(
            root.join("node_modules/sharp/package.json"),
            r#"{"optionalDependencies":{"@img/sharp-darwin-arm64":"0.9.0","@img/sharp-libvips-darwin-arm64":"1.2.0"}}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("node_modules/koffi/package.json"),
            r#"{"optionalDependencies":{"@koromix/koffi-darwin-arm64":"8.7.0"}}"#,
        )
        .unwrap();
        let plan = native_package_plan(
            &root,
            &NodeTarget {
                platform: "darwin".into(),
                arch: "arm64".into(),
            },
        );
        assert_eq!(
            plan,
            vec![
                "@img/sharp-darwin-arm64@0.9.0",
                "@img/sharp-libvips-darwin-arm64@1.2.0",
                "@koromix/koffi-darwin-arm64@8.7.0",
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    /// 普通用户（无管理员/开发者模式）下 `symlink_dir` 会以 os error 1314 失败，
    /// 必须回退为 junction 且仍可被 `read_link` 解析、被 `remove_dir` 只删入口。
    #[cfg(windows)]
    #[test]
    fn create_directory_link_falls_back_to_junction_without_privileges() {
        let root = std::env::temp_dir().join(format!("dsh-runtime-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let source = root.join("source-pkg");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("package.json"), r#"{"name":"dsh-tauri"}"#).unwrap();
        let destination = root.join("node_modules").join("dsh-tauri");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();

        let canonical_source = source.canonicalize().unwrap();
        create_directory_link(&canonical_source, &destination)
            .unwrap_or_else(|e| panic!("link must be created without privileges: {e}"));

        let metadata = std::fs::symlink_metadata(&destination).unwrap();
        assert!(
            metadata.file_type().is_symlink(),
            "junction must be treated as a link"
        );
        let resolved = std::fs::read_link(&destination).unwrap();
        assert_eq!(resolved.canonicalize().unwrap(), canonical_source);

        // 幂等：指向同一目标的链接应被 matches 逻辑识别，不重建（无错误即满足）。
        let matches = std::fs::read_link(&destination)
            .map(|target| {
                let resolved = if target.is_absolute() {
                    target
                } else {
                    destination.parent().unwrap_or(Path::new(".")).join(target)
                };
                resolved.canonicalize().ok().as_deref() == Some(canonical_source.as_path())
            })
            .unwrap_or(false);
        assert!(matches, "existing junction must match its source");

        // 删除只移除入口本身，绝不触碰源目录。
        remove_link_only(&destination).unwrap();
        assert!(!destination.exists());
        assert!(canonical_source.is_dir());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 确定性覆盖 junction 回退路径：无论本机是否启用开发者模式/管理员权限，
    /// 直接构造 junction 并断言其可解析、可删除，且与 ensure_package_link 的
    /// matches 幂等检查兼容。
    #[cfg(windows)]
    #[test]
    fn create_directory_junction_is_resolvable_and_idempotent() {
        let root = std::env::temp_dir().join(format!("dsh-junction-direct-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let source = root.join("source-pkg");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("package.json"), r#"{"name":"dsh-tauri"}"#).unwrap();
        let destination = root.join("node_modules").join("dsh-tauri");
        std::fs::create_dir_all(destination.parent().unwrap()).unwrap();

        let canonical_source = source.canonicalize().unwrap();
        create_directory_junction(&canonical_source, &destination)
            .unwrap_or_else(|e| panic!("junction must be creatable without privileges: {e}"));

        let metadata = std::fs::symlink_metadata(&destination).unwrap();
        assert!(
            metadata.file_type().is_symlink(),
            "junction must be treated as a link"
        );
        assert_eq!(
            std::fs::canonicalize(&destination).unwrap(),
            canonical_source,
            "junction must resolve to the source directory"
        );

        // 幂等：重复调用同一目标时 ensure_package_link 的 matches 应命中，
        // 先删旧入口再重建不会因 canonicalize 差异而失败。
        remove_link_only(&destination).unwrap();
        create_directory_junction(&canonical_source, &destination)
            .unwrap_or_else(|e| panic!("junction recreation must succeed: {e}"));
        let matches = std::fs::read_link(&destination)
            .ok()
            .map(|target| {
                let resolved = if target.is_absolute() {
                    target
                } else {
                    destination.parent().unwrap_or(Path::new(".")).join(target)
                };
                resolved.canonicalize().ok().as_deref() == Some(canonical_source.as_path())
            })
            .unwrap_or(false);
        assert!(matches, "existing junction must match its source");

        // 删除只移除入口本身，绝不触碰源目录。
        remove_link_only(&destination).unwrap();
        assert!(!destination.exists());
        assert!(canonical_source.is_dir());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 探测脚本必须写出 Rust 侧约定的标记行，并覆盖 ABI 敏感包与 sharp/koffi 两条路径。
    #[test]
    fn native_probe_script_matches_marker_and_checks_abi() {
        assert!(NATIVE_PROBE_SCRIPT.contains(NATIVE_PROBE_MARKER));
        assert!(NATIVE_PROBE_SCRIPT.contains("NODE_MODULE_VERSION"));
        assert!(NATIVE_PROBE_SCRIPT.contains("binding.gyp"));
        assert!(NATIVE_PROBE_SCRIPT.contains("'sharp'"));
        assert!(NATIVE_PROBE_SCRIPT.contains("'koffi'"));
    }

    #[test]
    fn native_probe_failures_parse_from_marker_line_ignoring_noise() {
        let stdout = concat!(
            "some addon chatter\n",
            "__DSH_NATIVE_PROBE__[{\"kind\":\"addon\",\"name\":\"fs-ext\",\"message\":\"The module 'x' was compiled against a different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.\",\"abi\":true},",
            "{\"kind\":\"import\",\"name\":\"sharp\",\"message\":\"Cannot find module 'sharp'\",\"abi\":false}]\n"
        );
        let failures = parse_native_probe_failures(stdout).expect("marker line must parse");
        assert_eq!(failures.len(), 2);
        assert_eq!(failures[0].name, "fs-ext");
        assert!(failures[0].abi);
        assert!(!failures[0].is_platform_import());
        assert!(!failures[1].abi);
        assert!(failures[1].is_platform_import());
    }

    #[test]
    fn native_probe_parse_returns_none_without_marker() {
        assert!(parse_native_probe_failures("no marker here").is_none());
        assert!(parse_native_probe_failures("__DSH_NATIVE_PROBE__not json").is_none());
    }

    #[test]
    fn native_probe_classifies_abi_and_platform_failures() {
        let probe = NativeProbe::Failed(vec![
            NativeProbeFailure {
                kind: "addon".into(),
                name: "fs-ext".into(),
                message: "NODE_MODULE_VERSION 137".into(),
                abi: true,
            },
            NativeProbeFailure {
                kind: "addon".into(),
                name: "fs-ext".into(),
                message: "duplicate entry".into(),
                abi: true,
            },
            NativeProbeFailure {
                kind: "import".into(),
                name: "koffi".into(),
                message: "Cannot find module".into(),
                abi: false,
            },
        ]);
        assert!(!probe.is_ready());
        assert!(probe.has_abi_mismatch());
        assert!(probe.has_platform_import_failure());
        assert_eq!(probe.abi_packages(), vec!["fs-ext".to_string()]);
        assert!(NativeProbe::Ready.abi_packages().is_empty());
        assert!(!NativeProbe::Unknown("boom".into()).has_abi_mismatch());
    }

    /// ABI 诊断必须点名模块、折叠 Node 的跨行报错并给出可操作建议（issue #441）。
    #[test]
    fn native_failure_diagnostic_reports_abi_mismatch() {
        let failures = vec![NativeProbeFailure {
            kind: "addon".into(),
            name: "fs-ext".into(),
            message: "The module 'fs_ext.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 137.".into(),
            abi: true,
        }];
        let diagnostic = native_failure_diagnostic(
            &failures,
            Path::new("C:\\missing\\node.exe"),
            Path::new("C:\\core"),
        );
        assert!(diagnostic.starts_with("CORE_NATIVE_ABI_MISMATCH:"));
        assert!(diagnostic.contains("fs-ext"));
        assert!(diagnostic.contains("NODE_MODULE_VERSION 137"));
        assert!(
            !diagnostic.contains('\n'),
            "diagnostic must be a single line"
        );
        assert!(diagnostic.contains("install the Node.js version the core was built with"));
    }

    #[test]
    fn native_failure_diagnostic_lists_non_abi_failures() {
        let failures = vec![NativeProbeFailure {
            kind: "import".into(),
            name: "sharp".into(),
            message: "Cannot find module 'sharp'".into(),
            abi: false,
        }];
        let diagnostic =
            native_failure_diagnostic(&failures, Path::new("node"), Path::new("C:\\core"));
        assert!(diagnostic.starts_with("CORE_NATIVE_DEPENDENCY_REPAIR_FAILED:"));
        assert!(diagnostic.contains("sharp: Cannot find module 'sharp'"));
    }

    #[test]
    fn collapse_whitespace_folds_multiline_messages() {
        assert_eq!(collapse_whitespace("a\n  b\t c"), "a b c");
    }

    /// 重建必须使用与所选运行时配套的 npm：捆绑运行时目录自带 npm-cli.js。
    #[test]
    fn npm_command_prefers_node_local_npm_cli() {
        let root = std::env::temp_dir().join(format!("dsh-npm-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let bin_dir = root.join("node-v22.22.0-win-x64");
        std::fs::create_dir_all(bin_dir.join("node_modules").join("npm").join("bin")).unwrap();
        let npm_cli = bin_dir
            .join("node_modules")
            .join("npm")
            .join("bin")
            .join("npm-cli.js");
        std::fs::write(&npm_cli, "// npm").unwrap();
        let node = bin_dir.join("node.exe");

        let (program, args) = npm_command(&node);
        assert_eq!(program, node.as_os_str().to_os_string());
        assert_eq!(args, vec![npm_cli.clone().into_os_string()]);
        assert_eq!(npm_cli_path_for(&node), Some(npm_cli));

        // 找不到配套 npm 时退回 PATH 中的 npm（不硬编码路径）
        let bare = root.join("bare").join("node.exe");
        std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
        let (program, args) = npm_command(&bare);
        assert!(program == "npm.cmd" || program == "npm");
        assert!(args.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 用真实 Node 跑一遍探测脚本：脚本语法/标记约定出错时这里会失败。
    /// 本机没有兼容 node 时跳过（受限环境）。
    #[test]
    fn native_probe_script_runs_on_real_node() {
        let Some(node) = crate::config::get_local_node_path() else {
            return;
        };
        let root = std::env::temp_dir().join(format!("dsh-native-probe-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules")).unwrap();

        let mut command = Command::new(&node);
        command
            .args(["--input-type=module", "-e", NATIVE_PROBE_SCRIPT])
            .current_dir(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().expect("node must be runnable");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "probe script must exit 0: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        // 空核心目录：sharp/koffi 解析失败但属于非 ABI 失败，必须能结构化解析。
        let failures =
            parse_native_probe_failures(&stdout).expect("probe must emit the marker line");
        assert!(failures.iter().all(|failure| !failure.abi));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 端到端契约测试：探测脚本 + Rust 解析必须能把"ABI 不匹配的原生包"识别出来
    /// （issue #441 的 fs-ext 形态：binding.gyp + build/Release/*.node，包入口抛 ABI 错误）。
    #[test]
    fn native_probe_detects_abi_mismatch_package() {
        let Some(node) = crate::config::get_local_node_path() else {
            return;
        };
        let root = std::env::temp_dir().join(format!("dsh-native-abi-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let pkg = root.join("node_modules").join("fs-ext");
        std::fs::create_dir_all(pkg.join("build").join("Release")).unwrap();
        std::fs::write(pkg.join("binding.gyp"), "{}").unwrap();
        std::fs::write(
            pkg.join("build").join("Release").join("fs_ext.node"),
            "stub",
        )
        .unwrap();
        std::fs::write(
            pkg.join("package.json"),
            r#"{"name":"fs-ext","main":"index.js"}"#,
        )
        .unwrap();
        std::fs::write(
            pkg.join("index.js"),
            "throw new Error(\"was compiled against a different Node.js version using\\nNODE_MODULE_VERSION 137. This version of Node.js requires\\nNODE_MODULE_VERSION 141.\");",
        )
        .unwrap();

        let mut command = Command::new(&node);
        command
            .args(["--input-type=module", "-e", NATIVE_PROBE_SCRIPT])
            .current_dir(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().expect("node must be runnable");
        let failures = parse_native_probe_failures(&String::from_utf8_lossy(&output.stdout))
            .expect("marker line");
        let probe = NativeProbe::Failed(failures);
        assert!(
            probe.has_abi_mismatch(),
            "fs-ext must be reported as an ABI mismatch"
        );
        assert_eq!(probe.abi_packages(), vec!["fs-ext".to_string()]);
        // 诊断必须点名模块，供前端直接展示（而不是让用户只看到 HARNESS_NOT_OWNED）
        let diagnostic = native_failure_diagnostic(probe.failures(), &node, &root);
        assert!(diagnostic.starts_with("CORE_NATIVE_ABI_MISMATCH:"));
        assert!(diagnostic.contains("fs-ext"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 档案里未被声明、且版本与安装锚点不一致的核心包必须被清掉——这正是
    /// 「未能保存设置，请重试。」的成因（旧世代 dsh-settings 抢在核心之前被解析）。
    #[test]
    fn stale_undeclared_core_package_is_pruned() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");

        write_package_version(&profile_modules, "dsh-settings", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        assert!(
            !profile_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .exists(),
            "mismatched undeclared core package must be removed from the profile"
        );
        assert!(
            anchor_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "the anchor copy must never be touched"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 版本与锚点一致的核心包是 pnpm hoisted 平铺的合法传递依赖，必须原样保留；
    /// 档案自己声明过的核心包同样不能动（哪怕是版本不一致）。
    #[test]
    fn matching_or_declared_core_packages_are_kept() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");

        write_package_version(&profile_modules, "dsh-settings", "0.1.7-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");
        write_package_version(&profile_modules, "dsh-tools", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-tools", "0.1.7-rc.2");
        // 非核心 scope 与无 package.json 的条目都不在判定范围内。
        write_package_version(&root.join("other"), "dsh-settings", "0.1.5-rc.2");
        std::fs::create_dir_all(profile_modules.join("@deepseek-ai/dsh-orphan")).unwrap();

        let declared = HashSet::from(["@deepseek-ai/dsh-tools".to_string()]);
        prune_stale_core_entries(&root.join("profiles/tauri"), &anchor_modules, &declared).unwrap();

        assert!(
            profile_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "version-matching core package must be kept"
        );
        assert!(
            profile_modules
                .join("@deepseek-ai/dsh-tools/package.json")
                .is_file(),
            "declared core package must be kept"
        );
        assert!(
            profile_modules.join("@deepseek-ai/dsh-orphan").is_dir(),
            "entry without a readable version must be left alone"
        );
        assert!(
            root.join("other/@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "only the @deepseek-ai scope is inspected"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 同 scope 下的共享框架库（插件可合法锁版本）与第三方插件 `dshmarket` 都不能
    /// 按「版本错配」误删，否则会直接弄坏插件。
    #[test]
    fn shared_framework_libraries_and_third_party_plugins_are_kept() {
        let root =
            std::env::temp_dir().join(format!("dsh-stale-core-scope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");

        for name in ["schemastery", "cosmokit", "cordis", "dshmarket"] {
            write_package_version(&profile_modules, name, "0.1.5-rc.2");
            write_package_version(&anchor_modules, name, "0.1.7-rc.2");
        }

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        for name in ["schemastery", "cosmokit", "cordis", "dshmarket"] {
            assert!(
                profile_modules
                    .join(format!("@deepseek-ai/{name}/package.json"))
                    .is_file(),
                "{name} is outside the core family and must be kept"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 符号链接形态（残留在 `.dsh-module-fallback` 已消失时正是这种）也必须能删掉，
    /// 且只删入口、不动源目录。
    #[cfg(unix)]
    #[test]
    fn stale_core_package_symlink_is_removed_without_touching_source() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");
        let source = root.join("fallback/@deepseek-ai/dsh-settings");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("package.json"), r#"{"version":"0.1.5-rc.2"}"#).unwrap();
        std::fs::create_dir_all(profile_modules.join("@deepseek-ai")).unwrap();
        std::os::unix::fs::symlink(&source, profile_modules.join("@deepseek-ai/dsh-settings"))
            .unwrap();
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        assert!(
            !profile_modules.join("@deepseek-ai/dsh-settings").exists(),
            "stale link must be removed"
        );
        assert!(
            source.join("package.json").is_file(),
            "the link source must survive"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// scope 目录本身被重定向时，宁可整轮不清，也不能顺着链接删到档案之外。
    #[cfg(unix)]
    #[test]
    fn redirected_scope_is_skipped_entirely() {
        let root =
            std::env::temp_dir().join(format!("dsh-stale-core-redirect-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile_modules = root.join("profiles/tauri/node_modules");
        let anchor_modules = root.join("dependencies/dsh/node_modules");
        let outside = root.join("outside/@deepseek-ai");
        write_package_version(&root.join("outside"), "dsh-settings", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");
        std::fs::create_dir_all(&profile_modules).unwrap();
        std::os::unix::fs::symlink(&outside, profile_modules.join("@deepseek-ai")).unwrap();

        prune_stale_core_entries(
            &root.join("profiles/tauri"),
            &anchor_modules,
            &HashSet::new(),
        )
        .unwrap();

        assert!(
            outside.join("dsh-settings/package.json").is_file(),
            "a redirected scope must never be pruned through"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// `node_modules` 自身被重定向成一个外部目录时，包含锚点必须是档案目录，
    /// 否则外部目录会被当成「档案内部」而遭删除。
    #[cfg(unix)]
    #[test]
    fn redirected_node_modules_is_skipped_entirely() {
        let root = std::env::temp_dir().join(format!("dsh-stale-core-nm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let profile = root.join("profiles/tauri");
        let anchor_modules = root.join("dependencies/dsh/node_modules");
        let outside_modules = root.join("outside/node_modules");
        write_package_version(&outside_modules, "dsh-settings", "0.1.5-rc.2");
        write_package_version(&anchor_modules, "dsh-settings", "0.1.7-rc.2");
        std::fs::create_dir_all(&profile).unwrap();
        std::os::unix::fs::symlink(&outside_modules, profile.join("node_modules")).unwrap();

        prune_stale_core_entries(&profile, &anchor_modules, &HashSet::new()).unwrap();

        assert!(
            outside_modules
                .join("@deepseek-ai/dsh-settings/package.json")
                .is_file(),
            "an external node_modules must never be pruned through"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    fn write_package_version(modules: &Path, name: &str, version: &str) {
        let dir = modules.join("@deepseek-ai").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"@deepseek-ai/{name}","version":"{version}"}}"#),
        )
        .unwrap();
    }
}
