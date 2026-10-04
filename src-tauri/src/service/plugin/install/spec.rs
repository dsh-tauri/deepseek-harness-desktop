//! 安装 spec 准备：本地目录 spec 的判定与规范化（统一改写成 `link:` 绝对路径）、
//! 内置插件捆绑目录解析、GitHub 简写规范化（绕开 pnpm 的 HTTPS→SSH 回退缺陷）
//! 与 Windows 下含空格 spec 的引号化（dsh CLI 只在 win32 用 shell 拼接参数）。

use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::bundled_dep_spec;
use super::bundled_plugin_dir;
use super::PreinstallPluginInfo;

/// 本地目录 spec 的判定：`link:` / `file:` 前缀、UNC、盘符绝对路径、`/` 起始的
/// 根路径与 `./` / `../` 显式相对路径都算；返回尚未绝对化的原始路径。
///
/// 判定必须先于 [`package_name_of_spec`] 里「含 `:` 即放弃」的形态检查：Windows
/// 盘符自带冒号，裸路径否则会被当成 git / URL 形态丢掉包名，安装前的只读检查也会
/// 误报 `invalid-spec`。
pub(super) fn local_path_spec(spec: &str) -> Option<PathBuf> {
    let trimmed = unquote(spec.trim());
    if trimmed.is_empty() {
        return None;
    }
    for prefix in ["link:", "file:"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            let rest = strip_file_url(rest);
            if rest.is_empty() {
                return None;
            }
            return Some(PathBuf::from(rest));
        }
    }
    if trimmed.starts_with('/') || trimmed.starts_with("\\\\") {
        return Some(PathBuf::from(trimmed));
    }
    if has_drive_prefix(trimmed) {
        return Some(PathBuf::from(trimmed));
    }
    if trimmed.starts_with("./") || trimmed.starts_with("../") {
        return Some(PathBuf::from(trimmed));
    }
    if trimmed.starts_with(".\\") || trimmed.starts_with("..\\") {
        return Some(PathBuf::from(trimmed));
    }
    None
}

/// 目录选择器给出的路径 → 安装 spec：一律写成 `link:` + 正斜杠绝对路径。
///
/// 与 [`local_dir_of`] 的区别是这里还没有目录：用户在安装框里手打的路径同样经
/// 这里统一形态，面板把结果回填进输入框后走的是与手打完全相同的安装链路。
pub(crate) fn local_spec_from_path(path: &Path) -> String {
    format!("link:{}", forward_slashes(path))
}

/// 剥掉成对的首尾引号：Windows 资源管理器「复制为路径」给出的正是 `"D:\x"`，
/// 这对引号会被 pnpm 当成路径的一部分而报 `ERR_PNPM_SPEC_NOT_SUPPORTED`。
fn unquote(spec: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(rest) = spec
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return rest.trim();
        }
    }
    spec
}

/// 盘符绝对路径（`D:\x` / `D:/x`）：两个 ASCII 字母之外的盘符不存在，其余形态
/// 一律不按本地路径处理。
fn has_drive_prefix(spec: &str) -> bool {
    let bytes = spec.as_bytes();
    bytes.len() > 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// `file:` 后的正文：`file:///D:/x` 的盘符形态还原成 `D:/x`，其余原样返回。
///
/// 不还原就会得到 `///D:/x`——在 Windows 上被解析成一个带 `\\` 前缀的怪路径，
/// 拼进 `link:` 后 pnpm 报 `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`。
fn strip_file_url(rest: &str) -> &str {
    let trimmed = rest.trim();
    let stripped = trimmed.trim_start_matches('/');
    if has_drive_prefix(stripped) {
        stripped
    } else {
        trimmed
    }
}

/// 本地 spec 的绝对目录：相对路径以 `base`（`dsh plugin add` 子进程的 cwd）为基准。
///
/// 存在的路径走 `canonicalize`：pnpm 与 chokidar 都按真实长名工作，Windows 8.3
/// 短名（`PROGRA~1` 一类）会让 chokidar 的原生事件层断言失败直接终止进程，必须在
/// 进入这两条链路之前展开；`dunce::simplified` 去掉 canonicalize 的 `\\?\` 前缀，
/// 否则 pnpm 会把该前缀当成路径的一部分。
pub(super) fn local_dir_of(spec: &str, base: &Path) -> Option<PathBuf> {
    let path = local_path_spec(spec)?;
    let joined = if path.is_absolute() {
        path
    } else {
        base.join(path)
    };
    Some(
        std::fs::canonicalize(&joined)
            .map(|resolved| dunce::simplified(&resolved).to_path_buf())
            .unwrap_or_else(|_| dunce::simplified(&joined).to_path_buf()),
    )
}

/// 路径的 `/` 分隔、无尾斜杠字符串（pnpm 落盘与 dsh 对账都用这一形态）。
pub(super) fn forward_slashes(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string()
}

/// 从安装 spec 解析包名，供「产物核验」与「入口补构建」定位
/// `node_modules/<name>`。
///
/// - 本地目录（`link:` / `file:` / 裸路径）：读目标目录的 `package.json` 的 `name`
///   （最准确），读不到时回落目录名（pnpm 落盘的目录名通常是包名，但 `link:` 目标
///   目录名未必与包名一致，故以清单为准）；
/// - npm 形态（含 scoped）：剥离末尾 `@版本/区间`，`@scope/name` 里的 `@` 不算分隔符；
/// - git / URL / 其他含 `:` 或空白的形态：install 后的目录名无法静态得知，返回 `None`
///   ——调用方跳过产物核验而不是把 `node_modules/<整条 spec>` 当成必然缺失。
pub(super) fn package_name_of_spec(spec: &str, base: &Path) -> Option<String> {
    if let Some(dir) = local_dir_of(spec, base) {
        // 目录不在场时不给名字：这条路径已被 `local_target` 提前拒绝，把不存在的
        // 目录名当成落盘目录只会让产物核验报一个与真实原因无关的缺失。
        return dir.is_dir().then(|| local_package_name(&dir)).flatten();
    }
    if spec.contains(':') || spec.contains(char::is_whitespace) {
        return None;
    }
    let name = package_name_of_npm_spec(spec);
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// 本地目录的包名：优先读其 `package.json`，回落目录名。
pub(super) fn local_package_name(path: &Path) -> Option<String> {
    if let Ok(content) = std::fs::read_to_string(path.join("package.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(name) = value.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() {
                    return Some(name.to_string());
                }
            }
        }
    }
    path.file_name().map(|s| s.to_string_lossy().into_owned())
}

/// 剥离 `name@range` 的版本后缀：scoped 包只在 `@scope/` 的斜杠之后寻找 `@`，
/// 否则 `@scope/name` 会被从首个 `@` 切开得到空包名。
fn package_name_of_npm_spec(spec: &str) -> &str {
    let search_from = if spec.starts_with('@') {
        spec.find('/').map_or(spec.len(), |i| i + 1)
    } else {
        0
    };
    match spec[search_from..].find('@') {
        Some(offset) => spec[..search_from + offset].trim_end_matches('@'),
        None => spec,
    }
}

/// 内置插件才需要解析捆绑目录（普通插件无此概念），避免无谓的资源探测
pub(super) fn bundled_dir_of(
    app_handle: &AppHandle,
    preset: &PreinstallPluginInfo,
) -> Option<PathBuf> {
    if !preset.internal {
        return None;
    }
    bundled_plugin_dir(app_handle, &preset.id)
}

/// 解析某预设的安装 spec（纯函数，便于单测）：内置插件固定为随包捆绑目录的
/// `link:` 本地依赖（pnpm 对 `file:` 的盘符绝对路径会按相对解析，故用 `link:`；
/// 路径正确性由 [`crate::service::plugin::internal::ensure`] 启动自愈核对）；
/// 普通插件沿用清单声明。
///
/// 捆绑目录缺失时返回错误：内置插件缺失意味着构建期 build:plugins 未执行或产物
/// 被删，属发布缺陷而非用户侧的普通安装失败，错误前缀便于区分。
pub(super) fn preset_spec_for_install(
    preset: &PreinstallPluginInfo,
    bundled_dir: Option<PathBuf>,
    core_version: Option<&str>,
) -> Result<String, String> {
    if !preset.internal {
        return Ok(pinned_spec(preset, core_version));
    }
    let dir = bundled_dir.ok_or_else(|| {
        format!(
            "BUNDLED_PLUGIN_MISSING: no bundled dir for internal plugin {} (run pnpm build:plugins at build time)",
            preset.id
        )
    })?;
    Ok(bundled_dep_spec(&dir))
}

/// 非内置插件按「当前核心那一代」的推荐区间钉版本。
///
/// 清单矩阵里的 `version` 是发布侧给出的该代推荐插件版本区间，而裸包名会让 pnpm 装
/// `latest`（未必属于这一代：核心 `^0.1.7-rc.1` 该装 `dsh-better-sidebar@^0.21.1`，
/// 但 registry 的 `latest` 仍解析到 0.19.x）。没有命中区间（字符串声明、核心超出全部
/// 区间、版本不可解析）时退回裸 spec，交由 pnpm 自行解析。
fn pinned_spec(preset: &PreinstallPluginInfo, core_version: Option<&str>) -> String {
    let Some(req) = preset
        .version
        .as_ref()
        .and_then(|version| version.plugin_req_for_core(core_version))
    else {
        return preset.spec.clone();
    };
    if !is_bare_package_spec(&preset.spec) {
        return preset.spec.clone();
    }
    format!("{}@{req}", preset.spec)
}

/// 是否为可直接追加 `@区间` 的裸 npm 包名（含 scope）。
///
/// `git+https://…` / `github:owner/repo` / `link:<路径>` 自带来源，`pkg@1.2.3` 已带
/// 版本，追加都会破坏 spec。
fn is_bare_package_spec(spec: &str) -> bool {
    if spec.contains(':') || spec.contains(char::is_whitespace) {
        return false;
    }
    let body = spec.strip_prefix('@').unwrap_or(spec);
    !body.is_empty() && !body.contains('@')
}

/// 把 `github:owner/repo[#ref]` 与裸 `git+ssh://git@github.com/...` 一类的
/// GitHub 依赖 spec 规范为显式 HTTPS 依赖形式
/// （`git+https://github.com/owner/repo.git[#ref]`）。
///
/// 动机：pnpm 解析 GitHub 简写时，「HTTPS 可达性探测一旦失败就回退 git+ssh」
/// 是已知缺陷（issue #3948 / #7243 / #13276，官方已 accepted 仍未修）。公开仓库
/// 一旦落进 git+ssh，在无 SSH 配置的桌面机上（非交互子进程无法应答 known_hosts
/// 询问）必然硬失败。规范为显式 `git+https:` 后 pnpm 直接走 HTTPS 克隆，绕开该
/// 回退。
///
/// 同时覆盖上游依赖锁定的裸 `git+ssh://git@github.com/owner/repo[.git][#ref]`
/// spec（如 pnpm-lock 里 `github:` 被解析成的形态）：这类公开仓库经 SSH 拉取在
/// 无 SSH 密钥的桌面机上同样必败（issue #369 的次要问题），一并改写为 HTTPS。
/// 非 GitHub 形式（纯 npm 包名 / 其他主机的 git spec）原样返回。
pub(super) fn normalize_git_spec(spec: &str) -> String {
    // 兼容带 `#ref` fragment 的两种宿主形态：`github:owner/repo` 简写与
    // `git+ssh://git@github.com/owner/repo[.git]` 裸 SSH URL
    let rest = spec
        .strip_prefix("github:")
        .or_else(|| spec.strip_prefix("git+ssh://git@github.com/"));
    let Some(rest) = rest else {
        return spec.to_string();
    };
    let (path, fragment) = match rest.split_once('#') {
        Some((p, f)) => (p.trim_end_matches('/'), Some(f)),
        None => (rest.trim_end_matches('/'), None),
    };
    let mut repo = path.to_string();
    if !repo.ends_with(".git") {
        repo.push_str(".git");
    }
    let mut url = format!("git+https://github.com/{repo}");
    if let Some(fragment) = fragment {
        url.push('#');
        url.push_str(fragment);
    }
    url
}

/// `dsh plugin` 仍把 pnpm 参数拼进 shell 的最后一个核心版本（开区间上界）。
///
/// 该版本起 `dsh plugin` 改经 `@deepseek-ai/dsh-plugin-manager`、用 execa 以
/// **argv 数组**启动 pnpm，并在 Windows 上自行按 cmd 规则转义参数
/// （`arguments/command-file.js`），spec 因此必须原样透传。
const SHELL_JOINED_PNPM_CLI_BELOW: &str = "0.1.6-alpha.2";

/// 活动核心的 `dsh plugin` 是否把 pnpm 参数拼成命令行交给 shell。
///
/// - `< 0.1.6-alpha.2`（0.1.5-rc.2 / 0.1.6-alpha.1 等）：JS 里
///   `spawnSync("pnpm", args, { shell: process.platform === "win32" })`，Node 对
///   `shell:true` 只按空格拼接、不做引号转义（DEP0190），含空格的 spec 不预加引号
///   就会被切碎成多个 spec。
/// - `>= 0.1.6-alpha.2`：参数作为单个 argv 直达 pnpm，spec 里的字面 `"` 会被当成
///   包名的一部分 → `ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER`（issue #647）。
///
/// 版本读不到 / 解析失败时按新核心处理：预加引号对新核心是**必然失败**，不预加
/// 引号只在「老核心 + 含空格安装路径」这一组合下失败。
pub(super) fn joins_pnpm_args_in_shell(core_version: Option<&str>) -> bool {
    let Ok(threshold) = semver::Version::parse(SHELL_JOINED_PNPM_CLI_BELOW) else {
        return false;
    };
    core_version
        .and_then(|version| semver::Version::parse(version).ok())
        .is_some_and(|actual| actual < threshold)
}

/// 给含空白字符的依赖 spec 加内嵌双引号，使其在 shell 拼接后仍保持单一 token。
///
/// 只对「把参数拼进 shell 的老核心」且「Windows」成立：老核心在 win32 用
/// `shell:true` 启动 pnpm，内置插件的 `link:<应用安装目录>` 一旦含空格就会被切碎
/// （pnpm 报 `ERR_PNPM_SPEC_NOT_SUPPORTED`），包一层双引号让 cmd 把整条 spec 视为
/// 单一 token；pnpm 解析后自行剥离引号，落盘 `package.json` 的值仍是不带引号的
/// `link:<路径>`（与 [`bundled_dep_spec`] 的内核对账一致）。
///
/// 新核心与 macOS / Linux（老核心在 mac 上也是 `shell:false`）都是 argv 数组直达
/// pnpm、空格天然保留，加引号反而把字面 `"` 当成包名的一部分传给 pnpm → 非法
/// spec → exit 1，这是 issue #104 的根因（内置插件指向 `/Applications/Deepseek
/// Harness Desktop.app/...`）。因此调用方必须经 [`spec_argument`] 按核心版本决定。
pub(super) fn shell_quote_spec(spec: &str) -> String {
    #[cfg(windows)]
    {
        if spec.chars().any(|c| c == ' ' || c == '\t') {
            return format!("\"{spec}\"");
        }
    }
    spec.to_string()
}

/// 传给 `dsh plugin add` 的最终参数：只有把参数拼进 shell 的老核心才预加引号
/// （见 [`joins_pnpm_args_in_shell`] 与 [`shell_quote_spec`]）。
pub(super) fn spec_argument(spec: &str, core_version: Option<&str>) -> String {
    if joins_pnpm_args_in_shell(core_version) {
        shell_quote_spec(spec)
    } else {
        spec.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::manifest::{PluginVersion, VersionPair};
    use std::path::PathBuf;

    /// 构造预设条目的测试助手（internal 由各用例显式指定）
    fn preset(id: &str, spec: &str, internal: bool) -> PreinstallPluginInfo {
        PreinstallPluginInfo {
            id: id.into(),
            spec: spec.into(),
            package: None,
            name: String::new(),
            description: String::new(),
            repo_url: String::new(),
            recommended: false,
            fix: false,
            default_checked: false,
            default_unchecked: false,
            version: None,
            win_only: false,
            internal,
        }
    }

    #[test]
    fn install_spec_passthrough_for_regular_preset() {
        // 普通插件：spec 原样返回，与捆绑目录无关
        let p = preset("dshmarket", "dshmarket", false);
        assert_eq!(
            preset_spec_for_install(&p, None, None).unwrap(),
            "dshmarket"
        );
        assert_eq!(
            preset_spec_for_install(&p, Some(PathBuf::from("/ignored")), None).unwrap(),
            "dshmarket"
        );
    }

    #[test]
    fn install_spec_pins_recommended_range_for_current_core() {
        // 清单矩阵声明的该代推荐区间必须钉进 spec：裸包名会让 pnpm 装 latest
        // （核心 0.1.7-rc.1 该装 ^0.21.1，registry 的 latest 却还是 0.19.x）
        let mut p = preset("dsh-better-sidebar", "dsh-better-sidebar", false);
        p.version = Some(PluginVersion::Matrix(vec![
            VersionPair {
                version: "^0.19.1".into(),
                dsh: "^0.1.5-rc.1".into(),
            },
            VersionPair {
                version: "^0.21.1".into(),
                dsh: "^0.1.7-rc.1".into(),
            },
        ]));
        assert_eq!(
            preset_spec_for_install(&p, None, Some("0.1.5-rc.3")).unwrap(),
            "dsh-better-sidebar@^0.19.1"
        );
        assert_eq!(
            preset_spec_for_install(&p, None, Some("0.1.7-rc.1")).unwrap(),
            "dsh-better-sidebar@^0.21.1"
        );
        // scope 包名同样支持；核心没有任何命中区间时退回裸 spec
        let mut scoped = preset("@xmanrui/dsh-im", "@xmanrui/dsh-im", false);
        scoped.version = p.version.clone();
        assert_eq!(
            preset_spec_for_install(&scoped, None, Some("0.1.7-rc.2")).unwrap(),
            "@xmanrui/dsh-im@^0.21.1"
        );
        assert_eq!(
            preset_spec_for_install(&p, None, Some("0.2.0")).unwrap(),
            "dsh-better-sidebar"
        );
        assert_eq!(
            preset_spec_for_install(&p, None, None).unwrap(),
            "dsh-better-sidebar"
        );

        // issue #715：清单区间本身就带 `^`，拼接只能再加一个 `@`——出现 `^^` 会让 pnpm
        // 报 ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER，而预设插件共用同一条 `add`
        // 调用，一个坏 spec 就让整批预设都装不上（应用卡在加载中，见 issue #716）。
        for core in ["0.1.5-rc.3", "0.1.7-rc.1", "0.1.7-rc.2", "0.2.0"] {
            let spec = preset_spec_for_install(&p, None, Some(core)).unwrap();
            assert!(!spec.contains("^^"), "core={core}: {spec}");
        }
    }

    #[test]
    fn install_spec_never_pins_non_package_specs() {
        // 自带来源 / 已带版本的 spec 不能再追加 `@区间`
        let mut git = preset("probe", "git+https://github.com/o/r.git", false);
        git.version = Some(PluginVersion::Matrix(vec![VersionPair {
            version: "^1.2.0".into(),
            dsh: "^0.1.5-rc.1".into(),
        }]));
        assert_eq!(
            preset_spec_for_install(&git, None, Some("0.1.6")).unwrap(),
            "git+https://github.com/o/r.git"
        );

        let mut versioned = preset("probe", "probe@1.0.0", false);
        versioned.version = git.version.clone();
        assert_eq!(
            preset_spec_for_install(&versioned, None, Some("0.1.6")).unwrap(),
            "probe@1.0.0"
        );

        let mut link = preset("probe", "link:C:/deps/probe", false);
        link.version = git.version.clone();
        assert_eq!(
            preset_spec_for_install(&link, None, Some("0.1.6")).unwrap(),
            "link:C:/deps/probe"
        );
    }

    #[test]
    fn install_spec_supports_npm_style_whitespace_ranges() {
        // 清单按 npm 习惯书写空格分隔的多比较符区间
        let mut p = preset("probe", "probe", false);
        p.version = Some(PluginVersion::Matrix(vec![VersionPair {
            version: "^1.2.0".into(),
            dsh: ">=0.1.7-rc.1 <0.1.7-rc.5".into(),
        }]));
        assert_eq!(
            preset_spec_for_install(&p, None, Some("0.1.7-rc.3")).unwrap(),
            "probe@^1.2.0"
        );
        assert_eq!(
            preset_spec_for_install(&p, None, Some("0.1.7-rc.5")).unwrap(),
            "probe"
        );
    }

    #[test]
    fn install_spec_uses_bundled_dir_for_internal_preset() {
        // 内置插件：安装依赖为 link:<捆绑目录>（正斜杠规范形；pnpm 对
        // `file:D:/...` 的盘符绝对路径会按相对解析，必须用 `link:`）
        let p = preset("dsh-tauri", "dsh-tauri@0.2.0", true);
        let dir = PathBuf::from("C:\\Apps\\dsh\\resources\\internal-plugins\\dsh-tauri");
        assert_eq!(
            preset_spec_for_install(&p, Some(dir), None).unwrap(),
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"
        );
    }

    #[test]
    fn install_spec_errors_when_internal_bundle_missing() {
        // 内置插件捆绑目录缺失：发布缺陷，显式报错而非静默走 npm/git spec
        let p = preset("dsh-tauri", "dsh-tauri@0.2.0", true);
        let err = preset_spec_for_install(&p, None, None).unwrap_err();
        assert!(err.starts_with("BUNDLED_PLUGIN_MISSING"));
        assert!(err.contains("dsh-tauri"));
    }

    // ---- git GitHub 简写规范化（issue #51 根因绕行）----

    #[test]
    fn normalize_github_shorthand_to_git_https() {
        assert_eq!(
            normalize_git_spec("github:baihejiangnan/dsh-session-context-menu"),
            "git+https://github.com/baihejiangnan/dsh-session-context-menu.git"
        );
    }

    #[test]
    fn normalize_github_shorthand_preserves_ref_and_dedup_git_suffix() {
        assert_eq!(
            normalize_git_spec("github:omdsh-dev/DSH-better-sidebar#next"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"
        );
        // 已带 .git 不重复追加
        assert_eq!(
            normalize_git_spec("github:user/repo.git"),
            "git+https://github.com/user/repo.git"
        );
        // 尾部多余斜杠剥掉
        assert_eq!(
            normalize_git_spec("github:user/repo/"),
            "git+https://github.com/user/repo.git"
        );
    }

    #[test]
    fn normalize_ssh_github_url_to_git_https() {
        // issue #369：裸 git+ssh://git@github.com/... spec（pnpm-lock 常见形态）
        // 同样改写为 HTTPS，避免公开仓库经 SSH 拉取在无密钥桌面机上必败
        assert_eq!(
            normalize_git_spec("git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git"
        );
        // 带 #ref 与不带 .git 后缀
        assert_eq!(
            normalize_git_spec("git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar#next"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"
        );
    }

    #[test]
    fn normalize_non_github_spec_passes_through() {
        assert_eq!(normalize_git_spec("dshmarket"), "dshmarket");
        assert_eq!(
            normalize_git_spec("git+https://github.com/foo/bar.git"),
            "git+https://github.com/foo/bar.git"
        );
        // 非 GitHub 主机的 SSH spec 不受影响（只规范 GitHub 公开仓库）
        assert_eq!(
            normalize_git_spec("git+ssh://git@gitlab.com/foo/bar.git"),
            "git+ssh://git@gitlab.com/foo/bar.git"
        );
    }

    // ---- spec 引号化（仅老核心 + Windows：dsh CLI 只在 win32 用 shell 拼接参数）----

    #[cfg(windows)]
    #[test]
    fn shell_quote_quotes_spec_containing_spaces() {
        // 安装目录含空格（如 G:\Deepseek Harness Desktop）：整条 spec 加双引号，
        // 使 dsh CLI 的 shell:true 拼接后仍被 shell 视为单一 token（DEP0190：
        // Node 对 shell:true 只拼接不转义）
        assert_eq!(
            shell_quote_spec(
                "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri"
            ),
            "\"link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri\""
        );
        // 制表符同样触发
        assert_eq!(shell_quote_spec("link:C:/x\ty"), "\"link:C:/x\ty\"");
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_quote_leaves_space_path_untouched_on_non_windows() {
        // 回归（issue #104）：macOS/Linux 上 dsh CLI 直接 spawnSync（shell:false），
        // spec 作为一个 argv 传递、空格天然保留，绝不能加引号——字面 `"` 会成为
        // 包名的一部分，pnpm 报非法 spec → exit 1 → 内置插件每次启动重装都失败。
        assert_eq!(
            shell_quote_spec("link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/internal-plugins/dsh-tauri-ui"),
            "link:/Applications/Deepseek Harness Desktop.app/Contents/Resources/resources/internal-plugins/dsh-tauri-ui"
        );
        assert_eq!(
            shell_quote_spec("link:/Users/me/my plugins/dsh-tauri"),
            "link:/Users/me/my plugins/dsh-tauri"
        );
    }

    #[test]
    fn shell_quote_leaves_space_free_spec_untouched() {
        // 普通 npm 包名 / git HTTPS spec 无空格：原样透传，不引入多余引号
        assert_eq!(shell_quote_spec("dshmarket"), "dshmarket");
        assert_eq!(
            shell_quote_spec("git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"),
            "git+https://github.com/omdsh-dev/DSH-better-sidebar.git#next"
        );
        // 无空格的内置插件路径同样不被改动（保持与 internal.rs expected 一致）
        assert_eq!(
            shell_quote_spec("link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"),
            "link:C:/Apps/dsh/resources/internal-plugins/dsh-tauri"
        );
    }

    #[cfg(windows)]
    #[test]
    fn shell_quote_preserves_link_prefix_semantics() {
        // 引号只包 path 部分也不影响 pnpm 解析（落盘值仍为不带引号的 link: 规范形）
        let quoted = shell_quote_spec(
            "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri",
        );
        assert!(quoted.starts_with('"'));
        assert!(quoted.ends_with('"'));
        assert!(quoted.contains("Deepseek Harness Desktop"));
    }

    // ---- 引号化随核心版本（issue #647：0.1.6-alpha.2 起 pnpm 由 argv 数组启动）----

    #[test]
    fn shell_join_gate_boundary_versions() {
        // 0.1.6-alpha.1 仍是 spawnSync + shell:true（首个 argv 数组版是 alpha.2）
        assert!(joins_pnpm_args_in_shell(Some("0.1.5-rc.2")));
        assert!(joins_pnpm_args_in_shell(Some("0.1.6-alpha.1")));
        assert!(!joins_pnpm_args_in_shell(Some("0.1.6-alpha.2")));
        assert!(!joins_pnpm_args_in_shell(Some("0.1.6")));
        assert!(!joins_pnpm_args_in_shell(Some("0.1.7")));
        assert!(!joins_pnpm_args_in_shell(Some("1.0.0")));
        // 版本未知 / 非法：按新核心处理（预加引号对新核心必然失败）
        assert!(!joins_pnpm_args_in_shell(None));
        assert!(!joins_pnpm_args_in_shell(Some("")));
        assert!(!joins_pnpm_args_in_shell(Some("not-a-version")));
    }

    // ---- 本地目录 spec（issue 需求的本地安装链路）----

    /// 造一个真实存在的本地插件目录：本地 spec 必须走 canonicalize，只有真实路径
    /// 才能覆盖「短名展开」「尾斜杠剥除」「大小写归一」这些只有落盘才成立的形态。
    fn temp_plugin_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dsh-spec-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // `temp_dir()` 在 Windows 上是 8.3 短名（`IUUUUU~1`），而实现按设计展开成
        // 真实长名——夹具必须站在同一口径上比较，否则断言只是在比短名。
        canonical(&dir)
    }

    fn canonical(path: &Path) -> PathBuf {
        dunce::simplified(&std::fs::canonicalize(path).unwrap()).to_path_buf()
    }

    #[test]
    fn local_path_spec_recognizes_every_local_form() {
        for spec in [
            "link:D:/plugins/probe",
            "file:D:/plugins/probe",
            "file:///D:/plugins/probe",
            "D:\\plugins\\probe",
            "D:/plugins/probe",
            "./plugins/probe",
            "../plugins/probe",
            ".\\plugins\\probe",
            "..\\plugins\\probe",
            "/opt/dsh/plugins/probe",
            "link:/opt/dsh/plugins/probe",
            "file:///opt/dsh/plugins/probe",
            "\\\\server\\share\\probe",
            "  D:/plugins/probe  ",
        ] {
            assert!(local_path_spec(spec).is_some(), "应识别为本地 spec: {spec}");
        }
        assert_eq!(
            local_path_spec("file:///D:/plugins/probe"),
            Some(PathBuf::from("D:/plugins/probe"))
        );
    }

    #[test]
    fn local_path_spec_ignores_registry_and_git_specs() {
        // 回归：裸包名、scoped 包名、带版本、GitHub 简写、git / https / ssh 形态
        // 都不能被当成路径——否则普通安装会被重写成 `link:<拼出来的怪路径>`。
        for spec in [
            "dshmarket",
            "@scope/dsh-plugin",
            "dshmarket@^2.12.0",
            "@scope/dsh-plugin@1.0.0",
            "github:user/repo#next",
            "git+https://github.com/user/repo.git",
            "git+ssh://git@gitlab.com/user/repo.git",
            "https://example.com/x.tgz",
            "",
            "   ",
            "link:",
            "file:",
        ] {
            assert!(
                local_path_spec(spec).is_none(),
                "不得识别为本地 spec: {spec}"
            );
        }
    }

    #[test]
    fn local_path_spec_strips_pasted_quotes() {
        // 资源管理器「复制为路径」粘贴出来是带引号的；引号必须剥掉，否则 pnpm
        // 收到的路径里带着字面 `"` 而直接报 spec 不支持。
        assert_eq!(
            local_path_spec("\"D:/plugins/probe\""),
            Some(PathBuf::from("D:/plugins/probe"))
        );
        assert_eq!(
            local_path_spec("'D:/plugins/probe'"),
            Some(PathBuf::from("D:/plugins/probe"))
        );
        assert!(local_path_spec("\"\"").is_none());
    }

    #[test]
    fn local_dir_of_resolves_relative_against_the_install_cwd() {
        // 相对路径的基准是 `dsh plugin add` 子进程的 cwd（`$AppData/dependencies/dsh`），
        // 不是 profile 目录，也不是应用进程自己的 cwd。
        let base = temp_plugin_dir("base");
        let dir = base.join("plugins").join("probe");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            "{\"name\":\"dsh-probe\",\"version\":\"1.2.3\"}",
        )
        .unwrap();

        assert_eq!(local_dir_of("./plugins/probe", &base), Some(dir.clone()));
        assert_eq!(
            local_dir_of("plugins/probe", &base),
            None,
            "裸相对路径不是本地 spec，须显式 ./ 或 ../"
        );
        assert_eq!(
            local_dir_of(&format!("link:{}", forward_slashes(&dir)), &base),
            Some(dir.clone())
        );
        // 尾斜杠 / 原生分隔符 / 大小写都归一到同一真实路径
        assert_eq!(
            local_dir_of(&format!("link:{}/", forward_slashes(&dir)), &base),
            Some(dir.clone()),
            "尾斜杠要剥掉"
        );
        assert_eq!(
            local_dir_of(&format!("link:{}", dir.display()), &base),
            Some(dir.clone()),
            "原生分隔符要归一到同一真实路径"
        );

        #[cfg(windows)]
        assert_eq!(
            local_dir_of(&format!("file:///{}", forward_slashes(&dir)), &base),
            Some(dir.clone()),
            "file:/// 的盘符还原只在 Windows 成立（Unix 上 /D:/x 不是绝对路径）"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn local_dir_of_keeps_missing_paths_for_the_caller_to_reject() {
        // 不存在的目录不在这里报错（调用方要按目录 / 清单分别给出可读原因），
        // 但仍要绝对化并去掉尾斜杠。
        let base = temp_plugin_dir("missing");
        assert_eq!(
            local_dir_of("./nowhere/", &base),
            Some(base.join("nowhere"))
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn package_name_of_spec_reads_local_manifest_then_falls_back_to_dir_name() {
        let base = temp_plugin_dir("name");
        let named = base.join("weird-dir-name");
        std::fs::create_dir_all(&named).unwrap();
        std::fs::write(
            named.join("package.json"),
            "{\"name\":\"dsh-reverse-skill\"}",
        )
        .unwrap();
        // 清单里的包名优先于目录名（link: 目标目录名未必等于包名，pnpm 落盘用包名）
        assert_eq!(
            package_name_of_spec(&format!("link:{}", forward_slashes(&named)), &base),
            Some("dsh-reverse-skill".to_string())
        );
        assert_eq!(
            package_name_of_spec("./weird-dir-name", &base),
            Some("dsh-reverse-skill".to_string())
        );

        // 清单缺失 / 无 name：回落目录名，产物核验仍能定位 node_modules/<目录名>
        let bare = base.join("bare-dir");
        std::fs::create_dir_all(&bare).unwrap();
        assert_eq!(
            package_name_of_spec("./bare-dir", &base),
            Some("bare-dir".to_string())
        );
        assert_eq!(package_name_of_spec("./never-existed", &base), None);

        // 回归：注册表与 git 形态照旧解析成包名或 None，不受本地分支影响
        assert_eq!(
            package_name_of_spec("dshmarket@^2.12.0", &base),
            Some("dshmarket".to_string())
        );
        assert_eq!(
            package_name_of_spec("@scope/dsh-plugin@1.0.0", &base),
            Some("@scope/dsh-plugin".to_string())
        );
        assert_eq!(
            package_name_of_spec("github:user/repo", &base),
            None,
            "含 `:` 且非本地形态：装后目录名不可静态得知"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn forward_slashes_normalizes_separators_and_trailing_slash() {
        assert_eq!(forward_slashes(Path::new("D:\\a\\b\\")), "D:/a/b");
        assert_eq!(forward_slashes(Path::new("D:/a/b/")), "D:/a/b");
        assert_eq!(forward_slashes(Path::new("D:\\a")), "D:/a");
    }

    #[test]
    fn spec_argument_keeps_space_spec_bare_for_argv_cores() {
        // issue #647：0.1.6-alpha.2 起 spec 作为单个 argv 直达 pnpm，Windows 上的
        // cmd 转义由 CLI 自己完成，预加引号会让 pnpm 收到带字面引号的 spec
        let spec = "link:D:/Deepseek Harness Desktop/resources/node_modules/dsh-tauri";
        assert_eq!(spec_argument(spec, Some("0.1.6-alpha.2")), spec);
        assert_eq!(spec_argument(spec, None), spec);
        assert_eq!(spec_argument(spec, Some("not-a-version")), spec);
        // 无空格 spec 与版本无关，始终原样透传
        assert_eq!(spec_argument("dshmarket", Some("0.1.5-rc.2")), "dshmarket");
    }

    #[cfg(windows)]
    #[test]
    fn spec_argument_quotes_space_spec_for_shell_joining_cores() {
        // 回归：老核心把参数拼进 cmd，含空格的安装路径必须预加引号才不被切碎
        let spec = "link:G:/Deepseek Harness Desktop/resources/internal-plugins/dsh-tauri";
        assert_eq!(
            spec_argument(spec, Some("0.1.5-rc.2")),
            format!("\"{spec}\"")
        );
        assert_eq!(
            spec_argument(spec, Some("0.1.6-alpha.1")),
            format!("\"{spec}\"")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn spec_argument_never_quotes_on_non_windows() {
        // issue #104：macOS/Linux 上 dsh 直接 spawnSync（shell:false），spec 作为
        // 单个 argv 传递、空格天然保留，老核心也不得加引号
        let spec = "link:/Users/me/my plugins/dsh-tauri";
        assert_eq!(spec_argument(spec, Some("0.1.5-rc.2")), spec);
        assert_eq!(spec_argument(spec, Some("0.1.6-alpha.2")), spec);
    }
}
