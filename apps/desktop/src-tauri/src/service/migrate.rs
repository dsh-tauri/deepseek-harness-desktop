//! 启动自愈：清理指向已失效旧位置的 pnpm 安装元数据。
//!
//! 桌面端历史上做过两次数据目录搬迁（AppData `data/dsh` → 官方 `$DSH_HOME`，
//! 以及应用标识符缩短后的 app-data 目录改名）。两次搬迁都会把 `node_modules`
//! 一并带入，而 pnpm 的 `.modules.yaml` 记录的是**旧位置的绝对路径**
//! （storeDir / virtualStoreDir），搬入后必然失配，任何 pnpm 操作都会在
//! checkCompatibility 阶段抛 `ERR_PNPM_UNEXPECTED_VIRTUAL_STORE`（见 issue #103）。
//!
//! 搬迁逻辑本身已删除：当前版本不再支持那两代旧数据位置，直接从当前
//! `$DSH_HOME` 起步。但用旧版本完成过搬迁的用户，其 `profiles/*/node_modules`
//! 里仍留着失效元数据，因此保留本模块兜底——启动时扫描 `profiles/*`，只删除
//! 满足「绝对路径 + 不在当前 `$DSH_HOME` 下 + 磁盘上已不存在」的
//! `.modules.yaml`，不触碰任何会话/档案数据。幂等、best-effort，仅告警不阻断启动。

use std::fs;
use std::path::Path;

/// 旧版独立 Node 运行时在依赖映射表里的键名。
const LEGACY_NODE_MAPPING_KEY: &str = "node";

/// 清除 `root` 下携带过来的 pnpm 安装元数据（`node_modules/.modules.yaml`）。
///
/// 该文件是纯元数据，记录的绝对路径来自旧位置；删除后 pnpm 跳过兼容性校验，
/// 下次 `install`/`add` 自动以新位置重建（物理链接随整树搬移仍有效）——比整体
/// 删除 `node_modules`（会破坏已安装状态展示、触发全量重链）更轻。
///
/// 递归遍历目录：只处理名为 `node_modules` 的目录（查其下 `.modules.yaml`，不
/// 深入 node_modules 内部的海量子目录）。best-effort，删除失败仅告警。
pub(crate) fn purge_carried_pnpm_metadata(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if !ft.is_dir() {
            continue;
        }
        let path = entry.path();
        if entry.file_name() == "node_modules" {
            let modules_yaml = path.join(".modules.yaml");
            if modules_yaml.is_file() {
                match fs::remove_file(&modules_yaml) {
                    Ok(()) => log::info!(
                        "purged carried pnpm modules metadata: {}",
                        modules_yaml.display()
                    ),
                    Err(e) => log::warn!("purge {} failed: {e}", modules_yaml.display()),
                }
            }
            // 不再深入 node_modules（子目录海量，且其中没有需要处理的元数据）
        } else {
            purge_carried_pnpm_metadata(&path);
        }
    }
}

/// 启动自愈：删除历史遗留的独立 Node 运行时目录（`$AppData/runtime`）。
///
/// dsh 与 pnpm 已改为以随包 Electron 的 Node 模式运行，该目录不再被任何路径
/// 使用；但旧安装可能残留一整套 node 发行版（debug 构建下含 corepack/npm 与
/// `node_modules`），既占空间，也会让「打开运行环境目录」指向一个已废弃的运行时。
///
/// 同时把映射表里的 `node` 记录一并清掉：映射值会让解析链把该槽位当作「已 pin」，
/// 目录删掉后记录悬空反而更容易误导后续诊断。幂等、best-effort，仅告警不阻断启动。
pub fn remove_legacy_node_runtime(app_handle: &crate::AppHandle) -> Result<(), String> {
    let legacy = crate::config::legacy_node_root(app_handle);
    let mut failures = Vec::new();
    if legacy.is_dir() {
        match fs::remove_dir_all(&legacy) {
            Ok(()) => log::info!("removed legacy node runtime: {}", legacy.display()),
            // Windows 上仍有句柄未释放时保留目录，下次启动再试。
            Err(error) => failures.push(format!("{}: {error}", legacy.display())),
        }
    }
    // 依赖映射的 `node` 键已不再有对应运行时；清空它，免得记录悬空。
    crate::config::dependencies::record(app_handle, LEGACY_NODE_MAPPING_KEY, None);
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!("LEGACY_NODE_CLEANUP_FAILED: {}", failures.join("; ")))
    }
}

/// 启动自愈：清理指向旧位置的 pnpm 安装元数据，兜底已用旧版完成搬迁的用户。
///
/// 每次启动扫描当前 `$DSH_HOME/profiles/*`：当记录的 `virtualStoreDir` /
/// `storeDir` 是「绝对路径、不在当前 `$DSH_HOME` 之下、且磁盘上已不存在」
/// （指向已被搬迁删除的旧树）时，删除该 `.modules.yaml`，下次 pnpm 操作即恢复
/// （相对路径与正常绝对路径不受影响）。幂等、best-effort，仅告警不阻断启动。
pub fn heal_stale_pnpm_metadata(dsh_home: &Path) -> Result<(), String> {
    let profiles = dsh_home.join("profiles");
    let Ok(entries) = fs::read_dir(&profiles) else {
        return Ok(()); // 全新安装 / 无 profiles 目录 → 无可修对象
    };
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            purge_if_stale_modules_metadata(&entry.path().join("node_modules"), dsh_home);
        }
    }
    Ok(())
}

/// 单个 profile 的 node_modules：`.modules.yaml` 记录的绝对路径同时满足
/// 「不在当前 DSH_HOME 下」且「磁盘上已不存在」→ 判定为指向旧树的失效元数据，
/// 删除该模块文件让 pnpm 重建。
fn purge_if_stale_modules_metadata(node_modules: &Path, dsh_home: &Path) {
    let modules_yaml = node_modules.join(".modules.yaml");
    if !modules_yaml.is_file() {
        return;
    }
    let Ok(content) = fs::read_to_string(&modules_yaml) else {
        return;
    };
    let Ok(doc): Result<serde_yaml::Value, _> = serde_yaml::from_str(&content) else {
        return;
    };
    let stale = doc.as_mapping().is_some_and(|mapping| {
        ["virtualStoreDir", "storeDir"].iter().any(|key| {
            mapping
                .get(serde_yaml::Value::String((*key).into()))
                .and_then(serde_yaml::Value::as_str)
                .is_some_and(|value| {
                    let p = Path::new(value);
                    p.is_absolute() && !p.starts_with(dsh_home) && !p.exists()
                })
        })
    });
    if stale {
        match fs::remove_file(&modules_yaml) {
            Ok(()) => log::info!(
                "purged stale pnpm modules metadata (old DSH_HOME paths): {}",
                modules_yaml.display()
            ),
            Err(e) => log::warn!("purge {} failed: {e}", modules_yaml.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// 构造一个带内容与 mtime 的临时目录树，返回 (root, 清理守卫)。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("dsh-migrate-test-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    // ------------------------------------------------------------------
    // 启动自愈：清理指向旧位置的 pnpm 元数据（老搬迁残留，issue #103）
    // ------------------------------------------------------------------

    #[test]
    fn heal_purges_stale_absolute_virtual_store_paths() {
        let home = temp_dir("heal-home");
        let node_modules = home.join("profiles/web/node_modules");
        // 模拟旧搬迁后的状态：`.modules.yaml` 记录的旧绝对路径已不存在
        // （指向已被搬迁删除的旧树；用 temp 下不存在的路径构造，
        //  保证在任何平台（Windows/Unix）都是绝对路径且磁盘上不存在）。
        let legacy_home = temp_dir("heal-legacy-home");
        let legacy_vsd = legacy_home.join("profiles/web/node_modules/.pnpm");
        write(
            &node_modules.join(".modules.yaml"),
            &format!(
                "lockfileVersion: '9.0'\nstoreDir: {}\nvirtualStoreDir: {}\n",
                legacy_home.join("pnpm/store/v10").display(),
                legacy_vsd.display()
            ),
        );
        // 真实虚拟商店目录在当前 home 下存在（物理链接有效，仅元数据失效）
        fs::create_dir_all(home.join("profiles/web/node_modules/.pnpm")).unwrap();

        heal_stale_pnpm_metadata(&home).unwrap();

        assert!(
            !node_modules.join(".modules.yaml").exists(),
            "stale pnpm metadata pointing at removed old DSH_HOME must be purged"
        );
    }

    #[test]
    fn heal_keeps_consistent_or_relative_modules_metadata() {
        let home = temp_dir("heal-keep");
        let node_modules = home.join("profiles/web/node_modules");
        fs::create_dir_all(&node_modules).unwrap();
        // 正常状态：virtualStoreDir 相对、storeDir 指向仍存在的 store → 保留
        let store = temp_dir("heal-keep-store");
        write(
            &node_modules.join(".modules.yaml"),
            &format!(
                "lockfileVersion: '9.0'\nstoreDir: {}\nvirtualStoreDir: node_modules/.pnpm\n",
                store.display()
            ),
        );

        heal_stale_pnpm_metadata(&home).unwrap();
        assert!(
            node_modules.join(".modules.yaml").is_file(),
            "valid modules metadata must be kept"
        );
    }

    #[test]
    fn heal_keeps_absolute_paths_living_under_current_home() {
        let home = temp_dir("heal-under-home");
        let node_modules = home.join("profiles/web/node_modules");
        let vsd = home.join("profiles/web/node_modules/.pnpm");
        fs::create_dir_all(&vsd).unwrap();
        write(
            &node_modules.join(".modules.yaml"),
            &format!("lockfileVersion: '9.0'\nvirtualStoreDir: {}\n", vsd.display()),
        );

        heal_stale_pnpm_metadata(&home).unwrap();
        assert!(
            node_modules.join(".modules.yaml").is_file(),
            "absolute path under current DSH_HOME is consistent, must be kept"
        );
    }

    #[test]
    fn heal_missing_profiles_dir_is_noop() {
        let home = temp_dir("heal-empty");
        heal_stale_pnpm_metadata(&home).unwrap();
        // 无 profiles 目录 → 无异常、不产生任何文件
        assert!(!home.join("profiles").exists());
    }
}
