/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method post */
export function postWorktree(body: Types.PostApiDesktopDshTauriWorktreeBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriWorktreeResponse>("/api/desktop/dsh-tauri-worktree", { method: "post", body, ...options });
}

/** @method delete */
export function deleteWorktree(body: Types.DeleteApiDesktopDshTauriWorktreeBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriWorktreeResponse>("/api/desktop/dsh-tauri-worktree", { method: "delete", body, ...options });
}

/** @method options */
export function options(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriWorktreeResponse>("/api/desktop/dsh-tauri-worktree", { method: "options", ...options });
}

/** @method get */
export function getBindings(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriWorktreeBindingsResponse>("/api/desktop/dsh-tauri-worktree/bindings", { method: "get", ...options });
}

/** @method post */
export function postBindings(body: Types.PostApiDesktopDshTauriWorktreeBindingsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriWorktreeBindingsResponse>("/api/desktop/dsh-tauri-worktree/bindings", { method: "post", body, ...options });
}

/** @method options */
export function optionsBindings(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriWorktreeBindingsResponse>("/api/desktop/dsh-tauri-worktree/bindings", { method: "options", ...options });
}

/** @method get */
export function getStatus(params?: Types.GetApiDesktopDshTauriWorktreeStatusQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriWorktreeStatusResponse>("/api/desktop/dsh-tauri-worktree/status", { method: "get", params, ...options });
}

/** @method options */
export function optionsStatus(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriWorktreeStatusResponse>("/api/desktop/dsh-tauri-worktree/status", { method: "options", ...options });
}

/** @method post */
export function postCheckouts(body: Types.PostApiDesktopDshTauriWorktreeCheckoutsBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriWorktreeCheckoutsResponse>("/api/desktop/dsh-tauri-worktree/checkouts", { method: "post", body, ...options });
}

/** @method options */
export function optionsCheckouts(options?: FetchOptions) {
  return ofetch<Types.OptionsApiDesktopDshTauriWorktreeCheckoutsResponse>("/api/desktop/dsh-tauri-worktree/checkouts", { method: "options", ...options });
}
