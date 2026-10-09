/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getSettings(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSshSettingsResponse>("/api/tauri/ssh/settings", { method: "get", ...options });
}

/** @method post */
export function postSettings(body: Types.PostApiTauriSshSettingsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSshSettingsResponse>("/api/tauri/ssh/settings", { method: "post", body, ...options });
}

/** @method get */
export function getSessionRole(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSshSessionRoleResponse>("/api/tauri/ssh/session/role", { method: "get", ...options });
}

/** @method get */
export function getMachines(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSshMachinesResponse>("/api/tauri/ssh/machines", { method: "get", ...options });
}

/** @method post */
export function postMachines(body: Types.PostApiTauriSshMachinesBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSshMachinesResponse>("/api/tauri/ssh/machines", { method: "post", body, ...options });
}

/** @method delete */
export function deleteMachines(body: Types.DeleteApiTauriSshMachinesBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriSshMachinesResponse>("/api/tauri/ssh/machines", { method: "delete", body, ...options });
}

/** @method post */
export function postMachinesTest(body: Types.PostApiTauriSshMachinesTestBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSshMachinesTestResponse>("/api/tauri/ssh/machines/test", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesConnect(body: Types.PostApiTauriSshMachinesConnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSshMachinesConnectResponse>("/api/tauri/ssh/machines/connect", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesDisconnect(body: Types.PostApiTauriSshMachinesDisconnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSshMachinesDisconnectResponse>("/api/tauri/ssh/machines/disconnect", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesInstall(body: Types.PostApiTauriSshMachinesInstallBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSshMachinesInstallResponse>("/api/tauri/ssh/machines/install", { method: "post", body, ...options });
}

/** @method get */
export function getMachinesEvents(params?: Types.GetApiTauriSshMachinesEventsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSshMachinesEventsResponse>("/api/tauri/ssh/machines/events", { method: "get", params, ...options });
}

/** @method get */
export function getSyncPreview(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSshSyncPreviewResponse>("/api/tauri/ssh/sync/preview", { method: "get", ...options });
}

/** @method post */
export function postSyncApply(body: Types.PostApiTauriSshSyncApplyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSshSyncApplyResponse>("/api/tauri/ssh/sync/apply", { method: "post", body, ...options });
}
