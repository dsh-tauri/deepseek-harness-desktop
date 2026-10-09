/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method get */
export function getSummary(params?: Types.GetApiTauriExperimentalSummaryQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriExperimentalSummaryResponse>("/api/tauri/experimental/summary", { method: "get", params, ...options });
}

/** @method get */
export function getLive(params?: Types.GetApiTauriExperimentalLiveQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriExperimentalLiveResponse>("/api/tauri/experimental/live", { method: "get", params, ...options });
}
