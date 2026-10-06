use std::ffi::OsString;

const AUTO_HEAP_MIN_MB: u64 = 2048;
const AUTO_HEAP_MAX_MB: u64 = 8192;

/// 「堆上限交给 NODE_OPTIONS」的哨兵值。
///
/// `--max-old-space-size=0` 在 V8 里按默认值处理（等价于没传参数），因此 0 可以
/// 安全地表达「本次不显式下发」，让 NODE_OPTIONS 里的上限继续生效。
const INHERITED_HEAP_LIMIT_MB: u32 = 0;

fn node_options_heap_limit(node_options: &str) -> Option<u32> {
    let mut tokens = node_options.split_whitespace();
    while let Some(token) = tokens.next() {
        let token = token.trim_matches(['"', '\'']);
        for flag in ["--max-old-space-size", "--max_old_space_size"] {
            if token == flag {
                return tokens
                    .next()
                    .and_then(|value| value.trim_matches(['"', '\'']).parse::<u32>().ok())
                    .filter(|mb| *mb > 0);
            }
            if let Some(value) = token.strip_prefix(flag).and_then(|tail| tail.strip_prefix('=')) {
                return value
                    .trim_matches(['"', '\''])
                    .parse::<u32>()
                    .ok()
                    .filter(|mb| *mb > 0);
            }
        }
    }
    None
}

/// 进程环境里 NODE_OPTIONS 指定的堆上限（MB）
pub(super) fn node_options_heap_limit_mb() -> Option<u32> {
    std::env::var("NODE_OPTIONS")
        .ok()
        .as_deref()
        .and_then(node_options_heap_limit)
}

pub(super) fn auto_heap_limit_mb(total_mb: u64) -> u32 {
    (total_mb / 2).clamp(AUTO_HEAP_MIN_MB, AUTO_HEAP_MAX_MB) as u32
}

/// 本次启动要给 Node 传的堆上限（MB）。
///
/// 优先级：用户设置 > NODE_OPTIONS 里的堆上限 > 按物理内存算出的自动值。
///
/// 用户设置排在最前是刻意的：设置页是唯一的显式入口，而 NODE_OPTIONS 可能来自
/// 系统环境变量或安装脚本，用户既改不动、也看不出它压住了自己的配置（issue 里
/// 「设置了 8192 还提示 8192」就是这么来的）。命令行 `--max-old-space-size`
/// 的优先级高于 NODE_OPTIONS（V8 实测），所以只要按用户填的值下发就一定能生效。
/// 用户没填时才把话语权让回 NODE_OPTIONS，返回哨兵 0 表示「不显式下发」。
pub(super) fn resolve_heap_limit_mb(
    configured: Option<u32>,
    inherited: Option<u32>,
    total_mb: Option<u64>,
) -> Option<u32> {
    if let Some(configured) = configured {
        return Some(configured);
    }
    if inherited.is_some() {
        return Some(INHERITED_HEAP_LIMIT_MB);
    }
    total_mb.filter(|total| *total > 0).map(auto_heap_limit_mb)
}

/// 子进程实际生效的 old-space 上限（MB）：显式下发时就是下发的值，交给
/// NODE_OPTIONS 时取继承值；两者都没有（物理内存未知且未配置）时无从得知。
pub(super) fn effective_limit_mb(heap_mb: Option<u32>, inherited: Option<u32>) -> Option<u32> {
    match heap_mb {
        Some(INHERITED_HEAP_LIMIT_MB) => inherited,
        other => other,
    }
}

pub(super) fn heap_option_arg(heap_mb: Option<u32>) -> Option<OsString> {
    heap_mb
        .filter(|mb| *mb > 0)
        .map(|mb| OsString::from(format!("--max-old-space-size={mb}")))
}

/// 按当前设置与进程环境算出「进程真正会拿到」的上限（MB）。
///
/// 崩溃提示与启动链路共用这一个判定，避免提示里说的上限与进程实际拿到的
/// 上限各说各话。
pub(crate) fn effective_heap_limit_mb(configured: Option<u32>) -> Option<u32> {
    let inherited = node_options_heap_limit_mb();
    effective_limit_mb(
        resolve_heap_limit_mb(configured, inherited, physical_memory_mb()),
        inherited,
    )
}

#[cfg(windows)]
pub(super) fn physical_memory_mb() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullTotalPhys / 1024 / 1024)
}

#[cfg(target_os = "macos")]
pub(super) fn physical_memory_mb() -> Option<u64> {
    use objc2_foundation::NSProcessInfo;
    let bytes = NSProcessInfo::processInfo().physicalMemory();
    (bytes > 0).then(|| bytes / 1024 / 1024)
}

#[cfg(target_os = "linux")]
pub(super) fn physical_memory_mb() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let total_kb = meminfo.lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))?
        .split_whitespace().next()?.parse::<u64>().ok()?;
    (total_kb > 0).then(|| total_kb / 1024)
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(super) fn physical_memory_mb() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adaptive_limit_clamps_at_half_physical_memory() {
        assert_eq!(auto_heap_limit_mb(4096), 2048);
        assert_eq!(auto_heap_limit_mb(8192), 4096);
        assert_eq!(auto_heap_limit_mb(12288), 6144);
        assert_eq!(auto_heap_limit_mb(16384), 8192);
        assert_eq!(auto_heap_limit_mb(32768), 8192);
    }

    #[test]
    fn resolve_preserves_configured_value_and_falls_back_on_unknown_memory() {
        assert_eq!(resolve_heap_limit_mb(Some(12288), None, Some(16384)), Some(12288));
        assert_eq!(resolve_heap_limit_mb(None, None, Some(16384)), Some(8192));
        assert_eq!(resolve_heap_limit_mb(None, None, Some(0)), None);
        assert_eq!(resolve_heap_limit_mb(None, None, None), None);
    }

    #[test]
    fn configured_limit_wins_over_inherited_node_options() {
        assert_eq!(
            resolve_heap_limit_mb(Some(1600), Some(8192), Some(32768)),
            Some(1600)
        );
        assert_eq!(
            resolve_heap_limit_mb(Some(12288), Some(8192), Some(32768)),
            Some(12288)
        );
    }

    #[test]
    fn inherited_heap_limit_is_left_to_node_options() {
        for options in [
            "--max-old-space-size=8192",
            "--trace-warnings --max-old-space-size 8192",
            "--max-old-space-size \"8192\"",
            "--max_old_space_size=8192",
            "--max_old_space_size 8192",
        ] {
            let inherited = node_options_heap_limit(options);
            assert_eq!(inherited, Some(8192), "{options}");
            assert_eq!(
                resolve_heap_limit_mb(None, inherited, Some(32768)),
                Some(INHERITED_HEAP_LIMIT_MB),
                "{options}"
            );
        }
    }

    #[test]
    fn unrelated_or_malformed_node_options_do_not_disable_adaptive_limit() {
        for options in [
            "--trace-warnings",
            "--no-max-old-space-size=8192",
            "--max-old-space-size-extra=8192",
            "--max-old-space-size=",
            "--max-old-space-size=not-a-number",
            "--max-old-space-size 0",
        ] {
            assert_eq!(node_options_heap_limit(options), None, "{options}");
            assert_eq!(
                resolve_heap_limit_mb(None, node_options_heap_limit(options), Some(16384)),
                Some(8192),
                "{options}"
            );
        }
    }

    #[test]
    fn node_options_heap_limit_reads_the_inherited_value() {
        assert_eq!(node_options_heap_limit("--max-old-space-size=8192"), Some(8192));
        assert_eq!(node_options_heap_limit("--max-old-space-size 1600"), Some(1600));
        assert_eq!(node_options_heap_limit("--max_old_space_size=4096"), Some(4096));
    }

    #[test]
    fn heap_option_arg_skips_the_inherited_sentinel() {
        assert_eq!(heap_option_arg(Some(INHERITED_HEAP_LIMIT_MB)), None);
        assert_eq!(heap_option_arg(None), None);
        assert_eq!(
            heap_option_arg(Some(2048)),
            Some(OsString::from("--max-old-space-size=2048"))
        );
    }

    #[test]
    fn effective_limit_reports_what_the_child_process_gets() {
        assert_eq!(effective_limit_mb(Some(1600), Some(8192)), Some(1600));
        assert_eq!(
            effective_limit_mb(Some(INHERITED_HEAP_LIMIT_MB), Some(8192)),
            Some(8192)
        );
        assert_eq!(
            effective_limit_mb(Some(INHERITED_HEAP_LIMIT_MB), None),
            None
        );
        assert_eq!(effective_limit_mb(None, Some(8192)), None);
    }
}
