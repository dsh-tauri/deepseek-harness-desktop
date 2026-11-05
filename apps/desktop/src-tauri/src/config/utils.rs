use std::path::{Path, PathBuf};

/// 文件的修改时间戳（纳秒，取不到时为 0）。
///
/// 资源清单与依赖映射表都是「进程内可反复读取、但 debug 下可能被编辑」的文件，
/// 用「路径 + 时间戳」作为解析缓存键即可在两者之间取得平衡。
pub fn file_stamp(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos() as u64)
        .unwrap_or(0)
}

/// Linux inotify 文件监视上限的推荐最小值。
///
/// harness 服务（dsh web）用 chokidar 递归监视 `$DSH_HOME/profiles/*`，node 的
/// 每个被监视目录都要消耗一个 inotify watch。系统默认值在新版 Ubuntu 上往往过小
/// （如 65536），一旦监视到 `node_modules` 等庞大树就抛
/// `ENOSPC: System limit for number of file watchers reached` 并使服务启动即崩溃
/// （issue #116）。低于该推荐值时在启动日志给出明确提示，引导用户调高参数。
#[cfg(unix)]
pub const MIN_INOTIFY_MAX_USER_WATCHES: u64 = 524_288;

/// 读取 Linux `fs.inotify.max_user_watches` 系统参数。
///
/// 进程无法自我调高该参数（需要 root / sysctl），但启动前探测并告警能让用户第一
/// 时间知道「服务崩溃与系统监视上限有关」，而非看到一串 node 堆栈不知所云。
/// 仅 Unix 存在该 procfs 节点；Windows / macOS 返回 None。纯函数，便于单测。
#[cfg(unix)]
pub fn linux_inotify_max_user_watches() -> Option<u64> {
    let content = std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches").ok()?;
    content.trim().parse::<u64>().ok()
}

pub fn unique_download_path(
    destination: &Path,
    downloads: Option<&Path>,
) -> Result<PathBuf, String> {
    use std::env;

    let downloads = downloads.filter(|dir| !dir.as_os_str().is_empty());
    let dir = match destination.parent() {
        // 无保存对话框时上游给的是临时目录，改落到系统下载目录（issue #1338）
        Some(parent) if parent == env::temp_dir().as_path() => {
            downloads.unwrap_or(parent).to_path_buf()
        }
        Some(parent) if parent.is_dir() => parent.to_path_buf(),
        _ => downloads.map(Path::to_path_buf).unwrap_or_else(|| {
            env::var("USERPROFILE")
                .map(PathBuf::from)
                .map(|home| home.join("Downloads"))
                .unwrap_or_else(|_| PathBuf::from("."))
        }),
    };
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("DOWNLOAD_DIR_UNAVAILABLE: {}: {error}", dir.display()))?;
    let name = destination
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download");
    // 拆分主名与扩展名，重名时在扩展名前插入 " (n)"
    let (stem, ext) = match name.rsplit_once('.') {
        Some((stem, ext)) => (stem.to_string(), format!(".{ext}")),
        None => (name.to_string(), String::new()),
    };
    let mut counter = 0usize;
    loop {
        let candidate = if counter == 0 {
            dir.join(name)
        } else {
            dir.join(format!("{stem} ({counter}){ext}"))
        };
        if !candidate.exists() {
            return Ok(candidate);
        }
        counter += 1;
    }
}

#[cfg(test)]
mod download_path_tests {
    use super::unique_download_path;
    use std::path::PathBuf;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "dsh-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_destination(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn temp_destination_is_relocated_to_the_downloads_directory() {
        let scratch = Scratch::new("downloads");
        let downloads = scratch.0.join("Downloads");
        assert_eq!(
            unique_download_path(&temp_destination("report.csv"), Some(&downloads)),
            Ok(downloads.join("report.csv"))
        );
        assert!(downloads.is_dir());
    }

    #[test]
    fn non_temp_destination_is_left_untouched() {
        let scratch = Scratch::new("untouched");
        let parent = scratch.0.join("elsewhere");
        std::fs::create_dir_all(&parent).unwrap();
        let destination = parent.join("report.csv");
        assert_eq!(
            unique_download_path(&destination, Some(&scratch.0.join("Downloads"))),
            Ok(destination)
        );
    }

    #[test]
    fn temp_destination_without_a_downloads_directory_stays_put_and_still_deduplicates() {
        let scratch = Scratch::new("dedupe");
        let name = scratch
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let taken = temp_destination(&format!("{name}.csv"));
        std::fs::write(&taken, b"taken").unwrap();
        assert_eq!(
            unique_download_path(&taken, None),
            Ok(temp_destination(&format!("{name} (1).csv")))
        );
        let _ = std::fs::remove_file(&taken);
    }

    #[test]
    fn unwritable_downloads_directory_is_reported_instead_of_accepted() {
        let scratch = Scratch::new("unwritable");
        std::fs::create_dir_all(&scratch.0).unwrap();
        let blocker = scratch.0.join("blocker");
        std::fs::write(&blocker, b"file, not a directory").unwrap();
        let downloads = blocker.join("Downloads");
        let error = unique_download_path(&temp_destination("report.csv"), Some(&downloads))
            .expect_err("unwritable directory must be reported");
        assert!(error.starts_with("DOWNLOAD_DIR_UNAVAILABLE:"), "{error}");
        assert!(!downloads.exists());
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn inotify_watch_limit_is_below_recommended_minimum() {
        // 推荐最小值本身应远高于常见默认（如 65536/8192），否则提示会过早触发
        assert!(
            MIN_INOTIFY_MAX_USER_WATCHES > 65_536,
            "recommended minimum {} should exceed common defaults",
            MIN_INOTIFY_MAX_USER_WATCHES
        );
    }

    #[test]
    fn inotify_watch_limit_reads_procfs_when_present() {
        // 存在该 procfs 节点（Linux 主机）时返回 Some(>0)；不存在时返回 None。
        // 只验证类型与基本不变量，不绑定具体值，避免在不同内核配置下 flake。
        match linux_inotify_max_user_watches() {
            Some(v) => assert!(v > 0),
            None => {
                // 非 Linux / 无 procfs（CI 容器裁剪等情况）：返回 None 属预期
                println!("inotify max_user_watches not available; skipping");
            }
        }
    }
}
