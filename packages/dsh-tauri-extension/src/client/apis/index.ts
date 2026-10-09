/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getSkills(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExtensionSkillsResponse>("/api/desktop/dsh-tauri-extension/skills", { method: "get", ...options });
}

/** @method options */
export function optionsSkills(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionSkillsResponse>("/api/desktop/dsh-tauri-extension/skills", { method: "options", ...options });
}

/** @method post */
export function postSkillsRefresh(options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionSkillsRefreshResponse>("/api/desktop/dsh-tauri-extension/skills/refresh", { method: "post", ...options });
}

/** @method options */
export function optionsSkillsRefresh(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionSkillsRefreshResponse>("/api/desktop/dsh-tauri-extension/skills/refresh", { method: "options", ...options });
}

/** @method get */
export function getSkill(params?: Types.GetApiDesktopDshTauriExtensionSkillQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExtensionSkillResponse>("/api/desktop/dsh-tauri-extension/skill", { method: "get", params, ...options });
}

/** @method post */
export function postSkill(body: Types.PostApiDesktopDshTauriExtensionSkillBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionSkillResponse>("/api/desktop/dsh-tauri-extension/skill", { method: "post", body, ...options });
}

/** @method delete */
export function deleteSkill(body: Types.DeleteApiDesktopDshTauriExtensionSkillBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriExtensionSkillResponse>("/api/desktop/dsh-tauri-extension/skill", { method: "delete", body, ...options });
}

/** @method options */
export function optionsSkill(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionSkillResponse>("/api/desktop/dsh-tauri-extension/skill", { method: "options", ...options });
}

/** @method post */
export function postSkillPolicy(body: Types.PostApiDesktopDshTauriExtensionSkillPolicyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionSkillPolicyResponse>("/api/desktop/dsh-tauri-extension/skill/policy", { method: "post", body, ...options });
}

/** @method options */
export function optionsSkillPolicy(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionSkillPolicyResponse>("/api/desktop/dsh-tauri-extension/skill/policy", { method: "options", ...options });
}

/** @method post */
export function postOpenDir(body: Types.PostApiDesktopDshTauriExtensionOpenDirBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionOpenDirResponse>("/api/desktop/dsh-tauri-extension/open/dir", { method: "post", body, ...options });
}

/** @method options */
export function optionsOpenDir(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionOpenDirResponse>("/api/desktop/dsh-tauri-extension/open/dir", { method: "options", ...options });
}

/** @method get */
export function getMcp(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExtensionMcpResponse>("/api/desktop/dsh-tauri-extension/mcp", { method: "get", ...options });
}

/** @method post */
export function postMcp(body: Types.PostApiDesktopDshTauriExtensionMcpBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionMcpResponse>("/api/desktop/dsh-tauri-extension/mcp", { method: "post", body, ...options });
}

/** @method delete */
export function deleteMcp(body: Types.DeleteApiDesktopDshTauriExtensionMcpBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriExtensionMcpResponse>("/api/desktop/dsh-tauri-extension/mcp", { method: "delete", body, ...options });
}

/** @method options */
export function optionsMcp(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionMcpResponse>("/api/desktop/dsh-tauri-extension/mcp", { method: "options", ...options });
}

/** @method post */
export function postMcpToggle(body: Types.PostApiDesktopDshTauriExtensionMcpToggleBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionMcpToggleResponse>("/api/desktop/dsh-tauri-extension/mcp/toggle", { method: "post", body, ...options });
}

/** @method options */
export function optionsMcpToggle(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionMcpToggleResponse>("/api/desktop/dsh-tauri-extension/mcp/toggle", { method: "options", ...options });
}

/** @method post */
export function postMcpCheck(body: Types.PostApiDesktopDshTauriExtensionMcpCheckBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionMcpCheckResponse>("/api/desktop/dsh-tauri-extension/mcp/check", { method: "post", body, ...options });
}

/** @method options */
export function optionsMcpCheck(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionMcpCheckResponse>("/api/desktop/dsh-tauri-extension/mcp/check", { method: "options", ...options });
}

/** @method post */
export function postMcpCopy(body: Types.PostApiDesktopDshTauriExtensionMcpCopyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionMcpCopyResponse>("/api/desktop/dsh-tauri-extension/mcp/copy", { method: "post", body, ...options });
}

/** @method options */
export function optionsMcpCopy(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionMcpCopyResponse>("/api/desktop/dsh-tauri-extension/mcp/copy", { method: "options", ...options });
}

/** @method get */
export function getImportScan(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExtensionImportScanResponse>("/api/desktop/dsh-tauri-extension/import/scan", { method: "get", ...options });
}

/** @method options */
export function optionsImportScan(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionImportScanResponse>("/api/desktop/dsh-tauri-extension/import/scan", { method: "options", ...options });
}

/** @method post */
export function postImportApply(body: Types.PostApiDesktopDshTauriExtensionImportApplyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionImportApplyResponse>("/api/desktop/dsh-tauri-extension/import/apply", { method: "post", body, ...options });
}

/** @method options */
export function optionsImportApply(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionImportApplyResponse>("/api/desktop/dsh-tauri-extension/import/apply", { method: "options", ...options });
}

/** @method get */
export function getRoots(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExtensionRootsResponse>("/api/desktop/dsh-tauri-extension/roots", { method: "get", ...options });
}

/** @method post */
export function postRoots(body: Types.PostApiDesktopDshTauriExtensionRootsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionRootsResponse>("/api/desktop/dsh-tauri-extension/roots", { method: "post", body, ...options });
}

/** @method delete */
export function deleteRoots(body: Types.DeleteApiDesktopDshTauriExtensionRootsBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriExtensionRootsResponse>("/api/desktop/dsh-tauri-extension/roots", { method: "delete", body, ...options });
}

/** @method options */
export function optionsRoots(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionRootsResponse>("/api/desktop/dsh-tauri-extension/roots", { method: "options", ...options });
}

/** @method post */
export function postHostRestart(options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionHostRestartResponse>("/api/desktop/dsh-tauri-extension/host/restart", { method: "post", ...options });
}

/** @method options */
export function optionsHostRestart(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriExtensionHostRestartResponse>("/api/desktop/dsh-tauri-extension/host/restart", { method: "options", ...options });
}
