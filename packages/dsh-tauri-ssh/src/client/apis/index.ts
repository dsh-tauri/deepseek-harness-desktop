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
  return ofetch<Types.GetApiDesktopDshTauriSshSettingsResponse>("/api/desktop/dsh-tauri-ssh/settings", { method: "get", ...options });
}

/** @method post */
export function postSettings(body: Types.PostApiDesktopDshTauriSshSettingsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshSettingsResponse>("/api/desktop/dsh-tauri-ssh/settings", { method: "post", body, ...options });
}

/** @method options */
export function optionsSettings(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshSettingsResponse>("/api/desktop/dsh-tauri-ssh/settings", { method: "options", ...options });
}

/** @method get */
export function getSessionRole(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshSessionRoleResponse>("/api/desktop/dsh-tauri-ssh/session/role", { method: "get", ...options });
}

/** @method options */
export function optionsSessionRole(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshSessionRoleResponse>("/api/desktop/dsh-tauri-ssh/session/role", { method: "options", ...options });
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

/** @method options */
export function optionsMachines(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshMachinesResponse>("/api/desktop/dsh-tauri-ssh/machines", { method: "options", ...options });
}

/** @method post */
export function postMachinesTest(body: Types.PostApiDesktopDshTauriSshMachinesTestBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesTestResponse>("/api/desktop/dsh-tauri-ssh/machines/test", { method: "post", body, ...options });
}

/** @method options */
export function optionsMachinesTest(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshMachinesTestResponse>("/api/desktop/dsh-tauri-ssh/machines/test", { method: "options", ...options });
}

/** @method post */
export function postMachinesConnect(body: Types.PostApiDesktopDshTauriSshMachinesConnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesConnectResponse>("/api/desktop/dsh-tauri-ssh/machines/connect", { method: "post", body, ...options });
}

/** @method options */
export function optionsMachinesConnect(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshMachinesConnectResponse>("/api/desktop/dsh-tauri-ssh/machines/connect", { method: "options", ...options });
}

/** @method post */
export function postMachinesDisconnect(body: Types.PostApiDesktopDshTauriSshMachinesDisconnectBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesDisconnectResponse>("/api/desktop/dsh-tauri-ssh/machines/disconnect", { method: "post", body, ...options });
}

/** @method options */
export function optionsMachinesDisconnect(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshMachinesDisconnectResponse>("/api/desktop/dsh-tauri-ssh/machines/disconnect", { method: "options", ...options });
}

/** @method post */
export function postMachinesInstall(body: Types.PostApiDesktopDshTauriSshMachinesInstallBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshMachinesInstallResponse>("/api/desktop/dsh-tauri-ssh/machines/install", { method: "post", body, ...options });
}

/** @method options */
export function optionsMachinesInstall(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshMachinesInstallResponse>("/api/desktop/dsh-tauri-ssh/machines/install", { method: "options", ...options });
}

/** @method get */
export function getMachinesEvents(params?: Types.GetApiDesktopDshTauriSshMachinesEventsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshMachinesEventsResponse>("/api/desktop/dsh-tauri-ssh/machines/events", { method: "get", params, ...options });
}

/** @method options */
export function optionsMachinesEvents(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshMachinesEventsResponse>("/api/desktop/dsh-tauri-ssh/machines/events", { method: "options", ...options });
}

/** @method get */
export function getSyncPreview(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSshSyncPreviewResponse>("/api/desktop/dsh-tauri-ssh/sync/preview", { method: "get", ...options });
}

/** @method options */
export function optionsSyncPreview(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshSyncPreviewResponse>("/api/desktop/dsh-tauri-ssh/sync/preview", { method: "options", ...options });
}

/** @method post */
export function postSyncApply(body: Types.PostApiDesktopDshTauriSshSyncApplyBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSshSyncApplyResponse>("/api/desktop/dsh-tauri-ssh/sync/apply", { method: "post", body, ...options });
}

/** @method options */
export function optionsSyncApply(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSshSyncApplyResponse>("/api/desktop/dsh-tauri-ssh/sync/apply", { method: "options", ...options });
}
