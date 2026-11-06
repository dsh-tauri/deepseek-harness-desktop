use std::path::{Path, PathBuf};

pub(crate) fn prepare_native_bridge(bin_dir: &Path) -> Result<PathBuf, String> {
    let path = bin_dir.join("asar-native.cjs");
    let source = concat!(
        r#"
{
  const process = require('node:process');
  const match = process.argv[1]?.match(/^(.*?\.asar)(?:[\\/]|$)/i);
  if (match) {
    const archive = require('node:path').resolve(match[1]);
    const stat = require('original-fs').statSync(archive);
    const hash = require('node:crypto').createHash('sha256')
      .update(JSON.stringify([archive, stat.size, stat.mtimeMs, process.versions.electron, process.arch]))
      .update(require('node:fs').readFileSync(__filename)).digest('hex');
    process.env.DSH_CORE_ARCHIVE = archive;
    process.env.DSH_CORE_NATIVE_CACHE = require('node:path').join(__dirname, '.asar-native', hash);
  }
}
"#,
        include_str!("asar-native.cjs")
    );
    if std::fs::read_to_string(&path).ok().as_deref() != Some(source) {
        std::fs::create_dir_all(bin_dir)
            .and_then(|_| std::fs::write(&path, source))
            .map_err(|error| format!("CORE_NATIVE_BOOTSTRAP_WRITE_FAILED: {error}"))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_preload_initializes_archive_cache_before_registering_hooks() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/electron");
        let Ok(electron) = electron_rs::electron_binary(&root) else {
            return;
        };
        let scratch = tempfile::tempdir().unwrap();
        let archive = scratch.path().join("core.asar");
        std::fs::create_dir_all(&archive).unwrap();
        let bootstrap = prepare_native_bridge(&scratch.path().join("bin")).unwrap();
        let mut command = std::process::Command::new(electron);
        command
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env_remove("DSH_CORE_ARCHIVE")
            .env_remove("DSH_CORE_NATIVE_CACHE")
            .env_remove("NODE_OPTIONS")
            .arg("--require").arg(bootstrap)
            .args(["--eval", "process.stdout.write(JSON.stringify([process.env.DSH_CORE_ARCHIVE,process.env.DSH_CORE_NATIVE_CACHE]))"])
            .arg(archive.join("entry.js"));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let paths: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(Path::new(&paths[0]), archive);
        let cache = Path::new(&paths[1]);
        assert_eq!(cache.file_name().unwrap().len(), 64);
        let cache_root = cache.parent().unwrap();
        assert_eq!(
            cache_root.file_name().unwrap(),
            std::ffi::OsStr::new(".asar-native")
        );
        assert_eq!(
            dunce::canonicalize(cache_root.parent().unwrap()).unwrap(),
            dunce::canonicalize(scratch.path().join("bin")).unwrap()
        );
    }
}
