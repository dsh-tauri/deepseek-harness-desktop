use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
    Ko,
    Ru,
}

static CURRENT_LANG: AtomicU8 = AtomicU8::new(0); // 0 = zh, 1 = en, 2 = ko, 3 = ru

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

pub fn lang_from_setting(language: &str) -> Lang {
    match language {
        "en" | "en-US" => Lang::En,
        "ko" | "ko-KR" => Lang::Ko,
        "ru" | "ru-RU" => Lang::Ru,
        _ => Lang::Zh,
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

pub fn t(key: &str) -> String {
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
        "pet.show_main_window" => ("显示主界面", "Show Main Window", "기본 창 표시", "Показать главное окно"),
        "pet.close" => ("关闭宠物", "Close Pet", "펫 닫기", "Закрыть питомца"),
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
    match lang() {
        Lang::Zh => zh.to_string(),
        Lang::En => en.to_string(),
        Lang::Ko => ko.to_string(),
        Lang::Ru => ru.to_string(),
    }
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
    fn tray_menu_keys_are_translated() {
        assert_ne!(t("menu.open_panel"), "menu.open_panel");
        assert_ne!(t("menu.quit"), "menu.quit");
    }

    #[test]
    fn korean_labels_are_translated() {
        set_language(Lang::Ko);
        assert_eq!(t("menu.file"), "파일");
        assert_eq!(t("menu.help"), "도움말");
        assert_eq!(t("install.done"), "의존성 설치 완료");
        set_language(Lang::Zh);
    }

    #[test]
    fn russian_labels_are_translated() {
        set_language(Lang::Ru);
        assert_eq!(t("menu.file"), "Файл");
        assert_eq!(t("menu.help"), "Справка");
        assert_eq!(t("install.done"), "Зависимости установлены");
        set_language(Lang::Zh);
    }
}
