use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Zh,
    En,
}

static CURRENT_LANG: AtomicU8 = AtomicU8::new(0); // 0 = zh, 1 = en

pub fn set_language(lang: Lang) {
    CURRENT_LANG.store(
        match lang {
            Lang::Zh => 0,
            Lang::En => 1,
        },
        Ordering::SeqCst,
    );
}

fn lang() -> Lang {
    if CURRENT_LANG.load(Ordering::SeqCst) == 1 {
        Lang::En
    } else {
        Lang::Zh
    }
}

pub fn t(key: &str) -> String {
    let (zh, en): (&str, &str) = match key {
        "install.downloading" => ("正在下载", "Downloading"),
        "install.extracting" => ("正在解压", "Extracting"),
        "install.done" => ("依赖已安装完毕", "Dependencies installed"),
        "menu.run" => ("运行", "Run"),
        "menu.application" => ("应用", "Application"),
        "menu.profiles" => ("档案", "Profiles"),
        "menu.plugins" => ("插件", "Plugins"),
        "menu.harness" => ("核心", "Core"),
        "menu.help" => ("帮助", "Help"),
        "menu.file" => ("文件", "File"),
        "menu.new_window" => ("新建窗口", "New Window"),
        "menu.new_chat" => ("新聊天", "New Chat"),
        "menu.open_folder" => ("打开文件夹", "Open Folder"),
        "menu.close" => ("关闭", "Close"),
        "menu.quit" => ("退出", "Quit"),
        "menu.documentation" => ("文档", "Documentation"),
        "menu.settings" => ("设置…", "Settings…"),
        "menu.services" => ("服务", "Services"),
        "menu.hide" => ("隐藏", "Hide"),
        "menu.hide_others" => ("隐藏其他", "Hide Others"),
        "menu.show_all" => ("显示全部", "Show All"),
        "menu.view" => ("视图", "View"),
        "menu.window" => ("窗口", "Window"),
        "menu.minimize" => ("最小化", "Minimize"),
        "menu.zoom" => ("缩放", "Zoom"),
        "menu.bring_all_to_front" => ("前置全部窗口", "Bring All to Front"),
        "menu.keyboard_shortcuts" => ("显示键盘快捷键", "Show Keyboard Shortcuts"),
        "menu.enter_fullscreen" => ("进入全屏幕", "Enter Full Screen"),
        "menu.exit_fullscreen" => ("退出全屏幕", "Exit Full Screen"),
        "menu.about" => ("关于 Desktop", "About Desktop"),
        "menu.run_logs" => ("运行日志", "Run Logs"),
        "menu.check_update" => ("检查更新", "Check for Updates"),
        "menu.restart" => ("重启", "Restart"),
        "menu.edit" => ("编辑", "Edit"),
        "menu.undo" => ("撤销", "Undo"),
        "menu.redo" => ("重做", "Redo"),
        "menu.cut" => ("剪切", "Cut"),
        "menu.copy" => ("复制", "Copy"),
        "menu.paste" => ("粘贴", "Paste"),
        "menu.select_all" => ("全选", "Select All"),
        _ => (key, key),
    };
    match lang() {
        Lang::Zh => zh.to_string(),
        Lang::En => en.to_string(),
    }
}
