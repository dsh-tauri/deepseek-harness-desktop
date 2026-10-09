//! 下载地域检测：中国大陆用户自动切换镜像加速源（npmmirror / GitHub 代理镜像），
//! 避免直连 GitHub / nodejs.org 大文件下载缓慢。

use std::sync::OnceLock;

/// 下载源地域
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Region {
    /// 中国大陆：走镜像（npmmirror / GitHub 代理镜像）
    Domestic,
    /// 其他地区：直连官方源（nodejs.org / GitHub）
    Overseas,
}

/// 进程内缓存：安装/更新流程会多次构造下载 URL，检测只做一次。
static REGION: OnceLock<Region> = OnceLock::new();

/// 判定当前下载地域（带缓存，进程生命周期内恒定）。
pub fn detect_region() -> Region {
    *REGION.get_or_init(detect_region_uncached)
}

fn detect_region_uncached() -> Region {
    let locale = current_locale();
    let locale_zh = locale_is_china(&locale);
    let tz_china = is_china_timezone();
    let region = region_for(locale_zh, tz_china);
    log::info!(
        "Download region detected: {:?} (locale={locale:?}, china_timezone={tz_china})",
        region
    );
    region
}

/// 组合判定：简体中文界面语言或中国时区任一命中，即视为国内用户。
fn region_for(locale_zh: bool, tz_china: bool) -> Region {
    if locale_zh || tz_china {
        Region::Domestic
    } else {
        Region::Overseas
    }
}

/// 界面语言是否为大陆简体中文（zh-CN / zh_CN / zh-Hans-CN / zh-Hans）。
///
/// zh-TW / zh-HK / zh-SG 不命中：这些地区的 GitHub 直连通常可用，
/// 保守起见只对大陆用户启用镜像。
fn locale_is_china(locale: &str) -> bool {
    let normalized = locale.to_ascii_lowercase().replace('_', "-");
    normalized.starts_with("zh-cn") || normalized.starts_with("zh-hans")
}

/// 时区名是否指向中国大陆（Asia/Shanghai 及别名 PRC / China/* / China Standard Time）。
fn tz_name_is_china(name: &str) -> bool {
    let normalized = name.to_ascii_lowercase();
    normalized.contains("asia/shanghai")
        || normalized == "prc"
        || normalized.starts_with("prc/")
        || normalized.starts_with("china/")
        || normalized.contains("china standard time")
}

/// 系统界面语言（RFC 语言标签，如 `zh-CN` / `zh_CN`；取不到时返回空串）。
fn current_locale() -> String {
    #[cfg(windows)]
    {
        // Windows 的权威来源是用户默认区域设置（zh-CN / zh-Hans-CN）
        use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
        let mut buf = [0u16; 85];
        // 返回值含结尾 NUL 的字符数；失败返回 0
        let len = unsafe { GetUserDefaultLocaleName(buf.as_mut_ptr(), buf.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize - 1])
    }
    #[cfg(not(windows))]
    {
        // LC_ALL > LC_MESSAGES > LANG，去掉编码与修饰符（zh_CN.UTF-8 → zh_CN）
        for var in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(value) = std::env::var(var) {
                let base = value
                    .split('.')
                    .next()
                    .unwrap_or(&value)
                    .split('@')
                    .next()
                    .unwrap_or(&value);
                if !base.is_empty() && base != "C" && base != "POSIX" {
                    return base.to_string();
                }
            }
        }
        String::new()
    }
}

/// 系统时区是否为中国大陆时区（Asia/Shanghai / China Standard Time）。
fn is_china_timezone() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Time::{
            GetDynamicTimeZoneInformation, DYNAMIC_TIME_ZONE_INFORMATION, TIME_ZONE_ID_INVALID,
        };
        let mut info: DYNAMIC_TIME_ZONE_INFORMATION = unsafe { std::mem::zeroed() };
        let id = unsafe { GetDynamicTimeZoneInformation(&mut info) };
        if id == TIME_ZONE_ID_INVALID {
            return false;
        }
        // TimeZoneKeyName 是定长 UTF-16 数组，取到首个 NUL 为止
        let len = info
            .TimeZoneKeyName
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(info.TimeZoneKeyName.len());
        tz_name_is_china(&String::from_utf16_lossy(&info.TimeZoneKeyName[..len]))
    }
    #[cfg(not(windows))]
    {
        // 1) TZ 环境变量（少数系统显式设置，如 Asia/Shanghai）
        if let Ok(tz) = std::env::var("TZ") {
            if tz_name_is_china(&tz) {
                return true;
            }
        }
        // 2) /etc/localtime 软链：主流发行版指向 /usr/share/zoneinfo/<Area>/<Zone>
        if let Ok(target) = std::fs::read_link("/etc/localtime") {
            if tz_name_is_china(&target.to_string_lossy()) {
                return true;
            }
        }
        // 3) /etc/timezone（Debian/Ubuntu 的纯文本时区名，如 Asia/Shanghai）
        if let Ok(content) = std::fs::read_to_string("/etc/timezone") {
            if tz_name_is_china(content.trim()) {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_matching_only_matches_mainland_chinese() {
        assert!(locale_is_china("zh-CN"));
        assert!(locale_is_china("zh_CN.UTF-8"));
        assert!(locale_is_china("zh-Hans-CN"));
        assert!(locale_is_china("ZH_cn"));
        // 台湾/香港/新加坡中文不视为大陆
        assert!(!locale_is_china("zh-TW"));
        assert!(!locale_is_china("zh-HK"));
        assert!(!locale_is_china("zh-SG"));
        assert!(!locale_is_china("en-US"));
        assert!(!locale_is_china("ja-JP"));
        assert!(!locale_is_china(""));
    }

    #[test]
    fn timezone_matching_only_matches_china_tz() {
        assert!(tz_name_is_china("Asia/Shanghai"));
        assert!(tz_name_is_china("/usr/share/zoneinfo/Asia/Shanghai"));
        assert!(tz_name_is_china("China Standard Time"));
        assert!(tz_name_is_china("PRC"));
        assert!(!tz_name_is_china("Asia/Singapore"));
        assert!(!tz_name_is_china("Asia/Taipei"));
        assert!(!tz_name_is_china("Asia/Hong_Kong"));
        assert!(!tz_name_is_china("America/New_York"));
        assert!(!tz_name_is_china(""));
    }

    #[test]
    fn region_combination_is_or() {
        assert_eq!(region_for(true, true), Region::Domestic);
        assert_eq!(region_for(true, false), Region::Domestic);
        assert_eq!(region_for(false, true), Region::Domestic);
        assert_eq!(region_for(false, false), Region::Overseas);
    }
}
