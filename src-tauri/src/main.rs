// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 无 GUI 的补丁入口：E2E 的插件 L2 直接起 `dsh web`，需要把 npm 装来的核心
    // 打成与桌面端装配核心同样的形态。复用 lib 里的补丁集，而不是另抄一份实现。
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--patch-core") {
        let Some(dir) = args.get(2) else {
            eprintln!("usage: deepseek-harness-desktop --patch-core <core-dir>");
            std::process::exit(2);
        };
        if let Err(e) = main::patch_core_dir(std::path::Path::new(dir)) {
            eprintln!("patch-core failed: {e}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = main::run() {
        main::desktop::startup::report(&error);
        std::process::exit(1);
    }
}
