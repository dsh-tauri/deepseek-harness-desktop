use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
#[cfg(target_os = "macos")]
use tauri::Manager;
use tauri::{AppHandle, Emitter};

use super::runtime::get_dsh_data_path;

/// dsh 主题偏好（0.1.7 起是当前档案 `cordis.patch.yml` 里 `ui-theme` 条目的
/// `config.preference`；更早的核心是 `$DSH_HOME/settings.yaml`）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DshTheme {
    Dark,
    Light,
    System,
}

/// 未设置过主题偏好时的回退值：跟随系统外观。
///
/// 首次进入（两代设置文件都不存在）或偏好值缺失/非法时都走这里；回退成固定
/// 深色会让「跟随系统」的默认体验失效（浅色系统上启动即深色）。
const DEFAULT_THEME: DshTheme = DshTheme::System;

static LAST_EMITTED: OnceLock<Mutex<Option<DshTheme>>> = OnceLock::new();

/// 读取 dsh 主题偏好；两代存放位置都缺失或解析失败时回退为跟随系统。
pub fn get_dsh_theme(app_handle: &AppHandle) -> DshTheme {
    let home = get_dsh_data_path(app_handle);
    let profile = crate::service::profile::profile_dir_of(
        app_handle,
        &crate::service::profile::active_profile(app_handle),
    );
    read_dsh_theme(&home, &profile)
}

/// 依次尝试当前档案的补丁层、旧 `settings.yaml`、导入后的 `settings.yaml.imported`。
///
/// 0.1.7 把设置收进当前 Profile 的插件配置，`settings.yaml` 只在首次导入时读一次、
/// 随后改名为 `settings.yaml.imported`。档案层是唯一的活配置；后两者只是旧核心与
/// 「导入完、档案里还没写过主题」的兜底。
fn read_dsh_theme(home: &Path, profile_dir: &Path) -> DshTheme {
    if let Ok(content) = fs::read_to_string(profile_dir.join("cordis.patch.yml")) {
        if let Some(theme) = parse_profile_theme(&content) {
            return theme;
        }
    }
    for name in [LEGACY_SETTINGS_FILE, IMPORTED_SETTINGS_FILE] {
        if let Ok(content) = fs::read_to_string(home.join(name)) {
            if let Some(theme) = parse_theme_preference(&content) {
                return theme;
            }
        }
    }
    log::debug!("no dsh theme preference found; following the system appearance");
    DEFAULT_THEME
}

/// 0.1.5 / 0.1.6 的设置文件。
const LEGACY_SETTINGS_FILE: &str = "settings.yaml";

/// 0.1.7 首次导入后留下的快照，此后不再更新。
const IMPORTED_SETTINGS_FILE: &str = "settings.yaml.imported";

/// 官方 web-app bundle 给主题插件的补丁条目 id（`packages/bundle/web-app/cordis.patch.yml`）；
/// 设置页把偏好写进同 id 的条目，因此这是跨版本稳定的锚点。
const UI_THEME_ENTRY_ID: &str = "ui-theme";

/// 从档案补丁层 `cordis.patch.yml` 提取 `ui-theme` 条目的 `config.preference`。
///
/// 必须按条目分段读取：`locale` 条目也有 `preference` 键（界面语言），越界匹配会把
/// 语言值当成主题值。
fn parse_profile_theme(content: &str) -> Option<DshTheme> {
    let mut in_theme_entry = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        // 顶层 `- ` 开启新条目；`config:` 下的嵌套列表有缩进，不会误判为边界。
        if line.starts_with('-') {
            in_theme_entry = false;
            if let Some(value) = trimmed.strip_prefix("- id:") {
                in_theme_entry = value.trim().trim_matches(['"', '\'']) == UI_THEME_ENTRY_ID;
            }
            continue;
        }
        if !in_theme_entry {
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("preference:") {
            return parse_theme_name(value.trim().trim_matches(['"', '\'']));
        }
    }
    None
}

fn parse_theme_name(value: &str) -> Option<DshTheme> {
    match value {
        "light" => Some(DshTheme::Light),
        "dark" => Some(DshTheme::Dark),
        "system" => Some(DshTheme::System),
        _ => None,
    }
}

/// 从 settings.yaml 文本中提取 `ui-theme.preference`（light/dark/system）
fn parse_theme_preference(content: &str) -> Option<DshTheme> {
    let mut in_ui_theme = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("ui-theme:") {
            in_ui_theme = true;
            continue;
        }
        if !in_ui_theme {
            continue;
        }
        // ui-theme 段结束（遇到无缩进的新顶层 key）
        if !line.starts_with(' ') && !line.starts_with('\t') {
            return None;
        }
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            if let Some(value) = trimmed.strip_prefix("preference:") {
                return parse_theme_name(value.trim());
            }
        }
    }
    None
}

/// 把 dsh 主题偏好同步为主窗口的原生外观（仅 macOS）。
///
/// macOS 上窗口保留了原生标题栏（`decorations(true)` + `Overlay` + `hidden_title`），
/// 其材质与交通灯底色跟随「系统外观」，而内嵌 dsh 页面的亮/暗由前端
/// `html[data-theme]` 独立控制；两者不联动就会出现「内容已切亮色、顶部标题栏仍
/// 是暗色」的割裂（issue #93）。这里把偏好直接落到原生外观：`system` → 跟随系统，
/// `light` / `dark` → 强制指定，让原生 chrome 与 dsh 页面始终一致。
///
/// 非 macOS 平台关闭了窗口 decoration、整窗皆为前端 `data-theme`，无原生 chrome
/// 可同步，无需（也无从）调用。
#[cfg(target_os = "macos")]
pub fn apply_window_theme(app_handle: &AppHandle, theme: DshTheme) {
    let appearance = match theme {
        DshTheme::System => None,
        DshTheme::Light => Some(tauri::Theme::Light),
        DshTheme::Dark => Some(tauri::Theme::Dark),
    };
    for window in app_handle.webview_windows().into_values() {
        if let Err(err) = window.set_theme(appearance) {
            log::warn!("[theme] failed to sync native window appearance: {err}");
        }
    }
}

/// 主题偏好变化时向前端推送 `dsh-theme-updated` 事件（仅在变化时触发一次）。
/// 变化时同步 macOS 原生窗口外观，与前端 `data-theme` 保持同源。
pub fn check_and_emit_theme(app_handle: &AppHandle) {
    let theme = get_dsh_theme(app_handle);
    let mut last = LAST_EMITTED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap();
    if *last == Some(theme) {
        return;
    }
    *last = Some(theme);
    log::debug!("dsh theme preference changed: {:?}", theme);
    let _ = app_handle.emit("dsh-theme-updated", &theme);
    #[cfg(target_os = "macos")]
    apply_window_theme(app_handle, theme);
}

/// 壳层画布色，与 `src/styles/main.css` 的 `--color-canvas` 同值。
const CANVAS_DARK: tauri::webview::Color = tauri::webview::Color(0x15, 0x15, 0x17, 0xFF);
const CANVAS_LIGHT: tauri::webview::Color = tauri::webview::Color(0xFF, 0xFF, 0xFF, 0xFF);

/// 窗口底色：显式偏好直接取画布色，`system` 按当前系统外观折算。
///
/// 壳层 CSS 以深色为默认（`src/styles/main.css` 的 `:root`），而偏好要等前端
/// `use-theme-adaptive` 的 IPC 回来才生效；窗口底色不对，这段间隙就会闪一次错色。
/// 底色由原生 webview 直接承担，不需要往页面注入脚本；此后偏好变化仍由
/// `check_and_emit_theme` 的 `dsh-theme-updated` 事件同步。
///
/// macOS 未实现该接口（`WebviewWindowBuilder::background_color` 的平台说明），
/// 那里由 [`apply_window_theme`] 同步原生外观。
pub fn window_background(
    theme: DshTheme,
    system: Option<tauri::Theme>,
) -> Option<tauri::webview::Color> {
    match theme {
        DshTheme::Light => Some(CANVAS_LIGHT),
        DshTheme::Dark => Some(CANVAS_DARK),
        DshTheme::System => match system {
            Some(tauri::Theme::Light) => Some(CANVAS_LIGHT),
            Some(tauri::Theme::Dark) => Some(CANVAS_DARK),
            _ => None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 首次进入（`settings.yaml` 不存在）与偏好值非法时都回退「跟随系统」；
    /// 回退固定深色会让浅色系统上的默认外观失效（首次进入即深色）。
    #[test]
    fn default_theme_follows_system() {
        assert_eq!(DEFAULT_THEME, DshTheme::System);
    }

    /// 0.1.7 起主题偏好落在当前 Profile 的 `cordis.patch.yml`。必须按条目分段：
    /// `locale` 条目同样有 `preference` 键（界面语言），越界匹配会取到 `zh`。
    #[test]
    fn parses_profile_patch_theme_entry() {
        let content = "- id: ui-theme\n  name: \"@deepseek-ai/dsh-client-ui-theme\"\n  config:\n    preference: light\n- id: locale\n  name: \"@deepseek-ai/dsh-client-locale\"\n  config:\n    preference: zh\n";
        assert_eq!(parse_profile_theme(content), Some(DshTheme::Light));
    }

    /// 只有 `locale` 条目时不得把界面语言当成主题。
    #[test]
    fn profile_patch_ignores_other_entries() {
        assert_eq!(
            parse_profile_theme("- id: locale\n  config:\n    preference: dark\n"),
            None
        );
    }

    /// `ui-theme` 条目缺失、取值非法或整段不存在都返回 `None`。
    #[test]
    fn profile_patch_rejects_missing_and_unknown() {
        assert_eq!(parse_profile_theme("[]\n"), None);
        assert_eq!(
            parse_profile_theme("- id: ui-theme\n  config:\n    preference: blue\n"),
            None
        );
        assert_eq!(
            parse_profile_theme("- id: ui-theme\n  config:\n    density: compact\n"),
            None
        );
    }

    /// 档案层优先于旧 `settings.yaml`：后者在 0.1.7 首次导入后就被弃用。
    #[test]
    fn profile_patch_wins_over_legacy_settings() {
        let home = std::env::temp_dir().join("dsh-theme-test-home");
        let profile = std::env::temp_dir().join("dsh-theme-test-profile");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&profile).unwrap();
        fs::write(
            home.join("settings.yaml"),
            "ui-theme:\n  preference: light\n",
        )
        .unwrap();
        fs::write(
            profile.join("cordis.patch.yml"),
            "- id: ui-theme\n  config:\n    preference: dark\n",
        )
        .unwrap();
        assert_eq!(read_dsh_theme(&home, &profile), DshTheme::Dark);
        let _ = fs::remove_file(profile.join("cordis.patch.yml"));
        assert_eq!(read_dsh_theme(&home, &profile), DshTheme::Light);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&profile);
    }

    /// 窗口底色跟随偏好；`system` 按系统外观折算，取不到外观时不设（保留 webview
    /// 默认），避免凭空猜一个可能错的底色。
    #[test]
    fn window_background_follows_preference() {
        let rgba = |c: Option<tauri::webview::Color>| c.map(|c| (c.0, c.1, c.2, c.3));
        assert_eq!(
            rgba(window_background(DshTheme::Light, None)),
            Some((0xFF, 0xFF, 0xFF, 0xFF))
        );
        assert_eq!(
            rgba(window_background(DshTheme::Dark, None)),
            Some((0x15, 0x15, 0x17, 0xFF))
        );
        assert_eq!(
            rgba(window_background(
                DshTheme::System,
                Some(tauri::Theme::Dark)
            )),
            Some((0x15, 0x15, 0x17, 0xFF))
        );
        assert_eq!(
            rgba(window_background(
                DshTheme::System,
                Some(tauri::Theme::Light)
            )),
            Some((0xFF, 0xFF, 0xFF, 0xFF))
        );
        assert_eq!(window_background(DshTheme::System, None), None);
    }

    #[test]
    fn parses_known_preference_values() {
        let cases = [
            ("ui-theme:\n  preference: dark\n", DshTheme::Dark),
            ("ui-theme:\n  preference: light\n", DshTheme::Light),
            ("ui-theme:\n  preference: system\n", DshTheme::System),
        ];
        for (content, expected) in cases {
            assert_eq!(
                parse_theme_preference(content),
                Some(expected),
                "content={content:?}"
            );
        }
    }

    /// 未知取值与整段缺失都返回 `None`，由调用方回退 `DEFAULT_THEME`。
    #[test]
    fn rejects_unknown_and_missing_preference() {
        assert_eq!(
            parse_theme_preference("ui-theme:\n  preference: blue\n"),
            None
        );
        assert_eq!(
            parse_theme_preference("ui-theme:\n  density: compact\n"),
            None
        );
        assert_eq!(parse_theme_preference("editor:\n  fontSize: 12\n"), None);
    }
}
