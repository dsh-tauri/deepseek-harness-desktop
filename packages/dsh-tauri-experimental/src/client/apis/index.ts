/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getSummary(params?: Types.GetApiDesktopDshTauriExperimentalSummaryQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExperimentalSummaryResponse>("/api/desktop/dsh-tauri-experimental/summary", { method: "get", params, ...options });
}

/** @method get */
export function getLive(params?: Types.GetApiDesktopDshTauriExperimentalLiveQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiDesktopDshTauriExperimentalLiveResponse>("/api/desktop/dsh-tauri-experimental/live", { method: "get", params, ...options });
}
