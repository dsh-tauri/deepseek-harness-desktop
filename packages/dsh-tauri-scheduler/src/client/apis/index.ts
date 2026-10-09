/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getTasks(params?: Types.GetApiTauriSchedulerTasksQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSchedulerTasksResponse>("/api/tauri/scheduler/tasks", { method: "get", params, ...options });
}

/** @method put */
export function putTasks(body: Types.PutApiTauriSchedulerTasksBody, options?: FetchOptions) {
  return ofetch<Types.PutApiTauriSchedulerTasksResponse>("/api/tauri/scheduler/tasks", { method: "put", body, ...options });
}

/** @method post */
export function postTasks(body: Types.PostApiTauriSchedulerTasksBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSchedulerTasksResponse>("/api/tauri/scheduler/tasks", { method: "post", body, ...options });
}

/** @method delete */
export function deleteTasks(body: Types.DeleteApiTauriSchedulerTasksBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriSchedulerTasksResponse>("/api/tauri/scheduler/tasks", { method: "delete", body, ...options });
}

/** @method post */
export function postTasksToggle(body: Types.PostApiTauriSchedulerTasksToggleBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSchedulerTasksToggleResponse>("/api/tauri/scheduler/tasks/toggle", { method: "post", body, ...options });
}

/** @method post */
export function postTasksRun(body: Types.PostApiTauriSchedulerTasksRunBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSchedulerTasksRunResponse>("/api/tauri/scheduler/tasks/run", { method: "post", body, ...options });
}

/** @method get */
export function getHistory(params?: Types.GetApiTauriSchedulerHistoryQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSchedulerHistoryResponse>("/api/tauri/scheduler/history", { method: "get", params, ...options });
}

/** @method delete */
export function deleteHistory(body: Types.DeleteApiTauriSchedulerHistoryBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriSchedulerHistoryResponse>("/api/tauri/scheduler/history", { method: "delete", body, ...options });
}

/** @method get */
export function getOptions(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriSchedulerOptionsResponse>("/api/tauri/scheduler/options", { method: "get", ...options });
}

/** @method post */
export function postRunsRecover(options?: FetchOptions) {
  return ofetch<Types.PostApiTauriSchedulerRunsRecoverResponse>("/api/tauri/scheduler/runs/recover", { method: "post", ...options });
}
