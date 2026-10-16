use crate::config::{self, dependencies as deps, manifest};
use crate::service::{cli, core, patch, plugin, profile as profiles};
use std::fs;
use std::path::{Path, PathBuf};

struct Inputs {
    setting: config::Setting,
    base: PathBuf,
    resource_root: PathBuf,
    manifest: manifest::Manifest,
    mapping: deps::DependencyMapping,
    dsh_home: PathBuf,
}

impl Inputs {
    fn root(&self, key: &str) -> PathBuf {
        deps::active_root_from(
            &self.base,
            Some(&self.resource_root),
            Some(&self.manifest),
            &self.mapping,
            key,
        )
    }

    fn binary(&self, key: &str) -> PathBuf {
        self.root(key)
            .join(deps::entry_relative_from(Some(&self.manifest), key))
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn read_setting(app_data: &Path) -> Option<config::Setting> {
    if !app_data.is_absolute() {
        return None;
    }
    let store = read_json(&app_data.join(config::store_dat_file_name()))?;
    let raw = store.get(config::STORE_SETTING_KEY)?;
    let value = config::unwrap_json_value(raw);
    if value.get("active_profile")?.as_str()? != profiles::DESKTOP_PROFILE
        || value.get("active_core")?.as_str()? != "app"
    {
        return None;
    }
    let setting = config::setting_from_value(Some(raw));
    (setting.installed && setting.auto_start && setting.port != 0).then_some(setting)
}

pub(super) fn profile(app_data: &Path) -> Option<String> {
    if !cfg!(windows) || config::is_first_install() {
        return None;
    }
    Some(read_setting(app_data)?.active_profile)
}

fn resolve(app_data: &Path, resources: &Path) -> Option<Inputs> {
    if !cfg!(windows)
        || config::is_first_install()
        || std::env::var_os("NODE_OPTIONS").is_some_and(|value| !value.is_empty())
        || !resources.is_absolute()
        || !resources.is_dir()
    {
        return None;
    }
    let setting = read_setting(app_data)?;
    let base = config::base_dir_from(|| app_data.to_path_buf());
    let resource_root = manifest::resource_root_from(resources);
    if !base.is_absolute() || !base.is_dir() || !resource_root.is_dir() {
        return None;
    }
    let path = manifest::manifest_path_from(Some(&resource_root), cfg!(debug_assertions))?;
    let manifest = manifest::read_at(&path).ok()?;
    let mapping = deps::read_mapping_at(&base.join(deps::MAPPING_FILE));
    let dsh_home = config::dsh_data_path_from_env();
    if !dsh_home.is_absolute() || !dsh_home.is_dir() {
        return None;
    }
    let profiles = dsh_home.join("profiles");
    if profiles.join("desktop").try_exists().ok()? {
        return None;
    }
    let package = read_json(
        &profiles
            .join(profiles::DESKTOP_PROFILE)
            .join("package.json"),
    )?;
    if !package.is_object()
        || package.get("name").and_then(|value| value.as_str()) == Some("dsh-profile-desktop")
    {
        return None;
    }
    for root in [resources.to_path_buf(), resources.join("resources")] {
        for legacy in ["preset-plugins", "internal-plugins"] {
            if root.join(legacy).try_exists().ok()? {
                return None;
            }
        }
    }
    let inputs = Inputs {
        setting,
        base,
        resource_root,
        manifest,
        mapping,
        dsh_home,
    };
    let root = inputs.root(deps::DEP_DSH);
    let entry = inputs.binary(deps::DEP_DSH);
    (root.is_absolute() && root.is_dir() && entry.is_absolute() && entry.is_file())
        .then_some(inputs)
}

pub(super) fn entry(app_data: &Path, resources: &Path) -> Option<PathBuf> {
    Some(resolve(app_data, resources)?.binary(deps::DEP_DSH))
}

fn exact_core_version(inputs: &Inputs, core_root: &Path) -> Option<String> {
    let package = read_json(&core_root.join(config::DSH_MANIFEST_RELATIVE))?;
    let direct = package.get("name").and_then(|value| value.as_str()) == Some("@deepseek-ai/dsh");
    if direct && package.pointer("/dependencies/@deepseek-ai~1dsh").is_some() {
        return None;
    }
    let version = if direct {
        package.get("version")?.as_str()?
    } else {
        package
            .get("dependencies")?
            .get("@deepseek-ai/dsh")?
            .as_str()?
    };
    semver::Version::parse(version).ok()?;
    if !direct {
        let installed = read_json(&core_root.join("node_modules/@deepseek-ai/dsh/package.json"))?;
        if installed.get("name").and_then(|value| value.as_str()) != Some("@deepseek-ai/dsh")
            || installed.get("version").and_then(|value| value.as_str()) != Some(version)
        {
            return None;
        }
    }
    let managed = deps::managed_root_from(
        &inputs.base,
        Some(&inputs.resource_root),
        Some(&inputs.manifest),
        deps::DEP_DSH,
    );
    let bundled = managed != inputs.resource_root
        && managed.starts_with(&inputs.resource_root)
        && managed == core_root;
    if !bundled
        && inputs
            .setting
            .dsh_pkg_tag
            .as_deref()
            .and_then(crate::service::download::parse_version_from_tag)
            .as_deref()
            != Some(version)
    {
        return None;
    }
    Some(version.to_string())
}

pub(super) fn prepare(
    app_data: &Path,
    resources: &Path,
) -> Result<Option<super::launch::LaunchPlan>, String> {
    let Some(profile) = profile(app_data) else {
        return Ok(None);
    };
    if super::instances::current_profile().as_deref() != Some(profile.as_str()) {
        return Ok(None);
    }
    let Some(inputs) = resolve(app_data, resources) else {
        return Ok(None);
    };
    if inputs.setting.active_profile != profile
        || inputs.setting.port
            != inputs
                .setting
                .manual_port
                .unwrap_or_else(config::default_port)
        || super::utils::is_port_in_use(inputs.setting.port)
    {
        return Ok(None);
    }
    let core_dir = inputs.root(deps::DEP_DSH);
    let Some(version) = exact_core_version(&inputs, &core_dir) else {
        return Ok(None);
    };
    let node_root = inputs.root(deps::DEP_NODE);
    let node_entry = deps::entry_relative_from(Some(&inputs.manifest), deps::DEP_NODE);
    let pinned = matches!(inputs.mapping.get(deps::DEP_NODE), Some(Some(_)));
    let node = config::node_binary_path_from(&node_root, &node_entry, pinned);
    #[cfg(windows)]
    if !super::early::probes_ready()? {
        return Ok(None);
    }
    let pnpm_root = inputs.root(deps::DEP_PNPM);
    let pnpm_binary = inputs.binary(deps::DEP_PNPM);
    let local_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    if !node.is_absolute()
        || !node.is_file()
        || !pnpm_root.is_absolute()
        || !pnpm_binary.is_absolute()
        || !local_data.is_some_and(|path| path.is_absolute() && path.is_dir())
    {
        return Ok(None);
    }
    let bin_dir = cli::get_bin_dir_from(None, None);
    let git_dir = config::git_cmd_dir_from(|| inputs.binary(deps::DEP_GIT));
    #[cfg(windows)]
    if !super::early::probes_ready()? {
        return Ok(None);
    }
    let user_pnpm = cli::find_user_pnpm_from(&bin_dir, None);
    if !bin_dir.is_absolute()
        || !bin_dir.is_dir()
        || git_dir
            .as_ref()
            .is_some_and(|path| !path.is_absolute() || !path.is_dir())
        || match user_pnpm.as_ref() {
            Some(_) => pnpm_binary.exists(),
            None => !pnpm_root.is_dir() || !pnpm_binary.is_file(),
        }
    {
        return Ok(None);
    }
    let profile_root = inputs.dsh_home.join("profiles").join(&profile);
    if let Err(error) = crate::service::migrate::heal_stale_pnpm_metadata(&inputs.dsh_home) {
        log::warn!("pnpm modules metadata self-heal skipped: {error}");
        return Ok(None);
    }
    if let Err(error) = profiles::prepare_at(&inputs.dsh_home, &profile) {
        log::warn!("ensure active profile core bundles failed: {error}");
        return Ok(None);
    }
    if let Err(error) = super::win_inspector::apply_at(&profile_root) {
        log::warn!("win32 legacy patch cleanup failed: {error}");
    }
    for (label, apply) in [
        (
            "renderer SlotOutlet patch",
            patch::renderer::apply_at as fn(&Path) -> Result<(), String>,
        ),
        ("composer workspace-less patch", patch::composer::apply_at),
        (
            "conversation draft compatibility patch",
            patch::conversation_draft::apply_at,
        ),
        ("mobile composer patch", patch::mobile_composer::apply_at),
        ("mobile sidebar patch", patch::mobile_sidebar::apply_at),
        ("SessionStore.remove patch", patch::session::apply_at),
        ("pi-ai session header patch", patch::llm_session::apply_at),
        (
            "pi-ai thinking-as-text patch",
            patch::pi_ai_thinking::apply_at,
        ),
        (
            "model selection mouse click patch",
            patch::model_selection::apply_at,
        ),
        (
            "workspace worktree membership patch",
            patch::workspace::apply_at,
        ),
        (
            "workspace view state patch",
            patch::workspace_view::apply_at,
        ),
        (
            "plugin visibility patch",
            patch::plugin_visibility::apply_at,
        ),
    ] {
        if let Err(error) = apply(&core_dir) {
            log::warn!("{label} failed: {error}");
        }
    }
    patch::mcp_startup::apply_at(&core_dir)?;
    if let Err(error) = plugin::ensure_npmrc_at(&profile_root.join(".npmrc")) {
        log::warn!("ensure profile .npmrc failed: {error}");
        return Ok(None);
    }
    match plugin::prepare_early_plugins(
        &profile_root,
        &inputs.dsh_home,
        Some(resources),
        Some(&inputs.manifest),
        Some(&version),
    ) {
        Ok(plugin::EarlyPluginState::Ready) => {}
        Ok(plugin::EarlyPluginState::Defer) => return Ok(None),
        Err(error) if plugin::is_process_cleanup_failure(&error) => return Err(error),
        Err(error) => {
            log::warn!("ensure internal plugins failed: {error}");
            return Ok(None);
        }
    }
    if let Err(error) = patch::plugin_visibility::apply_at(&core_dir) {
        log::warn!("plugin visibility patch after plugin self-healing failed: {error}");
    }
    let presets = plugin::presets_from_manifest(&inputs.manifest, Some(resources));
    let required: Vec<_> = presets
        .iter()
        .filter(|preset| preset.internal)
        .map(|preset| core::RuntimeRequiredPlugin {
            name: plugin::installed_name(preset),
            source: plugin::bundled_plugin_dir_from(Some(resources), &preset.id),
            version: preset.version.as_ref(),
        })
        .collect();
    if core::prepare_active_runtime_at(&core::RuntimePreparationPaths {
        source: core::CoreSource::App,
        base: &inputs.base,
        core_root: &core_dir,
        node: &node,
        profile: &profile_root,
        profiles: &inputs.dsh_home.join("profiles"),
        resources: Some(&inputs.resource_root),
        core_version: Some(&version),
        required_plugins: Some(&required),
    })? != core::RuntimePreparation::Ready
        || config::node_binary_path_from(&node_root, &node_entry, pinned) != node
    {
        return Ok(None);
    }
    let channel = usize::from(config::APP_IDENTIFIER == "dsh-tauri-nightly");
    let dsh_binary = inputs.binary(deps::DEP_DSH);
    Ok(Some(super::launch::LaunchPlan {
        setting: inputs.setting,
        profile,
        node,
        dsh_binary,
        core_dir,
        pid_path: profile_root.join(config::HARNESS_PID_MARKER_NAMES[channel]),
        profile_root,
        dsh_home: inputs.dsh_home,
        base: inputs.base,
        bin_dir,
        pnpm_root,
        pnpm_binary,
        resources: Some(resources.to_path_buf()),
        git_dir,
        user_pnpm,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn original_store_is_read_only_and_defaults_never_become_ready() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(config::store_dat_file_name());
        assert!(read_setting(root.path()).is_none());
        let ready = json!({
            "installed": true, "auto_start": true, "port": 3080,
            "language": "en", "active_core": "app", "active_profile": profiles::DESKTOP_PROFILE
        });
        for raw in [ready.clone(), json!(ready.to_string())] {
            let bytes = serde_json::to_vec(&json!({"setting": raw})).unwrap();
            fs::write(&path, &bytes).unwrap();
            assert_eq!(
                read_setting(root.path()).unwrap().active_profile,
                profiles::DESKTOP_PROFILE
            );
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        for (key, value) in [
            ("installed", json!(false)),
            ("auto_start", json!(false)),
            ("port", json!(0)),
            ("language", json!(null)),
            ("active_core", json!(null)),
            ("active_core", json!("local")),
            ("active_profile", json!("safe")),
            ("active_profile", json!("desktop")),
            ("active_profile", json!("custom")),
            ("active_profile", json!("web")),
            ("active_profile", json!("../web")),
            ("active_profile", json!(" web")),
        ] {
            let mut setting = ready.clone();
            setting[key] = value;
            fs::write(&path, json!({"setting": setting}).to_string()).unwrap();
            assert!(read_setting(root.path()).is_none(), "{key}");
        }
        for key in ["active_core", "active_profile", "auto_start", "installed"] {
            let mut setting = ready.clone();
            setting.as_object_mut().unwrap().remove(key);
            fs::write(&path, json!({"setting": setting}).to_string()).unwrap();
            assert!(read_setting(root.path()).is_none(), "{key}");
        }
        fs::write(&path, json!({"setting": ready}).to_string()).unwrap();
        super::super::instances::scope_sync("other".into(), || {
            assert!(prepare(root.path(), &root.path().join("missing"))
                .unwrap()
                .is_none());
        });
        assert!(entry(root.path(), Path::new("relative-resources")).is_none());
    }
}
