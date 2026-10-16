//! bridge/preset_pet.rs — 预设宠物清单（`resources/manifest.jsonc` 的 `pets.built-in`）。
//!
//! 预设宠物不再下载到本地：清单里的条目本身就是 `dsh-pet-component` 的
//! `<Pet>` 渲染参数（`config` / `uri` / `ext` / `kind` / `size`），pet 窗口按
//! 当前激活 id 取到条目后直连远端素材播放（macOS 用 `uri.mac` / `ext.mac`
//! 指向 HEVC-with-Alpha 的 `.mov` 素材：WKWebView 不认 VP9-alpha WebM）。
//!
//! 内置清单与用户登记的远端条目合并返回；store 只持久化资源地址与元信息。

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const REMOTE_PET_CATALOG_KEY: &str = "remote_pet_catalog";

use crate::config::manifest::{self, PresetPetSpec};

/// 清单条目 + 是否由用户登记：只有登记来的条目能在设置页删除，内置条目不可删。
#[derive(Debug, Clone, serde::Serialize)]
pub struct PresetPetEntry {
    #[serde(flatten)]
    pub spec: PresetPetSpec,
    pub remote: bool,
}

/// 预设 id 是否安全（直接进入设置持久化与命令参数，只允许 ASCII 字母数字与 `-`/`_`）。
pub(crate) fn safe_preset_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || value == '-' || value == '_')
}

/// 读取并校验清单。任何形状问题都返回带 `PET_PRESET_CATALOG_*` 前缀的错误，不做静默兜底。
pub fn read_preset_catalog(app: &AppHandle) -> Result<Vec<PresetPetSpec>, String> {
    Ok(read_preset_entries(app)?
        .into_iter()
        .map(|entry| entry.spec)
        .collect())
}

/// 读取清单并标出每个条目的来源；内置在前，登记的在后，与合并顺序一致。
fn read_preset_entries(app: &AppHandle) -> Result<Vec<PresetPetEntry>, String> {
    let manifest = manifest::read(app)
        .ok_or_else(|| "PET_PRESET_CATALOG_MISSING: manifest.jsonc was not found".to_string())?;
    let store = app
        .store(crate::config::store_dat_file_name())
        .map_err(|error| format!("PET_REMOTE_STORE_FAILED: {error}"))?;
    let mut entries: Vec<PresetPetEntry> = manifest
        .pets
        .built_in
        .into_iter()
        .map(|spec| PresetPetEntry {
            spec,
            remote: false,
        })
        .collect();
    entries.extend(
        remote_catalog(store.get(REMOTE_PET_CATALOG_KEY))?
            .into_iter()
            .map(|spec| PresetPetEntry { spec, remote: true }),
    );
    let catalog: Vec<PresetPetSpec> = entries.iter().map(|entry| entry.spec.clone()).collect();
    validate_catalog(&catalog)?;
    Ok(entries)
}

fn pet_catalog_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 覆写登记清单；写盘失败时恢复写前的内存值（无此键则删除），避免内存与磁盘分叉。
fn write_remote_catalog(app: &AppHandle, catalog: Vec<PresetPetSpec>) -> Result<(), String> {
    let store = app
        .store(crate::config::store_dat_file_name())
        .map_err(|error| format!("PET_REMOTE_STORE_FAILED: {error}"))?;
    let previous = store.get(REMOTE_PET_CATALOG_KEY);
    store.set(
        REMOTE_PET_CATALOG_KEY,
        serde_json::to_value(&catalog)
            .map_err(|error| format!("PET_REMOTE_CATALOG_INVALID: {error}"))?,
    );
    if let Err(error) = store.save() {
        match previous {
            Some(previous) => store.set(REMOTE_PET_CATALOG_KEY, previous),
            None => {
                store.delete(REMOTE_PET_CATALOG_KEY);
            }
        }
        return Err(format!("PET_REMOTE_STORE_FAILED: {error}"));
    }
    Ok(())
}

fn remote_catalog(value: Option<serde_json::Value>) -> Result<Vec<PresetPetSpec>, String> {
    let catalog: Vec<PresetPetSpec> = match value {
        Some(value) => serde_json::from_value(value)
            .map_err(|error| format!("PET_REMOTE_CATALOG_INVALID: {error}"))?,
        None => Vec::new(),
    };
    validate_catalog(&catalog)?;
    Ok(catalog)
}

pub(super) fn register_remote_pet(
    app: &AppHandle,
    spec: PresetPetSpec,
) -> Result<PresetPetSpec, String> {
    let _guard = pet_catalog_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let store = app
        .store(crate::config::store_dat_file_name())
        .map_err(|error| format!("PET_REMOTE_STORE_FAILED: {error}"))?;
    let mut registered = remote_catalog(store.get(REMOTE_PET_CATALOG_KEY))?;
    ensure_new_pet(&read_preset_catalog(app)?, &spec)?;
    registered.push(spec.clone());
    write_remote_catalog(app, registered)?;
    Ok(spec)
}

/// 反注册用户登记的远端条目；内置条目不在登记清单里，删不到即报错。
pub(super) fn unregister_remote_pet(app: &AppHandle, id: &str) -> Result<(), String> {
    let _guard = pet_catalog_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let store = app
        .store(crate::config::store_dat_file_name())
        .map_err(|error| format!("PET_REMOTE_STORE_FAILED: {error}"))?;
    let mut registered = remote_catalog(store.get(REMOTE_PET_CATALOG_KEY))?;
    drop_registered(&mut registered, id)?;
    write_remote_catalog(app, registered)
}

pub(super) fn update_remote_pet(
    app: &AppHandle,
    spec: PresetPetSpec,
) -> Result<PresetPetSpec, String> {
    let _guard = pet_catalog_lock()
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let store = app
        .store(crate::config::store_dat_file_name())
        .map_err(|error| format!("PET_REMOTE_STORE_FAILED: {error}"))?;
    let mut registered = remote_catalog(store.get(REMOTE_PET_CATALOG_KEY))?;
    replace_registered(&mut registered, &spec)?;
    write_remote_catalog(app, registered)?;
    Ok(spec)
}

fn replace_registered(catalog: &mut [PresetPetSpec], spec: &PresetPetSpec) -> Result<(), String> {
    let index = catalog
        .iter()
        .position(|item| item.id == spec.id)
        .ok_or_else(|| format!("PET_NOT_FOUND: preset {} is not registered", spec.id))?;
    ensure_new_pet(
        &catalog
            .iter()
            .filter(|item| item.id != spec.id)
            .cloned()
            .collect::<Vec<_>>(),
        spec,
    )?;
    catalog[index] = spec.clone();
    Ok(())
}

fn drop_registered(catalog: &mut Vec<PresetPetSpec>, id: &str) -> Result<(), String> {
    if !catalog.iter().any(|spec| spec.id == id) {
        return Err(format!("PET_NOT_FOUND: preset {id} is not registered"));
    }
    catalog.retain(|spec| spec.id != id);
    Ok(())
}

fn ensure_new_pet(catalog: &[PresetPetSpec], spec: &PresetPetSpec) -> Result<(), String> {
    validate_catalog(std::slice::from_ref(spec))?;
    if catalog.iter().any(|item| {
        item.id == spec.id
            || item.config == spec.config
            || match (
                super::pet::pet_repository_revision(item),
                super::pet::pet_repository_revision(spec),
            ) {
                (Ok((owner, name, _)), Ok((other_owner, other_name, _))) => {
                    owner.eq_ignore_ascii_case(&other_owner)
                        && name.eq_ignore_ascii_case(&other_name)
                }
                _ => false,
            }
    }) {
        return Err(format!(
            "PET_ALREADY_IMPORTED: pet {} or repository is already registered",
            spec.id
        ));
    }
    Ok(())
}

fn validate_catalog(catalog: &[PresetPetSpec]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for spec in catalog {
        if !safe_preset_id(&spec.id) {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: preset id {:?} is not a safe id",
                spec.id
            ));
        }
        if !ids.insert(spec.id.as_str()) {
            return Err(format!(
                "PET_PRESET_CATALOG_INVALID: duplicate preset id {:?}",
                spec.id
            ));
        }
        for (field, value) in [
            ("name", spec.name.as_str()),
            ("config", spec.config.as_str()),
            ("uri.default", spec.uri.default.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!(
                    "PET_PRESET_CATALOG_INVALID: preset {:?} must have a non-empty {field}",
                    spec.id
                ));
            }
        }
        if let Some(kind) = spec.kind.as_deref() {
            if kind != "dsh" && kind != "codex" {
                return Err(format!(
                    "PET_PRESET_CATALOG_INVALID: preset {:?} kind must be dsh or codex",
                    spec.id
                ));
            }
        }
    }
    Ok(())
}

/// 列出预设宠物清单（前端按当前激活 id 自行取用；条目即 `<Pet>` 的渲染参数）。
#[tauri::command]
pub fn list_preset_pets(app: AppHandle) -> Result<Vec<PresetPetEntry>, String> {
    read_preset_entries(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_serialization_flattens_the_spec_and_marks_registered_pets() {
        // 前端 PresetPetItem 直接展开这些字段；`remote` 决定卡片上有没有删除按钮，
        // 嵌套成 spec 子对象就会静默丢掉这个判定。
        let spec: PresetPetSpec = serde_json::from_str(
            r#"{"id":"remote","name":"Remote","config":"https://e/c","uri":{"default":"https://e/w"}}"#,
        )
        .unwrap();
        let value = serde_json::to_value(PresetPetEntry { spec, remote: true }).unwrap();
        assert_eq!(value["id"], "remote");
        assert_eq!(value["name"], "Remote");
        assert_eq!(value["remote"], true);
        assert!(value.get("spec").is_none());
    }

    #[test]
    fn updates_replace_only_registered_entries_and_preserve_original_on_invalid_spec() {
        let original: PresetPetSpec = serde_json::from_str(
            r#"{"id":"remote","name":"Old","config":"https://e/old","uri":{"default":"https://e/old/webm"}}"#,
        ).unwrap();
        let mut catalog = vec![original.clone()];
        let mut updated = original.clone();
        updated.name.clear();
        assert!(replace_registered(&mut catalog, &updated).is_err());
        assert_eq!(catalog[0].name, "Old");
        updated.name = "New".into();
        updated.id = "builtin".into();
        assert!(replace_registered(&mut catalog, &updated)
            .unwrap_err()
            .starts_with("PET_NOT_FOUND:"));
        assert_eq!(catalog[0].name, "Old");
        updated.id = "remote".into();
        updated.config = "https://e/new".into();
        assert_eq!(replace_registered(&mut catalog, &updated), Ok(()));
        assert_eq!(catalog[0].config, "https://e/new");
        assert_eq!(catalog[0].name, "New");
        assert_eq!(catalog.len(), 1);
    }

    #[test]
    fn unregister_drops_only_registered_ids_and_rejects_built_in_ones() {
        let spec = |id: &str| -> PresetPetSpec {
            serde_json::from_str(&format!(
                r#"{{"id":"{id}","name":"Pet","config":"https://e/c","uri":{{"default":"https://e/w"}}}}"#
            ))
            .unwrap()
        };
        let mut catalog = vec![spec("remote")];
        assert_eq!(
            drop_registered(&mut catalog, "builtin"),
            Err("PET_NOT_FOUND: preset builtin is not registered".into())
        );
        assert_eq!(catalog.len(), 1);
        assert_eq!(drop_registered(&mut catalog, "remote"), Ok(()));
        assert!(catalog.is_empty());
    }

    #[test]
    fn remote_catalog_roundtrip_preserves_urls_and_rejects_duplicate_id_or_repository() {
        let spec: PresetPetSpec = serde_json::from_value(serde_json::json!({
            "id": "remote", "name": "Remote", "kind": "dsh",
            "config": "https://raw.githubusercontent.com/o/r/HEAD/config.jsonc",
            "image": "https://raw.githubusercontent.com/o/r/HEAD/preview/preview.gif",
            "uri": {"default": "https://raw.githubusercontent.com/o/r/HEAD/webm"},
            "ext": {"default": "webm", "mac": "webm"}
        }))
        .unwrap();
        let value = serde_json::to_value(vec![spec.clone()]).unwrap();
        let catalog = remote_catalog(Some(value.clone())).unwrap();
        assert_eq!(serde_json::to_value(&catalog).unwrap(), value);
        assert_eq!(remote_catalog(None).unwrap().len(), 0);
        assert!(ensure_new_pet(&catalog, &spec)
            .unwrap_err()
            .starts_with("PET_ALREADY_IMPORTED:"));
        let mut renamed = spec.clone();
        renamed.id = "renamed".into();
        assert!(ensure_new_pet(&catalog, &renamed)
            .unwrap_err()
            .starts_with("PET_ALREADY_IMPORTED:"));
        renamed.config = "https://raw.githubusercontent.com/O/R/0123456789abcdef0123456789abcdef01234567/new/config.jsonc".into();
        assert!(ensure_new_pet(&catalog, &renamed)
            .unwrap_err()
            .starts_with("PET_ALREADY_IMPORTED:"));
        renamed.config = "https://raw.githubusercontent.com/o/other/HEAD/config.jsonc".into();
        assert_eq!(ensure_new_pet(&catalog, &renamed), Ok(()));
        assert!(remote_catalog(Some(serde_json::json!({})))
            .unwrap_err()
            .starts_with("PET_REMOTE_CATALOG_INVALID:"));
    }

    #[test]
    fn remote_catalog_persists_in_an_isolated_store_without_config_content() {
        let root = tempfile::tempdir().unwrap();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let path = root.path().join("pets.json");
        let store = app.store(&path).unwrap();
        let catalog = serde_json::json!([{
            "id": "remote", "name": "Remote", "kind": "dsh",
            "config": "https://raw.githubusercontent.com/o/r/HEAD/config.jsonc",
            "uri": {"default": "https://raw.githubusercontent.com/o/r/HEAD/webm"}
        }]);
        store.set(REMOTE_PET_CATALOG_KEY, catalog.clone());
        store.save().unwrap();
        let persisted: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted[REMOTE_PET_CATALOG_KEY], catalog);
        assert_eq!(
            remote_catalog(Some(persisted[REMOTE_PET_CATALOG_KEY].clone())).unwrap()[0].id,
            "remote"
        );
        assert!(persisted[REMOTE_PET_CATALOG_KEY][0]
            .get("motions")
            .is_none());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }

    fn shipped_catalog() -> Vec<PresetPetSpec> {
        manifest::read_at(
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/manifest.jsonc"),
        )
        .expect("shipped manifest should be valid")
        .pets
        .built_in
    }

    #[test]
    fn shipped_catalog_is_valid_and_remote_only() {
        // 随包分发的清单是唯一事实来源：字段名/形状写错必须在这里炸，
        // 而不是等用户点「启用」才在运行时静默失败。
        let catalog = shipped_catalog();
        assert!(!catalog.is_empty(), "预设清单不应为空");
        for spec in catalog {
            assert!(safe_preset_id(&spec.id), "非法 id: {}", spec.id);
            assert!(!spec.name.trim().is_empty());
            assert!(!spec.config.trim().is_empty());
            assert!(!spec.uri.default.trim().is_empty());
            // 不再有本地安装：素材与配置都必须是远端地址。
            assert!(
                spec.config.starts_with("https://"),
                "config 必须是 https 地址"
            );
            assert!(
                spec.uri.default.starts_with("https://"),
                "uri.default 必须是 https 地址"
            );
            if let Some(kind) = spec.kind.as_deref() {
                assert!(kind == "dsh" || kind == "codex");
            }
        }
    }

    #[test]
    fn shipped_catalog_provides_macos_mov_override() {
        // macOS 的 WKWebView 不认 VP9-alpha：至少一个预设必须给出 .mov 覆盖块。
        let spec = shipped_catalog()
            .into_iter()
            .find(|spec| spec.uri.mac.is_some())
            .expect("至少一个预设应提供 macOS 素材覆盖");
        let mac = spec.uri.mac.unwrap();
        assert!(mac.starts_with("https://"));
        assert!(mac.ends_with("/mov"), "macOS 素材目录应为 mov/: {mac}");
        assert_eq!(
            spec.ext.as_ref().and_then(|ext| ext.mac.as_deref()),
            Some("mov")
        );
    }

    #[test]
    fn catalog_entry_deserializes_with_defaults_and_rejects_unknown_fields() {
        let spec: PresetPetSpec = serde_json::from_str(
            r#"{
                "id": "maid-deepseek-whale",
                "name": "Maid DeepSeek Whale",
                "config": "https://example.com/config.jsonc",
                "uri": { "default": "https://example.com/webm" }
            }"#,
        )
        .unwrap();
        assert_eq!(spec.id, "maid-deepseek-whale");
        assert_eq!(spec.desc, None);
        assert_eq!(spec.kind, None);
        assert_eq!(spec.size, None);
        assert_eq!(spec.ext, None);
        assert_eq!(spec.uri.mac, None);

        // 字段名写错（如旧的 sizeMb）必须立刻报错，而不是被静默忽略。
        let error = serde_json::from_str::<PresetPetSpec>(
            r#"{
                "id": "x",
                "name": "X",
                "config": "https://example.com/config.jsonc",
                "uri": { "default": "https://example.com/webm" },
                "sizeMb": 113
            }"#,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("sizeMb"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn serialization_omits_absent_optional_fields() {
        // 前端 props 里 optional 字段缺省即 undefined：null 会让 `mac?: string` 变成 null。
        let spec = PresetPetSpec {
            id: "p".to_string(),
            name: "P".to_string(),
            desc: None,
            image: None,
            kind: Some("dsh".to_string()),
            size: Some(220.0),
            config: "https://example.com/config.jsonc".to_string(),
            uri: manifest::PresetPetUri {
                default: "https://example.com/webm".to_string(),
                mac: None,
            },
            ext: None,
        };
        let value = serde_json::to_value(&spec).unwrap();
        assert!(value.get("desc").is_none());
        assert!(value.get("ext").is_none());
        assert!(value["uri"].get("mac").is_none());
        assert_eq!(value["kind"], "dsh");
        assert_eq!(value["size"], 220.0);
    }

    #[test]
    fn catalog_validation_preserves_field_errors_and_order() {
        let valid: PresetPetSpec = serde_json::from_str(
            r#"{"id":"safe","name":"Pet","config":"https://e/c","uri":{"default":"https://e/w"}}"#,
        )
        .unwrap();
        assert_eq!(validate_catalog(&[]), Ok(()));
        assert_eq!(validate_catalog(std::slice::from_ref(&valid)), Ok(()));
        for (field, expected) in [
            (
                "name",
                "PET_PRESET_CATALOG_INVALID: preset \"safe\" must have a non-empty name",
            ),
            (
                "config",
                "PET_PRESET_CATALOG_INVALID: preset \"safe\" must have a non-empty config",
            ),
            (
                "uri.default",
                "PET_PRESET_CATALOG_INVALID: preset \"safe\" must have a non-empty uri.default",
            ),
        ] {
            let mut spec = valid.clone();
            match field {
                "name" => spec.name = " \t".into(),
                "config" => spec.config = "\n".into(),
                _ => spec.uri.default = " ".into(),
            }
            assert_eq!(validate_catalog(&[spec]), Err(expected.into()));
        }
        let mut duplicate = valid.clone();
        duplicate.name.clear();
        assert_eq!(
            validate_catalog(&[valid.clone(), duplicate]),
            Err("PET_PRESET_CATALOG_INVALID: duplicate preset id \"safe\"".into())
        );
        let mut unsafe_id = valid.clone();
        unsafe_id.id = "../escape".into();
        unsafe_id.name.clear();
        assert_eq!(
            validate_catalog(&[unsafe_id]),
            Err("PET_PRESET_CATALOG_INVALID: preset id \"../escape\" is not a safe id".into())
        );
        for kind in [None, Some("dsh"), Some("codex")] {
            let mut spec = valid.clone();
            spec.kind = kind.map(str::to_owned);
            assert_eq!(validate_catalog(&[spec]), Ok(()));
        }
        let mut invalid_kind = valid;
        invalid_kind.kind = Some("sprite".into());
        assert_eq!(
            validate_catalog(&[invalid_kind]),
            Err("PET_PRESET_CATALOG_INVALID: preset \"safe\" kind must be dsh or codex".into())
        );
    }

    #[test]
    fn catalog_validation_rejects_unsafe_ids_and_bad_kind() {
        let bad_id = r#"[{ "id": "../escape", "name": "X", "config": "https://e.com/c.jsonc", "uri": { "default": "https://e.com/w" } }]"#;
        let catalog: Vec<PresetPetSpec> = serde_json::from_str(bad_id).unwrap();
        assert!(!safe_preset_id(&catalog[0].id));

        let bad_kind = r#"[{ "id": "x", "name": "X", "kind": "sprite", "config": "https://e.com/c.jsonc", "uri": { "default": "https://e.com/w" } }]"#;
        let catalog: Vec<PresetPetSpec> = serde_json::from_str(bad_kind).unwrap();
        assert_eq!(catalog[0].kind.as_deref(), Some("sprite"));
        assert!(catalog[0]
            .kind
            .as_deref()
            .is_some_and(|kind| kind != "dsh" && kind != "codex"));
    }
}
