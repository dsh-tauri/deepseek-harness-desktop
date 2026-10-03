//! 上次迁移记录与 `.moved-*` 备份发现。
//!
//! 备份目录名自带原位置（`<原目录>.moved-<时间戳>`），因此回滚目标可以从名字反推，
//! 不需要额外状态。但跨盘搬家时备份留在旧盘上——既不在当前目录旁边、也不在
//! `~/.dsh` 旁边，只靠两侧搜索会漏掉，所以搬家时把原位置另记一份（issue E）。

use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// 备份目录名后缀前缀：`D:\DSHHome.moved-2026-10-02T21-33-14`
const MOVED_INFIX: &str = ".moved-";

/// 回滚前把当前目录挪到一边时用的后缀前缀（与恢复脚本的 `.current-` 一致）
pub(super) const CURRENT_INFIX: &str = ".current-";

/// 上次迁移记录文件路径：`%LOCALAPPDATA%\deepseek-harness\last-migration.txt`。
///
/// 与恢复脚本的 `$StatePath` 逐字一致（脚本也会读这里），因此放在 CLI 集成目录
/// （`get_bin_dir` 的父目录）而不是应用数据目录：两者必须看到同一份记录。
/// debug 构建自动落到 `dev-dsh`，与生产互不干扰。
pub(super) fn state_path(app_handle: &AppHandle) -> PathBuf {
    crate::service::cli::get_bin_dir(app_handle)
        .parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_else(std::env::temp_dir)
        .join("last-migration.txt")
}

/// 读取上次搬家的原目录（文件首行；空文件视为无记录）。
pub(super) fn read_last_migration(app_handle: &AppHandle) -> Option<String> {
    let text = fs::read_to_string(state_path(app_handle)).ok()?;
    let first = text.lines().next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

/// 写入上次搬家的原目录（UTF-8 无 BOM，首行）。
///
/// 必须无 BOM：恢复脚本用 `Get-Content` 读首行做路径比较，带 BOM 会让路径前多出
/// 一个不可见字符从而匹配失败（脚本自己也用 `UTF8Encoding($false)` 写）。
pub(super) fn write_last_migration(app_handle: &AppHandle, value: &str) -> Result<(), String> {
    let path = state_path(app_handle);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("DATA_DIR_STATE_MKDIR: {e}"))?;
    }
    fs::write(&path, value).map_err(|e| format!("DATA_DIR_STATE_WRITE: {e}"))
}

/// 目录名是否形如 `<leaf>.moved-<时间戳>`，是则返回时间戳部分。
///
/// 时间戳只允许数字、`T` 与 `-`（脚本用 `-replace '\.moved-[0-9T\-]+$'` 反推原路径，
/// 这里保持同一字符集，两个实现才能互相识别对方留下的备份）。
pub(super) fn moved_stamp(name: &str) -> Option<&str> {
    let index = name.rfind(MOVED_INFIX)?;
    let stamp = &name[index + MOVED_INFIX.len()..];
    if stamp.is_empty() {
        return None;
    }
    if stamp.chars().all(|c| c.is_ascii_digit() || c == 'T' || c == '-') {
        Some(stamp)
    } else {
        None
    }
}

/// 从备份目录名反推它该还原到哪里（`D:\DSHHome.moved-2026-…` → `D:\DSHHome`）。
pub(super) fn original_of(moved: &Path) -> Option<PathBuf> {
    let name = moved.file_name()?.to_str()?;
    let stamp = moved_stamp(name)?;
    let leaf = &name[..name.len() - MOVED_INFIX.len() - stamp.len()];
    if leaf.is_empty() {
        return None;
    }
    Some(moved.with_file_name(leaf))
}

/// 列出 `parent` 下所有 `<leaf>.moved-<时间戳>` 备份（含时间戳）。
pub(super) fn find_moved_dirs(parent: &Path, leaf: &str) -> Vec<(PathBuf, String)> {
    let Ok(read_dir) = fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in read_dir.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(stamp) = moved_stamp(name) else {
            continue;
        };
        if name.len() != leaf.len() + MOVED_INFIX.len() + stamp.len() {
            continue;
        }
        if !name.starts_with(leaf) {
            continue;
        }
        found.push((entry.path(), stamp.to_string()));
    }
    found
}

/// 给目录名加上 `.moved-<时间戳>` 后缀（迁移时把旧目录改名保底）。
///
/// 同名备份已存在时不覆盖：换个后缀重试到时间戳唯一为止。用户可能在同一秒里
/// 连续点了两次迁移，直接 `rename` 会把上一次的备份当成目标而失败（Windows 上
/// 目标目录已存在时 `rename` 报错），这里的自增后缀让两次都留得下来。
pub(super) fn with_moved_suffix(original: &Path, stamp: &str) -> Result<PathBuf, String> {
    suffixed(original, MOVED_INFIX, stamp)
}

/// 给目录名加上 `.current-<时间戳>` 后缀（回滚时把当前目录挪到一边）。
pub(super) fn with_current_suffix(original: &Path, stamp: &str) -> Result<PathBuf, String> {
    suffixed(original, CURRENT_INFIX, stamp)
}

/// 生成 `<原目录><中缀><时间戳>`；已被占用时在时间戳后追加 `-2`、`-3`…。
///
/// 追加段仍只用数字与 `-`，因此 `moved_stamp` 与恢复脚本的正则都还能反推原路径。
fn suffixed(original: &Path, infix: &str, stamp: &str) -> Result<PathBuf, String> {
    let name = original
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("DATA_DIR_NAME_INVALID: {}", original.display()))?;
    if original.parent().is_none() {
        return Err(format!("DATA_DIR_NAME_INVALID: {}", original.display()));
    }
    let mut candidate = original.with_file_name(format!("{name}{infix}{stamp}"));
    let mut attempt = 2;
    while candidate.exists() {
        candidate = original.with_file_name(format!("{name}{infix}{stamp}-{attempt}"));
        attempt += 1;
    }
    Ok(candidate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_moved_suffix_produces_a_script_compatible_name() {
        let dir = std::env::temp_dir().join(format!(
            "dsh-data-dir-suffix-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let original = dir.join("DSHHome");
        fs::create_dir_all(&original).unwrap();

        let moved = with_moved_suffix(&original, "2026-10-02T21-33-14").unwrap();
        assert_eq!(
            moved.file_name().unwrap().to_str().unwrap(),
            "DSHHome.moved-2026-10-02T21-33-14"
        );
        // 脚本的正则必须能反推出原路径
        assert_eq!(original_of(&moved).unwrap(), original);

        // 同名备份已存在时换后缀，不覆盖已有备份
        fs::create_dir_all(&moved).unwrap();
        let second = with_moved_suffix(&original, "2026-10-02T21-33-14").unwrap();
        assert_ne!(second, moved);
        assert_eq!(original_of(&second).unwrap(), original);
        let _ = fs::remove_dir_all(&dir);
    }

    /// 挪到一边的目录名必须还能反推出原路径。
    ///
    /// 这里刻意用 `/DSHHome` 这种两平台都认的绝对路径：`D:\DSHHome` 在非 Windows 上
    /// 只是**一个**组件（`\` 是普通字符），`file_name()` 会把整串吐回来，断言随之失败。
    /// 生产路径只可能是 Windows 盘符，但这条测试要验的是「拼后缀不改叶子名」，与盘符无关。
    #[test]
    fn with_current_suffix_keeps_the_original_path_recoverable() {
        let original = Path::new("/DSHHome");
        let aside = with_current_suffix(original, "2026-10-02T21-33-14").unwrap();
        assert_eq!(
            aside.file_name().unwrap().to_str().unwrap(),
            "DSHHome.current-2026-10-02T21-33-14"
        );
        // `.current-` 不是迁移备份，发现逻辑不该把它当回滚目标
        assert_eq!(moved_stamp(aside.file_name().unwrap().to_str().unwrap()), None);
    }

    #[test]
    fn moved_stamp_accepts_only_script_compatible_suffixes() {
        assert_eq!(
            moved_stamp("DSHHome.moved-2026-10-02T21-33-14"),
            Some("2026-10-02T21-33-14")
        );
        assert_eq!(moved_stamp("DSHHome.moved-"), None);
        assert_eq!(moved_stamp("DSHHome.moved-2026.10.02"), None);
        assert_eq!(moved_stamp("DSHHome.current-2026-10-02T21-33-14"), None);
        assert_eq!(moved_stamp("DSHHome"), None);
    }

    #[test]
    fn original_of_strips_the_moved_suffix() {
        let moved = Path::new("D:\\DSHHome.moved-2026-10-02T21-33-14");
        assert_eq!(
            original_of(moved).unwrap(),
            Path::new("D:\\DSHHome").to_path_buf()
        );
        assert_eq!(original_of(Path::new("D:\\DSHHome")), None);
    }

    #[test]
    fn find_moved_dirs_matches_only_the_same_leaf() {
        let root = std::env::temp_dir().join(format!(
            "dsh-data-dir-state-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("DSHHome.moved-2026-10-02T21-33-14")).unwrap();
        fs::create_dir_all(root.join("DSHHome.moved-2026-10-03T01-02-03")).unwrap();
        fs::create_dir_all(root.join("Other.moved-2026-10-02T21-33-14")).unwrap();
        fs::create_dir_all(root.join("DSHHome.current-2026-10-02T21-33-14")).unwrap();

        let mut found: Vec<String> = find_moved_dirs(&root, "DSHHome")
            .into_iter()
            .map(|(_, stamp)| stamp)
            .collect();
        found.sort();
        assert_eq!(found, vec!["2026-10-02T21-33-14", "2026-10-03T01-02-03"]);
        let _ = fs::remove_dir_all(&root);
    }
}
