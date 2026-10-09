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
  return ofetch<Types.GetApiTauriRemoteSettingsResponse>("/api/tauri/remote/settings", { method: "get", ...options });
}

/** @method post */
export function postSettings(body: Types.PostApiTauriRemoteSettingsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRemoteSettingsResponse>("/api/tauri/remote/settings", { method: "post", body, ...options });
}

/** @method get */
export function getSessionRole(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriRemoteSessionRoleResponse>("/api/tauri/remote/session/role", { method: "get", ...options });
}

/** @method get */
export function getMachines(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriRemoteMachinesResponse>("/api/tauri/remote/machines", { method: "get", ...options });
}

/** @method post */
export function postMachines(body: Types.PostApiTauriRemoteMachinesBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRemoteMachinesResponse>("/api/tauri/remote/machines", { method: "post", body, ...options });
}

/** @method delete */
export function deleteMachines(body: Types.DeleteApiTauriRemoteMachinesBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriRemoteMachinesResponse>("/api/tauri/remote/machines", { method: "delete", body, ...options });
}

/** @method post */
export function postMachinesTest(body: Types.PostApiTauriRemoteMachinesTestBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRemoteMachinesTestResponse>("/api/tauri/remote/machines/test", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesConnect(body: Types.PostApiTauriRemoteMachinesConnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRemoteMachinesConnectResponse>("/api/tauri/remote/machines/connect", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesDisconnect(body: Types.PostApiTauriRemoteMachinesDisconnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRemoteMachinesDisconnectResponse>("/api/tauri/remote/machines/disconnect", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesInstall(body: Types.PostApiTauriRemoteMachinesInstallBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRemoteMachinesInstallResponse>("/api/tauri/remote/machines/install", { method: "post", body, ...options });
}

/** @method get */
export function getMachinesEvents(params?: Types.GetApiTauriRemoteMachinesEventsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriRemoteMachinesEventsResponse>("/api/tauri/remote/machines/events", { method: "get", params, ...options });
}

/** @method get */
export function getSyncPreview(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriRemoteSyncPreviewResponse>("/api/tauri/remote/sync/preview", { method: "get", ...options });
}

/** @method post */
export function postSyncApply(body: Types.PostApiTauriRemoteSyncApplyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriRemoteSyncApplyResponse>("/api/tauri/remote/sync/apply", { method: "post", body, ...options });
}
