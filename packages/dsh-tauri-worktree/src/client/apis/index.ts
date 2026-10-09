/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method post */
export function postWorktree(body: Types.PostApiTauriWorktreeBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriWorktreeResponse>("/api/tauri/worktree", { method: "post", body, ...options });
}

/** @method delete */
export function deleteWorktree(body: Types.DeleteApiTauriWorktreeBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriWorktreeResponse>("/api/tauri/worktree", { method: "delete", body, ...options });
}

/** @method get */
export function getBindings(options?: FetchOptions) {
  return ofetch<Types.GetApiTauriWorktreeBindingsResponse>("/api/tauri/worktree/bindings", { method: "get", ...options });
}

/** @method post */
export function postBindings(body: Types.PostApiTauriWorktreeBindingsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriWorktreeBindingsResponse>("/api/tauri/worktree/bindings", { method: "post", body, ...options });
}

/** @method get */
export function getStatus(params?: Types.GetApiTauriWorktreeStatusQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriWorktreeStatusResponse>("/api/tauri/worktree/status", { method: "get", params, ...options });
}

/** @method post */
export function postCheckouts(body: Types.PostApiTauriWorktreeCheckoutsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriWorktreeCheckoutsResponse>("/api/tauri/worktree/checkouts", { method: "post", body, ...options });
}
