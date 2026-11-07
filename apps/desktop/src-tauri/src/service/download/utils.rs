use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

/// GitHub 未认证 `api.github.com` 限流（HTTP 403）冷却器。
///
/// 桌面端多个流程（dsh 内核更新检查、启动自愈核对、预装插件安装后的收尾检查）
/// 会在很短时间内多次访问 api.github.com，而未认证 API 只有 60 次/小时/IP 的配额，
/// 共享 IP / NAT 下极易命中 403。此模块维护一个进程级冷却窗口：一旦命中 403，
/// 窗口内所有调用方直接跳过 api.github.com、改走不受限流的兜底来源
/// （releases.atom / expanded_assets HTML / tag 内嵌 build-id），既避免把配额快速
/// 打光，也不再每次启动/重启都向日志刷一条吓人又无法处置的 403 警告（issue #48）。
pub mod github_api {
    use super::*;

    /// 命中 403 后的冷却时长。GitHub 按小时重置配额，30 分钟足够覆盖一次
    /// 启动 + 预装重启的密集调用；窗口期后自动恢复用 API（拿到最准的元数据）。
    const COOLDOWN: Duration = Duration::from_secs(30 * 60);

    static COOLDOWN_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

    /// 当前是否处于限流冷却期（是则调用方应跳过 api.github.com）。
    pub fn rate_limited() -> bool {
        COOLDOWN_UNTIL
            .lock()
            .map(|slot| slot.is_some_and(|until| Instant::now() < until))
            .unwrap_or(false)
    }

    /// 收到 api.github.com 的 403（限流）后标记冷却开始。
    ///
    /// 进入冷却时只打一次提示；冷却中的重复 403 不会反复记录，避免刷屏。
    pub fn mark_rate_limited() {
        if let Ok(mut slot) = COOLDOWN_UNTIL.lock() {
            let now = Instant::now();
            let already_cooling = slot.is_some_and(|until| now < until);
            if !already_cooling {
                log::warn!(
                    "GitHub API rate-limited (HTTP 403), pausing api.github.com for {} min, using fallback sources",
                    COOLDOWN.as_secs() / 60
                );
            }
            *slot = Some(now + COOLDOWN);
        }
    }
}

/// 递归设置权限 (rwxr-xr-x)
#[cfg(unix)]
pub fn fix_recursive_permissions(path: &Path) -> io::Result<()> {
    // 设置当前路径权限
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms)?;

    // 如果是目录，递归处理子项
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            fix_recursive_permissions(&entry?.path())?;
        }
    }
    Ok(())
}

/// 解压产物里不允许被「上提」压缩的目录：这些名字本身就是安装根的内容。
///
/// asar 核心解压后根下只有一个归档文件（不是目录），`flatten_directory` 因此原样
/// 跳过；这里额外保护目录形态的核心产物（历史目录核心与手动解包的归档）。
const PRESERVE_DIRS: &[&str] = &["node_modules", ".git"];

pub fn flatten_directory(dest: &PathBuf) -> Result<(), String> {
    // 1. 寻找唯一合法的子目录
    let sub_dirs: Vec<PathBuf> = fs::read_dir(dest)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|path| {
            if !path.is_dir() {
                return false;
            }

            // 检查文件名（过滤隐藏文件和保留目录）
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|name| !name.starts_with('.') && !PRESERVE_DIRS.contains(&name))
                .unwrap_or(false)
        })
        .collect();

    // 如果不满足“只有一个子目录”的条件，直接返回
    if sub_dirs.len() != 1 {
        return Ok(());
    }

    let sub_dir = &sub_dirs[0];
    log::debug!("Flattening subdirectory: {:?}", sub_dir);

    // 2. 移动子目录下的内容
    for entry in fs::read_dir(sub_dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let file_name = entry.file_name();
        let to = dest.join(&file_name);

        force_move(&from, &to).map_err(|e| {
            let msg = format!("Failed to move {:?} to {:?}: {}", from, to, e);
            log::error!("{}", msg);
            msg
        })?;
    }

    // 3. 清理空的子目录
    if let Err(e) = fs::remove_dir(sub_dir) {
        log::warn!("Could not remove empty directory {:?}: {}", sub_dir, e);
    }

    Ok(())
}

/// 辅助函数：强制移动文件或目录（如果目标存在则覆盖）
fn force_move(from: &Path, to: &Path) -> io::Result<()> {
    // 尝试直接重命名
    if let Err(err) = fs::rename(from, to) {
        // 如果失败是因为目标已存在 (通常是目录冲突或跨文件系统)
        if to.exists() {
            log::debug!("Target exists, removing: {:?}", to);
            if to.is_dir() {
                fs::remove_dir_all(to)?;
            } else {
                fs::remove_file(to)?;
            }
            // 删除目标后再次尝试重命名
            fs::rename(from, to)?;
        } else {
            return Err(err);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::github_api;

    #[test]
    fn rate_limit_cooldown_activates_after_mark() {
        // 标记后必然进入冷却期；重复标记保持冷却（幂等、不报错、不重置到更短）
        github_api::mark_rate_limited();
        assert!(github_api::rate_limited());
        github_api::mark_rate_limited();
        assert!(github_api::rate_limited());
    }
}
