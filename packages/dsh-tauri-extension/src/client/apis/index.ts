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

/** @method post */
export function postSkillsRefresh(options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionSkillsRefreshResponse>("/api/desktop/dsh-tauri-extension/skills/refresh", { method: "post", ...options });
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

/** @method post */
export function postSkillPolicy(body: Types.PostApiDesktopDshTauriExtensionSkillPolicyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionSkillPolicyResponse>("/api/desktop/dsh-tauri-extension/skill/policy", { method: "post", body, ...options });
}

/** @method post */
export function postOpenDir(body: Types.PostApiDesktopDshTauriExtensionOpenDirBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionOpenDirResponse>("/api/desktop/dsh-tauri-extension/open/dir", { method: "post", body, ...options });
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

/** @method post */
export function postMcpToggle(body: Types.PostApiDesktopDshTauriExtensionMcpToggleBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionMcpToggleResponse>("/api/desktop/dsh-tauri-extension/mcp/toggle", { method: "post", body, ...options });
}

/** @method post */
export function postMcpCheck(body: Types.PostApiDesktopDshTauriExtensionMcpCheckBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionMcpCheckResponse>("/api/desktop/dsh-tauri-extension/mcp/check", { method: "post", body, ...options });
}

/** @method post */
export function postMcpCopy(body: Types.PostApiDesktopDshTauriExtensionMcpCopyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionMcpCopyResponse>("/api/desktop/dsh-tauri-extension/mcp/copy", { method: "post", body, ...options });
}

/** @method get */
export function getImportScan(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExtensionImportScanResponse>("/api/desktop/dsh-tauri-extension/import/scan", { method: "get", ...options });
}

/** @method post */
export function postImportApply(body: Types.PostApiDesktopDshTauriExtensionImportApplyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionImportApplyResponse>("/api/desktop/dsh-tauri-extension/import/apply", { method: "post", body, ...options });
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

/** @method post */
export function postHostRestart(options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriExtensionHostRestartResponse>("/api/desktop/dsh-tauri-extension/host/restart", { method: "post", ...options });
}
