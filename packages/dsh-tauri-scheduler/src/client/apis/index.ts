/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getTasks(params?: Types.GetApiDesktopDshTauriSchedulerTasksQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSchedulerTasksResponse>("/api/desktop/dsh-tauri-scheduler/tasks", { method: "get", params, ...options });
}

/** @method put */
export function putTasks(body: Types.PutApiDesktopDshTauriSchedulerTasksBody, options?: FetchOptions) {
  return ofetch<Types.PutApiDesktopDshTauriSchedulerTasksResponse>("/api/desktop/dsh-tauri-scheduler/tasks", { method: "put", body, ...options });
}

/** @method post */
export function postTasks(body: Types.PostApiDesktopDshTauriSchedulerTasksBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSchedulerTasksResponse>("/api/desktop/dsh-tauri-scheduler/tasks", { method: "post", body, ...options });
}

/** @method delete */
export function deleteTasks(body: Types.DeleteApiDesktopDshTauriSchedulerTasksBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriSchedulerTasksResponse>("/api/desktop/dsh-tauri-scheduler/tasks", { method: "delete", body, ...options });
}

/** @method options */
export function optionsTasks(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSchedulerTasksResponse>("/api/desktop/dsh-tauri-scheduler/tasks", { method: "options", ...options });
}

/** @method post */
export function postTasksToggle(body: Types.PostApiDesktopDshTauriSchedulerTasksToggleBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSchedulerTasksToggleResponse>("/api/desktop/dsh-tauri-scheduler/tasks/toggle", { method: "post", body, ...options });
}

/** @method options */
export function optionsTasksToggle(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSchedulerTasksToggleResponse>("/api/desktop/dsh-tauri-scheduler/tasks/toggle", { method: "options", ...options });
}

/** @method post */
export function postTasksRun(body: Types.PostApiDesktopDshTauriSchedulerTasksRunBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSchedulerTasksRunResponse>("/api/desktop/dsh-tauri-scheduler/tasks/run", { method: "post", body, ...options });
}

/** @method options */
export function optionsTasksRun(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSchedulerTasksRunResponse>("/api/desktop/dsh-tauri-scheduler/tasks/run", { method: "options", ...options });
}

/** @method get */
export function getHistory(params?: Types.GetApiDesktopDshTauriSchedulerHistoryQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSchedulerHistoryResponse>("/api/desktop/dsh-tauri-scheduler/history", { method: "get", params, ...options });
}

/** @method delete */
export function deleteHistory(body: Types.DeleteApiDesktopDshTauriSchedulerHistoryBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriSchedulerHistoryResponse>("/api/desktop/dsh-tauri-scheduler/history", { method: "delete", body, ...options });
}

/** @method options */
export function optionsHistory(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSchedulerHistoryResponse>("/api/desktop/dsh-tauri-scheduler/history", { method: "options", ...options });
}

/** @method get */
export function getOptions(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriSchedulerOptionsResponse>("/api/desktop/dsh-tauri-scheduler/options", { method: "get", ...options });
}

/** @method options */
export function optionsOptions(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSchedulerOptionsResponse>("/api/desktop/dsh-tauri-scheduler/options", { method: "options", ...options });
}

/** @method post */
export function postRunsRecover(options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriSchedulerRunsRecoverResponse>("/api/desktop/dsh-tauri-scheduler/runs/recover", { method: "post", ...options });
}

/** @method options */
export function optionsRunsRecover(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriSchedulerRunsRecoverResponse>("/api/desktop/dsh-tauri-scheduler/runs/recover", { method: "options", ...options });
}
