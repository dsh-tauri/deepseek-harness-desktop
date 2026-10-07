use std::ffi::OsString;

const AUTO_HEAP_MIN_MB: u64 = 2048;

/// 自动值的上限。取物理内存的一半后再按这个上限收敛。
///
/// 曾长期是 8192，实测在 63.2GiB 的机器上偏小：单个大会话的日志（Session.log
/// 常驻内存）加载后就要 2GB 以上，跑起来峰值轻松越过 8GB，进程在 8.2GB 附近
/// 以 code 134（SIGABRT）终止。抬高到 16384 后同一会话稳定运行。
const AUTO_HEAP_MAX_MB: u64 = 16384;

/// 「堆上限交给 NODE_OPTIONS」的哨兵值。
///
/// `--max-old-space-size=0` 在 V8 里按默认值处理（等价于没传参数），因此 0 可以
/// 安全地表达「本次不显式下发」，让 NODE_OPTIONS 里的上限继续生效。
const INHERITED_HEAP_LIMIT_MB: u32 = 0;

/// 显式表达 old-space 上限的 flag（含 V8 接受的下划线变体）。
const HEAP_LIMIT_FLAGS: [&str; 2] = ["--max-old-space-size", "--max_old_space_size"];

/// 百分比形式的 old-space 上限。它的优先级高于 `--max-old-space-size`（V8 实测：
/// NODE_OPTIONS 里只写 percentage 时，命令行 `--max-old-space-size=1600` 会被无视，
/// 实际拿到的是物理内存的百分比），因此既要能识别它，也要在显式下发上限时把它从
/// 子进程环境里摘掉，否则用户设置看似生效、实际被百分比覆盖。
const HEAP_PERCENTAGE_FLAGS: [&str; 2] = [
    "--max-old-space-size-percentage",
    "--max_old_space_size_percentage",
];

fn heap_flags() -> impl Iterator<Item = &'static str> {
    HEAP_LIMIT_FLAGS
        .iter()
        .chain(HEAP_PERCENTAGE_FLAGS.iter())
        .copied()
}

/// 按出现顺序把 NODE_OPTIONS 里的堆 flag 交给 `visit`（`--flag value` 与 `--flag=value` 都认）。
///
/// `visit` 的 `bool` 参数表示取值是否是 V8 会接受的形式（size 要正整数、percentage 要
/// 正数）：解析不出来的取值既改不了上限，也不该把话语权从自动值那里抢走。
fn for_each_heap_flag(node_options: &str, mut visit: impl FnMut(&'static str, &str, bool)) {
    let mut tokens = node_options.split_whitespace();
    while let Some(token) = tokens.next() {
        let token = token.trim_matches(['"', '\'']);
        for flag in heap_flags() {
            let attached = token.strip_prefix(flag).and_then(|tail| tail.strip_prefix('='));
            if token != flag && attached.is_none() {
                continue;
            }
            let value = match attached {
                Some(value) => value.trim_matches(['"', '\'']),
                None => tokens
                    .next()
                    .map(|value| value.trim_matches(['"', '\'']))
                    .unwrap_or_default(),
            };
            let is_limit = if HEAP_LIMIT_FLAGS.contains(&flag) {
                value.parse::<u32>().is_ok_and(|mb| mb > 0)
            } else {
                value.parse::<f64>().is_ok_and(|percent| percent > 0.0)
            };
            visit(flag, value, is_limit);
            break;
        }
    }
}

/// NODE_OPTIONS 里指定的 old-space 上限（MB）。
///
/// 同一个变量里出现多个时以**最后一个**为准——V8 就是这么解析的（实测
/// `--max-old-space-size=4096 --max-old-space-size=8192` 生效的是 8192），取第一个
/// 会把实际生效值报小一半。取值解析不出来的条目直接忽略。
///
/// 只要出现可解析的 percentage flag 就返回 None：V8 让 percentage 压过 size（实测
/// `--max-old-space-size=8192 --max-old-space-size-percentage=50` 在 63 GB 机器上得到
/// 32413 MB，两个 flag 的先后顺序无关），此时报 size 就是谎报生效值。
fn node_options_heap_limit(node_options: &str) -> Option<u32> {
    let mut limit = None;
    let mut has_percentage = false;
    for_each_heap_flag(node_options, |flag, value, is_limit| {
        if !is_limit {
            return;
        }
        if !HEAP_LIMIT_FLAGS.contains(&flag) {
            has_percentage = true;
            return;
        }
        if let Ok(mb) = value.parse::<u32>() {
            limit = Some(mb);
        }
    });
    if has_percentage {
        return None;
    }
    limit
}

/// NODE_OPTIONS 是否出现过任何会决定 old-space 上限的 flag（size 或 percentage）。
///
/// 解析不出来的取值（`--max-old-space-size=` /`=not-a-number`）不算：V8 会忽略它们，
/// 让位只会把自动上限白送给一个不生效的 flag。
pub(super) fn node_options_has_heap_flags(node_options: &str) -> bool {
    let mut found = false;
    for_each_heap_flag(node_options, |_, _, is_limit| found |= is_limit);
    found
}

/// 摘掉 NODE_OPTIONS 里所有堆 flag，其余选项（`--require` 等）原样保留；全被摘空时返回 None。
///
/// 只在桌面端显式下发上限时使用：命令行 `--max-old-space-size` 只压得住 NODE_OPTIONS 里
/// 的 size，压不住 percentage，留着 percentage 就等于用户设置没生效。
pub(super) fn node_options_without_heap_flags(node_options: &str) -> Option<String> {
    let mut kept: Vec<&str> = Vec::new();
    let mut tokens = node_options.split_whitespace();
    while let Some(token) = tokens.next() {
        let bare = token.trim_matches(['"', '\'']);
        let is_heap_flag = heap_flags().any(|flag| bare == flag || bare.starts_with(&format!("{flag}=")));
        if !is_heap_flag {
            kept.push(token);
            continue;
        }
        // `--flag value` 形式：取值是独立 token，必须连它一起丢弃。
        if !bare.contains('=') {
            tokens.next();
        }
    }
    (!kept.is_empty()).then(|| kept.join(" "))
}

/// 进程环境里 NODE_OPTIONS 指定的堆上限（MB）
pub(super) fn node_options_heap_limit_mb() -> Option<u32> {
    std::env::var("NODE_OPTIONS")
        .ok()
        .as_deref()
        .and_then(node_options_heap_limit)
}

/// 当前进程环境里的 NODE_OPTIONS 是否带了任何堆 flag（size 或 percentage）。
pub(super) fn node_options_has_heap_flags_env() -> bool {
    std::env::var("NODE_OPTIONS").is_ok_and(|value| node_options_has_heap_flags(&value))
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
///
/// `inherited` 只看 NODE_OPTIONS 里**有没有**堆 flag，而不是能不能解析出数值：
/// 只有 `--max-old-space-size-percentage` 时我们解析不出 MB，但它的优先级高于命令行
/// `--max-old-space-size`，此时显式下发反而会谎报「用户设置已生效」，所以同样让位。
pub(super) fn resolve_heap_limit_mb(
    configured: Option<u32>,
    inherited: bool,
    total_mb: Option<u64>,
) -> Option<u32> {
    if let Some(configured) = configured {
        return Some(configured);
    }
    if inherited {
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
        resolve_heap_limit_mb(
            configured,
            node_options_has_heap_flags_env(),
            physical_memory_mb(),
        ),
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
        assert_eq!(auto_heap_limit_mb(32768), 16384);
        // 64GB 机器（用户机器 63.2GiB 的同类量级）：一半是 31615MB，必须仍然钳在自动上限内
        assert_eq!(auto_heap_limit_mb(63231), AUTO_HEAP_MAX_MB as u32);
        assert_eq!(auto_heap_limit_mb(131072), AUTO_HEAP_MAX_MB as u32);
    }

    #[test]
    fn resolve_preserves_configured_value_and_falls_back_on_unknown_memory() {
        assert_eq!(resolve_heap_limit_mb(Some(12288), false, Some(16384)), Some(12288));
        assert_eq!(resolve_heap_limit_mb(None, false, Some(16384)), Some(8192));
        // 大内存机器上自动值不再被 8192 截断（issue 里的 8.2GB 崩溃现场）
        assert_eq!(resolve_heap_limit_mb(None, false, Some(65536)), Some(AUTO_HEAP_MAX_MB as u32));
        assert_eq!(resolve_heap_limit_mb(None, false, Some(0)), None);
        assert_eq!(resolve_heap_limit_mb(None, false, None), None);
    }

    #[test]
    fn configured_limit_wins_over_inherited_node_options() {
        assert_eq!(resolve_heap_limit_mb(Some(1600), true, Some(32768)), Some(1600));
        assert_eq!(resolve_heap_limit_mb(Some(12288), true, Some(32768)), Some(12288));
    }

    #[test]
    fn inherited_heap_limit_is_left_to_node_options() {
        for options in [
            "--max-old-space-size=8192",
            "--trace-warnings --max-old-space-size 8192",
            "--max-old-space-size \"8192\"",
            "--max_old_space_size=8192",
            "--max_old_space_size 8192",
            "--max-old-space-size-percentage=50",
            "--max_old_space_size_percentage 50",
        ] {
            assert!(node_options_has_heap_flags(options), "{options}");
            assert_eq!(
                resolve_heap_limit_mb(None, true, Some(32768)),
                Some(INHERITED_HEAP_LIMIT_MB),
                "{options}"
            );
        }
        // 只有 size 时才解析得出数值；percentage 拿不到 MB，但仍算「有堆 flag」。
        for options in [
            "--max-old-space-size=8192",
            "--trace-warnings --max-old-space-size 8192",
            "--max-old-space-size \"8192\"",
            "--max_old_space_size=8192",
            "--max_old_space_size 8192",
        ] {
            assert_eq!(node_options_heap_limit(options), Some(8192), "{options}");
        }
        for options in ["--max-old-space-size-percentage=50", "--max_old_space_size_percentage 50"] {
            assert_eq!(node_options_heap_limit(options), None, "{options}");
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
            assert!(!node_options_has_heap_flags(options), "{options}");
            assert_eq!(
                resolve_heap_limit_mb(None, false, Some(16384)),
                Some(8192),
                "{options}"
            );
        }
    }

    /// V8 在同一作用域里取**最后一个** `--max-old-space-size`（实测 4096/8192 组合拿到
    /// 8192），解析器必须跟它一致，否则会把实际生效值报小。
    #[test]
    fn the_last_heap_limit_in_node_options_wins() {
        assert_eq!(
            node_options_heap_limit("--max-old-space-size=4096 --max-old-space-size=8192"),
            Some(8192)
        );
        assert_eq!(
            node_options_heap_limit("--max-old-space-size=8192 --max-old-space-size=4096"),
            Some(4096)
        );
        // 解析失败的条目忽略，前一个有效值仍然算数。
        assert_eq!(
            node_options_heap_limit("--max-old-space-size=4096 --max-old-space-size=oops"),
            Some(4096)
        );
    }

    #[test]
    fn strips_every_heap_flag_but_keeps_the_rest_of_node_options() {
        assert_eq!(
            node_options_without_heap_flags("--require C:/probe.cjs --max-old-space-size=8192"),
            Some("--require C:/probe.cjs".to_string())
        );
        assert_eq!(
            node_options_without_heap_flags("--max-old-space-size 8192 --trace-warnings"),
            Some("--trace-warnings".to_string())
        );
        assert_eq!(
            node_options_without_heap_flags("--max-old-space-size-percentage=50 --require a.cjs"),
            Some("--require a.cjs".to_string())
        );
        // 显式下发上限时真正要摘的组合：size + percentage + 无关选项同时在场，两个堆
        // flag 都必须消失（留下 percentage 会让命令行上限完全失效）。
        assert_eq!(
            node_options_without_heap_flags(
                "--max-old-space-size=8192 --max-old-space-size-percentage 50 --require C:/probe.cjs"
            ),
            Some("--require C:/probe.cjs".to_string())
        );
        assert_eq!(
            node_options_without_heap_flags("--max_old_space_size 8192"),
            None
        );
        assert_eq!(node_options_without_heap_flags("--trace-warnings"), Some("--trace-warnings".to_string()));
    }

    #[test]
    fn node_options_heap_limit_reads_the_inherited_value() {
        assert_eq!(node_options_heap_limit("--max-old-space-size=8192"), Some(8192));
        assert_eq!(node_options_heap_limit("--max-old-space-size 1600"), Some(1600));
        assert_eq!(node_options_heap_limit("--max_old_space_size=4096"), Some(4096));
    }

    /// V8 让 percentage 压过 size（实测 63 GB 机器上 `size=8192 percentage=50` 拿到
    /// 32413 MB，两个 flag 的先后顺序无关），此时报 size 就是谎报生效值。
    #[test]
    fn a_valid_percentage_flag_hides_the_size_flag() {
        for options in [
            "--max-old-space-size=8192 --max-old-space-size-percentage=50",
            "--max-old-space-size-percentage=50 --max-old-space-size=8192",
            "--max_old_space_size=8192 --max_old_space_size_percentage 50",
        ] {
            assert_eq!(node_options_heap_limit(options), None, "{options}");
            assert!(node_options_has_heap_flags(options), "{options}");
        }
        // 解析不出来的 percentage 不生效，size 仍然算数。
        assert_eq!(
            node_options_heap_limit("--max-old-space-size=8192 --max-old-space-size-percentage=abc"),
            Some(8192)
        );
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
