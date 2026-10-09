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
  return ofetch<Types.GetApiTauriArchiveSessionArchiveResponse>("/api/tauri/archive/session/archive", { method: "get", ...options });
}

/** @method post */
export function postSessionArchive(body: Types.PostApiTauriArchiveSessionArchiveBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriArchiveSessionArchiveResponse>("/api/tauri/archive/session/archive", { method: "post", body, ...options });
}

/** @method delete */
export function deleteSessionArchive(body: Types.DeleteApiTauriArchiveSessionArchiveBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriArchiveSessionArchiveResponse>("/api/tauri/archive/session/archive", { method: "delete", body, ...options });
}

/** @method post */
export function postSessionArchiveClear(options?: FetchOptions) {
  return ofetch<Types.PostApiTauriArchiveSessionArchiveClearResponse>("/api/tauri/archive/session/archive/clear", { method: "post", ...options });
}

/** @method delete */
export function deleteSessionArchiveClear(options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriArchiveSessionArchiveClearResponse>("/api/tauri/archive/session/archive/clear", { method: "delete", ...options });
}

/** @method post */
export function postSessionWorkspaceArchive(body: Types.PostApiTauriArchiveSessionWorkspaceArchiveBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriArchiveSessionWorkspaceArchiveResponse>("/api/tauri/archive/session/workspace/archive", { method: "post", body, ...options });
}

/** @method delete */
export function deleteSessionWorkspaceArchive(body: Types.DeleteApiTauriArchiveSessionWorkspaceArchiveBody, options?: FetchOptions) {
  return ofetch<Types.DeleteApiTauriArchiveSessionWorkspaceArchiveResponse>("/api/tauri/archive/session/workspace/archive", { method: "delete", body, ...options });
}

/** @method post */
export function postSessionArchiveRestore(body: Types.PostApiTauriArchiveSessionArchiveRestoreBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriArchiveSessionArchiveRestoreResponse>("/api/tauri/archive/session/archive/restore", { method: "post", body, ...options });
}

/** @method post */
export function postSessionOpenPath(body: Types.PostApiTauriArchiveSessionOpenPathBody, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriArchiveSessionOpenPathResponse>("/api/tauri/archive/session/open/path", { method: "post", body, ...options });
}
