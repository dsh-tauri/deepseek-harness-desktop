//! Unix shell rc 幂等块更新：向 `~/.zshrc` / `~/.bashrc` 注入/移除
//! `~/.local/bin` 的 PATH 导出块（备份 + 失败回滚）。
//!
//! 注入/移除（依赖 `AppHandle::path()`）仅 Unix 编译；纯文本操作辅助（upsert /
//! strip / 备份写回）在全部平台编译（Windows 上按 dead_code 允许，供测试覆盖）。

use std::fs;
#[cfg(not(windows))]
use tauri::{AppHandle, Manager};

/// shell rc 注入标记（用于幂等增删）
#[cfg_attr(windows, allow(dead_code))]
pub(super) const RC_MARK_START: &str = "# >>> deepseek-harness dsh >>>";
#[cfg_attr(windows, allow(dead_code))]
pub(super) const RC_MARK_END: &str = "# <<< deepseek-harness dsh <<<";

/// Unix 下需要写入 PATH 导出的 rc 文件（按顺序处理）
#[cfg_attr(windows, allow(dead_code))]
pub(super) const RC_FILES: [&str; 2] = [".zshrc", ".bashrc"];

/// Unix：向 `~/.zshrc` / `~/.bashrc` 幂等注入 `~/.local/bin` 的 PATH 导出。
///
/// 只更新自身标记块：读取原文件 → 移除旧块 → 末尾追加新块；仅当文件不存在时
/// 才新建。读失败（非"不存在"）直接报错退出，绝不把"读不到"当作空文件去
/// 全量覆盖用户配置；写入前先备份，写失败自动回滚（见 `write_rc_with_backup`）。
#[cfg(not(windows))]
pub(super) fn inject_shell_rc(app_handle: &AppHandle) -> Result<(), String> {
    let home = app_handle
        .path()
        .home_dir()
        .map_err(|_| "RC_HOME_RESOLVE_FAILED: failed to resolve home directory".to_string())?;
    let block = format!("{RC_MARK_START}\nexport PATH=\"$HOME/.local/bin:$PATH\"\n{RC_MARK_END}\n");

    for name in RC_FILES {
        let rc_path = home.join(name);
        let original = match fs::read_to_string(&rc_path) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => {
                return Err(format!(
                    "READ_RC_FAILED: read {} failed: {e}",
                    rc_path.display()
                ))
            }
        };
        let next = upsert_rc_block(&original, &block, RC_MARK_START, RC_MARK_END);
        if next == original {
            continue;
        }
        write_rc_with_backup(&rc_path, &next)?;
        log::info!("Injected PATH export into {}", rc_path.display());
    }
    Ok(())
}

/// Unix：从 rc 文件中移除注入块（保留用户其余配置，同样走备份 + 回滚写入）
#[cfg(not(windows))]
pub(super) fn strip_shell_rc(app_handle: &AppHandle) -> Result<(), String> {
    let home = app_handle
        .path()
        .home_dir()
        .map_err(|_| "RC_HOME_RESOLVE_FAILED: failed to resolve home directory".to_string())?;
    for name in RC_FILES {
        let rc_path = home.join(name);
        let original = match fs::read_to_string(&rc_path) {
            Ok(content) => content,
            // 文件不存在则无需清理
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                return Err(format!(
                    "READ_RC_FAILED: read {} failed: {e}",
                    rc_path.display()
                ))
            }
        };
        let cleaned = strip_rc_block(&original, RC_MARK_START, RC_MARK_END);
        if cleaned != original {
            write_rc_with_backup(&rc_path, &cleaned)?;
            log::info!("Removed PATH export from {}", rc_path.display());
        }
    }
    Ok(())
}

/// 将标记块并入 rc 内容：先移除已有标记块，再在文件末尾追加新块，
/// 只更新自身块、保留用户其余配置，且块始终落在文件末尾。
///
/// 标记行由调用方给出而不是写死：同一个 rc 文件里会有多份本应用注入的块
/// （PATH 导出、`DSH_HOME` 导出），每份块必须只认得自己的标记，否则后写的
/// 块会把前一份删掉。
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn upsert_rc_block(
    content: &str,
    block: &str,
    mark_start: &str,
    mark_end: &str,
) -> String {
    let mut out = strip_rc_block(content, mark_start, mark_end);
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(block);
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// 原子写回 rc 文件：写入前先备份为 `<file>.dsh-backup`，再通过同目录
/// 临时文件 + rename 原子替换；写失败时删除临时文件并回滚备份内容，
/// 保证任何异常路径下用户原文件都不会被半写/被清空。
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn write_rc_with_backup(
    rc_path: &std::path::Path,
    new_content: &str,
) -> Result<(), String> {
    let backup_path = rc_path.with_extension("dsh-backup");
    let had_original = rc_path.exists();
    if had_original {
        fs::copy(rc_path, &backup_path).map_err(|e| {
            format!(
                "BACKUP_RC_FAILED: backup {} to {} failed: {e}",
                rc_path.display(),
                backup_path.display()
            )
        })?;
    }

    let tmp_path = rc_path.with_extension("dsh-rc-tmp");
    fs::write(&tmp_path, new_content)
        .map_err(|e| format!("WRITE_RC_FAILED: write {} failed: {e}", tmp_path.display()))?;
    let rename_res = match fs::rename(&tmp_path, rc_path) {
        Ok(()) => Ok(()),
        // Windows 下 rename 不覆盖已存在目标（仅测试环境会走到）：删旧文件后重试
        Err(_) => {
            let _ = fs::remove_file(rc_path);
            fs::rename(&tmp_path, rc_path)
        }
    };
    if let Err(e) = rename_res {
        let _ = fs::remove_file(&tmp_path);
        if had_original {
            let _ = fs::copy(&backup_path, rc_path);
        }
        return Err(format!(
            "RENAME_RC_FAILED: rename into {} failed: {e}",
            rc_path.display()
        ));
    }
    Ok(())
}

/// 移除 rc 文件中的标记块（含标记行本身）。
/// 同时被注入（`upsert_rc_block`）与移除路径使用。
#[cfg_attr(windows, allow(dead_code))]
pub(crate) fn strip_rc_block(content: &str, mark_start: &str, mark_end: &str) -> String {
    let lines = content.lines().peekable();
    let mut out = String::with_capacity(content.len());
    let mut skipping = false;
    for line in lines {
        if line.trim() == mark_start {
            skipping = true;
            continue;
        }
        if skipping {
            if line.trim() == mark_end {
                skipping = false;
            }
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::test_util::temp_dir;
    use super::*;

    const RC_BLOCK: &str =
        "# >>> deepseek-harness dsh >>>\nexport PATH=\"$HOME/.local/bin:$PATH\"\n# <<< deepseek-harness dsh <<<\n";

    /// issue #57：目标 rc 文件已存在且包含用户自定义内容 → 只追加块，原内容保留
    #[test]
    fn upsert_keeps_user_content_and_appends_block() {
        let content = "# oh-my-zsh\nplugins=(git)\nalias ll='ls -alF'\n";
        let next = upsert_rc_block(content, RC_BLOCK, RC_MARK_START, RC_MARK_END);
        assert!(next.starts_with(content));
        assert!(next.ends_with(RC_BLOCK));
        assert_eq!(next.matches(RC_MARK_START).count(), 1);
    }

    /// issue #57：旧块位于文件中间时 → 移除并移动到末尾，周围用户内容保留
    #[test]
    fn upsert_moves_stale_block_to_end() {
        let stale = format!("alias ll='ls -alF'\n{RC_BLOCK}export NVM_DIR=\"$HOME/.nvm\"\n");
        let next = upsert_rc_block(&stale, RC_BLOCK, RC_MARK_START, RC_MARK_END);
        let stripped = strip_rc_block(&next, RC_MARK_START, RC_MARK_END);
        assert_eq!(
            stripped,
            "alias ll='ls -alF'\nexport NVM_DIR=\"$HOME/.nvm\"\n"
        );
        assert!(next.ends_with(RC_BLOCK));
        assert_eq!(next.matches(RC_MARK_START).count(), 1);
    }

    /// 幂等：重复注入不产生第二块
    #[test]
    fn upsert_is_idempotent() {
        let content = "user content\n";
        let once = upsert_rc_block(content, RC_BLOCK, RC_MARK_START, RC_MARK_END);
        assert_eq!(upsert_rc_block(&once, RC_BLOCK, RC_MARK_START, RC_MARK_END), once);
    }

    /// 空内容（文件不存在时的新建场景）→ 仅注入块，没有多余空行
    #[test]
    fn upsert_from_missing_file_creates_block_only() {
        assert_eq!(upsert_rc_block("", RC_BLOCK, RC_MARK_START, RC_MARK_END), RC_BLOCK.to_string());
    }

    /// 无末尾换行的内容 → 补换行后再追加块
    #[test]
    fn upsert_handles_missing_trailing_newline() {
        let next = upsert_rc_block("no trailing nl", RC_BLOCK, RC_MARK_START, RC_MARK_END);
        assert_eq!(next, "no trailing nl\n".to_string() + RC_BLOCK);
    }

    /// strip 原语：移除标记块且幂等
    #[test]
    fn strip_rc_block_removes_block_and_is_idempotent() {
        let content = format!("keep\n{RC_BLOCK}tail\n");
        let cleaned = strip_rc_block(&content, RC_MARK_START, RC_MARK_END);
        assert_eq!(cleaned, "keep\ntail\n");
        assert_eq!(strip_rc_block(&cleaned, RC_MARK_START, RC_MARK_END), cleaned);
    }

    /// 写回：备份保留原内容、目标被替换为 new_content
    #[test]
    fn write_rc_with_backup_preserves_backup() {
        let dir = temp_dir("backup");
        let rc_path = dir.join(".zshrc");
        std::fs::write(&rc_path, "original\n").unwrap();

        write_rc_with_backup(&rc_path, "original\n# block\n").unwrap();

        assert_eq!(
            std::fs::read_to_string(&rc_path).unwrap(),
            "original\n# block\n"
        );
        assert_eq!(
            std::fs::read_to_string(rc_path.with_extension("dsh-backup")).unwrap(),
            "original\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 写回：文件原本不存在 → 新建成功且不产生备份
    #[test]
    fn write_rc_with_backup_creates_missing_file() {
        let dir = temp_dir("create");
        let rc_path = dir.join(".bashrc");
        write_rc_with_backup(&rc_path, "# block\n").unwrap();
        assert_eq!(std::fs::read_to_string(&rc_path).unwrap(), "# block\n");
        assert!(!rc_path.with_extension("dsh-backup").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 同一个 rc 文件里可以有多份本应用的块（PATH 与 issue #871 的 DSH_HOME）：
    /// 各自只认得自己的标记，后写的一份不能把前一份删掉。
    #[test]
    fn two_blocks_coexist_without_clobbering_each_other() {
        const HOME_START: &str = "# >>> deepseek-harness dsh home >>>";
        const HOME_END: &str = "# <<< deepseek-harness dsh home <<<";
        let home_block = format!("{HOME_START}\nexport DSH_HOME=\"/data/dsh\"\n{HOME_END}\n");

        let both = upsert_rc_block(RC_BLOCK, &home_block, HOME_START, HOME_END);
        assert!(both.contains(RC_MARK_START));
        assert!(both.contains(HOME_START));

        let again = upsert_rc_block(&both, RC_BLOCK, RC_MARK_START, RC_MARK_END);
        assert!(again.contains(HOME_START));
        assert!(again.contains("export DSH_HOME=\"/data/dsh\""));
        assert_eq!(again.matches(RC_MARK_START).count(), 1);
        assert_eq!(again.matches(HOME_START).count(), 1);
        assert_eq!(
            upsert_rc_block(&again, RC_BLOCK, RC_MARK_START, RC_MARK_END),
            again
        );
    }
}
