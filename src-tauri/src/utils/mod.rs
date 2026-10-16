use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::service::core::active_core_dir;

/// 对某个 dsh 包文件的一次性幂等补丁判定结果。
#[derive(Debug, PartialEq, Eq)]
pub enum PatchOutcome {
    /// 目标已含补丁标记（本补丁已生效，或上游官方已合并），无需再改。
    AlreadyPatched,
    /// 锚点缺失（上游布局变更），跳过并向调用方说明降级兜底。
    AnchorMissing,
    /// 已生成补丁后的完整内容。
    Patched(String),
}

/// 对活动核心安装目录下的某个 dsh 包文件应用一次性幂等补丁。
///
/// - `rel_path`：相对活动核心安装目录的包内路径，例如
///   `node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js`（即 `patch_dsh("packagename/xxx/xxx.js", ..)` 里的包路径）。
/// - `patch`：纯函数式补丁判定，输入文件原文、返回 [`PatchOutcome`]；只做内容变换，
///   不触碰文件系统，便于单测。
///
/// 统一处理「定位文件 → 读取 → 打补丁 → 写回」与对应的日志。文件缺失、已打过、
/// 锚点变更均静默跳过并返回 Ok；只有真实读/写失败才返回 Err（不阻断启动的调用方
/// 据此仅告警）。活动核心的判定与 [`active_core_dir`] 一致。
pub fn patch_dsh(
    app_handle: &tauri::AppHandle,
    rel_path: &str,
    patch: impl FnOnce(&str) -> PatchOutcome,
) -> Result<(), String> {
    patch_core_file(&active_core_dir(app_handle), rel_path, patch)
}

/// [`patch_dsh`] 的目录版本：对显式给定的核心安装目录施加同一个补丁。
///
/// 供 E2E 编排复用——那条链路没有运行中的桌面端，拿不到 `AppHandle`，
/// 但必须让被测核心与本应用装配出的核心保持同一份补丁。
pub fn patch_core_file(
    core_dir: &Path,
    rel_path: &str,
    patch: impl FnOnce(&str) -> PatchOutcome,
) -> Result<(), String> {
    let target = core_dir.join(rel_path);
    if !target.exists() {
        log::info!("dsh patch target not found, skip: {}", target.display());
        return Ok(());
    }
    let source = std::fs::read_to_string(&target)
        .map_err(|e| format!("DSH_PATCH_READ: {} failed: {e}", target.display()))?;
    match patch(&source) {
        PatchOutcome::AlreadyPatched => {
            log::info!("dsh patch already applied: {}", target.display());
        }
        PatchOutcome::AnchorMissing => {
            log::warn!("dsh patch anchor missing, skip: {}", target.display());
        }
        PatchOutcome::Patched(patched) => {
            std::fs::write(&target, patched)
                .map_err(|e| format!("DSH_PATCH_WRITE: {} failed: {e}", target.display()))?;
            log::info!("dsh patch applied: {}", target.display());
        }
    }
    Ok(())
}

pub fn show_window<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 显示主窗口：托盘「打开面板」、托盘左键点击、macOS Dock 图标点击共用。
/// 关闭按钮只隐藏窗口（见 builder 的 on_window_event），所以这里取到即可 show；
/// 若窗口确实不存在（非预期路径），仅记录日志，不重建。
pub fn shell_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("main").or_else(|| {
        app.webview_windows().into_values().find(|window| {
            window.label().starts_with("window-") || window.label().starts_with("remote-")
        })
    })
}

pub fn operation_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    use crate::service::workflow::instances;
    let profile = instances::current_profile()?;
    app.get_webview_window("main")
        .filter(|window| instances::window_uses_profile(window.label(), &profile))
        .or_else(|| {
            app.webview_windows().into_values().find(|window| {
                (window.label().starts_with("window-") || window.label().starts_with("remote-"))
                    && instances::window_uses_profile(window.label(), &profile)
            })
        })
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = shell_window(app) {
        // 关窗驻留用的是应用级 hide（NSApp hide:，见 builder 的 CloseRequested），
        // 恢复前必须先 unhide 整个应用，否则 window.show() 在隐藏态应用上不可见。
        #[cfg(target_os = "macos")]
        if let Err(error) = app.show() {
            log::warn!("[window] APP_SHOW_FAILED: {error}");
        }
        // Accessory 下 window.show() 有历史问题（tauri #5122），必须先切回
        // regular 再 show；放在这里可一次覆盖托盘菜单「打开面板」、托盘左键、
        // RunEvent::Reopen、release single-instance 四条恢复路径。
        #[cfg(target_os = "macos")]
        crate::desktop::activation::set_regular_policy(app);
        // 恢复路径不改变全屏状态：全屏关窗后从托盘恢复，窗口依旧全屏。
        // 不在此重新挂起 Accessory：窗口此时已可见，若挂起推迟标志，用户
        // 退出全屏时 on_window_resized 会把可见应用切进 Accessory，导致 Dock
        // 图标与 ⌘-Tab 在窗口仍打开时消失。Accessory 只在关窗驻留路径的
        // hide 之后生效，前台可见态应保持 regular。
        show_window(&window);
        // 恢复路径不改变全屏状态：全屏关窗后从托盘恢复，窗口依旧全屏，
        // 而 set_regular_policy 已无条件清掉推迟标志。这里按需重新挂起，
        // 否则用户退出全屏时 Accessory 永不生效（Dock / ⌘-Tab 整个驻留期可见）。
        #[cfg(target_os = "macos")]
        crate::desktop::activation::rearm_pending_accessory_if_fullscreen(&window);
    } else {
        log::warn!("[window] main window not found, skip show");
    }
}

/// 解码子进程输出的一行。
///
/// 中文 Windows 下子进程（cmd.exe、python MCP 服务器等）按 ANSI 代码页输出 GBK，
/// 图省事的 `from_utf8_lossy` 会把 `系统找不到指定的路径。` 解成
/// `ϵͳ�Ҳ���ָ����·����`——日志里认不出原话。这里先严格 UTF-8，失败再按 ANSI
/// 代码页解码，仍失败才回落 lossy。
///
/// 任何情况下都不能中断读取：管道读端一关，dsh 主进程写 stderr 就收到 EPIPE
/// 并静默退出（见 `service::workflow::utils::drain_subprocess_output`）。
pub fn decode_process_line(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_owned();
    }
    #[cfg(windows)]
    if let Some(text) = decode_multibyte(bytes, windows_sys::Win32::Globalization::CP_ACP) {
        return text;
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// 按给定代码页把多字节串解成 UTF-16，再取 `String`；转换失败返回 `None`。
#[cfg(windows)]
pub(crate) fn decode_multibyte(bytes: &[u8], codepage: u32) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    if bytes.is_empty() {
        return Some(String::new());
    }
    if bytes.len() > i32::MAX as usize {
        return None;
    }
    let len = bytes.len() as i32;
    // SAFETY: 指针与长度同源于 `bytes`；空缓冲 + 0 长度只探测所需宽字符数。
    let needed =
        unsafe { MultiByteToWideChar(codepage, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if needed <= 0 {
        return None;
    }
    let mut wide = vec![0u16; needed as usize];
    // SAFETY: `wide` 恰有 `needed` 个元素，等于上一次探测出的所需长度。
    let written =
        unsafe { MultiByteToWideChar(codepage, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), needed) };
    if written <= 0 {
        return None;
    }
    wide.truncate(written as usize);
    Some(String::from_utf16_lossy(&wide))
}

/// 按给定代码页把文本编码成多字节串；出现该代码页无法表示的字符时返回 `None`。
///
/// 与 [`decode_process_line`] 对称：写入交给外部程序按系统代码页解析的文件
/// （`.cmd`/`.bat`）时，UTF-8 字节会被读成乱码。带 `WC_NO_BEST_FIT_CHARS`：
/// 否则 `∞` 这类字符会被「近似」成 `8`，编出一条指向别处的路径却报成功。
#[cfg(windows)]
pub(crate) fn encode_multibyte(text: &str, codepage: u32) -> Option<Vec<u8>> {
    use windows_sys::Win32::Globalization::{WideCharToMultiByte, CP_UTF8, WC_NO_BEST_FIT_CHARS};

    if text.is_empty() {
        return Some(Vec::new());
    }
    // UTF-8 能表示 Rust `str` 的全部字符（无落单代理项），且该代码页不接受
    // `lpUsedDefaultChar`；直接给出等价字节。
    if codepage == CP_UTF8 {
        return Some(text.as_bytes().to_vec());
    }
    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.len() > i32::MAX as usize {
        return None;
    }
    let len = wide.len() as i32;
    let mut used_default = 0i32;
    // SAFETY: 指针与长度同源于 `wide`；空缓冲 + 0 长度只探测所需字节数。
    let needed = unsafe {
        WideCharToMultiByte(
            codepage,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            len,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            &mut used_default,
        )
    };
    if needed <= 0 {
        return None;
    }
    let mut bytes = vec![0u8; needed as usize];
    used_default = 0;
    // SAFETY: `bytes` 恰有 `needed` 个元素，等于上一次探测出的所需长度。
    let written = unsafe {
        WideCharToMultiByte(
            codepage,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            len,
            bytes.as_mut_ptr(),
            needed,
            std::ptr::null(),
            &mut used_default,
        )
    };
    if written <= 0 || used_default != 0 {
        return None;
    }
    bytes.truncate(written as usize);
    Some(bytes)
}

/// 路径的 Windows 8.3 短名（纯 ASCII），长名含非 ASCII 时用它烘焙进 `.cmd`。
///
/// 短名由卷上的 8dot3 机制维护：路径不存在、或该卷已关闭短名时返回 `None`
/// （此时 API 原样返回长名，调用方据 `is_ascii` 判定不可用）。
#[cfg(windows)]
pub(crate) fn short_path(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: 空缓冲 + 0 长度只探测所需长度（含结尾 NUL）；指针来自 `wide`。
    let needed = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
    if needed == 0 {
        return None;
    }
    let mut buf = vec![0u16; needed as usize];
    // SAFETY: `buf` 恰有 `needed` 个元素，等于上一次探测出的所需长度。
    let written = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), needed) };
    if written == 0 || written >= needed {
        return None;
    }
    buf.truncate(written as usize);
    Some(PathBuf::from(std::ffi::OsString::from_wide(&buf)))
}

/// 外部程序（cmd.exe）解析文本文件所用的代码页：优先 OEM，其次 ANSI。
///
/// 批处理文件由 cmd.exe 按控制台代码页读取（中文 Windows 为 936），因此把带
/// 非 ASCII 路径的 `.cmd` 写成 UTF-8 必然乱码。取不到时回落 UTF-8 代码页，
/// 调用方据此退回原字节写出。
#[cfg(windows)]
pub(crate) fn console_code_page() -> u32 {
    use windows_sys::Win32::Globalization::{GetACP, GetOEMCP};

    // SAFETY: 两个 API 都无参数、无副作用，仅返回系统代码页常量。
    let oem = unsafe { GetOEMCP() };
    if oem != 0 {
        return oem;
    }
    // SAFETY: 同上。
    let ansi = unsafe { GetACP() };
    if ansi != 0 {
        return ansi;
    }
    65001
}

#[cfg(test)]
mod tests {
    use super::decode_process_line;
    #[cfg(windows)]
    use super::{decode_multibyte, encode_multibyte, short_path};

    #[tokio::test]
    async fn operation_window_never_falls_back_to_another_profile() {
        use crate::service::workflow::instances;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        for label in ["main", "window-operation-test", "remote-operation-test"] {
            tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
                .build()
                .unwrap();
        }
        instances::bind_window("main", "operation-main-profile");
        instances::bind_window("window-operation-test", "operation-extra-profile");
        instances::bind_window("remote-operation-test", "operation-remote-profile");
        assert!(super::operation_window(app.handle()).is_none());
        for (profile, expected) in [
            ("operation-main-profile", Some("main")),
            ("operation-extra-profile", Some("window-operation-test")),
            ("operation-remote-profile", Some("remote-operation-test")),
            ("operation-missing-profile", None),
        ] {
            instances::scope(profile.into(), async {
                let window = super::operation_window(app.handle());
                assert_eq!(window.as_ref().map(|window| window.label()), expected);
            })
            .await;
        }
        for label in ["main", "window-operation-test", "remote-operation-test"] {
            instances::release_window(label);
        }
    }

    #[test]
    fn keeps_valid_utf8_untouched() {
        let text = "系统找不到指定的路径。";
        assert_eq!(decode_process_line(text.as_bytes()), text);
    }

    #[test]
    fn invalid_bytes_still_produce_a_line() {
        assert!(!decode_process_line(&[0xFF, 0xFE, 0x80]).is_empty());
    }

    /// GBK 字节按显式 936 解码，与 runner 自身的 ANSI 代码页无关。
    #[cfg(windows)]
    #[test]
    fn decodes_gbk_with_an_explicit_codepage() {
        let gbk = [
            0xCF, 0xB5, 0xCD, 0xB3, 0xD5, 0xD2, 0xB2, 0xBB, 0xB5, 0xBD, 0xD6, 0xB8, 0xB6, 0xA8,
            0xB5, 0xC4, 0xC2, 0xB7, 0xBE, 0xB6, 0xA1, 0xA3,
        ];
        assert_eq!(
            decode_multibyte(&gbk, 936).as_deref(),
            Some("系统找不到指定的路径。")
        );
    }

    #[cfg(windows)]
    #[test]
    fn encodes_back_to_the_same_codepage_bytes() {
        let text = "系统找不到指定的路径。";
        let gbk = encode_multibyte(text, 936).expect("gbk");
        assert!(!gbk.is_ascii());
        assert_eq!(decode_multibyte(&gbk, 936).as_deref(), Some(text));
        // UTF-8 代码页不看 `lpUsedDefaultChar`，直接给出等价字节。
        assert_eq!(
            encode_multibyte(text, 65001).as_deref(),
            Some(text.as_bytes())
        );
    }

    /// 该代码页表示不了的字符必须报 `None`，不能靠「近似字符」蒙混过关。
    #[cfg(windows)]
    #[test]
    fn rejects_characters_outside_the_codepage() {
        assert_eq!(encode_multibyte("小蔡", 437), None);
    }

    /// 短名只在路径存在且卷上保留 8dot3 时才有；拿不到时调用方按 `is_ascii` 拒绝。
    #[cfg(windows)]
    #[test]
    fn short_path_resolves_existing_paths() {
        let temp = std::env::temp_dir();
        let short = short_path(&temp).expect("temp dir always resolves");
        assert!(short.exists());
    }
}
