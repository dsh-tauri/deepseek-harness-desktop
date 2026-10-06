//! `dsh plugin` 子进程环境构建：隔离 $DSH_HOME、关闭遥测与颜色、PATH 前置
//! shim/node/git 目录；并检测用户 git 配置里「GitHub HTTPS → SSH」改写规则，
//! 按需隔离子进程 git 配置强制 HTTPS（桌面机无 SSH 密钥时 git+ssh 必然失败）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::config;
use crate::service::cli;

/// 构建 `dsh plugin` 子进程的环境变量：隔离 $DSH_HOME、关闭遥测与颜色、
/// 注入预检解析出的 node 路径（`DSH_NODE`，shim 优先采用，见 shim.rs）、
/// PATH 前置 shim、node 与桌面端自动配置的 Git 目录；用户 pnpm 过旧时强制
/// 捆绑版（见 ensure_pnpm）。
///
/// 供本模块的安装/升级/卸载与 [`crate::service::plugin::verify`] 的完整性修复共用：
/// 子进程（dsh 或 pnpm）都按同一套桌面端环境策略运行，保证 $DSH_HOME / PATH
/// 布局一致。
pub(crate) fn build_plugin_envs(
    app_handle: &AppHandle,
    prefer_bundled_pnpm: bool,
) -> HashMap<String, String> {
    let node = config::get_node_binary_path(app_handle);
    // 规范化为绝对路径：get_node_binary_path 可能返回相对路径（PATH 上出现
    // 相对条目时，如 `.` 或 `tools\node`），而子进程 CWD 与应用进程不同，
    // 相对路径会被解析到错误位置——shim 经 DSH_NODE / PATH 都找不到 node
    // （issue #121 的 "Node.js runtime not found"）。已存在（预检通过）的
    // node 可安全 canonicalize；失败时回退原值。
    let node_abs = dunce::canonicalize(&node).unwrap_or_else(|_| node.clone());
    let bin_dir = cli::get_bin_dir(app_handle);
    let mut envs = HashMap::from([
        (
            "DSH_HOME".to_string(),
            config::get_dsh_data_path(app_handle)
                .to_string_lossy()
                .into_owned(),
        ),
        ("DSH_TELEMETRY_DISABLED".to_string(), "1".to_string()),
        ("NO_COLOR".to_string(), "1".to_string()),
        // pnpm 在非 TTY 子进程里拒绝「清空 node_modules 重建」，直接
        // `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 退出 1；pnpm 11 起也不再读
        // profile `.npmrc` 的 `confirmModulesPurge`，于是 `dsh plugin install` 每次
        // 都失败 → `dsh.profile.bundles` 永远登记不上 → 内置插件不挂载（宿主插件
        // 的 apply 不运行，索引恒 401、健康检查永远 boot page 401）。
        // pnpm 自己给出的开关就是 `CI=true`。
        ("CI".to_string(), "true".to_string()),
        // 把预检解析出的 node 路径显式交给 pnpm/dsh shim（DSH_NODE 优先）：
        // shim 自身经 PATH 解析 node 可能与应用预检不一致（PATH 上的相对条目、
        // junction/符号链接、或子进程 PATH 布局差异），导致 pnpm shim 报
        // "Node.js runtime not found" 而应用预检却通过（issue #121）。
        (
            "DSH_NODE".to_string(),
            node_abs.to_string_lossy().into_owned(),
        ),
    ]);
    // 用户 pnpm 过旧/不可探测时强制 pnpm shim 优先捆绑版，避免 8/9 的
    // autoInstallPeers 语义与 workspace-root gate 破坏插件安装（见 ensure_pnpm）
    if prefer_bundled_pnpm {
        envs.insert("DSH_PREFER_BUNDLED_PNPM".to_string(), "1".to_string());
    } else if let Some(pnpm) = cli::find_user_pnpm(app_handle) {
        // 显式注入绝对路径，避免子进程在不同 PATH/CWD 下重新发现失败。
        // Unix 保留 mise 依赖 argv[0] 的 shim 链接；Windows 仍解析连接点并剥离
        // `\\?\`。同时防御性排除应用自身 shim，避免递归调用。
        if let Some(pnpm_value) = cli::pnpm_env_value(&pnpm, &bin_dir) {
            envs.insert("DSH_PNPM".to_string(), pnpm_value);
        }
    }

    // 捆绑 pnpm 的绝对路径也显式下传（shim 优先采用 `DSH_PNPM_BIN`）：shim 内
    // 烘焙的字面量要经 cmd.exe/PowerShell 的代码页解析，用户名含非 ASCII（如
    // `C:\Users\小蔡\...`）时会被读成乱码，`if exist "%PNPM_BIN%"` 判定落空 →
    // shim 走 `:no_pnpm` 以退出码 1 结束，安装只报 `PREINSTALL_FAILED`。
    // 环境变量块是 UTF-16，不受代码页影响。
    let bundled_pnpm = config::get_pnpm_binary_path(app_handle);
    if bundled_pnpm.exists() {
        envs.insert(
            "DSH_PNPM_BIN".to_string(),
            bundled_pnpm.to_string_lossy().into_owned(),
        );
    }

    // 档案 node_modules 是用哪份 store 装的，是既有事实：pnpm 只在「自己解析出的 store」
    // 与 `node_modules/.modules.yaml` 记录的一致时才继续，否则直接
    // `ERR_PNPM_UNEXPECTED_STORE` 退出（该错误与插件本身无关，用户看到的是「插件安装失败」）。
    // 用户的 pnpm 用户级/全局配置（如 `store-dir`）或环境变量可能把 store 指到别处
    // （典型场景：用户在另一个分区的工程里跑过 pnpm，pnpm 就把那份 store 写进了全局配置），
    // 此时档案安装必然失败且无法自愈。这里显式下传档案记录的 store：
    // pnpm 的优先级是 CLI > 环境变量 > 项目 .npmrc > 用户/全局配置，
    // 因此该值压过用户配置；传的是去掉版本段的基目录，由 pnpm 追加自身主版本的
    // 版本段（主版本与档案一致时即等于 `.modules.yaml` 里的记录，见
    // [`super::pnpm::profile_store_base_dir`]）。
    // 全新档案（没有 node_modules）不注入：让 pnpm 按用户配置自行决定并写回记录。
    if let Some(store_dir) = super::pnpm::profile_store_base_dir(app_handle) {
        log::info!("pinning plugin install pnpm store to the profile record: {store_dir}");
        // pnpm 11 起不再读取 `npm_config_*`：`config/reader` 的 `parseEnvVars` 只认
        // `pnpm_config_` / `PNPM_CONFIG_` 前缀，其余按键静默 `continue`（见
        // pnpm 11.0.0 release notes：`npm_config_registry` → `pnpm_config_registry`）。
        // 只设 `npm_config_store_dir` 对捆绑版 pnpm 11 是空操作 —— 档案记录的 store
        // 根本没下传，pnpm 用自己解析出的 store 与 `.modules.yaml` 比对失败，仍报
        // `ERR_PNPM_UNEXPECTED_STORE`。两个前缀同设：pnpm 10 认 `npm_config_*`，
        // pnpm 11 认 `pnpm_config_*`，值相同因此不冲突。
        envs.insert("npm_config_store_dir".to_string(), store_dir.clone());
        envs.insert("pnpm_config_store_dir".to_string(), store_dir);
    }

    let mut paths = vec![bin_dir];
    if let Some(node_dir) = node_abs.parent() {
        paths.push(node_dir.to_path_buf());
    }
    // pnpm 安装 github:/git+ssh: 插件时会直接调用 git。Windows 空白环境使用
    // 桌面端已校验安装的 MinGit，仅对子进程 PATH 生效，不污染用户系统 PATH。
    if let Some(git_dir) = config::get_git_cmd_dir(app_handle) {
        paths.push(git_dir);
    }
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));

    if let Ok(joined) = std::env::join_paths(paths) {
        envs.insert("PATH".to_string(), joined.to_string_lossy().into_owned());
    }
    // 桌面端代理设置（issue #110）：核心只在启动时读 `http_proxy` 系环境变量，
    // 桌面端直接 spawn 的 `dsh plugin` 子进程拿不到配置页里的代理，内网机拉取
    // 元数据与仓库会直连失败。空值时返回空 map，用户没配代理则零影响。
    envs.extend(config::proxy::proxy_child_env(
        &config::get_store_dat_setting(app_handle).proxy_url,
    ));
    // 用户 git 配置若把 GitHub HTTPS 改写为 SSH（url.<base>.insteadOf），pnpm 的
    // git 传输会落进 SSH 而硬失败；按需隔离子进程 git 配置强制 HTTPS
    // （见 [`git_https_isolation_env`]，未命中改写规则时返回空 map，零影响）。
    envs.extend(git_https_isolation_env(app_handle));
    envs
}

/// 检测用户 git 配置中「把 GitHub HTTPS 改写为 SSH」的 `url.<base>.insteadOf`
/// 规则，命中时返回隔离子进程 git 配置所需的环境变量，强制插件安装走 HTTPS。
///
/// 背景：不少用户按 GitHub 官方文档配置过
/// `git config --global url."git@github.com:".insteadOf "https://github.com/"`
/// 让个人 git 操作走 SSH。pnpm 解析 `git+https://github.com/...` 插件时同样调用
/// git，URL 被该规则改写后实际走 SSH；桌面机通常没有 SSH 密钥（非交互子进程也
/// 无法应答 known_hosts 询问），于是 `Permission denied (publickey)` /
/// `Host key verification failed` 硬失败（用户可见提示见
/// [`super::diagnose::git_transport_hint`]）。检测到该类规则后，把子进程的 git
/// 配置隔离为空文件（`GIT_CONFIG_GLOBAL`）或关闭系统配置（`GIT_CONFIG_NOSYSTEM`），
/// 让 HTTPS 地址原样生效——公开仓库无需任何凭据即可克隆。
///
/// 未命中时返回空 map：普通用户（含只配代理/凭据助手、无 SSH 改写者）的子进程
/// git 配置原样保留，零影响。探测全部为最佳努力——git 缺失、命令失败或输出异常
/// 都视为「无需隔离」，不阻断安装。
///
/// 仅用于桌面端驱动的 `dsh plugin` 子进程（`build_plugin_envs`）：不注入长驻服务
/// 进程的环境——那里会被 agent 子进程继承，隔离 git 配置会让 agent 的 git 操作
/// 丢失 user.name/凭据助手/代理等用户配置。
fn git_https_isolation_env(app_handle: &AppHandle) -> HashMap<String, String> {
    let Some(git) = plugin_git_binary(app_handle) else {
        return HashMap::new();
    };
    let mut envs = HashMap::new();
    if git_scope_has_github_ssh_rewrite(&git, &["--global"]) {
        if let Some(config) = empty_git_config_file() {
            log::info!(
                "git config rewrites GitHub HTTPS to SSH (global); isolating GIT_CONFIG_GLOBAL to force HTTPS"
            );
            envs.insert(
                "GIT_CONFIG_GLOBAL".to_string(),
                config.to_string_lossy().into_owned(),
            );
        }
    }
    if git_scope_has_github_ssh_rewrite(&git, &["--system"]) {
        log::info!(
            "git config rewrites GitHub HTTPS to SSH (system); disabling system git config to force HTTPS"
        );
        envs.insert("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string());
    }
    envs
}

/// 解析插件子进程将使用的 git 可执行文件：Windows 用桌面端已选 Git（系统 Git 或
/// 捆绑 MinGit，见 [`config::get_git_cmd_dir`]，与注入子进程 PATH 的目录一致），
/// Unix 直接用 PATH 上的 `git`。
fn plugin_git_binary(_app_handle: &AppHandle) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        config::get_git_cmd_dir(_app_handle).map(|dir| dir.join("git.exe"))
    }
    #[cfg(not(windows))]
    {
        Some(PathBuf::from("git"))
    }
}

/// 当前环境是否实际可用的 git（供 git 托管插件安装前的预检）。
///
/// 背景：Windows 空白环境由桌面端安装 MinGit 并在子进程 PATH 注入其目录，因此
/// `git_runtime_ready` 在 Windows 有完整判定；而 Linux/macOS 完全依赖系统 git，
/// 不在自动配置范围（`config::git_runtime_ready` 非 Windows 恒真）。一旦系统缺
/// git，`pnpm spawn git` 直接 `ENOENT`，用户只看到裸错误 + 误导性的 allowBuilds
/// 提示（issue #369）。这里实际探测 git 可执行能否运行，供安装 git 托管插件前
/// 给用户可读的失败原因；无法解析二进制 / 启动失败都视为不可用。
pub(crate) fn git_available(app_handle: &AppHandle) -> bool {
    let Some(git) = plugin_git_binary(app_handle) else {
        return false;
    };
    let mut cmd = std::process::Command::new(&git);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：GUI 进程下禁止闪现控制台窗口
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// 运行 `git config <scope> --get-regexp '^url\.'`，判断该作用域的配置里是否存在
/// 把 GitHub HTTP(S) 改写为 SSH 的 insteadOf 规则。无匹配（git 返回 1）或命令
/// 失败都视为不存在。
fn git_scope_has_github_ssh_rewrite(git: &Path, scope: &[&str]) -> bool {
    let mut cmd = std::process::Command::new(git);
    cmd.args(scope).args(["--get-regexp", "^url\\."]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：GUI 进程下禁止闪现控制台窗口
        cmd.creation_flags(0x0800_0000);
    }
    let Ok(output) = cmd.output() else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    has_github_ssh_rewrite_in_output(&String::from_utf8_lossy(&output.stdout))
}

/// 从 `git config --get-regexp '^url\.'` 的输出文本中判定是否存在把 GitHub
/// HTTP(S) 改写为 SSH 的规则（纯函数，便于单测）。
fn has_github_ssh_rewrite_in_output(output: &str) -> bool {
    output.lines().any(rewrite_rule_targets_ssh_github)
}

/// 判定单条 `url.<base>.insteadOf <value>` 输出行是否为「把 GitHub HTTP(S) 地址
/// 改写为 SSH」的有害规则。git 会把 section/key 名小写化（实际形如
/// `url.git@github.com:.insteadof`），subsection 与 value 大小写保留；
/// pushInsteadOf（`.pushinsteadof`）不会命中 `.insteadof` 后缀剥离，天然排除
/// （只影响 push，不影响拉取）。
fn rewrite_rule_targets_ssh_github(line: &str) -> bool {
    let mut parts = line.splitn(2, ' ');
    let (key, value) = match (parts.next(), parts.next()) {
        (Some(k), Some(v)) => (k.to_ascii_lowercase(), v.trim()),
        _ => return false,
    };
    let Some(base) = key
        .strip_prefix("url.")
        .and_then(|k| k.strip_suffix(".insteadof"))
    else {
        return false;
    };
    let ssh_base =
        base.starts_with("git@") || base.starts_with("ssh://") || base.starts_with("git+ssh://");
    ssh_base && github_http_host(value)
}

/// value 是否为 GitHub 的 HTTP(S) URL 前缀（如 `https://github.com/`、
/// `https://github.com`、`http://github.com/`）。
fn github_http_host(value: &str) -> bool {
    let value = value.trim();
    let scheme_end = value.find("://").map(|i| i + 3).unwrap_or(0);
    let host = value[scheme_end..]
        .split('/')
        .next()
        .unwrap_or(&value[scheme_end..]);
    host == "github.com" || host == "www.github.com"
}

/// 在系统临时目录创建一个空配置文件，作为隔离后的 `GIT_CONFIG_GLOBAL`。
/// 文件名带进程号与纳秒时间戳防碰撞（0 字节文件由 OS 临时目录回收，无需主动
/// 清理；GIT_CONFIG_GLOBAL 语义为「仅读取该文件」，空文件即无任何全局配置）。
fn empty_git_config_file() -> Option<PathBuf> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "dsh-gitconfig-{}-{nanos:x}.empty",
        std::process::id()
    ));
    std::fs::write(&path, "").ok()?;
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrite_rule_targets_ssh_github_detects_common_rewrites() {
        // GitHub 官方文档的经典写法：HTTPS -> SSH（scp 风格与 ssh:// 风格）
        assert!(rewrite_rule_targets_ssh_github(
            "url.git@github.com:.insteadof https://github.com/"
        ));
        assert!(rewrite_rule_targets_ssh_github(
            "url.ssh://git@github.com/.insteadof https://github.com/"
        ));
        assert!(rewrite_rule_targets_ssh_github(
            "url.git+ssh://git@github.com/.insteadof https://github.com"
        ));
        // http 同样属于被改写对象；value 无尾斜杠也能命中
        assert!(rewrite_rule_targets_ssh_github(
            "url.git@github.com:.insteadof http://github.com"
        ));
        // subsection 大小写保留、key 小写化后仍可识别
        assert!(rewrite_rule_targets_ssh_github(
            "url.git@Github.com:.insteadOf https://github.com/"
        ));
    }

    #[test]
    fn rewrite_rule_targets_ssh_github_ignores_harmless_rules() {
        // 反向规则（ssh -> https）、非 GitHub 主机、https base 都不隔离
        assert!(!rewrite_rule_targets_ssh_github(
            "url.https://github.com/.insteadof git@github.com:"
        ));
        assert!(!rewrite_rule_targets_ssh_github(
            "url.git@gitlab.example.com:.insteadof https://gitlab.example.com/"
        ));
        assert!(!rewrite_rule_targets_ssh_github(
            "url.ssh://git@github.com/.pushinsteadof https://github.com/"
        ));
        assert!(!rewrite_rule_targets_ssh_github(
            "url.file:///c:/git/.insteadof https://github.com/"
        ));
        // 非 url 键与空行
        assert!(!rewrite_rule_targets_ssh_github("core.autocrlf true"));
        assert!(!rewrite_rule_targets_ssh_github(""));
        assert!(!rewrite_rule_targets_ssh_github("   "));
    }

    #[test]
    fn has_github_ssh_rewrite_in_output_checks_all_lines() {
        let harmful =
            "core.autocrlf true\nuser.name=x\nurl.git@github.com:.insteadof https://github.com/\n";
        assert!(has_github_ssh_rewrite_in_output(harmful));
        let clean =
            "core.autocrlf true\nuser.name=x\nurl.https://github.com/.insteadof git@github.com:\n";
        assert!(!has_github_ssh_rewrite_in_output(clean));
        assert!(!has_github_ssh_rewrite_in_output(""));
    }
}
