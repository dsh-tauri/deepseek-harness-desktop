use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
    Ko,
    Ru,
}

static CURRENT_LANG: AtomicU8 = AtomicU8::new(0);

/// 注入页面的系统语言候选上限：只为让核心挑出界面语言，再多也没有意义。
const LANGUAGE_LIMIT: usize = 8;

/// 语言未知时的落点：桌面端历来以简体中文为默认界面语言。
pub const DEFAULT_LANGUAGE: &str = "zh-CN";

pub fn set_language(lang: Lang) {
    CURRENT_LANG.store(
        match lang {
            Lang::Zh => 0,
            Lang::En => 1,
            Lang::Ko => 2,
            Lang::Ru => 3,
        },
        Ordering::SeqCst,
    );
}

/// 语言标记清洗：去掉编码（`.UTF-8`）与修饰符（`@euro`），`_` 折成 `-`。
///
/// `C` / `POSIX` 表示「用户没有偏好」，继续往下传会让核心误判成一种真实语言。
fn language_tag(value: &str) -> Option<String> {
    let tag = value
        .trim()
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .replace('_', "-");
    let tag = tag.trim();
    let neutral =
        tag.is_empty() || tag.eq_ignore_ascii_case("c") || tag.eq_ignore_ascii_case("posix");
    (!neutral).then(|| tag.to_string())
}

/// 任意来源的语言标记收敛到桌面端打包的四个资源 id。
///
/// 中文按主语言判定：`zh_CN` / `zh-Hans-CN` / `zh-TW` 都落到已打包的 `zh-CN`。
/// 拿不到已打包语言时返回 `None`，由调用方决定回退，不在这里臆造默认值。
pub fn normalize_language(value: &str) -> Option<&'static str> {
    let tag = language_tag(value)?;
    let primary = tag.split('-').next()?.to_ascii_lowercase();
    match primary.as_str() {
        "zh" => Some("zh-CN"),
        "en" => Some("en-US"),
        "ko" => Some("ko-KR"),
        "ru" => Some("ru-RU"),
        _ => None,
    }
}

pub fn lang_from_setting(language: &str) -> Lang {
    match normalize_language(language) {
        Some("en-US") => Lang::En,
        Some("ko-KR") => Lang::Ko,
        Some("ru-RU") => Lang::Ru,
        _ => Lang::Zh,
    }
}

/// 注入页面的语言初始化数据：桌面壳的显式选择、系统语言顺序、核心可用的偏好。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageLocale {
    /// 桌面壳的显式语言（完整资源 id）；用户从未手动选择过时为 `None`。
    pub language: Option<String>,
    /// 系统语言，按优先级排列。
    pub languages: Vec<String>,
    /// 传给 dsh 客户端的 `locale.preference`：核心只认 `zh` / `en`。
    pub core_preference: Option<&'static str>,
}

/// 清洗系统语言候选：`LANGUAGE` 是冒号分隔的优先级列表，逐项清洗去重后截断。
fn clean_languages(sources: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut languages: Vec<String> = Vec::new();
    for source in sources {
        for raw in source.split(':') {
            let Some(tag) = language_tag(raw) else {
                continue;
            };
            if languages
                .iter()
                .any(|known| known.eq_ignore_ascii_case(&tag))
            {
                continue;
            }
            languages.push(tag);
            if languages.len() == LANGUAGE_LIMIT {
                return languages;
            }
        }
    }
    languages
}

/// 当前会话的系统语言（进程内只探测一次）。
pub fn system_languages() -> Vec<String> {
    static CACHE: OnceLock<Vec<String>> = OnceLock::new();
    CACHE.get_or_init(detect_system_languages).clone()
}

/// 环境变量最贴近登录会话，其次是桌面环境与系统默认值。
fn detect_system_languages() -> Vec<String> {
    let mut sources: Vec<String> = ["LANGUAGE", "LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name))
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    sources.extend(desktop_region());
    sources.extend(file_locale_defaults());
    clean_languages(sources)
}

/// GNOME「区域与语言」把选择写在 `org.gnome.system.locale region`。
///
/// 从桌面快捷方式启动时会拿不到 `LANG`（它只存在于登录 shell 里），此时这里是
/// Ubuntu 上唯一还能问到的来源。
#[cfg(target_os = "linux")]
fn desktop_region() -> Option<String> {
    let output = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.system.locale", "region"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(not(target_os = "linux"))]
fn desktop_region() -> Option<String> {
    None
}

/// `/etc/default/locale` 是 Debian / Ubuntu 的系统级语言默认值。
#[cfg(target_os = "linux")]
fn file_locale_defaults() -> Vec<String> {
    const KEYS: [&str; 4] = ["LANGUAGE", "LC_ALL", "LANG", "LC_MESSAGES"];
    let Ok(content) = std::fs::read_to_string("/etc/default/locale") else {
        return Vec::new();
    };
    let mut sources = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !KEYS.contains(&key.trim()) {
            continue;
        }
        sources.push(value.trim().trim_matches(['"', '\'']).to_string());
    }
    sources
}

#[cfg(not(target_os = "linux"))]
fn file_locale_defaults() -> Vec<String> {
    Vec::new()
}

/// 页面语言初始化数据；`explicit` 只有用户手动选过语言时才给值。
pub fn page_locale(explicit: Option<&str>) -> PageLocale {
    page_locale_with(explicit, system_languages())
}

fn page_locale_with(explicit: Option<&str>, languages: Vec<String>) -> PageLocale {
    let language = explicit.and_then(normalize_language).map(str::to_string);
    let core_preference = match language.as_deref() {
        Some("zh-CN") => Some("zh"),
        Some("en-US") => Some("en"),
        _ => None,
    };
    let mut languages = languages;
    if let Some(language) = &language {
        languages.retain(|tag| !tag.eq_ignore_ascii_case(language));
        languages.insert(0, language.clone());
    }
    PageLocale {
        language,
        languages,
        core_preference,
    }
}

fn lang() -> Lang {
    match CURRENT_LANG.load(Ordering::SeqCst) {
        1 => Lang::En,
        2 => Lang::Ko,
        3 => Lang::Ru,
        _ => Lang::Zh,
    }
}

fn pick(key: &str, lang: Lang) -> String {
    let (zh, en, ko, ru): (&str, &str, &str, &str) = match key {
        "install.downloading" => ("正在下载", "Downloading", "내려받는 중", "Загрузка"),
        "install.extracting" => ("正在解压", "Extracting", "압축 푸는 중", "Распаковка"),
        "install.done" => ("依赖已安装完毕", "Dependencies installed", "의존성 설치 완료", "Зависимости установлены"),
        "menu.run" => ("运行与管理", "Run & Manage", "실행 및 관리", "Запуск и управление"),
        "menu.application" => ("应用", "Application", "애플리케이션", "Приложение"),
        "menu.profiles" => ("档案管理…", "Manage Profiles…", "프로파일 관리…", "Управление профилями…"),
        "menu.plugins" => ("插件管理…", "Manage Plugins…", "플러그인 관리…", "Управление плагинами…"),
        "menu.harness" => ("核心管理…", "Manage Core…", "코어 관리…", "Управление ядром…"),
        "menu.help" => ("帮助", "Help", "도움말", "Справка"),
        "menu.file" => ("文件", "File", "파일", "Файл"),
        "menu.new_window" => ("新建窗口", "New Window", "새 창", "Новое окно"),
        "menu.new_chat" => ("新聊天", "New Chat", "새 채팅", "Новый чат"),
        "menu.open_folder" => ("打开文件夹", "Open Folder", "폴더 열기", "Открыть папку"),
        "menu.open_panel" => ("打开面板", "Open Panel", "패널 열기", "Открыть панель"),
        "menu.close" => ("关闭", "Close", "닫기", "Закрыть"),
        "menu.quit" => ("退出", "Quit", "종료", "Выход"),
        "menu.documentation" => ("文档", "Documentation", "문서", "Документация"),
        "menu.desktop_feedback" => ("桌面版问题反馈", "Desktop Feedback", "데스크톱 피드백", "Обратная связь по приложению"),
        "menu.harness_feedback" => ("DeepSeek Harness 官方反馈", "DeepSeek Harness Official Feedback", "DeepSeek Harness 공식 피드백", "Официальная обратная связь DeepSeek Harness"),
        "menu.settings" => ("设置…", "Settings…", "설정…", "Настройки…"),
        "menu.services" => ("服务", "Services", "서비스", "Службы"),
        "menu.hide" => ("隐藏", "Hide", "가리기", "Скрыть"),
        "menu.hide_others" => ("隐藏其他", "Hide Others", "기타 숨기기", "Скрыть остальные"),
        "menu.show_all" => ("显示全部", "Show All", "모두 보기", "Показать все"),
        "menu.view" => ("视图", "View", "보기", "Вид"),
        "menu.toggle_sidebar" => ("显示/隐藏侧边栏", "Toggle Sidebar", "사이드바 표시/숨기기", "Показать/скрыть боковую панель"),
        "menu.toggle_right_panel" => ("显示/隐藏右侧面板", "Toggle Right Panel", "오른쪽 패널 표시/숨기기", "Показать/скрыть правую панель"),
        "menu.open_terminal" => ("打开终端", "Open Terminal", "터미널 열기", "Открыть терминал"),
        "menu.search_chats" => ("查找聊天", "Search Chats", "채팅 검색", "Поиск чатов"),
        "menu.zoom_in" => ("放大", "Zoom In", "확대", "Увеличить"),
        "menu.zoom_out" => ("缩小", "Zoom Out", "축소", "Уменьшить"),
        "menu.actual_size" => ("实际大小", "Actual Size", "실제 크기", "Фактический размер"),
        "menu.window" => ("窗口", "Window", "창", "Окно"),
        "menu.minimize" => ("最小化", "Minimize", "최소화", "Свернуть"),
        "menu.zoom" => ("缩放", "Zoom", "크기 조절", "Изменить масштаб"),
        "menu.bring_all_to_front" => ("全部置于顶层", "Bring All to Front", "모두 앞으로", "Все окна на передний план"),
        "menu.keyboard_shortcuts" => ("显示键盘快捷键", "Show Keyboard Shortcuts", "키보드 단축키 보기", "Сочетания клавиш"),
        "menu.enter_fullscreen" => ("进入全屏幕", "Enter Full Screen", "전체 화면", "Во весь экран"),
        "menu.exit_fullscreen" => ("退出全屏幕", "Exit Full Screen", "전체 화면 종료", "Выйти из полноэкранного режима"),
        "menu.about" => ("关于 Desktop", "About Desktop", "데스크톱 정보", "О программе Desktop"),
        "menu.toggle_devtools" => ("切换开发者工具", "Toggle Developer Tools", "개발자 도구 전환", "Инструменты разработчика"),
        "menu.task_manager" => ("任务管理器", "Task Manager", "작업 관리자", "Диспетчер задач"),
        "menu.run_logs" => ("运行日志", "Run Logs", "실행 로그", "Журналы запуска"),
        "menu.check_update" => ("检查更新", "Check for Updates", "업데이트 확인", "Проверить обновления"),
        "menu.restart" => ("重启 Harness", "Restart Harness", "Harness 다시 시작", "Перезапустить Harness"),
        "menu.edit" => ("编辑", "Edit", "편집", "Правка"),
        "menu.undo" => ("撤销", "Undo", "실행 취소", "Отменить"),
        "menu.redo" => ("重做", "Redo", "다시 실행", "Повторить"),
        "menu.cut" => ("剪切", "Cut", "자르기", "Вырезать"),
        "menu.copy" => ("复制", "Copy", "복사", "Копировать"),
        "menu.paste" => ("粘贴", "Paste", "붙여넣기", "Вставить"),
        "menu.select_all" => ("全选", "Select All", "모두 선택", "Выбрать все"),
        _ => (key, key, key, key),
    };
    match lang {
        Lang::Zh => zh.to_string(),
        Lang::En => en.to_string(),
        Lang::Ko => ko.to_string(),
        Lang::Ru => ru.to_string(),
    }
}

pub fn t(key: &str) -> String {
    pick(key, lang())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lang_from_setting_covers_english_variants() {
        assert!(matches!(lang_from_setting("en"), Lang::En));
        assert!(matches!(lang_from_setting("en-US"), Lang::En));
        assert!(matches!(lang_from_setting("zh-CN"), Lang::Zh));
        assert!(matches!(lang_from_setting(""), Lang::Zh));
    }

    #[test]
    fn lang_from_setting_covers_korean_variants() {
        assert!(matches!(lang_from_setting("ko"), Lang::Ko));
        assert!(matches!(lang_from_setting("ko-KR"), Lang::Ko));
    }

    #[test]
    fn lang_from_setting_covers_russian_variants() {
        assert!(matches!(lang_from_setting("ru"), Lang::Ru));
        assert!(matches!(lang_from_setting("ru-RU"), Lang::Ru));
    }

    #[test]
    fn normalize_language_folds_posix_and_bcp47_spellings() {
        for (raw, expected) in [
            ("zh", "zh-CN"),
            ("zh_CN", "zh-CN"),
            ("zh-CN", "zh-CN"),
            ("zh-Hans", "zh-CN"),
            ("zh-Hans-CN", "zh-CN"),
            ("zh_CN.UTF-8", "zh-CN"),
            ("zh_TW.UTF-8", "zh-CN"),
            ("ZH_cn", "zh-CN"),
            ("en", "en-US"),
            ("en_US.UTF-8", "en-US"),
            ("en-GB", "en-US"),
            ("ko_KR.UTF-8", "ko-KR"),
            ("ru_RU@euro", "ru-RU"),
        ] {
            assert_eq!(normalize_language(raw), Some(expected), "{raw}");
        }
        for raw in ["", "   ", "C", "POSIX", "C.UTF-8", "fr_FR.UTF-8", "ja-JP"] {
            assert_eq!(normalize_language(raw), None, "{raw}");
        }
    }

    #[test]
    fn lang_from_setting_follows_the_normalized_tag() {
        assert!(matches!(lang_from_setting("zh_CN.UTF-8"), Lang::Zh));
        assert!(matches!(lang_from_setting("EN_us"), Lang::En));
        assert!(matches!(lang_from_setting("fr_FR.UTF-8"), Lang::Zh));
    }

    #[test]
    fn clean_languages_splits_priority_lists_and_drops_neutral_entries() {
        let sources = [
            "zh_CN:zh:en_US".to_string(),
            "C".to_string(),
            String::new(),
            "zh-CN".to_string(),
            "en_US.UTF-8".to_string(),
        ];
        assert_eq!(
            clean_languages(sources),
            ["zh-CN", "zh", "en-US"].map(str::to_string).to_vec()
        );
        assert_eq!(
            clean_languages((0..20).map(|index| format!("l{index}"))),
            (0..LANGUAGE_LIMIT)
                .map(|index| format!("l{index}"))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn page_locale_prefers_the_explicit_shell_choice() {
        let locale = page_locale_with(Some("zh_CN.UTF-8"), vec!["en-US".to_string()]);
        assert_eq!(locale.language.as_deref(), Some("zh-CN"));
        assert_eq!(locale.core_preference, Some("zh"));
        assert_eq!(locale.languages, ["zh-CN", "en-US"].map(str::to_string));
    }

    /// 没有显式选择时必须原样给出系统语言，而不是塞一个硬编码的默认值。
    #[test]
    fn page_locale_without_explicit_choice_keeps_system_order() {
        let locale = page_locale_with(None, vec!["zh-CN".to_string(), "en-US".to_string()]);
        assert_eq!(locale.language, None);
        assert_eq!(locale.core_preference, None);
        assert_eq!(locale.languages, ["zh-CN", "en-US"].map(str::to_string));
    }

    #[test]
    fn page_locale_ignores_unpackaged_and_unsupported_explicit_choices() {
        for raw in ["fr-FR", "C", ""] {
            let locale = page_locale_with(Some(raw), vec!["en-US".to_string()]);
            assert_eq!(locale.language, None, "{raw}");
            assert_eq!(locale.core_preference, None, "{raw}");
        }
        let korean = page_locale_with(Some("ko-KR"), Vec::new());
        assert_eq!(korean.core_preference, None);
        assert_eq!(korean.languages, ["ko-KR"].map(str::to_string));
    }

    #[test]
    fn tray_menu_keys_are_translated() {
        assert_ne!(t("menu.open_panel"), "menu.open_panel");
        assert_ne!(t("menu.quit"), "menu.quit");
    }

    #[test]
    fn korean_labels_are_translated() {
        assert_eq!(pick("menu.file", Lang::Ko), "파일");
        assert_eq!(pick("menu.help", Lang::Ko), "도움말");
        assert_eq!(pick("install.done", Lang::Ko), "의존성 설치 완료");
    }

    #[test]
    fn russian_labels_are_translated() {
        assert_eq!(pick("menu.file", Lang::Ru), "Файл");
        assert_eq!(pick("menu.help", Lang::Ru), "Справка");
        assert_eq!(pick("install.done", Lang::Ru), "Зависимости установлены");
    }
}
