//! 版本比较与当前平台安装包资产选择。
//!
//! 除 `linux_package_family`（包管理家族）与 `host_is_aarch64`（宿主 CPU）两处只读
//! 探测外不触网、不依赖可变运行时状态，均为 `更新` 模块内其它部分的判定基础。

use semver::Version;

/// 当前桌面端版本号（来自 Cargo.toml / tauri.conf.json）
pub(super) fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 发行版仓库（Copr、AUR、Flathub 等）构建时注入 `DSH_DISTRO_MANAGED`：升级交给系统包
/// 管理器，应用内不检查、不下载、退出时也不拉起安装包，否则会在包管理器的安装之外再装一份
/// AppImage（issue #1230）。
pub(super) const DISTRO_MANAGED: bool = option_env!("DSH_DISTRO_MANAGED").is_some();

pub(super) fn supports_stable_updates(identifier: &str) -> bool {
    stable_updates_allowed(identifier, DISTRO_MANAGED)
}

fn stable_updates_allowed(identifier: &str, distro_managed: bool) -> bool {
    !distro_managed && identifier != "dsh-tauri-nightly"
}

/// 解析版本号为 semver（容忍 `v` 前缀）；非合法 semver 返回 `None`。
///
/// 用标准 semver 语义而非手写数字段比较：`0.7.14-rc.1` / `0.7.14-beta` 这样的
/// pre-release 与 `test-main-123` 这类手动测试 release tag 都能被正确识别。
pub(super) fn parse_version(v: &str) -> Option<Version> {
    Version::parse(v.trim().trim_start_matches('v')).ok()
}

/// 是否「正式版」：纯数字版本，无 pre-release 与 build metadata（如 `0.7.14`）。
///
/// 更新通知只发给正式版：`0.7.14-rc.1` / `0.7.14-beta` 等 pre-release 一律跳过，
/// 用户不会收到非正式版的更新提示（见 [`super::meta`]）。
pub(super) fn is_stable(version: &Version) -> bool {
    version.pre.is_empty() && version.build.is_empty()
}

/// 判断 `latest` 是否严格高于 `current`（semver 语义）。
///
/// 注意 `0.7.14 > 0.7.14-rc.1`：装了 rc 的用户也能收到同号正式版的通知，
/// 而 rc 自身（`0.7.14-rc.2`）永远不会高于同号后的正式版。
pub(super) fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// 宿主 CPU 是否为 aarch64（运行时判定，与编译目标架构解耦）。
///
/// `#[cfg(target_arch)]` 描述的是**编译目标**而非宿主 CPU：Intel 版应用在 Apple
/// Silicon 上经 Rosetta 运行时编译目标仍是 x86_64，会持续给 M 系列芯片用户下载
/// Intel 安装包（issue #576）。macOS 因此必须运行时探测宿主。
#[cfg(target_os = "macos")]
fn host_is_aarch64() -> bool {
    // 编译目标已是 aarch64 ⇒ 该二进制无法在 Intel Mac 上运行，宿主必为 Apple Silicon
    cfg!(target_arch = "aarch64") || apple_silicon_host()
}

/// 非 macOS 平台的宿主架构仍按编译目标判定（安装包与二进制同架构分发）。
#[cfg(not(target_os = "macos"))]
fn host_is_aarch64() -> bool {
    cfg!(target_arch = "aarch64")
}

/// 探测 macOS 宿主是否为 Apple Silicon。
///
/// `sysctl hw.optional.arm64` 在 Apple Silicon 上为 `1`（Rosetta 转译下同样为 `1`），
/// Intel Mac 上该 OID 不存在、查询失败。结果缓存，避免反复打开进程挑选资产。
#[cfg(target_os = "macos")]
fn apple_silicon_host() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        let mut value: i32 = 0;
        let mut size = std::mem::size_of::<i32>();
        let name = b"hw.optional.arm64\0";
        // SAFETY: 只读查询单个 i32 sysctl，指针与长度均指向本函数栈上的变量
        let code = unsafe {
            libc::sysctlbyname(
                name.as_ptr() as *const libc::c_char,
                &mut value as *mut i32 as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        code == 0 && value == 1
    })
}

/// 根据资产文件名判断其架构匹配度，用于同扩展名下挑选正确架构的安装包：
/// - `2`：与宿主架构完全匹配（如 `_x64.dmg` / `_aarch64.dmg` / `_amd64.deb`）
/// - `1`：通用包（`universal`），任何架构都可用
/// - `0`：不匹配或文件名未携带架构信息（作为兜底仍可尝试）
fn arch_rank(name: &str) -> i8 {
    arch_rank_for(name, host_is_aarch64())
}

/// 架构匹配度判定；宿主架构由参数给出，两种宿主都能在任意 CI 平台覆盖。
fn arch_rank_for(name: &str, host_aarch64: bool) -> i8 {
    let lower = name.to_lowercase();
    if lower.contains("universal") {
        return 1;
    }
    let markers: &[&str] = if host_aarch64 {
        &["aarch64", "arm64", "apple-silicon", "-arm", "_arm"]
    } else {
        &["x86_64", "amd64", "x64", "intel", "-x86", "_x86"]
    };
    if markers.iter().any(|k| lower.contains(k)) {
        2
    } else {
        0
    }
}

/// 判断当前 Linux 发行版的包管理家族，用于选择原生安装包格式。
///
/// - `"deb"`：Debian/Ubuntu 系（存在 `/etc/debian_version` 或 `dpkg`）
/// - `"rpm"`：Fedora/RHEL/openSUSE 系（存在 `/etc/redhat-release`、`/etc/fedora-release`
///   或 `rpm`）
/// - `"unknown"`：都无法判定（如 Arch/pacman）
///
#[cfg(target_os = "linux")]
fn linux_package_family() -> &'static str {
    let debianish = std::path::Path::new("/etc/debian_version").exists()
        || std::path::Path::new("/usr/bin/dpkg").exists();
    let rpmish = std::path::Path::new("/etc/redhat-release").exists()
        || std::path::Path::new("/etc/fedora-release").exists()
        || std::path::Path::new("/usr/bin/rpm").exists();
    if debianish {
        "deb"
    } else if rpmish {
        "rpm"
    } else {
        "unknown"
    }
}

/// 当前进程若由 AppImage 镜像直接拉起，返回该镜像文件本身的路径。
///
/// 只认非空 `APPIMAGE` 不够：被别的 AppImage 环境继承或用户 shell 里残留该变量时，
/// 会把不相干镜像当成「当前安装」，更新就会覆盖到那个文件上。AppImage 运行时同时
/// 注入 `APPDIR`（本进程的挂载点），当前可执行文件必须落在其中才算数。没有这套环境
/// 变量时退回可执行文件后缀判定（直接 exec 镜像的场景）。
///
/// 纯函数：三个输入都由调用方给出，任意 CI 平台都能构造断言。
#[cfg(target_os = "linux")]
fn running_appimage_from(
    appimage: Option<&str>,
    appdir: Option<&str>,
    exe: &std::path::Path,
) -> Option<std::path::PathBuf> {
    let image = appimage
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|path| {
            path.extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("AppImage"))
        });
    if let Some(image) = image {
        // `APPDIR` 是本进程的挂载点：能取到它时可执行文件必须落在其中，否则这个
        // `APPIMAGE` 是从别的进程继承来的；取不到（老运行时）时只能信它。
        let belongs = match appdir.filter(|dir| !dir.is_empty()) {
            Some(dir) => !exe.as_os_str().is_empty() && exe.starts_with(dir),
            None => true,
        };
        return belongs.then_some(image);
    }
    exe.extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("AppImage"))
        .then(|| exe.to_path_buf())
}

#[cfg(target_os = "linux")]
pub(super) fn running_appimage() -> Option<std::path::PathBuf> {
    running_appimage_from(
        std::env::var("APPIMAGE").ok().as_deref(),
        std::env::var("APPDIR").ok().as_deref(),
        &std::env::current_exe().unwrap_or_default(),
    )
}

/// 当前这份安装是怎么跑起来的：`"appimage"` 为便携镜像直接运行，`"package"` 为已
/// 落到系统目录、由桌面条目/命令名拉起（deb、rpm、AUR 或手工解包都算这类）。
///
/// 纯函数：`APPIMAGE`/`APPDIR` 由 AppRun 注入，`current_exe` 由调用方给出，三者都能
/// 在任意 CI 平台上构造断言（同 [`arch_rank_for`]）。
#[cfg(target_os = "linux")]
fn linux_install_media_for(
    appimage: Option<&str>,
    appdir: Option<&str>,
    exe: &std::path::Path,
) -> &'static str {
    if running_appimage_from(appimage, appdir, exe).is_some() {
        "appimage"
    } else {
        "package"
    }
}

#[cfg(target_os = "linux")]
fn linux_install_media() -> &'static str {
    let exe = std::env::current_exe().unwrap_or_default();
    linux_install_media_for(
        std::env::var("APPIMAGE").ok().as_deref(),
        std::env::var("APPDIR").ok().as_deref(),
        &exe,
    )
}

/// 按包管理家族与安装媒介返回 Linux 资产扩展名优先级列表（纯函数，便于测试）。
///
/// 便携安装优先 `.AppImage`（新镜像直接替换旧镜像）；系统包安装优先发行版原生包
/// （deb→`.deb`、rpm→`.rpm`，issue #79），AppImage 作为便携兜底。
#[cfg(target_os = "linux")]
fn linux_prefs(family: &str, media: &str) -> &'static [&'static str] {
    match (media, family) {
        ("appimage", _) => &[".AppImage", ".deb", ".rpm"],
        (_, "deb") => &[".deb", ".AppImage", ".rpm"],
        (_, "rpm") => &[".rpm", ".AppImage", ".deb"],
        _ => &[".AppImage", ".deb", ".rpm"],
    }
}

/// 下载的安装包能否就地替换当前安装（纯函数，判定见 [`linux_install_media_for`]）。
///
/// 两种无法就地替换的情形都必须提前拒绝，否则用户点完「立即更新」版本号不变：
/// - 系统包安装 + 包管理家族无法判定（pacman/AUR、tar 解包）：没有能装 deb/rpm 的
///   包管理器，AppImage 只会「另跑一份」，桌面条目仍指向旧版本。
/// - 系统包安装，但当前运行的二进制不属于该家族的包（Ubuntu 上从用户目录跑的
///   手工解包程序）：安装 .deb 只写系统目录，用户的原启动入口依旧是旧版本。
#[cfg(target_os = "linux")]
fn self_updatable_for(media: &str, family: &str, packaged: bool) -> bool {
    media == "appimage" || (family != "unknown" && packaged)
}

/// 运行中的可执行文件是否由该家族的包管理器登记在案（`dpkg -S` / `rpm -qf`）。
///
/// 符号链接入口（`/usr/bin/x` → `/usr/lib/x/y`）只有一端出现在包的文件列表里，
/// 所以原路径与真实路径都查一次。包管理器优先用绝对路径：桌面会话的 `PATH` 未必
/// 含 `/usr/bin`（`fix-path-env` 就是为此存在的），找不到 dpkg 会被误判成「不归包管
/// 理」，进而把能正常更新的 deb 用户挡在门外。
#[cfg(target_os = "linux")]
fn exe_owned_by_package_for(family: &str, exe: &std::path::Path) -> bool {
    let (program, flag) = match family {
        "deb" => ("/usr/bin/dpkg", "-S"),
        "rpm" => ("/usr/bin/rpm", "-qf"),
        _ => return false,
    };
    let program = match std::path::Path::new(program).exists() {
        true => program,
        false => program.rsplit('/').next().unwrap_or(program),
    };
    let mut paths = vec![exe.to_path_buf()];
    if let Ok(real) = std::fs::canonicalize(exe) {
        if real != exe {
            paths.push(real);
        }
    }
    paths.iter().any(|path| {
        std::process::Command::new(program)
            .arg(flag)
            .arg(path)
            .output()
            .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
    })
}

/// 当前运行环境是否具备可就地替换的安装媒介（Linux 专有判定）。
///
/// 包归属查询要 spawn `dpkg`/`rpm`，而轮询检查每十分钟一次、`download` 结束还会
/// 再调一次，结果缓存。
#[cfg(target_os = "linux")]
pub(super) fn self_updatable() -> bool {
    static CACHE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        let media = linux_install_media();
        let family = linux_package_family();
        let packaged = media != "appimage"
            && family != "unknown"
            && exe_owned_by_package_for(family, &std::env::current_exe().unwrap_or_default());
        self_updatable_for(media, family, packaged)
    })
}

/// 选择当前平台对应的安装包资产文件名。
///
/// 选择规则分两层：先按平台偏好扩展名排序，同扩展名下再按架构匹配度挑选。
/// - Windows 优先 NSIS setup.exe（其次 msi）：NSIS 不会像 MSI 那样由
///   RestartManager 强杀旧进程并在安装完成后自动重开应用，避免应用在旧进程
///   被强杀、运行文件瞬时缺失的窗口被自动拉起，从而误触发核心重下载。
/// - macOS 选 dmg，并按架构区分，避免 Intel 芯片 Mac 下载到 M 芯片
///   （aarch64）的安装包（issue #33）。
/// - Linux 按**安装媒介**与**发行版包管理**两层排序（见 [`linux_prefs`]）：便携镜像
///   优先 `.AppImage`，系统包安装优先与发行版一致的原生包（**deb 系优先 `.deb`、
///   rpm 系优先 `.rpm`**，issue #79），同样按架构匹配。
pub(super) fn pick_asset(assets: &[String]) -> Option<String> {
    #[cfg(target_os = "windows")]
    let prefs: &[&str] = &[".exe", ".msi"];
    #[cfg(target_os = "macos")]
    let prefs: &[&str] = &[".dmg"];
    #[cfg(target_os = "linux")]
    let prefs: &[&str] = linux_prefs(linux_package_family(), linux_install_media());

    let mut best: Option<(usize, i8, String)> = None;
    for name in assets {
        let Some(idx) = prefs.iter().position(|p| name.ends_with(p)) else {
            continue;
        };
        let rank = prefs.len() - idx; // 扩展名优先级：越靠前越高
        let ar = arch_rank(name); // 架构匹配度：同扩展名下优先选匹配架构
        if best
            .as_ref()
            .is_none_or(|(r, a, _)| rank > *r || (rank == *r && ar > *a))
        {
            best = Some((rank, ar, name.clone()));
        }
    }
    best.map(|(_, _, name)| name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nightly_does_not_receive_stable_installers() {
        assert!(!stable_updates_allowed("dsh-tauri-nightly", false));
    }

    #[test]
    fn stable_and_legacy_identifiers_keep_stable_updates() {
        for identifier in ["dsh-tauri", "io.github.hairyf.deepseek-harness-desktop"] {
            assert!(stable_updates_allowed(identifier, false));
        }
    }

    #[test]
    fn distro_managed_builds_never_receive_installers() {
        for identifier in [
            "dsh-tauri",
            "dsh-tauri-nightly",
            "io.github.hairyf.deepseek-harness-desktop",
        ] {
            assert!(!stable_updates_allowed(identifier, true));
        }
    }

    #[test]
    fn parse_version_strips_v_prefix() {
        assert_eq!(parse_version("v0.5.2").unwrap().to_string(), "0.5.2");
        assert_eq!(parse_version("0.5.2").unwrap().to_string(), "0.5.2");
        // pre-release 也是合法 semver
        assert_eq!(
            parse_version("0.5.2-rc.1").unwrap().to_string(),
            "0.5.2-rc.1"
        );
        // 非法 semver（如手动测试 release 的 tag / 只有两段）返回 None
        assert_eq!(parse_version("abc"), None);
        assert_eq!(parse_version("test-main-123"), None);
        assert_eq!(parse_version("0.5"), None);
    }

    #[test]
    fn is_newer_compares_semver() {
        assert!(is_newer("0.5.2", "0.5.1"));
        assert!(is_newer("1.0.0", "0.9.0"));
        // rc 数值段更高 → 比旧正式版新
        assert!(is_newer("0.7.14-rc.1", "0.7.13"));
        // 正式版高于同号 rc（装了 rc 的用户能收到正式版通知）
        assert!(is_newer("0.7.14", "0.7.14-rc.1"));
        assert!(is_newer("0.7.14-rc.2", "0.7.14-rc.1"));
        assert!(!is_newer("0.5.1", "0.5.2"));
        assert!(!is_newer("0.5.1", "0.5.1"));
        // rc 不会高于同号正式版
        assert!(!is_newer("0.7.14-rc.1", "0.7.14"));
    }

    #[test]
    fn is_newer_ignores_unparseable() {
        assert!(!is_newer("abc", "0.5.1"));
        assert!(!is_newer("0.5.1", "abc"));
        assert!(!is_newer("test-main-123", "0.5.1"));
    }

    #[test]
    fn is_stable_only_pure_numeric() {
        assert!(is_stable(&parse_version("0.7.14").unwrap()));
        assert!(is_stable(&parse_version("0.7.0").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14-rc.1").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14-beta.2").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14-alpha").unwrap()));
        assert!(!is_stable(&parse_version("0.7.14+build.5").unwrap()));
    }

    #[test]
    fn pick_asset_prefers_matching_suffix() {
        let mk = |name: &str| name.to_string();
        #[cfg(target_os = "windows")]
        {
            // NSIS setup.exe 优先于 msi（避免 MSI 的 RestartManager 强杀+自动重开）
            let assets: Vec<String> = vec![mk("app-x86_64-setup.exe"), mk("app-x64_en-US.msi")];
            assert_eq!(pick_asset(&assets).as_deref(), Some("app-x86_64-setup.exe"));
        }
        #[cfg(target_os = "macos")]
        {
            let assets: Vec<String> = vec![mk("app.dmg"), mk("app-x86_64.tar.gz")];
            assert_eq!(pick_asset(&assets).as_deref(), Some("app.dmg"));
        }
        let no_match: Vec<String> = vec![mk("README.md")];
        assert!(pick_asset(&no_match).is_none());
        assert!(pick_asset(&[]).is_none());
    }

    /// 架构匹配度按**宿主 CPU** 判定而非编译目标：issue #576 现场是 Intel 版应用在
    /// Apple Silicon 上（Rosetta）一直挑到 Intel 安装包。宿主由参数驱动，任意 CI
    /// 平台都能覆盖两种宿主。
    #[test]
    fn arch_rank_for_matches_host_and_universal() {
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop_0.15.3_aarch64.dmg", true),
            2
        );
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop_0.15.3_x64.dmg", true),
            0
        );
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop_0.15.3_x64.dmg", false),
            2
        );
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop_0.15.3_aarch64.dmg", false),
            0
        );
        // Linux / 其它命名同样按宿主判定
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop_0.15.3_amd64.AppImage", false),
            2
        );
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop-0.15.3-1.x86_64.rpm", false),
            2
        );
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop-0.15.3-1.aarch64.rpm", true),
            2
        );
        // 通用包任何架构都可用
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop-universal.dmg", true),
            1
        );
        assert_eq!(
            arch_rank_for("Deepseek.Harness.Desktop-universal.dmg", false),
            1
        );
        // 未携带架构信息的文件名作为兜底（0）
        assert_eq!(arch_rank_for("app.dmg", true), 0);
        assert_eq!(arch_rank_for("app.dmg", false), 0);
    }

    /// Linux 资产优先级：包管理家族决定原生格式最优先（issue #79），未知家族落回 AppImage。
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_prefs_prefers_native_format_per_family() {
        let deb = linux_prefs("deb", "package");
        let deb_rank = deb.iter().position(|p| *p == ".deb").unwrap();
        let appimage_rank = deb.iter().position(|p| *p == ".AppImage").unwrap();
        let rpm_rank = deb.iter().position(|p| *p == ".rpm").unwrap();
        assert!(
            deb_rank < appimage_rank && deb_rank < rpm_rank,
            "deb 系应优先 .deb，实际 {deb:?}"
        );

        let rpm = linux_prefs("rpm", "package");
        let rpm_rank = rpm.iter().position(|p| *p == ".rpm").unwrap();
        let deb_rank = rpm.iter().position(|p| *p == ".deb").unwrap();
        let appimage_rank = rpm.iter().position(|p| *p == ".AppImage").unwrap();
        assert!(
            rpm_rank < appimage_rank && rpm_rank < deb_rank,
            "rpm 系应优先 .rpm，实际 {rpm:?}"
        );

        // 未知家族（如 pacman）：无对应原生包，AppImage 最通用
        let unknown = linux_prefs("unknown", "package");
        let appimage_rank = unknown.iter().position(|p| *p == ".AppImage").unwrap();
        let deb_rank = unknown.iter().position(|p| *p == ".deb").unwrap();
        let rpm_rank = unknown.iter().position(|p| *p == ".rpm").unwrap();
        assert!(
            appimage_rank < deb_rank && appimage_rank < rpm_rank,
            "未知家族应优先 AppImage，实际 {unknown:?}"
        );
    }

    /// 便携镜像运行时，即便宿主是 deb/rpm 系也必须选 `.AppImage`：系统包只会装到
    /// 另一个位置，镜像仍跑旧版本（与 [`self_updatable_for`] 同一事故的两个面）。
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_prefs_prefers_appimage_for_portable_media() {
        for family in ["deb", "rpm", "unknown"] {
            let prefs = linux_prefs(family, "appimage");
            assert_eq!(prefs.first(), Some(&".AppImage"), "{family}");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_install_media_for_detects_portable_image() {
        let mount = std::path::Path::new("/tmp/.mount_DSHuQmxq/usr/bin/deepseek-harness");
        let appdir = "/tmp/.mount_DSHuQmxq";
        assert_eq!(
            linux_install_media_for(Some("/opt/DSH.AppImage"), Some(appdir), mount),
            "appimage"
        );
        assert_eq!(
            linux_install_media_for(None, None, std::path::Path::new("/opt/DSH-x64.AppImage")),
            "appimage"
        );
        // `APPIMAGE` 空串等同未设置；系统目录与无扩展名都归为 package
        assert_eq!(
            linux_install_media_for(Some(""), Some(appdir), mount),
            "package"
        );
        assert_eq!(
            linux_install_media_for(
                None,
                None,
                std::path::Path::new("/usr/lib/DSH Tauri/runtime/linux-x64/DSH Tauri")
            ),
            "package"
        );
        assert_eq!(
            linux_install_media_for(None, None, std::path::Path::new("")),
            "package"
        );
        // 继承来的 `APPIMAGE` 不属于本进程（可执行文件不在该 APPDIR 里）时不算便携镜像
        assert_eq!(
            linux_install_media_for(
                Some("/opt/DSH.AppImage"),
                Some(appdir),
                std::path::Path::new("/usr/bin/deepseek-harness")
            ),
            "package"
        );
    }

    /// 就地替换的目标必须是用户保存的那个镜像文件，而不是 `/tmp/.mount_*` 挂载点，
    /// 也不能是环境里继承来的别的镜像。
    #[cfg(target_os = "linux")]
    #[test]
    fn running_appimage_prefers_the_appimage_variable() {
        let mount = std::path::Path::new("/tmp/.mount_DSHuQmxq/usr/bin/deepseek-harness");
        let appdir = "/tmp/.mount_DSHuQmxq";
        assert_eq!(
            running_appimage_from(Some("/home/u/Apps/DSH.AppImage"), Some(appdir), mount),
            Some(std::path::PathBuf::from("/home/u/Apps/DSH.AppImage"))
        );
        assert_eq!(
            running_appimage_from(None, None, std::path::Path::new("/opt/DSH-x64.AppImage")),
            Some(std::path::PathBuf::from("/opt/DSH-x64.AppImage"))
        );
        assert_eq!(running_appimage_from(Some(""), Some(appdir), mount), None);
        assert_eq!(
            running_appimage_from(
                None,
                None,
                std::path::Path::new("/usr/lib/DSH Tauri/runtime/linux-x64/DSH Tauri")
            ),
            None
        );
        // 变量指向的不是镜像文件，或可执行文件不在该 APPDIR 内 → 不认这个目标
        assert_eq!(
            running_appimage_from(Some("/home/u/notes.txt"), Some(appdir), mount),
            None
        );
        assert_eq!(
            running_appimage_from(
                Some("/home/u/Apps/DSH.AppImage"),
                Some(appdir),
                std::path::Path::new("/usr/bin/deepseek-harness")
            ),
            None
        );
    }

    /// 只有「系统包安装 + 家族未知」与「系统包安装 + 当前二进制不属于该家族的包」
    /// 无法就地替换；AppImage 安装任何宿主都能自我替换，被包管理器登记的原生安装则用
    /// 原生包。
    #[cfg(target_os = "linux")]
    #[test]
    fn self_updatable_only_fails_for_package_media_on_unknown_family() {
        assert!(self_updatable_for("appimage", "deb", false));
        assert!(self_updatable_for("appimage", "rpm", false));
        assert!(self_updatable_for("appimage", "unknown", false));
        assert!(self_updatable_for("package", "deb", true));
        assert!(self_updatable_for("package", "rpm", true));
        assert!(!self_updatable_for("package", "deb", false));
        assert!(!self_updatable_for("package", "rpm", false));
        assert!(!self_updatable_for("package", "unknown", true));
        assert!(!self_updatable_for("package", "unknown", false));
    }

    /// macOS 上 aarch64 二进制不可能跑在 Intel Mac 上 ⇒ 宿主判定必为 Apple Silicon，
    /// 这也是 Rosetta 场景（Intel 版应用 + M 芯片）能自愈的基础。
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn host_arch_is_apple_silicon_for_aarch64_build() {
        assert!(host_is_aarch64());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn pick_asset_prefers_host_arch_dmg() {
        let mk = |name: &str| name.to_string();
        let aarch64 = "Deepseek.Harness.Desktop_0.6.6_aarch64.dmg";
        let x64 = "Deepseek.Harness.Desktop_0.6.6_x64.dmg";
        let universal = "Deepseek.Harness.Desktop_0.6.6-universal.dmg";
        // aarch64 与 x64 并存（与真实发布资产命名一致）：选与宿主 CPU 匹配的包
        let picked = pick_asset(&[mk(aarch64), mk(x64)]).unwrap();
        assert_eq!(picked, if host_is_aarch64() { aarch64 } else { x64 });
        // 通用包优于与宿主不匹配的包
        let wrong = if host_is_aarch64() { x64 } else { aarch64 };
        let picked = pick_asset(&[mk(wrong), mk(universal)]).unwrap();
        assert_eq!(picked, universal);
    }
}
