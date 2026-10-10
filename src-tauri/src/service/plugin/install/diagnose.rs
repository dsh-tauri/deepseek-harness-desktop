//! 失败输出解析：识别网络错误（代理/DNS/连接/TLS）、git 传输层失败
//! （HTTPS→SSH 回退提示）、pnpm store 布局不兼容（`ERR_PNPM_UNEXPECTED_STORE`
//! 一族）、dsh 版本兼容性拒绝（逐条精确 `包名@版本` + 运行时版本，供用户授权），
//! 并从输出中挑选可展示的错误消息（ANSI 清洗、命中错误标记的行优先、截断）。

/// 给非空诊断文本加 `: ` 前缀，便于直接拼进错误消息（空文本返回空串）。
pub(super) fn diagnostic_suffix(detail: &str) -> String {
    if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    }
}

/// 命中即视为可展示错误行的标记。除 pnpm/Node 的常规错误外，还覆盖「命令或
/// shim 不可用」一类失败：cmd.exe 的 `'pnpm' is not recognized…`、shim 的
/// `[pnpm] pnpm not found…`、批处理跳转失败 `The system cannot find the batch
/// label…`，以及中文 cmd 文案。这些行不含 `error`/`failed`，一旦被过滤掉，
/// 用户只会看到 dsh 包装后的 `pnpm failed in profile directory`，真实原因
/// （shim 不可用）永远不可见。
const ERROR_MARKERS: [&str; 14] = [
    "ERR_",
    "error",
    "Error",
    "failed",
    "✖",
    "warning",
    "not recognized",
    "not found",
    "No such file",
    "cannot find",
    "Cannot find",
    "找不到",
    "无法",
    "不是内部或外部命令",
];

/// 从 dsh/pnpm 失败输出中提取可展示的错误消息：优先 git 传输层提示；
/// 否则挑出命中错误标记的行（最多 8 行），没有则取输出尾部，ANSI 清洗后
/// 截断到 2000 字符。
pub(super) fn pick_error_message(output: &str, hint: Option<&str>) -> String {
    if let Some(hint) = hint {
        return hint.to_string();
    }
    let cleaned: Vec<String> = output
        .split('\n')
        .filter_map(|line| {
            let trimmed = strip_ansi(line);
            let trimmed = trimmed.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .filter(|line| {
            ERROR_MARKERS.iter().any(|marker| line.contains(marker))
                || line.split_whitespace().any(|word| {
                    let code = word
                        .strip_prefix('[')
                        .and_then(|word| word.strip_suffix(']'))
                        .or_else(|| word.strip_suffix(':'));
                    code.is_some_and(|code| {
                        code.len() > 1
                            && code.starts_with('E')
                            && code.bytes().all(|byte| {
                                byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_'
                            })
                    })
                })
        })
        .take(8)
        .collect();
    let base = if cleaned.is_empty() {
        output.trim().to_string()
    } else {
        cleaned.join("\n")
    };
    base.chars().take(2000).collect()
}

/// 去除 ANSI 转义序列（`\x1B[...m`，含颜色/样式码）。
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' && chars.peek() == Some(&'[') {
            chars.next(); // '['
            while let Some(&n) = chars.peek() {
                if n.is_ascii_digit() || n == ';' {
                    chars.next();
                } else {
                    break;
                }
            }
            if chars.peek() == Some(&'m') {
                chars.next();
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// 真实的发布时长策略违规里的一条记录（[`policy_blocked_versions`] 的解析结果）。
///
/// 与 [`IncompatibleVersion`] 区分：这里说的是 pnpm 的 `minimumReleaseAge` 门禁，不是
/// dsh 的版本兼容性。豁免写入档案的 `minimumReleaseAgeExclude`（精确 `包名@版本`），
/// 因此授权键只需要这两个字段，运行时版本与之无关。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PolicyBlockedVersion {
    /// `package.json` 的包名（scoped 包含 `@scope/` 前缀）
    pub name: String,
    pub version: String,
}

/// 从失败输出里提取**真实**的发布时长策略违规条目。
///
/// pnpm 11 有两种 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`：
/// - 解析阶段（`<包名>@<版本> was published recently (released …; minimumReleaseAge is …)`）
///   —— pnpm 自己挑中了太新的版本，回落到旧版本即可，通常不报错；
/// - lockfile 校验阶段（`<包名>@<版本> was published at <时间>, within the minimumReleaseAge
///   cutoff (<时间>)`）—— 档案已经声明/装了这个版本，而策略不接受它，于是**每一次**
///   插件操作都在这里硬失败（issue #222 的另一面）。
///
/// 只认后一种：它带了 pnpm **真的拿到**的发布时间（`was published at <ISO>`），因此能
/// 确定不是「元数据拉不到被误判」——那种情况见 [`policy_verification_network_failure`]，
/// 属于可重试的网络问题。解析结果用于给用户一条可操作的出路（授权这些精确版本），
/// 解析失败一律返回空，退回普通失败展示。
pub(super) fn policy_blocked_versions(output: &str) -> Vec<PolicyBlockedVersion> {
    let mut found: Vec<PolicyBlockedVersion> = Vec::new();
    for line in output.split('\n') {
        let stripped = strip_ansi(line);
        let Some((key, rest)) = stripped.split_once(" was published at ") else {
            continue;
        };
        // 必须同时是「按发布时间判定的违规」：缺了这句说明不是时间门禁（文案改版也走这里）
        if !rest.contains("within the minimumReleaseAge cutoff") {
            continue;
        }
        // 版本号自身不含 `@`，按最后一个 `@` 切开包名与版本（scoped 包名以 `@` 开头）
        let Some((name, version)) = key.trim().rsplit_once('@') else {
            continue;
        };
        let name = name.trim();
        let version = version.trim();
        if name.is_empty() || version.is_empty() {
            continue;
        }
        let entry = PolicyBlockedVersion {
            name: name.to_string(),
            version: version.to_string(),
        };
        if !found.contains(&entry) {
            found.push(entry);
        }
    }
    found
}

/// dsh 版本兼容性拒绝里的一条记录（[[`incompatible_versions`]] 的解析结果）。
///
/// 授权（`dsh plugin allow-version`）只认**精确**的包名 + 版本 + 运行时版本三元组，
/// 因此三者都必须原样带出，前端据此逐项向用户确认风险后再授权。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IncompatibleVersion {
    /// `package.json` 的包名（scoped 包含 `@scope/` 前缀）
    pub name: String,
    pub version: String,
    /// 被拒时所处的 dsh 运行时精确版本：授权必须与它完全一致，否则 dsh 拒绝写入
    pub runtime_version: String,
}

/// 从安装失败输出里提取版本兼容性拒绝条目。
///
/// dsh 在 pnpm 之前核对每个待装插件声明的 DSH peer 依赖，未授权精确版本时整批拒绝
/// （不下载、不构建），输出里逐条印出
/// `Plugin <包名>@<版本> is incompatible with dsh <运行时版本>: peerDependencies …`。
/// 这是唯一同时给出三者（可授权键）的地方：`pick_error_message` 的行标记过滤会把它
/// 并进一大段纯文本，用户只能自己从中抄出版本去敲 CLI。解析失败一律返回空——空结果
/// 只是退回原来的「安装失败」展示，绝不误报成可授权项。
pub(super) fn incompatible_versions(output: &str) -> Vec<IncompatibleVersion> {
    let mut found: Vec<IncompatibleVersion> = Vec::new();
    for line in output.split('\n') {
        let stripped = strip_ansi(line);
        // 第一条警告与 `dsh: installation rejected: ` 同处一行（dsh 用同一个模板拼出
        // 整段拒绝说明），因此只能在行内定位而不能要求行首匹配；后续条目各自成行。
        let Some(start) = stripped.find("Plugin ") else {
            continue;
        };
        let Some((key, rest)) = stripped[start + "Plugin ".len()..].split_once(" is incompatible with dsh ")
        else {
            continue;
        };
        // 版本号自身不含 `@`，按最后一个 `@` 切开包名与版本（scoped 包名以 `@` 开头）
        let Some((name, version)) = key.rsplit_once('@') else {
            continue;
        };
        let runtime_version = rest.split(':').next().unwrap_or_default().trim();
        // 运行时版本必须以数字开头：这样即使后续文案改用别的分隔符，也不会把
        // 冒号后的说明文字当成版本号带进授权命令
        if name.is_empty()
            || version.is_empty()
            || !runtime_version.starts_with(|c: char| c.is_ascii_digit())
        {
            continue;
        }
        let entry = IncompatibleVersion {
            name: name.to_string(),
            version: version.to_string(),
            runtime_version: runtime_version.to_string(),
        };
        if !found.contains(&entry) {
            found.push(entry);
        }
    }
    found
}

/// 从 pnpm 失败输出里识别网络错误，返回稳定提示，避免把网络问题误报为 dsh
/// 子进程错误。代理、DNS、连接超时和 TLS 失败都属于此类。
pub(super) fn network_error_hint(output: &str) -> Option<&'static str> {
    const SIGNALS: &[&str] = &[
        "eai_again",
        "enotfound",
        "econnrefused",
        "econnreset",
        "etimedout",
        "network timeout",
        "network request failed",
        "fetch failed",
        "unable to verify the first certificate",
        "self signed certificate",
        "socket hang up",
        "could not resolve host",
        "failed to connect",
        "connection timed out",
        "connection reset",
    ];
    let lower = output.to_ascii_lowercase();
    SIGNALS
        .iter()
        .any(|signal| lower.contains(signal))
        .then_some("网络连接失败，请检查网络或代理设置后重试。")
}

/// pnpm 的 lockfile supply-chain 校验（`minimumReleaseAge`）要按 registry 元数据核对
/// 每个条目的发布时间；元数据拉不到时 pnpm 会把条目**直接判成违规**并以
/// `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 中止，输出里唯一的线索只有
/// `[WARN] GET https://registry.npmjs.org/<pkg> error (unknown)` —— 用户看到的
/// 「违反供应链策略」其实是网络问题（实测 `undici@7.29.1` 已发布 21 天仍被判违规）。
/// 命中即说明重跑同一条命令大概率能过，调用方据此重试。
///
/// 真·发布时间违规（版本确实太新）不带任何拉取失败信号，绝不命中：那种失败重试无用，
/// 也不该把供应链信号降级成网络问题。
///
/// 判据收紧到「拿不到真实发布时间」：输出里已经能解析出违规条目与它的发布时间
/// （[`policy_blocked_versions`]）时直接返回 false——那说明 pnpm 拿到了元数据、判定是
/// 真的，重跑同一条命令只会再失败一次，而且每次都要停服/重启。
///
/// 传入的必须是**单次尝试**的输出（`run_plugin_with_allow_build_retry` 为此额外返回
/// 最后一次尝试的输出）：把历次重试拼接起来判断时，早先一次的网络字样会给最终一次的真·
/// 违规「背书」，正好破坏上面这条边界。
pub(super) fn policy_verification_network_failure(output: &str) -> bool {
    if !policy_blocked_versions(output).is_empty() {
        return false;
    }
    let lower = output.to_ascii_lowercase();
    if !lower.contains("err_pnpm_minimum_release_age_violation") {
        return false;
    }
    const FETCH_FAILURES: [&str; 4] = [
        "error (unknown)",
        "will retry in",
        "fetch failed",
        "failed to fetch",
    ];
    FETCH_FAILURES.iter().any(|signal| lower.contains(signal))
}

pub(super) fn git_transport_hint(output: &str) -> Option<&'static str> {
    const SIGNALS: &[(&str, &str)] = &[
        (
            "spawn git enoent",
            "Git is not installed or not on PATH (pnpm could not spawn git: ENOENT). Install git (e.g. Debian/Ubuntu: `sudo apt install git`; macOS: `brew install git`) or uncheck git-hosted plugins and retry.",
        ),
        (
            "command failed with enoent: git",
            "Git is not installed or not on PATH (pnpm could not run git: ENOENT). Install git (e.g. Debian/Ubuntu: `sudo apt install git`; macOS: `brew install git`) or uncheck git-hosted plugins and retry.",
        ),
        (
            "host key verification failed",
            "git fell back to SSH and could not verify GitHub's host key (no known_hosts entry; the process ran non-interactively). Make sure GitHub is reachable over HTTPS.",
        ),
        (
            "permission denied (publickey)",
            "git reached GitHub over SSH instead of HTTPS (Permission denied (publickey)) — usually your git config rewrites GitHub HTTPS to SSH (url.<base>.insteadOf) while no SSH key is configured. The desktop app isolates git config to force HTTPS for plugin installs; if you still see this, remove that rewrite (git config --global --unset-all 'url.git@github.com:.insteadOf') or configure an SSH key.",
        ),
        (
            "could not read from remote repository",
            "pnpm could not read from the git remote — commonly a git+ssh transport failure. Ensure GitHub is reachable over HTTPS.",
        ),
        (
            "ssh: connect to host",
            "pnpm tried to reach GitHub over SSH (port 22) and the connection was refused. Use HTTPS instead.",
        ),
    ];
    let lower = output.to_ascii_lowercase();
    SIGNALS
        .iter()
        .find(|(sig, _)| lower.contains(sig))
        .map(|(_, hint)| *hint)
}

/// pnpm `reportUnexpectedStore` / `reportUnexpectedVirtualStoreDir` 正文里分别给出
/// 「档案记录的位置」与「当前解析出的位置」，路径用双引号包裹。
const RECORDED_PATH_MARKERS: &[&str] = &[
    "currently linked from the store at ",
    "symlinked from the virtual store directory at ",
];
const CURRENT_PATH_MARKERS: &[&str] = &[
    "now wants to use the store at ",
    "now wants to use the virtual store at ",
];

/// 从 pnpm 失败输出里识别 store 布局不兼容（`ERR_PNPM_UNEXPECTED_STORE`、
/// `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`、`ERR_PNPM_STORE_BREAKING_CHANGE`、
/// `ERR_PNPM_MODULES_BREAKING_CHANGE`），返回带双方路径与处置办法的指引。
///
/// pnpm 只在正文里给出「档案记录的 store」与「当前 store」两条路径，而
/// [`pick_error_message`] 的标记行过滤把它们全部丢掉（正文两行都不含
/// `ERR_`/`error`/`failed` 标记），用户最终只看到
/// `Unexpected store location (This error may happen if the node_modules was installed
/// with a different major version of pnpm)` —— 插件装不上却看不到任何原因。这里直接从
/// 原始输出把两条路径捞出来。
pub(super) fn store_mismatch_hint(output: &str) -> Option<String> {
    const CODES: &[&str] = &[
        "ERR_PNPM_UNEXPECTED_STORE",
        "ERR_PNPM_UNEXPECTED_VIRTUAL_STORE",
        "ERR_PNPM_STORE_BREAKING_CHANGE",
        "ERR_PNPM_MODULES_BREAKING_CHANGE",
    ];
    if !CODES.iter().any(|code| contains_error_code(output, code)) {
        return None;
    }
    Some(match (
        quoted_after(output, RECORDED_PATH_MARKERS),
        quoted_after(output, CURRENT_PATH_MARKERS),
    ) {
        (Some(recorded), Some(current)) => format!(
            "The profile's node_modules was created by a different pnpm major version: it is linked from the store at \"{recorded}\", but the pnpm now in use resolves the store at \"{current}\". Install/update cannot succeed until those match — install the pnpm major version that created this profile, or delete the profile's node_modules directory and retry so pnpm rebuilds it with the current version."
        ),
        _ => "The profile's node_modules is not compatible with the pnpm version now in use (pnpm refused before installing). Install the pnpm major version that created this profile, or delete the profile's node_modules directory and retry so pnpm rebuilds it with the current version.".to_string(),
    })
}

/// 取 `markers` 中最早出现的那一条之后紧跟的双引号路径。
fn quoted_after(output: &str, markers: &[&str]) -> Option<String> {
    let (index, marker) = markers
        .iter()
        .filter_map(|marker| output.find(marker).map(|index| (index, *marker)))
        .min_by_key(|(index, _)| *index)?;
    let rest = output[index + marker.len()..].strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// 完整错误码匹配（大小写不敏感）：`ERR_PNPM_UNEXPECTED_STORE_EXTRA` 这类更长变体
/// 不算命中 —— 命中即会把误导性的 store 指引顶到真正的失败原因之前，宁可 fail closed。
fn contains_error_code(output: &str, code: &str) -> bool {
    let upper = output.to_ascii_uppercase();
    let mut from = 0;
    while let Some(index) = upper[from..].find(code) {
        let end = from + index + code.len();
        let boundary = upper[end..]
            .chars()
            .next()
            .is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '_'));
        if boundary {
            return true;
        }
        from = from + index + 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_error_message_preserves_filesystem_cause_before_cli_summary() {
        for cause in [
            "[EISDIR] EISDIR: illegal operation on a directory, readlink 'F:/apps/.dsh/profiles/tauri/node_modules/dsh-tauri'",
            "EPERM: operation not permitted, unlink 'C:/apps/plugin/package.json'",
            "[ENOTEMPTY] ENOTEMPTY: directory not empty, rmdir 'C:/apps/plugin'",
            "EACCES: permission denied, open '/tmp/profile/package.json'",
            "ENOSPC: no space left on device, write",
        ] {
            let output = format!(
                "Progress: resolved 1, reused 0\n\u{1b}[31m{cause}\u{1b}[0m\ndsh: plugin command failed; diagnostics: C:/profile/.plugin-manager/logs/operation-test/pnpm.log\n"
            );
            assert_eq!(
                pick_error_message(&output, None),
                format!("{cause}\ndsh: plugin command failed; diagnostics: C:/profile/.plugin-manager/logs/operation-test/pnpm.log")
            );
        }
    }

    #[test]
    fn pick_error_message_does_not_promote_errno_in_progress_paths() {
        let output = "Progress: unpacking C:/EISDIR/cache\nResolved EACCES-helper@1.0.0\ndsh: plugin command failed; diagnostics: C:/profile/pnpm.log\n";
        assert_eq!(
            pick_error_message(output, None),
            "dsh: plugin command failed; diagnostics: C:/profile/pnpm.log"
        );
    }

    #[test]
    fn diagnostic_suffix_preserves_non_allowbuilds_failure() {
        assert_eq!(diagnostic_suffix(""), "");
        assert_eq!(
            diagnostic_suffix("ERR_PNPM_LINKING_FAILED: stale symlink"),
            ": ERR_PNPM_LINKING_FAILED: stale symlink"
        );
    }

    // ---- dsh 版本兼容性拒绝：逐条精确版本授权 ----

    /// 用户实测拒绝输出（dsh 0.2.0-rc.1，预装引导一次装两个插件、双双被拒）。
    const INCOMPATIBLE_OUTPUT: &str = "\ndsh: installation rejected: Plugin dsh-better-sidebar@0.22.1 is incompatible with dsh 0.2.0-rc.1: peerDependencies {\"@deepseek-ai/dsh-llm\":\"^0.1.7-rc.1\"}. Running it may cause crashes or data loss. Update the plugin or install a plugin version compatible with this dsh runtime.\ndsh: nothing was installed.\ndsh: to accept the risk, run: dsh plugin --profile core-020 allow-version dsh-better-sidebar@0.22.1 --dsh-version 0.2.0-rc.1 --accept-risk\n";

    #[test]
    fn incompatible_versions_extracts_exact_grantable_triple() {
        assert_eq!(
            incompatible_versions(INCOMPATIBLE_OUTPUT),
            vec![IncompatibleVersion {
                name: "dsh-better-sidebar".to_string(),
                version: "0.22.1".to_string(),
                runtime_version: "0.2.0-rc.1".to_string(),
            }]
        );
    }

    #[test]
    fn incompatible_versions_reads_header_line_and_own_lines_together() {
        // 真实形状：dsh 把第一条警告与 `installation rejected: ` 拼在同一行，其余各自成行
        let out = concat!(
            "\ndsh: installation rejected: Plugin dsh-better-sidebar@0.22.1 is incompatible with dsh 0.2.0-rc.1: peerDependencies {\"@deepseek-ai/dsh-llm\":\"^0.1.7-rc.1\"}. Running it may cause crashes or data loss.\n",
            "Plugin dsh-rewind-plugin@0.14.0 is incompatible with dsh 0.2.0-rc.1: peerDependencies {\"@deepseek-ai/dsh-fs\":\"^0.1.7-rc.2\"}. Running it may cause crashes or data loss.\n",
            "dsh: nothing was installed.\n",
        );
        assert_eq!(
            incompatible_versions(out),
            vec![
                IncompatibleVersion {
                    name: "dsh-better-sidebar".to_string(),
                    version: "0.22.1".to_string(),
                    runtime_version: "0.2.0-rc.1".to_string(),
                },
                IncompatibleVersion {
                    name: "dsh-rewind-plugin".to_string(),
                    version: "0.14.0".to_string(),
                    runtime_version: "0.2.0-rc.1".to_string(),
                },
            ]
        );
    }

    #[test]
    fn incompatible_versions_keeps_scoped_package_name() {
        let out = "dsh: installation rejected: Plugin @wenbin_wb/dsh-bridge@1.2.3 is incompatible with dsh 0.2.0-rc.1: peerDependencies {}.\n";
        assert_eq!(
            incompatible_versions(out),
            vec![IncompatibleVersion {
                name: "@wenbin_wb/dsh-bridge".to_string(),
                version: "1.2.3".to_string(),
                runtime_version: "0.2.0-rc.1".to_string(),
            }]
        );
    }

    #[test]
    fn incompatible_versions_dedupes_repeated_refusals() {
        // 重试拼接的整串里同一插件会出现多次：授权列表只应留一条
        let repeated = format!("{INCOMPATIBLE_OUTPUT}{INCOMPATIBLE_OUTPUT}");
        assert_eq!(incompatible_versions(&repeated).len(), 1);
    }

    #[test]
    fn incompatible_versions_ignores_other_failures_and_malformed_lines() {
        assert!(incompatible_versions("ERR_PNPM_FETCH_404 registry error").is_empty());
        assert!(incompatible_versions("").is_empty());
        assert!(incompatible_versions(
            "dsh: plugin command failed; diagnostics: /tmp/pnpm.log\n"
        )
        .is_empty());
        // 运行时版本不是版本号（文案改版）时宁可放弃解析，也不把说明文字当版本带进授权
        assert!(incompatible_versions(
            "Plugin foo@1.0.0 is incompatible with dsh unknown-runtime: peerDependencies {}."
        )
        .is_empty());
        assert!(incompatible_versions(
            "Plugin foo is incompatible with dsh 0.2.0-rc.1: peerDependencies {}."
        )
        .is_empty());
    }

    // ---- git 传输层错误识别（区别于 allowBuilds 门禁）----

    /// shim 不可用时 cmd.exe / shim 自己的原话，不含 `error`/`failed`：
    /// 若被过滤掉，用户只剩 dsh 的 `pnpm failed in profile directory`。
    #[test]
    fn pick_error_message_keeps_shim_unavailable_lines() {
        let out = "dsh: pnpm failed in profile directory C:\\Users\\小蔡\\.dsh\\profiles\\safe\n\
                   [pnpm] pnpm not found. Please run DeepSeek Harness Desktop to install it first.\n";
        let picked = pick_error_message(out, None);
        assert!(
            picked.contains("pnpm not found"),
            "shim diagnostic must survive: {picked}"
        );

        let cmd = "'pnpm' is not recognized as an internal or external command,\noperable program or batch file.\n";
        assert!(pick_error_message(cmd, None).contains("not recognized"));

        let label = "The system cannot find the batch label specified - no_pnpm\n";
        assert!(pick_error_message(label, None).contains("batch label"));
    }

    #[test]
    fn pick_error_message_still_drops_noise() {
        let out = "Progress: resolved 1, reused 0, downloaded 0\n\
                   ERR_PNPM_LINKING_FAILED: stale symlink\n\
                   Done in 2.8s\n";
        let picked = pick_error_message(out, None);
        assert!(picked.contains("ERR_PNPM_LINKING_FAILED"));
        assert!(!picked.contains("Done in"), "progress noise must be dropped: {picked}");
    }

    #[test]
    fn git_transport_hint_detects_host_key_failure() {
        let out = "git ls-remote \"git+ssh://git@github.com/foo.git\" HEAD\nHost key verification failed.\nfatal: Could not read from remote repository.\n";
        assert!(git_transport_hint(out).is_some());
    }

    #[test]
    fn git_transport_hint_detects_publickey_and_ssh() {
        assert!(git_transport_hint("git@github.com: Permission denied (publickey)").is_some());
        assert!(
            git_transport_hint("ssh: connect to host github.com port 22: Connection refused")
                .is_some()
        );
    }

    #[test]
    fn git_transport_hint_detects_enoent_missing_git() {
        // issue #369：Linux 无系统 git 时 pnpm spawn git 直接 ENOENT
        let out = "[ENOENT] Command failed with ENOENT: git ls-remote 'git+ssh://git@github.com/omdsh-dev/DSH-better-sidebar.git' HEAD\nspawn git ENOENT\n";
        assert!(git_transport_hint(out).is_some());
        // 单独一行也命中
        assert!(git_transport_hint("spawn git ENOENT").is_some());
    }

    #[test]
    fn git_transport_hint_none_for_allowbuilds_output() {
        // allowBuilds 场景（prepare 构建被拦）不应误判为传输层错误
        let out = "[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] ...\nallowBuilds:\n  node-pty: true\n";
        assert!(git_transport_hint(out).is_none());
    }

    // ---- lockfile supply-chain 校验因 registry 元数据拉取失败而误判违规 ----

    /// 用户实测（pnpm 11.7.0，`undici@7.29.1` 已发布 21 天）：判定违规的唯一线索是
    /// registry 元数据请求失败，而不是发布时间。
    const POLICY_VERIFICATION_FETCH_FAILURE: &str = "✗ Lockfile failed supply-chain policy check (4 entries in 2.7s) [ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]\n1 lockfile entries failed verification:\n[WARN] GET https://registry.npmjs.org/undici error (unknown). Will retry in 10 seconds. 2 retries left.\n";

    #[test]
    fn policy_verification_failure_detects_registry_fetch_error() {
        assert!(policy_verification_network_failure(
            POLICY_VERIFICATION_FETCH_FAILURE
        ));
    }

    #[test]
    fn policy_verification_failure_ignores_real_release_age_violation() {
        // 真违规会给出发布时间与阈值、没有拉取失败信号：重试无用，也不该改判成网络问题。
        let real = "[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] undici@7.29.1 was published recently (released 5 minutes ago; minimumReleaseAge is 1440)\n";
        assert!(!policy_verification_network_failure(real));
        assert!(!policy_verification_network_failure(
            "ERR_PNPM_FETCH_404 registry error"
        ));
        assert!(!policy_verification_network_failure(""));
    }

    // ---- 真实的发布时长违规（档案已声明太新的版本 → 每次插件操作都硬失败）----

    /// 用户实测（pnpm 11.7.0，档案 spec 被升到 `^2.11.2`）：违规条目带的是 pnpm **真的
    /// 拿到**的发布时间；后面那些 `UND_ERR_DESTROYED` 拉取失败是进程被 kill 的后果，
    /// 不是原因。
    const REAL_POLICY_VIOLATION: &str = "? Verifying lockfile against supply-chain policies (201 entries)...\n✗ Lockfile failed supply-chain policy check (201 entries in 1.5s)\n[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:\n@wenbin_wb/dsh-bridge@2.11.2 was published at 2026-09-28T14:14:07.937Z, within the minimumReleaseAge cutoff (2026-09-27T15:50:11.385Z)\n\nProgress: resolved 48, reused 0, downloaded 0, added 0\n[WARN] GET https://registry.npmjs.org/axios error (UND_ERR_DESTROYED). Will retry in 10 seconds. 2 retries left.\n";

    #[test]
    fn policy_blocked_versions_reads_the_real_lockfile_violation() {
        let blocked = policy_blocked_versions(REAL_POLICY_VIOLATION);

        assert_eq!(blocked.len(), 1);
        assert_eq!(blocked[0].name, "@wenbin_wb/dsh-bridge");
        assert_eq!(blocked[0].version, "2.11.2");
    }

    #[test]
    fn policy_blocked_versions_dedupes_and_ignores_other_output() {
        let output = format!(
            "{REAL_POLICY_VIOLATION}{}\n",
            "lodash@4.17.21 was published at 2026-09-28T10:00:00.000Z, within the minimumReleaseAge cutoff (2026-09-27T15:50:11.385Z)"
        );
        let blocked = policy_blocked_versions(&output);

        assert_eq!(blocked.len(), 2);
        assert_eq!(blocked[1].name, "lodash");
        assert_eq!(blocked[1].version, "4.17.21");

        // 解析阶段那种「pnpm 自己挑中太新版本」的文案：没有精确发布时间，不作为可授权项
        let resolution_form = "[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] undici@7.29.1 was published recently (released 5 minutes ago; minimumReleaseAge is 1440)";
        assert!(policy_blocked_versions(resolution_form).is_empty());
        // 有时间但没有门禁判据（文案改版）时宁可退回普通失败
        let no_cutoff = "undici@7.29.1 was published at 2026-09-28T10:00:00.000Z";
        assert!(policy_blocked_versions(no_cutoff).is_empty());
    }

    #[test]
    fn genuine_policy_violation_is_not_retried_as_a_network_failure() {
        // 关键回归：真违规后面跟着的拉取失败（进程被 kill 的后果）不能把它改判成网络问题，
        // 否则每次插件操作都会白停服重试 4 轮，还给出「registry 元数据拉取失败」的错因。
        assert!(!policy_verification_network_failure(REAL_POLICY_VIOLATION));
    }

    // ---- pnpm store 布局不兼容（ERR_PNPM_UNEXPECTED_STORE 一族）----

    /// pnpm 的真实原始输出：档案由 pnpm 10 装好，当前 pnpm 11 解析出另一份 store。
    const UNEXPECTED_STORE_OUTPUT: &str = r#"
 ERR_PNPM_UNEXPECTED_STORE  Unexpected store location

The dependencies at "/Users/gao/.dsh/profiles/web/node_modules" are currently linked from the store at "/Users/gao/Library/pnpm/store/v10".

pnpm now wants to use the store at "/Users/gao/Library/pnpm/store/v11" to link dependencies.

If you want to use the new store location, reinstall your dependencies with "pnpm install".

You may change the global store location by running "pnpm config set store-dir <dir> --global".
(This error may happen if the node_modules was installed with a different major version of pnpm)
"#;

    #[test]
    fn store_mismatch_hint_names_both_store_paths() {
        let hint = store_mismatch_hint(UNEXPECTED_STORE_OUTPUT).expect("store hint");
        assert!(hint.contains("/Users/gao/Library/pnpm/store/v10"));
        assert!(hint.contains("/Users/gao/Library/pnpm/store/v11"));
        assert!(hint.contains("node_modules"));
    }

    #[test]
    fn store_mismatch_hint_covers_virtual_store_and_pathless_codes() {
        let virtual_store = r#"
 ERR_PNPM_UNEXPECTED_VIRTUAL_STORE  Unexpected virtual store location

The dependencies at "/p/node_modules" are currently symlinked from the virtual store directory at "/old/.pnpm".

pnpm now wants to use the virtual store at "/new/.pnpm" to link dependencies from the store.
"#;
        let hint = store_mismatch_hint(virtual_store).expect("virtual store hint");
        assert!(hint.contains("/old/.pnpm"));
        assert!(hint.contains("/new/.pnpm"));

        // 正文里没有双方路径（breaking change 一族）也要给指引，而不是退回裸标题
        let pathless = r#"[ERR_PNPM_MODULES_BREAKING_CHANGE] The node_modules structure at "/p/node_modules" is not compatible with the current pnpm version. Run "pnpm install --force" to recreate node_modules."#;
        assert!(store_mismatch_hint(pathless).is_some());
    }

    #[test]
    fn store_mismatch_hint_none_for_other_failures() {
        assert!(store_mismatch_hint("ERR_PNPM_NO_MATCHING_VERSION: no version").is_none());
        assert!(store_mismatch_hint("").is_none());
        // 前缀相同的更长错误码不算命中（fail closed，别把 store 指引顶到真因之前）
        assert!(store_mismatch_hint("[ERR_PNPM_UNEXPECTED_STORE_EXTRA] other failure").is_none());
        assert!(store_mismatch_hint("[ERR_PNPM_UNEXPECTED_VIRTUAL_STORE_X] other").is_none());
        // 完整码（方括号/空格/行尾都算边界）仍命中
        assert!(store_mismatch_hint("[ERR_PNPM_UNEXPECTED_STORE] Unexpected store location").is_some());
        assert!(store_mismatch_hint(" ERR_PNPM_UNEXPECTED_STORE  x").is_some());
    }

    #[test]
    fn pick_error_message_drops_store_paths_which_is_why_the_hint_exists() {
        // 回归说明：标记行过滤把两条 store 路径都丢掉（都不含 ERR_/error/failed），
        // 用户只剩标题与末行括号说明 —— 必须由 store_mismatch_hint 兜住。
        let picked = pick_error_message(UNEXPECTED_STORE_OUTPUT, None);
        assert!(picked.contains("Unexpected store location"));
        assert!(!picked.contains("store/v10"));
        assert!(!picked.contains("store/v11"));
    }
}
