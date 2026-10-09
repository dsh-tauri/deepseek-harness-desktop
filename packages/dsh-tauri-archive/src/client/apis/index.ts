/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getSessionArchive(options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriArchiveSessionArchiveResponse>("/api/desktop/dsh-tauri-archive/session/archive", { method: "get", ...options });
}

/** @method post */
export function postSessionArchive(body: Types.PostApiDesktopDshTauriArchiveSessionArchiveBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriArchiveSessionArchiveResponse>("/api/desktop/dsh-tauri-archive/session/archive", { method: "post", body, ...options });
}

/** @method delete */
export function deleteSessionArchive(body: Types.DeleteApiDesktopDshTauriArchiveSessionArchiveBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriArchiveSessionArchiveResponse>("/api/desktop/dsh-tauri-archive/session/archive", { method: "delete", body, ...options });
}

/** @method post */
export function postSessionArchiveClear(options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriArchiveSessionArchiveClearResponse>("/api/desktop/dsh-tauri-archive/session/archive/clear", { method: "post", ...options });
}

/** @method delete */
export function deleteSessionArchiveClear(options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriArchiveSessionArchiveClearResponse>("/api/desktop/dsh-tauri-archive/session/archive/clear", { method: "delete", ...options });
}

/** @method post */
export function postSessionWorkspaceArchive(body: Types.PostApiDesktopDshTauriArchiveSessionWorkspaceArchiveBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriArchiveSessionWorkspaceArchiveResponse>("/api/desktop/dsh-tauri-archive/session/workspace/archive", { method: "post", body, ...options });
}

/** @method delete */
export function deleteSessionWorkspaceArchive(body: Types.DeleteApiDesktopDshTauriArchiveSessionWorkspaceArchiveBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiDesktopDshTauriArchiveSessionWorkspaceArchiveResponse>("/api/desktop/dsh-tauri-archive/session/workspace/archive", { method: "delete", body, ...options });
}

/** @method post */
export function postSessionArchiveRestore(body: Types.PostApiDesktopDshTauriArchiveSessionArchiveRestoreBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriArchiveSessionArchiveRestoreResponse>("/api/desktop/dsh-tauri-archive/session/archive/restore", { method: "post", body, ...options });
}

/** @method post */
export function postSessionOpenPath(body: Types.PostApiDesktopDshTauriArchiveSessionOpenPathBody, options?: FetchOptions) {
  return ofetch<Types.PostApiDesktopDshTauriArchiveSessionOpenPathResponse>("/api/desktop/dsh-tauri-archive/session/open/path", { method: "post", body, ...options });
}
