use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const MCP_INDEX_JS: &str = "node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js";
const READY_ANCHOR: &str = "\tconst outcome = await connection.ready;";
const READY_PATCHED: &str = r#"	// issue #1022: non-strict MCP connections must not block Host readiness.
	if (!config.failOnStartupError) {
		connection.ready.catch((error) => ctx.logger.error(`mcp-client(${config.serverName}): background startup failed: ${String(error)}`));
		return;
	}
	const outcome = await connection.ready;"#;

const OAUTH_SOURCE: &str = include_str!("mcp_oauth.mjs");
const OAUTH_IMPORT: &str = "import * as desktopMcpSdk from \"@modelcontextprotocol/client\";\n";
const TRANSPORT_ANCHOR: &str = "case \"streamable-http\": return new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });";
const TRANSPORT_PATCHED: &str = "case \"streamable-http\": return new StreamableHTTPClientTransport(new URL(config.url), { authProvider: desktopMcpOAuth(desktopMcpSdk, credentials).provider(config), requestInit: { headers: config.headers } });";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(OAUTH_SOURCE) && source.contains(TRANSPORT_PATCHED) {
        return PatchOutcome::AlreadyPatched;
    }
    if !source.contains(READY_ANCHOR)
        || !source.contains(TRANSPORT_ANCHOR)
        || !source.contains("function createTransport(config) {")
        || !(source.contains("transport = createTransport(config);")
            || source.contains("generation.connect(createTransport(config));"))
        || !source.contains("const inject = [\"tools\"];")
    {
        return PatchOutcome::AnchorMissing;
    }
    let ready = if source.contains(READY_PATCHED) {
        source.to_owned()
    } else {
        source.replacen(READY_ANCHOR, READY_PATCHED, 1)
    };
    if source.contains("@modelcontextprotocol/sdk/client/") {
        return if source.contains(READY_PATCHED) {
            PatchOutcome::AlreadyPatched
        } else {
            PatchOutcome::Patched(ready)
        };
    }
    let patched = ready
        .replacen(
            "function createTransport(config) {",
            "function createTransport(config, credentials) {",
            1,
        )
        .replacen(
            "transport = createTransport(config);",
            "transport = createTransport(config, ctx.credentials);",
            1,
        )
        .replacen(
            "generation.connect(createTransport(config));",
            "generation.connect(createTransport(config, ctx.credentials));",
            1,
        )
        .replacen(
            "const inject = [\"tools\"];",
            "const inject = [\"tools\", \"credentials\"];",
            1,
        )
        .replacen(TRANSPORT_ANCHOR, TRANSPORT_PATCHED, 1);
    PatchOutcome::Patched(format!("{OAUTH_IMPORT}{patched}\n{OAUTH_SOURCE}"))
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, MCP_INDEX_JS, patch_source)
}

pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, MCP_INDEX_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_read_failure_is_reported_before_launch() {
        let core = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(core.path().join(MCP_INDEX_JS)).unwrap();
        let error = apply_at(core.path()).expect_err("unreadable MCP file must fail");
        assert!(error.starts_with("DSH_PATCH_READ:"));
    }

    #[test]
    fn legacy_sdk_keeps_existing_transport_without_unavailable_imports() {
        let source = format!("import {{ Client }} from \"@modelcontextprotocol/sdk/client/index.js\";\nfunction createTransport(config) {{\n{TRANSPORT_ANCHOR}\n}}\ngeneration.connect(createTransport(config));\nconst inject = [\"tools\"];\n{READY_ANCHOR}");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected legacy readiness patch")
        };
        assert!(patched.contains(READY_PATCHED));
        assert!(patched.contains(TRANSPORT_ANCHOR));
        assert!(!patched.contains(OAUTH_IMPORT));
        assert!(!patched.contains(OAUTH_SOURCE));
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn legacy_transport_receives_credentials_and_remains_idempotent() {
        let source = format!("function createTransport(config) {{\n{TRANSPORT_ANCHOR}\n}}\ngeneration.connect(createTransport(config));\nconst inject = [\"tools\"];\n{READY_ANCHOR}");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected legacy transport patch")
        };
        assert!(patched.contains("generation.connect(createTransport(config, ctx.credentials));"));
        assert!(patched.contains(TRANSPORT_PATCHED));
        assert!(patched.contains("const inject = [\"tools\", \"credentials\"];"));
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn readiness_patch_is_idempotent_and_preserves_surrounding_lifecycle() {
        let source = format!("function createTransport(config) {{\n{TRANSPORT_ANCHOR}\n}}\ntransport = createTransport(config);\nconst inject = [\"tools\"];\nctx.effect(() => dispose, \"mcp-client.connection\");\n{READY_ANCHOR}\nif (outcome.error !== void 0 && config.failOnStartupError) throw outcome.error;");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected patch")
        };
        assert!(patched.contains(READY_PATCHED));
        assert!(patched.contains(TRANSPORT_PATCHED));
        assert!(patched.contains("createTransport(config, ctx.credentials)"));
        assert!(patched.contains("const inject = [\"tools\", \"credentials\"];"));
        assert!(patched.contains(OAUTH_SOURCE));
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
        let previous = source.replace(READY_ANCHOR, READY_PATCHED);
        let PatchOutcome::Patched(upgraded) = patch_source(&previous) else {
            panic!("expected readiness-only patch upgrade")
        };
        assert_eq!(upgraded.matches(READY_PATCHED).count(), 1);
        assert!(upgraded.contains(TRANSPORT_PATCHED));
        assert_eq!(
            patch_source("upstream changed"),
            PatchOutcome::AnchorMissing
        );
    }
}
