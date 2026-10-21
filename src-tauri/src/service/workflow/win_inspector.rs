//! Windows 极简模式遗留注入行清理与 Git Bash PATH 注入。
//!
//! 历史版本曾把社区插件 `dsh-win-terminal-inspector` 的 `- insert:` 条目写进
//! profile 的 `cordis.patch.yml`。该插件已不再使用（DSH 0.1.0-rc.8 起官方运行时
//! 内置 Windows process inspector），但条目不会随依赖卸载被清掉，loader 会去挂载
//! 一个不存在的包（`Cannot find package`）导致启动/热加载报错。`apply` 幂等地剥离
//! 该条目，其余条目与用户注释以外的结构原样保留。
//!
//! `git_bash_bin_dirs` 供服务启动时的 PATH 注入使用（与版本无关）。

#[cfg(windows)]
mod imp {
    use std::fs;
    use std::path::{Path, PathBuf};

    use crate::service::plugin::{parse_patch_layer, render_patch_layer};

    /// 历史注入块的自识别标记。
    const PATCH_MARKER: &str = "dsh-win-terminal-inspector";

    /// 候选 Git Bash 安装位置（常见路径 + 环境变量覆盖）。
    const GIT_BASH_CANDIDATES: [&str; 4] = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    ];

    /// 当前档案的 profile 目录：`<DSH_HOME>/profiles/<当前档案>`。
    fn profile_dir(app_handle: &tauri::AppHandle) -> PathBuf {
        crate::service::profile::profile_dir_of(
            app_handle,
            &crate::service::profile::active_profile(app_handle),
        )
    }

    /// 写入一个文件及其父目录，返回错误信息。
    fn write_file(path: &Path, content: &str) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("create parent dir failed: {e}"))?;
        }
        fs::write(path, content).map_err(|e| format!("write {} failed: {e}", path.display()))
    }

    /// 幂等地从 `cordis.patch.yml` 移除历史注入的 `- insert:` 块。
    ///
    /// 场景：插件卸载后我们写入的挂载行不会随依赖被清掉，loader 会去挂载一个不存在
    /// 的包导致 harness 启动/热加载报错。因此把顶层数组中属于该插件的条目整块删掉，
    /// 其余条目原样保留。无该块时无操作。
    ///
    /// 自愈保证：删除后若数组为空，序列化结果自然是 `[]`（而非纯注释/空——那是
    /// YAML `null`，`parsePatchList` 会抛「必须是顶层数组」直接崩掉启动）。
    pub(super) fn apply_at(profile: &Path) -> Result<(), String> {
        let patch_path = profile.join("cordis.patch.yml");
        let existing = match fs::read_to_string(&patch_path) {
            Ok(s) => s,
            Err(_) => return Ok(()),
        };

        let doc = match parse_patch_list(&existing) {
            Ok(d) => d,
            Err(_) => return Ok(()),
        };
        let serde_yaml::Value::Sequence(seq) = doc else {
            return Ok(());
        };
        if !seq.iter().any(block_is_ours) {
            return Ok(());
        }

        let retained: Vec<serde_yaml::Value> =
            seq.into_iter().filter(|el| !block_is_ours(el)).collect();
        let out = render_patch_layer(&serde_yaml::Value::Sequence(retained))
            .map_err(|e| format!("PATCH_RENDER_FAILED: {e}"))?;
        write_file(&patch_path, &out).map_err(|e| format!("PATCH_PRUNE_FAILED: {e}"))
    }

    /// 把 `cordis.patch.yml` 文本解析为顶层数组 `Value`；空/纯注释视为空数组。
    fn parse_patch_list(content: &str) -> Result<serde_yaml::Value, String> {
        if content.trim().is_empty() {
            return Ok(serde_yaml::Value::Sequence(Vec::new()));
        }
        let doc = parse_patch_layer(content).map_err(|e| format!("PATCH_PARSE_FAILED: {e}"))?;
        match &doc {
            serde_yaml::Value::Sequence(_) => Ok(doc),
            serde_yaml::Value::Null => Ok(serde_yaml::Value::Sequence(Vec::new())),
            _ => Err("PATCH_NOT_ARRAY: cordis.patch.yml must be a top-level array".to_string()),
        }
    }

    /// 顶层数组元素是否为该插件的 `- insert:` 挂载块（按注入标记字符串判定）。
    fn block_is_ours(el: &serde_yaml::Value) -> bool {
        serde_yaml::to_string(el)
            .map(|s| s.contains(PATCH_MARKER))
            .unwrap_or(false)
    }

    /// 在本机查找 Git Bash 可执行文件（环境变量优先，其次常见安装路径）。
    fn find_git_bash() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("DSH_GIT_BASH_PATH") {
            let candidate = PathBuf::from(p);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        GIT_BASH_CANDIDATES
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
    }

    /// 本机 Git Bash 的 bin 目录：bash.exe 所在目录（`<git>\bin`）与
    /// `<git>\usr\bin`（coreutils 所在，`ls`/`sed`/`find` 等）。两者都存在才会
    /// 加入结果；未找到 Git Bash 时返回空。
    pub fn git_bash_bin_dirs() -> Vec<PathBuf> {
        let Some(bash) = find_git_bash() else {
            return Vec::new();
        };
        let mut dirs = Vec::new();
        if let Some(bin_dir) = bash.parent() {
            dirs.push(bin_dir.to_path_buf());
        }
        if let Some(usr_bin) = bash
            .parent()
            .and_then(Path::parent)
            .map(|git_root| git_root.join("usr").join("bin"))
            .filter(|p| p.is_dir())
        {
            dirs.push(usr_bin);
        }
        dirs
    }

    /// 清理 profile 的遗留注入行（幂等）。
    pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
        apply_at(&profile_dir(app_handle))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp_dir(tag: &str) -> PathBuf {
            std::env::temp_dir().join(format!("win-inspector-test-{}-{tag}", std::process::id()))
        }

        #[test]
        fn patch_prune_removes_only_our_insert_block() {
            let dir = temp_dir("i");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            std::fs::write(
                &patch,
                "# user comments\n- insert:\n    - id: win-terminal-inspector\n      name: dsh-win-terminal-inspector\n- id: some-row\n  config:\n    a: 1\n",
            )
            .unwrap();

            apply_at(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            assert!(!out.contains("win-terminal-inspector"));
            assert!(!out.contains("insert:"));
            assert!(out.contains("some-row"));

            apply_at(&dir).unwrap();
            let again = std::fs::read_to_string(&patch).unwrap();
            assert_eq!(out, again);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_prune_self_repairs_comment_only_remainder() {
            let dir = temp_dir("j");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            // 我们的块是唯一的实际内容：删掉后只剩注释，必须补 `[]`，
            // 否则纯注释 YAML 解析为 null，下一次启动会崩溃（顶层数组错误）
            std::fs::write(
                &patch,
                "# Your patch layer for this dsh profile\n- insert:\n    - id: win-terminal-inspector\n      name: dsh-win-terminal-inspector\n",
            )
            .unwrap();

            apply_at(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            assert!(!out.contains("win-terminal-inspector"));
            assert!(out.contains("[]\n"));

            apply_at(&dir).unwrap();
            let again = std::fs::read_to_string(&patch).unwrap();
            assert_eq!(out, again);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_prune_leaves_foreign_patch_untouched() {
            let dir = temp_dir("k");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            let content = "- id: some-row\n  config:\n    a: 1\n";
            std::fs::write(&patch, content).unwrap();

            apply_at(&dir).unwrap();
            assert_eq!(std::fs::read_to_string(&patch).unwrap(), content);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_prune_keeps_js_expressions() {
            let dir = temp_dir("l");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            std::fs::write(
                &patch,
                "- insert:\n    - id: win-terminal-inspector\n      name: dsh-win-terminal-inspector\n- id: some-row\n  config:\n    token: !!js process.env.TOKEN\n",
            )
            .unwrap();

            apply_at(&dir).unwrap();
            assert_eq!(
                std::fs::read_to_string(&patch).unwrap(),
                "- id: some-row\n  config:\n    token: !!js process.env.TOKEN\n"
            );

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn git_bash_dirs_follow_finder() {
            match find_git_bash() {
                Some(bash) => {
                    let dirs = git_bash_bin_dirs();
                    assert!(dirs.contains(&bash.parent().unwrap().to_path_buf()));
                }
                None => assert!(git_bash_bin_dirs().is_empty()),
            }
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// 非 Windows 平台无操作：补丁文件由 dsh 自身管理。
    pub fn apply(_app_handle: &tauri::AppHandle) -> Result<(), String> {
        Ok(())
    }

    pub(super) fn apply_at(_profile: &std::path::Path) -> Result<(), String> {
        Ok(())
    }

    /// 非 Windows 无 Git Bash bin 目录。
    pub fn git_bash_bin_dirs() -> Vec<std::path::PathBuf> {
        Vec::new()
    }
}

/// 清理 profile 中遗留的 Windows 终端检查插件注入行（仅 Windows 生效，幂等）。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    imp::apply(app_handle)
}

pub(crate) fn apply_at(profile: &std::path::Path) -> Result<(), String> {
    imp::apply_at(profile)
}

/// 本机 Git Bash 的 bin 目录（供服务 PATH 注入）。
///
/// 返回 bash.exe 所在目录（`<git>\bin`）与 `<git>\usr\bin`（`ls`/`sed`/`find` 等
/// coreutils 所在）。原因：persistent bash 跑在 `--noprofile --norc` 下不执行
/// profile 脚本，PATH 完全继承服务进程；若服务 PATH 不含 Git 目录，会话内只有
/// 内建命令、外部命令全部 `command not found`（MSYS 运行时在部分环境下不会自动
/// 补 `/usr/bin`）。仅 Windows 且找到 Git Bash 时返回非空；非 Windows 返回空。
pub fn git_bash_bin_dirs() -> Vec<std::path::PathBuf> {
    imp::git_bash_bin_dirs()
}
