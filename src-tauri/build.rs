fn main() -> Result<(), Box<dyn std::error::Error>> {
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
    let attributes = tauri_build::Attributes::new();
    let attributes = if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        // tauri-build 默认只给应用嵌入清单；测试程序也需要 Common Controls v6。
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        attributes
    };
    tauri_build::try_build(attributes)?;
    Ok(())
}
