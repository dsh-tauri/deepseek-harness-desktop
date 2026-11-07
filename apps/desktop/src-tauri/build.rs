fn main() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = std::env::var_os("CARGO_MANIFEST_DIR").unwrap();
    let manifest_dir = std::path::PathBuf::from(manifest_dir);
    // capability / permission 是编译期生成的 ACL；不声明依赖时改完 JSON cargo 不会重跑
    // 本脚本，产物里仍是旧权限，表现为运行时 `emit_to not allowed`。
    for relative in ["capabilities", "permissions", "tauri.conf.json"] {
        println!(
            "cargo:rerun-if-changed={}",
            manifest_dir.join(relative).display()
        );
    }
    // 壳层产物经 `include_str!` 编译期内嵌；不声明依赖时改完 dist.shell 不会重编，
    // 运行时仍是旧壳层（表现为改了 UI 却没反应）。
    println!(
        "cargo:rerun-if-changed={}",
        manifest_dir.join("../dist.shell/shell.mjs").display()
    );
    let target = tauri_utils::platform::Target::from_triple(&std::env::var("TARGET")?);
    let (mut config, _) = tauri_utils::config::parse::read_from(target, &std::env::current_dir()?)?;
    if let Ok(extra) = std::env::var("TAURI_CONFIG") {
        json_patch::merge(&mut config, &serde_json::from_str(&extra)?);
    }
    for (key, variable) in [
        ("identifier", "DSH_APP_IDENTIFIER"),
        ("productName", "DSH_PRODUCT_NAME"),
    ] {
        let value = config[key].as_str().ok_or("missing Tauri app identity")?;
        println!("cargo:rustc-env={variable}={value}");
    }
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    let attributes = tauri_build::Attributes::new().plugin(
        "electron-window",
        tauri_build::InlinedPlugin::new().commands(&["set_effects"]),
    );
    let attributes = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        attributes
    };
    tauri_build::try_build(attributes)?;
    #[cfg(unix)]
    mirror_directory_links()?;
    Ok(())
}

#[cfg(unix)]
fn mirror_directory_links() -> Result<(), Box<dyn std::error::Error>> {
    use std::path::{Path, PathBuf};

    fn walk(from: &Path, to: &Path) -> std::io::Result<()> {
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let source = entry.path();
            let target = to.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                if std::fs::symlink_metadata(&target).is_err() && source.is_dir() {
                    std::os::unix::fs::symlink(std::fs::read_link(&source)?, &target)?;
                }
            } else if kind.is_dir() && target.is_dir() {
                walk(&source, &target)?;
            }
        }
        Ok(())
    }

    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").ok_or("missing manifest dir")?);
    let source = manifest.join("target/electron");
    let out = PathBuf::from(std::env::var_os("OUT_DIR").ok_or("missing OUT_DIR")?);
    let Some(profile) = out.ancestors().nth(3) else {
        return Ok(());
    };
    let target = profile.join("runtime");
    if source.is_dir() && target.is_dir() {
        walk(&source, &target)?;
    }
    Ok(())
}
