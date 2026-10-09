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
  return ofetch<Types.GetApiTauriExtensionSkillsResponse>("/api/tauri/extension/skills", { method: "get", ...options });
}

/** @method post */
export function postSkillsRefresh(options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionSkillsRefreshResponse>("/api/tauri/extension/skills/refresh", { method: "post", ...options });
}

/** @method get */
export function getSkill(params?: Types.GetApiTauriExtensionSkillQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriExtensionSkillResponse>("/api/tauri/extension/skill", { method: "get", params, ...options });
}

/** @method post */
export function postSkill(body: Types.PostApiTauriExtensionSkillBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionSkillResponse>("/api/tauri/extension/skill", { method: "post", body, ...options });
}

/** @method delete */
export function deleteSkill(body: Types.DeleteApiTauriExtensionSkillBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriExtensionSkillResponse>("/api/tauri/extension/skill", { method: "delete", body, ...options });
}

/** @method post */
export function postSkillPolicy(body: Types.PostApiTauriExtensionSkillPolicyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionSkillPolicyResponse>("/api/tauri/extension/skill/policy", { method: "post", body, ...options });
}

/** @method post */
export function postOpenDir(body: Types.PostApiTauriExtensionOpenDirBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionOpenDirResponse>("/api/tauri/extension/open/dir", { method: "post", body, ...options });
}

/** @method get */
export function getMcp(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriExtensionMcpResponse>("/api/tauri/extension/mcp", { method: "get", ...options });
}

/** @method post */
export function postMcp(body: Types.PostApiTauriExtensionMcpBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionMcpResponse>("/api/tauri/extension/mcp", { method: "post", body, ...options });
}

/** @method delete */
export function deleteMcp(body: Types.DeleteApiTauriExtensionMcpBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriExtensionMcpResponse>("/api/tauri/extension/mcp", { method: "delete", body, ...options });
}

/** @method post */
export function postMcpToggle(body: Types.PostApiTauriExtensionMcpToggleBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionMcpToggleResponse>("/api/tauri/extension/mcp/toggle", { method: "post", body, ...options });
}

/** @method post */
export function postMcpCheck(body: Types.PostApiTauriExtensionMcpCheckBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionMcpCheckResponse>("/api/tauri/extension/mcp/check", { method: "post", body, ...options });
}

/** @method post */
export function postMcpCopy(body: Types.PostApiTauriExtensionMcpCopyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionMcpCopyResponse>("/api/tauri/extension/mcp/copy", { method: "post", body, ...options });
}

/** @method get */
export function getImportScan(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriExtensionImportScanResponse>("/api/tauri/extension/import/scan", { method: "get", ...options });
}

/** @method post */
export function postImportApply(body: Types.PostApiTauriExtensionImportApplyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionImportApplyResponse>("/api/tauri/extension/import/apply", { method: "post", body, ...options });
}

/** @method get */
export function getRoots(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriExtensionRootsResponse>("/api/tauri/extension/roots", { method: "get", ...options });
}

/** @method post */
export function postRoots(body: Types.PostApiTauriExtensionRootsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionRootsResponse>("/api/tauri/extension/roots", { method: "post", body, ...options });
}

/** @method delete */
export function deleteRoots(body: Types.DeleteApiTauriExtensionRootsBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriExtensionRootsResponse>("/api/tauri/extension/roots", { method: "delete", body, ...options });
}

/** @method post */
export function postHostRestart(options?: FetchOptions) {
  return ofetch<Types.PostApiTauriExtensionHostRestartResponse>("/api/tauri/extension/host/restart", { method: "post", ...options });
}
