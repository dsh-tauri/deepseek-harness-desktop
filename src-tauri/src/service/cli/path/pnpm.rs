//! 用户 pnpm 探测：在继承 PATH 与平台标准目录中查找用户 pnpm（排除应用注册的
//! shim），并生成传给 shim 的精确 `DSH_PNPM` 值。

use std::path::{Path, PathBuf};
use tauri::AppHandle;
#[cfg(unix)]
use tauri::Manager;

use super::super::shim::is_generated_shim;
use super::get_bin_dir;

/// 在继承 PATH 与平台标准目录中查找用户 pnpm（排除应用注册的 shim）。
///
/// "用户优先"策略：安装时（`Pnpm::check_installed`）用户已有 pnpm 则跳过
/// 捆绑安装；Unix GUI 额外检查 mise 标准数据目录，生成的 `pnpm` shim 也会
/// 优先转发到探测出的精确路径。
pub fn find_user_pnpm(app_handle: &AppHandle) -> Option<PathBuf> {
    #[cfg(unix)]
    let home = app_handle.path().home_dir().ok();
    #[cfg(not(unix))]
    let home: Option<PathBuf> = None;
    find_user_pnpm_from(&get_bin_dir(app_handle), home.as_deref())
}

pub(crate) fn find_user_pnpm_from(bin_dir: &Path, home_dir: Option<&Path>) -> Option<PathBuf> {
    find_pnpm_in_dirs(bin_dir, &user_pnpm_dirs(home_dir))
}

/// Windows 直接创建进程时不能执行 `.cmd`/`.bat`；为无需 shell 的修复流程单独
/// 查找原生 `pnpm.exe`，不改变常规 shim 对 `.cmd` 的既有优先级。
#[cfg(windows)]
pub(crate) fn find_user_pnpm_executable(app_handle: &AppHandle) -> Option<PathBuf> {
    let dirs = user_pnpm_dirs(None);
    find_windows_executable_pnpm_in_dirs(&get_bin_dir(app_handle), &dirs)
}

fn user_pnpm_dirs(_home_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    #[cfg(windows)]
    append_windows_pnpm_dirs(&mut dirs);
    #[cfg(unix)]
    {
        let mise_data = std::env::var_os("MISE_DATA_DIR").map(PathBuf::from);
        let xdg_data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from);
        append_unix_mise_dirs(
            &mut dirs,
            mise_data.as_deref(),
            xdg_data.as_deref(),
            _home_dir,
        );
    }
    dirs
}

/// Unix 图形进程不会读取交互式 shell 配置；在继承 PATH 之后补充 mise 的
/// 官方数据目录，并保留先出现的字面路径，避免解析 `pnpm -> mise` 符号链接。
#[cfg_attr(windows, allow(dead_code))]
fn append_unix_mise_dirs(
    dirs: &mut Vec<PathBuf>,
    mise_data: Option<&Path>,
    xdg_data: Option<&Path>,
    home: Option<&Path>,
) {
    let candidates = [
        mise_data.map(|path| path.join("shims")),
        xdg_data.map(|path| path.join("mise/shims")),
        home.map(|path| path.join(".local/share/mise/shims")),
    ];
    for candidate in candidates.into_iter().flatten() {
        let candidate_key = std::path::absolute(&candidate).unwrap_or_else(|_| candidate.clone());
        let duplicate = dirs.iter().any(|existing| {
            std::path::absolute(existing).unwrap_or_else(|_| existing.clone()) == candidate_key
        });
        if candidate.is_absolute() && !duplicate {
            dirs.push(candidate);
        }
    }
}

/// 子进程环境中的 pnpm 必须是绝对路径。Unix 只做字面绝对化，不能解析 mise
/// 依赖 argv[0] 的 shim 符号链接；Windows 继续去除 `\\?\` 并解析连接点。
fn pnpm_env_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        dunce::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
    }
    #[cfg(not(windows))]
    {
        std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
    }
}

/// 生成传给 shim 的精确 `DSH_PNPM` 值，并拒绝桌面端自身的 pnpm shim。
pub fn pnpm_env_value(pnpm: &Path, bin_dir: &Path) -> Option<String> {
    let pnpm = pnpm_env_path(pnpm);
    let bin_dir = pnpm_env_path(bin_dir);
    (pnpm.parent() != Some(bin_dir.as_path())).then(|| pnpm.to_string_lossy().into_owned())
}

/// 在给定目录中按顺序查找用户 pnpm，便于不依赖全局环境测试探测规则。
fn find_pnpm_in_dirs(bin_dir: &Path, dirs: &[PathBuf]) -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["pnpm.cmd", "pnpm.exe", "pnpm.bat"]
    } else {
        &["pnpm"]
    };
    find_pnpm_candidates_in_dirs(bin_dir, dirs, candidates)
}

#[cfg(windows)]
fn find_windows_executable_pnpm_in_dirs(bin_dir: &Path, dirs: &[PathBuf]) -> Option<PathBuf> {
    find_pnpm_candidates_in_dirs(bin_dir, dirs, &["pnpm.exe"])
}

fn find_pnpm_candidates_in_dirs(
    bin_dir: &Path,
    dirs: &[PathBuf],
    candidates: &[&str],
) -> Option<PathBuf> {
    let bin_dir = pnpm_env_path(bin_dir);
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let normalized = pnpm_env_path(dir);
        if normalized == bin_dir {
            continue;
        }
        for name in candidates {
            let candidate = normalized.join(name);
            if usable_pnpm_candidate(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// 只接受真实可执行文件，并拒绝复制或链接到其它目录的桌面端生成 shim。
fn usable_pnpm_candidate(candidate: &Path) -> bool {
    if !candidate.is_file() || !pnpm_is_executable(candidate) {
        return false;
    }
    let is_small_wrapper = candidate
        .metadata()
        .map(|metadata| metadata.len() <= 16 * 1024)
        .unwrap_or(false);
    !is_small_wrapper || !is_generated_shim(candidate)
}

#[cfg(unix)]
fn pnpm_is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn pnpm_is_executable(_path: &Path) -> bool {
    true
}

/// Windows GUI 进程的 PATH 可能早于 npm/pnpm 安装，补充这些工具的标准用户目录。
#[cfg(windows)]
fn append_windows_pnpm_dirs(dirs: &mut Vec<PathBuf>) {
    let mut append = |dir: PathBuf| {
        if dir.is_absolute() && !dirs.iter().any(|existing| existing == &dir) {
            dirs.push(dir);
        }
    };
    if let Some(appdata) = std::env::var_os("APPDATA") {
        append(PathBuf::from(appdata).join("npm"));
    }
    for variable in ["PNPM_HOME", "NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(value) = std::env::var_os(variable) {
            append(PathBuf::from(value));
        }
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        append(PathBuf::from(local_app_data).join("pnpm"));
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_util::{make_executable, temp_dir};
    use super::*;

    #[test]
    fn find_pnpm_prefers_path_order_and_skips_shim_dir() {
        let root = temp_dir("pnpm-discovery");
        let shim_dir = root.join("shim");
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&shim_dir).unwrap();
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let name = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
        std::fs::write(shim_dir.join(name), "shim").unwrap();
        std::fs::write(first.join(name), "first").unwrap();
        std::fs::write(second.join(name), "second").unwrap();
        make_executable(&shim_dir.join(name));
        make_executable(&first.join(name));
        make_executable(&second.join(name));
        let found = find_pnpm_in_dirs(&shim_dir, &[shim_dir.clone(), first.clone(), second]);
        assert_eq!(found, Some(pnpm_env_path(&first.join(name))));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    fn direct_discovery_uses_exe_when_cmd_and_exe_share_a_directory() {
        let root = temp_dir("pnpm-direct-exe");
        let desktop_bin = root.join("desktop-bin");
        let user_bin = root.join("user-bin");
        std::fs::create_dir_all(&desktop_bin).unwrap();
        std::fs::create_dir_all(&user_bin).unwrap();
        let cmd = user_bin.join("pnpm.cmd");
        let exe = user_bin.join("pnpm.exe");
        std::fs::write(&cmd, "cmd").unwrap();
        std::fs::write(&exe, "exe").unwrap();

        assert_eq!(
            find_pnpm_in_dirs(&desktop_bin, std::slice::from_ref(&user_bin)),
            Some(pnpm_env_path(&cmd))
        );
        assert_eq!(
            find_windows_executable_pnpm_in_dirs(&desktop_bin, std::slice::from_ref(&user_bin)),
            Some(pnpm_env_path(&exe))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn mise_dirs_follow_path_and_dedupe_in_source_order() {
        let root = temp_dir("pnpm-mise-dirs");
        let inherited = root.join("inherited");
        let mise = root.join("mise-data");
        let xdg = root.join("xdg-data");
        let home = root.join("home");
        let mut dirs = vec![inherited.clone(), xdg.join("mise/shims")];

        append_unix_mise_dirs(&mut dirs, Some(&mise), Some(&xdg), Some(&home));

        assert_eq!(
            dirs,
            vec![
                inherited,
                xdg.join("mise/shims"),
                mise.join("shims"),
                home.join(".local/share/mise/shims"),
            ]
        );
        let mut fresh = vec![root.join("fresh-path")];
        append_unix_mise_dirs(&mut fresh, Some(&mise), Some(&xdg), Some(&home));
        assert_eq!(
            fresh,
            vec![
                root.join("fresh-path"),
                mise.join("shims"),
                xdg.join("mise/shims"),
                home.join(".local/share/mise/shims"),
            ]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn inherited_path_pnpm_precedes_appended_mise_pnpm() {
        let root = temp_dir("pnpm-mise-precedence");
        let desktop_bin = root.join("desktop-bin");
        let inherited = root.join("inherited");
        let mise_data = root.join("mise");
        let mise_shims = mise_data.join("shims");
        for dir in [&desktop_bin, &inherited, &mise_shims] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let name = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
        let inherited_pnpm = inherited.join(name);
        let mise_pnpm = mise_shims.join(name);
        std::fs::write(&inherited_pnpm, "inherited").unwrap();
        std::fs::write(&mise_pnpm, "mise").unwrap();
        make_executable(&inherited_pnpm);
        make_executable(&mise_pnpm);
        let mut dirs = vec![inherited];
        append_unix_mise_dirs(&mut dirs, Some(&mise_data), None, None);

        assert_eq!(
            find_pnpm_in_dirs(&desktop_bin, &dirs),
            Some(pnpm_env_path(&inherited_pnpm))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn default_home_mise_pnpm_is_discovered_when_path_misses() {
        let root = temp_dir("pnpm-mise-home-default");
        let desktop_bin = root.join("desktop-bin");
        let inherited = root.join("inherited");
        let home = root.join("home");
        let home_shims = home.join(".local/share/mise/shims");
        for dir in [&desktop_bin, &inherited, &home_shims] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let name = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
        let pnpm = home_shims.join(name);
        std::fs::write(&pnpm, "mise home").unwrap();
        make_executable(&pnpm);
        let mut dirs = vec![inherited];
        append_unix_mise_dirs(&mut dirs, None, None, Some(&home));

        assert_eq!(
            find_pnpm_in_dirs(&desktop_bin, &dirs),
            Some(pnpm_env_path(&pnpm))
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn discovery_misses_desktop_generated_shim_and_absent_candidates() {
        let root = temp_dir("pnpm-own-shim-only");
        let desktop_bin = root.join("desktop-bin");
        let copied_bin = root.join("copied-bin");
        let empty = root.join("empty");
        std::fs::create_dir_all(&desktop_bin).unwrap();
        std::fs::create_dir_all(&copied_bin).unwrap();
        std::fs::create_dir_all(&empty).unwrap();
        let name = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
        let own = desktop_bin.join(name);
        let copied = copied_bin.join(name);
        for path in [&own, &copied] {
            std::fs::write(
                path,
                "# DeepSeek Harness Desktop - pnpm command shim (generated)\n",
            )
            .unwrap();
            make_executable(path);
        }

        assert_eq!(
            find_pnpm_in_dirs(&desktop_bin, &[desktop_bin.clone(), copied_bin, empty]),
            None
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn pnpm_env_value_injects_exact_external_path_and_rejects_own_dir() {
        let root = temp_dir("pnpm-env-value");
        let desktop_bin = root.join("desktop-bin");
        let external_bin = root.join("external-bin");
        std::fs::create_dir_all(&desktop_bin).unwrap();
        std::fs::create_dir_all(&external_bin).unwrap();
        let name = if cfg!(windows) { "pnpm.cmd" } else { "pnpm" };
        let own = desktop_bin.join(name);
        let external = external_bin.join(name);
        std::fs::write(&own, "own").unwrap();
        std::fs::write(&external, "external").unwrap();

        assert_eq!(pnpm_env_value(&own, &desktop_bin), None);
        assert_eq!(
            pnpm_env_value(&external, &desktop_bin),
            Some(pnpm_env_path(&external).to_string_lossy().into_owned())
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_non_executable_pnpm() {
        let root = temp_dir("pnpm-nonexec");
        let desktop_bin = root.join("desktop-bin");
        let mise_shims = root.join("mise/shims");
        std::fs::create_dir_all(&desktop_bin).unwrap();
        std::fs::create_dir_all(&mise_shims).unwrap();
        std::fs::write(mise_shims.join("pnpm"), "not executable").unwrap();

        assert_eq!(
            find_pnpm_in_dirs(&desktop_bin, std::slice::from_ref(&mise_shims)),
            None
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn discovery_preserves_argv0_style_mise_symlink() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = temp_dir("pnpm-mise-symlink");
        let desktop_bin = root.join("desktop-bin");
        let mise_bin = root.join("mise/bin");
        let mise_shims = root.join("mise/shims");
        for dir in [&desktop_bin, &mise_bin, &mise_shims] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let target = mise_bin.join("mise");
        std::fs::write(
            &target,
            "#!/bin/sh\n[ \"$(basename \"$0\")\" = pnpm ] || exit 51\nprintf 'argv0-ok\\n'\n",
        )
        .unwrap();
        let mut permissions = std::fs::metadata(&target).unwrap().permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&target, permissions).unwrap();
        let pnpm = mise_shims.join("pnpm");
        symlink(&target, &pnpm).unwrap();

        let found = find_pnpm_in_dirs(&desktop_bin, std::slice::from_ref(&mise_shims)).unwrap();
        assert_eq!(found, pnpm);
        assert_eq!(
            pnpm_env_value(&found, &desktop_bin),
            Some(found.to_string_lossy().into_owned())
        );
        let output = std::process::Command::new(&found).output().unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "argv0-ok\n");
        let _ = std::fs::remove_dir_all(root);
    }
}
