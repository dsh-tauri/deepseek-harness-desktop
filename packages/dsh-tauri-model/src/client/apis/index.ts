/*
 * @title index
 * @swagger 2.0
 * @version 0.0.0
 */

import type * as Types from "./index.type";
import { ofetch } from "dsh-tauri/client";
import type { FetchOptions } from "dsh-tauri/client";

/** @method post */
export function postConfigOpen(params?: Types.PostApiTauriModelConfigOpenQuery, options?: FetchOptions) {
  return ofetch<Types.PostApiTauriModelConfigOpenResponse>("/api/tauri/model/config/open", { method: "post", params, ...options });
}

/** @method get */
export function getEndpointModels(params?: Types.GetApiTauriModelEndpointModelsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriModelEndpointModelsResponse>("/api/tauri/model/endpoint/models", { method: "get", params, ...options });
}

/** @method get */
export function getPresets(params?: Types.GetApiTauriModelPresetsQuery, options?: FetchOptions) {
  return ofetch<Types.GetApiTauriModelPresetsResponse>("/api/tauri/model/presets", { method: "get", params, ...options });
}
