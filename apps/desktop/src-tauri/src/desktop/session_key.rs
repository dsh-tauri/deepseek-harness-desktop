use sha2::{Digest, Sha256};
use std::fmt::Write as _;

const PROFILE_CHARS: usize = 40;
const LABEL_CHARS: usize = 40;
const DIGEST_CHARS: usize = 32;

fn hex(value: &[u8], limit: usize) -> String {
    value
        .iter()
        .take(limit / 2)
        .fold(String::with_capacity(limit), |mut out, byte| {
            let _ = write!(out, "{byte:02x}");
            out
        })
}

fn sanitize(value: &str, limit: usize) -> String {
    value
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => character,
            _ => '-',
        })
        .take(limit)
        .collect()
}

/// 认证宿主 webview 的持久分区 key：同 profile 同窗口跨重启稳定，不同组合互不相同。
///
/// profile 与 label 都可能是任意字符串：可读前段各自按字符集与长度截断，唯一性由完整输入的
/// 摘要兜底——只清洗不摘要时，`a/b` 与 `a:b` 会撞进同一个分区，两个 webview 抢同一个 Session。
pub(crate) fn authenticated_session_key(profile: &str, label: &str) -> String {
    let prefix = hex(profile.as_bytes(), PROFILE_CHARS);
    let prefix = if prefix.is_empty() { "0".to_owned() } else { prefix };
    let readable = sanitize(label, LABEL_CHARS);
    let digest = hex(
        &Sha256::new().chain_update(profile).chain_update([0]).chain_update(label).finalize(),
        DIGEST_CHARS,
    );
    format!("{prefix}-{readable}-{digest}")
}

/// 窗口自己那个 webview 的持久分区 key（宿主窗口即 DSH 页面本身时使用）。
pub(crate) fn window_authenticated_session_key<R: tauri::Runtime>(
    app: &crate::AppHandle<R>,
    label: &str,
) -> String {
    authenticated_session_key(
        &crate::service::workflow::instances::window_profile(app, label),
        label,
    )
}

#[cfg(test)]
mod tests {
    use super::authenticated_session_key;

    /// 与 electron-rs `authenticated-host.ts` 的 SESSION_KEY 上限一致（128 字符）。
    const MAX_KEY_CHARS: usize = 128;

    fn is_valid_key(key: &str) -> bool {
        key.len() <= MAX_KEY_CHARS
            && key.chars().next().is_some_and(|first| first.is_ascii_alphanumeric())
            && key
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
    }

    #[test]
    fn session_key_pins_the_partition_of_a_known_profile_and_window() {
        // 用户升级后必须继续命中同一个分区，所以这条断言把派生结果钉成字面量。
        assert_eq!(
            authenticated_session_key("desktop", "main"),
            "6465736b746f70-main-2ffa0470e3d30c048e9c0b374c0804df"
        );
        assert_eq!(
            authenticated_session_key("desktop", "window-1"),
            "6465736b746f70-window-1-827ebb899bc834a12dd4bee586d98180"
        );
        assert_eq!(
            authenticated_session_key("web", "main"),
            "776562-main-d4555b1b4039d12c9d15ba48ec4980c5"
        );
    }

    #[test]
    fn session_keys_never_collide_after_sanitizing_or_truncating() {
        assert_ne!(
            authenticated_session_key("desktop", "a/b"),
            authenticated_session_key("desktop", "a:b")
        );
        assert_ne!(
            authenticated_session_key("desktop", &"x".repeat(60)),
            authenticated_session_key("desktop", &"x".repeat(61))
        );
        assert_ne!(
            authenticated_session_key("desktop", "main"),
            authenticated_session_key("deskto", "main")
        );
    }

    #[test]
    fn session_keys_stay_inside_the_electron_partition_charset() {
        for (profile, label) in [
            ("desktop", "main"),
            ("", "main"),
            ("de sk/top:é", "窗口 1"),
            (&"p".repeat(300), &"l".repeat(300)),
            ("desktop", ""),
            ("desktop", "../escape"),
        ] {
            let key = authenticated_session_key(profile, label);
            assert!(is_valid_key(&key), "{key}");
        }
        assert!(authenticated_session_key("", "main").starts_with('0'));
    }
}