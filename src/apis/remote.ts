/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./remote.types";
import { ofetch } from "./http";
import type { FetchOptions } from "./http";

/** @method get */
export function getSettings(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshSettingsResponse>("/api/desktop/dsh-tauri-ssh/settings", { method: "get", ...options });
}

/** @method post */
export function postSettings(body: Types.PostApiDesktopDshTauriSshSettingsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshSettingsResponse>("/api/desktop/dsh-tauri-ssh/settings", { method: "post", body, ...options });
}

/** @method get */
export function getSessionRole(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshSessionRoleResponse>("/api/desktop/dsh-tauri-ssh/session/role", { method: "get", ...options });
}

/** @method get */
export function getMachines(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshMachinesResponse>("/api/desktop/dsh-tauri-ssh/machines", { method: "get", ...options });
}

/** @method post */
export function postMachines(body: Types.PostApiDesktopDshTauriSshMachinesBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesResponse>("/api/desktop/dsh-tauri-ssh/machines", { method: "post", body, ...options });
}

/** @method delete */
export function deleteMachines(body: Types.DeleteApiDesktopDshTauriSshMachinesBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriSshMachinesResponse>("/api/desktop/dsh-tauri-ssh/machines", { method: "delete", body, ...options });
}

/** @method post */
export function postMachinesTest(body: Types.PostApiDesktopDshTauriSshMachinesTestBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesTestResponse>("/api/desktop/dsh-tauri-ssh/machines/test", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesConnect(body: Types.PostApiDesktopDshTauriSshMachinesConnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesConnectResponse>("/api/desktop/dsh-tauri-ssh/machines/connect", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesDisconnect(body: Types.PostApiDesktopDshTauriSshMachinesDisconnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesDisconnectResponse>("/api/desktop/dsh-tauri-ssh/machines/disconnect", { method: "post", body, ...options });
}

/** @method post */
export function postMachinesInstall(body: Types.PostApiDesktopDshTauriSshMachinesInstallBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesInstallResponse>("/api/desktop/dsh-tauri-ssh/machines/install", { method: "post", body, ...options });
}

/** @method get */
export function getMachinesEvents(params?: Types.GetApiDesktopDshTauriSshMachinesEventsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshMachinesEventsResponse>("/api/desktop/dsh-tauri-ssh/machines/events", { method: "get", params, ...options });
}

/** @method get */
export function getSyncPreview(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshSyncPreviewResponse>("/api/desktop/dsh-tauri-ssh/sync/preview", { method: "get", ...options });
}

/** @method post */
export function postSyncApply(body: Types.PostApiDesktopDshTauriSshSyncApplyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshSyncApplyResponse>("/api/desktop/dsh-tauri-ssh/sync/apply", { method: "post", body, ...options });
}
